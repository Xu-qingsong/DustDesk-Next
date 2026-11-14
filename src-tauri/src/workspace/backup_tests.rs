use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{Duration, Utc};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs::FileTimes;

struct Fixture {
    root: PathBuf,
    store: WorkspaceStore,
    _cleanup: Cleanup,
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("dustdesk-rust-backup-{}", Uuid::new_v4()));
        let mut store = WorkspaceStore::open(root.clone()).unwrap();
        let mut state = normalize::default_state();
        state["Settings"]["AutomaticBackupEnabled"] = json!(false);
        store.initialize(state, "main").unwrap();
        Self {
            _cleanup: Cleanup(root.clone()),
            root,
            store,
        }
    }
    fn state(&mut self) -> Value {
        self.store.load("main").unwrap().state
    }
    fn backup(&self, state: &Value, name: &str) -> String {
        let directory = self.root.join("Backups");
        fs::create_dir_all(&directory).unwrap();
        let target = directory.join(format!("{name}.json"));
        fs::write(&target, serde_json::to_vec(state).unwrap()).unwrap();
        target.display().to_string()
    }
    fn files(&self, directory: &str) -> Vec<PathBuf> {
        let mut files: Vec<_> = fs::read_dir(self.root.join(directory))
            .into_iter()
            .flatten()
            .map(|entry| entry.unwrap().path())
            .collect();
        files.sort();
        files
    }
}

fn portable(mut state: Value) -> Value {
    state["Notes"][0]["BackgroundImagePath"] = json!("C:/original/live.png");
    state["RecycleBin"] = json!([{"Id":"recycled","kind":"note","DeletedAt":"2026-01-01T00:00:00Z","ExpiresAt":"2099-01-01T00:00:00Z","value":{"Id":"deleted-note","Title":"deleted","Text":"保留回收站","BackgroundImagePath":"C:/original/deleted.jpg"}}]);
    state["BackupNoteAssets"] = json!({"C:/original/live.png":STANDARD.encode(b"live-image"),"C:/original/deleted.jpg":STANDARD.encode(b"deleted-image")});
    state["ClipboardHistory"] = json!([{"Id":"image","Kind":"Image","Text":"","ImagePngBase64":STANDARD.encode(b"clipboard-image")}]);
    state["UnknownBackupField"] = json!({"keep":"完整保留"});
    state
}

#[test]
fn restore_remaps_live_and_recycled_assets_exports_portable_bytes_and_retains_unknown_fields() {
    let mut fixture = Fixture::new();
    let state = portable(fixture.state());
    let target = fixture.backup(&state, "imported");
    let preview = fixture.store.preview_backup(&target).unwrap();
    assert_eq!(
        preview.fingerprint,
        format!("{:x}", Sha256::digest(fs::read(&target).unwrap()))
    );
    assert_eq!(preview.notes, state["Notes"].as_array().unwrap().len());
    assert_eq!(preview.recycle_entries, 1);
    let restored = fixture
        .store
        .restore_backup(Some(target), Some(preview.fingerprint))
        .unwrap()
        .state;
    let live = restored["Notes"][0]["BackgroundImagePath"]
        .as_str()
        .unwrap();
    let deleted = restored["RecycleBin"][0]["value"]["BackgroundImagePath"]
        .as_str()
        .unwrap();
    assert_eq!(fs::read(live).unwrap(), b"live-image");
    assert_eq!(fs::read(deleted).unwrap(), b"deleted-image");
    assert!(Path::new(live).starts_with(fixture.root.join("NoteBackgrounds")));
    assert_ne!(live, "C:/original/live.png");
    assert_eq!(restored["UnknownBackupField"], state["UnknownBackupField"]);
    assert!(restored.get("BackupNoteAssets").is_none());
    assert!(restored.get("BackupWarnings").is_none());
    assert_eq!(
        assets::read(&fixture.root, &restored["ClipboardHistory"][0]).unwrap(),
        b"clipboard-image"
    );
    assert_eq!(
        fixture.store.read_note_image(live).unwrap(),
        format!("data:image/png;base64,{}", STANDARD.encode(b"live-image"))
    );
    assert!(fixture
        .store
        .read_note_image(deleted)
        .unwrap()
        .starts_with("data:image/jpeg;base64,"));
    let exported = fixture.store.create_backup().unwrap();
    let exported: Value = serde_json::from_slice(&fs::read(exported).unwrap()).unwrap();
    assert_eq!(
        exported["BackupNoteAssets"][live],
        STANDARD.encode(b"live-image")
    );
    assert_eq!(
        exported["BackupNoteAssets"][deleted],
        STANDARD.encode(b"deleted-image")
    );
    assert_eq!(
        exported["ClipboardHistory"][0]["ImagePngBase64"],
        STANDARD.encode(b"clipboard-image")
    );
    assert!(exported["BackupWarnings"].as_array().unwrap().is_empty());
}

#[test]
fn stale_fingerprint_cannot_write_workspace_or_create_protection_backup() {
    let mut fixture = Fixture::new();
    let target = fixture.store.create_backup().unwrap();
    let preview = fixture.store.preview_backup(&target).unwrap();
    let mut changed: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
    changed["QuickNote"] = json!("changed after preview");
    fs::write(&target, serde_json::to_vec(&changed).unwrap()).unwrap();
    let before = fs::read(fixture.store.path()).unwrap();
    assert!(fixture
        .store
        .restore_backup(Some(target), Some(preview.fingerprint))
        .err()
        .unwrap()
        .contains("重新预览"));
    assert_eq!(fs::read(fixture.store.path()).unwrap(), before);
    assert_eq!(fixture.store.list_backups().unwrap().len(), 1);
}

#[test]
fn malformed_and_future_backup_inputs_never_change_current_data() {
    let mut fixture = Fixture::new();
    let valid = portable(fixture.state());
    let before = fs::read(fixture.store.path()).unwrap();
    for invalid in [
        json!(null),
        {
            let mut changed = valid.clone();
            changed["SchemaVersion"] = json!(4);
            changed
        },
        {
            let mut changed = valid.clone();
            changed["BackupNoteAssets"]["C:/original/live.png"] = json!("YQ==\n");
            changed
        },
        {
            let mut changed = valid.clone();
            changed["BackupNoteAssets"] = json!({"C:/bad.exe":"YQ=="});
            changed
        },
    ] {
        let target = fixture.backup(&invalid, "invalid");
        assert!(fixture.store.preview_backup(&target).is_err());
        assert!(fixture.store.restore_backup(Some(target), None).is_err());
        assert_eq!(fs::read(fixture.store.path()).unwrap(), before);
    }
}

#[test]
fn failed_metadata_commit_removes_only_new_assets_and_keeps_originals_and_protection() {
    let mut fixture = Fixture::new();
    let state = portable(fixture.state());
    let target = fixture.backup(&state, "imported");
    let directory = fixture.root.join("NoteBackgrounds");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("keep.png"), b"untouched").unwrap();
    let originals = fixture.files("NoteBackgrounds");
    let before = fs::read(fixture.store.path()).unwrap();
    fs::create_dir(fixture.store.backup()).unwrap();
    assert!(fixture.store.restore_backup(Some(target), None).is_err());
    assert_eq!(fs::read(fixture.store.path()).unwrap(), before);
    assert_eq!(fixture.files("NoteBackgrounds"), originals);
    assert!(fixture.files("ClipboardImages").is_empty());
    assert_eq!(
        fixture
            .store
            .list_backups()
            .unwrap()
            .iter()
            .filter(|entry| entry.name.starts_with("before-restore-"))
            .count(),
        1
    );
}

#[test]
fn missing_current_note_assets_block_manual_backup_but_protection_retains_warnings() {
    let mut fixture = Fixture::new();
    let initial = fixture.state();
    let target = fixture.backup(&initial, "valid");
    let mut broken = initial;
    broken["Notes"][0]["BackgroundImagePath"] = json!(fixture
        .root
        .join("NoteBackgrounds/missing.png")
        .display()
        .to_string());
    fixture.store.write(&mut broken, true).unwrap();
    assert!(fixture.store.create_backup().is_err());
    fixture.store.restore_backup(Some(target), None).unwrap();
    let protection = fixture
        .store
        .list_backups()
        .unwrap()
        .into_iter()
        .find(|entry| entry.name.starts_with("before-restore-"))
        .unwrap();
    let preview = fixture.store.preview_backup(&protection.path).unwrap();
    assert_eq!(preview.warnings.len(), 1);
    let protected: Value = serde_json::from_slice(&fs::read(&protection.path).unwrap()).unwrap();
    assert_eq!(
        protected["Notes"][0]["BackgroundImagePath"],
        broken["Notes"][0]["BackgroundImagePath"]
    );
    let before = fs::read(fixture.store.path()).unwrap();
    assert!(fixture
        .store
        .restore_backup(Some(protection.path), Some(preview.fingerprint))
        .is_err());
    assert_eq!(fs::read(fixture.store.path()).unwrap(), before);
}

#[test]
fn damaged_current_and_fallback_are_preserved_byte_for_byte_before_explicit_recovery() {
    let mut fixture = Fixture::new();
    let target = fixture.store.create_backup().unwrap();
    fs::write(fixture.store.path(), b"{damaged-current").unwrap();
    fs::write(fixture.store.backup(), b"{damaged-fallback").unwrap();
    assert!(fixture.store.load("main").is_err());
    fixture.store.restore_backup(Some(target), None).unwrap();
    let protected: Vec<_> = fixture
        .store
        .list_backups()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.name.starts_with("before-restore-damaged-"))
        .map(|entry| fs::read(entry.path).unwrap())
        .collect();
    assert!(protected.contains(&b"{damaged-current".to_vec()));
    assert!(protected.contains(&b"{damaged-fallback".to_vec()));
    assert_eq!(
        fs::read(fixture.store.backup()).unwrap(),
        b"{damaged-fallback"
    );
    assert!(fixture.store.load("main").is_ok());
}

#[test]
fn restored_focus_pauses_at_checkpoint_instead_of_counting_offline_time() {
    let mut fixture = Fixture::new();
    let mut state = fixture.state();
    state["ActiveFocus"] = json!({"Id":"focus","TaskTitle":"task","ProjectName":"","PlannedSeconds":1500,"ElapsedSeconds":5,"StartedAt":"2026-11-09T01:00:00Z","RunningSince":"2026-11-09T01:00:00Z","CheckpointAt":"2026-11-09T01:00:10Z"});
    let target = fixture.backup(&state, "focus");
    let restored = fixture
        .store
        .restore_backup(Some(target), None)
        .unwrap()
        .state;
    assert_eq!(restored["ActiveFocus"]["ElapsedSeconds"], 15.0);
    assert!(restored["ActiveFocus"]["RunningSince"].is_null());
}

#[test]
fn retention_removes_only_expired_auto_backups_and_runs_once_per_local_day() {
    let mut fixture = Fixture::new();
    let mut state = fixture.state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(true);
    state["Settings"]["BackupRetentionDays"] = json!(2);
    fixture.store.write(&mut state, true).unwrap();
    let now = Utc::now();
    for name in ["auto-old", "manual-old", "before-restore-old"] {
        let target = fixture.backup(&state, name);
        let past: std::time::SystemTime = (now - Duration::days(10)).into();
        File::options()
            .write(true)
            .open(target)
            .unwrap()
            .set_times(FileTimes::new().set_modified(past))
            .unwrap();
    }
    fixture.store.maintain_backups(now).unwrap();
    let entries = fixture.store.list_backups().unwrap();
    assert_eq!(entries.len(), 3);
    assert!(!entries.iter().any(|entry| entry.name == "auto-old.json"));
    assert!(entries.iter().any(|entry| entry.name == "manual-old.json"));
    assert!(entries
        .iter()
        .any(|entry| entry.name == "before-restore-old.json"));
    assert!(!fixture
        .store
        .backup_status()
        .last_automatic_backup_at
        .is_empty());
    fixture.store.maintain_backups(now).unwrap();
    assert_eq!(fixture.store.list_backups().unwrap().len(), 3);
}

#[test]
fn automatic_backup_failure_is_reported_and_retries_after_the_directory_is_fixed() {
    let mut fixture = Fixture::new();
    let mut state = fixture.state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(true);
    fixture.store.write(&mut state, true).unwrap();
    let directory = fixture.root.join("Backups");
    fs::write(&directory, b"blocked").unwrap();
    fixture.store.backup_maintenance();
    assert!(!fixture.store.backup_status().error.is_empty());
    assert!(fixture.store.restore_backup(None, None).is_err());
    fs::remove_file(&directory).unwrap();
    fixture.store.last_backup_check = None;
    fixture.store.backup_maintenance();
    assert!(fixture.store.backup_status().error.is_empty());
    assert_eq!(fixture.store.list_backups().unwrap().len(), 1);
}

#[test]
fn only_current_managed_note_references_authorize_image_reads() {
    let mut fixture = Fixture::new();
    let directory = fixture.root.join("NoteBackgrounds");
    fs::create_dir(&directory).unwrap();
    let target = directory.join("unauthorized.png");
    fs::write(&target, b"private").unwrap();
    assert!(fixture
        .store
        .read_note_image(target.to_str().unwrap())
        .is_err());
    let mut state = fixture.state();
    state["Notes"][0]["BackgroundImagePath"] = json!(target.display().to_string());
    fixture.store.write(&mut state, true).unwrap();
    assert!(fixture
        .store
        .read_note_image(target.to_str().unwrap())
        .is_ok());
    let traversal = directory.join("../workspace.json");
    state["Notes"][0]["BackgroundImagePath"] = json!(traversal.display().to_string());
    fixture.store.write(&mut state, true).unwrap();
    assert!(fixture
        .store
        .read_note_image(traversal.to_str().unwrap())
        .is_err());
    assert!(fixture
        .store
        .preview_backup(fixture.store.path().to_str().unwrap())
        .is_err());
}

#[test]
fn cumulative_image_budget_rejects_oversized_exports_without_publishing_a_partial_backup() {
    let mut fixture = Fixture::new();
    let mut state = fixture.state();
    let template = state["Notes"][0].clone();
    state["Notes"] = json!([]);
    let directory = fixture.root.join("NoteBackgrounds");
    fs::create_dir(&directory).unwrap();
    let bytes = vec![42; 12 * 1024 * 1024];
    for index in 0..4 {
        let target = directory.join(format!("image-{index}.png"));
        fs::write(&target, &bytes).unwrap();
        let mut note = template.clone();
        note["Id"] = json!(format!("note-{index}"));
        note["BackgroundImagePath"] = json!(target.display().to_string());
        state["Notes"].as_array_mut().unwrap().push(note);
    }
    fixture.store.write(&mut state, true).unwrap();
    let before = fs::read(fixture.store.path()).unwrap();
    assert!(fixture
        .store
        .create_backup()
        .unwrap_err()
        .contains("64 MiB"));
    assert!(fixture.store.list_backups().unwrap().is_empty());
    assert_eq!(fs::read(fixture.store.path()).unwrap(), before);
}

#[test]
fn explicit_recovery_protects_future_schema_bytes_and_accepts_valid_legacy_backups() {
    let mut fixture = Fixture::new();
    let mut legacy = fixture.state();
    legacy["SchemaVersion"] = json!(1);
    legacy["Notes"][0].as_object_mut().unwrap().remove("Id");
    let target = fixture.backup(&legacy, "legacy");
    let future = br#"{"SchemaVersion":4,"FutureField":"keep"}"#;
    fs::write(fixture.store.path(), future).unwrap();
    assert!(fixture.store.load("main").is_err());
    let restored = fixture
        .store
        .restore_backup(Some(target), None)
        .unwrap()
        .state;
    assert_eq!(restored["SchemaVersion"], 3);
    assert!(restored["Notes"][0]["Id"]
        .as_str()
        .is_some_and(|id| !id.is_empty()));
    let protected: Vec<_> = fixture
        .store
        .list_backups()
        .unwrap()
        .into_iter()
        .filter(|entry| entry.name.starts_with("before-restore-damaged-"))
        .map(|entry| fs::read(entry.path).unwrap())
        .collect();
    assert!(protected.contains(&future.to_vec()));
}
