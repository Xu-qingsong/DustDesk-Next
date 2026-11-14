use super::*;
use crate::lan::state_store::StateStore;
use serde_json::{json, Value};
use std::{cell::Cell, fs, path::PathBuf, process::Command};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    profile: PathBuf,
    lan: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("dustdesk-lan-checkpoint-test-{}", Uuid::new_v4()));
        let profile = root.join("Profile");
        fs::create_dir_all(&profile).unwrap();
        let lan = profile.join("LanTransfers");
        Self { root, profile, lan }
    }
    fn initialize(&self) {
        fs::create_dir(&self.lan).unwrap();
        let store = StateStore::open(&self.lan).unwrap();
        store.ensure_identity(&CancellationToken::new()).unwrap();
        fs::write(self.lan.join("state.json"), b"{\r\n \"enabled\":true, \"trusted\":[], \"tasks\":[], \"future\":{\"keep\":3}\r\n}\r\n").unwrap();
    }
    fn capture(&self) -> Frozen {
        Frozen::capture(&self.profile, &CancellationToken::new(), || Ok(())).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn names(path: &Path) -> Vec<String> {
    let mut names: Vec<_> = fs::read_dir(path)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

fn task() -> Value {
    json!({"peer":{"id":"peer","name":"设备","address":"127.0.0.1","port":12345,"fingerprint":"a".repeat(64),"lastSeen":1.25},
        "manifest":{"id":"task","name":"文件","entries":[],"directories":[]},
        "view":{"id":"task","direction":"send","device":"设备","name":"文件","total":0,"done":0,"speed":0,"status":"paused"},
        "prepared":false,"sources":["C:/original"],"future":{"retained":true}})
}

#[test]
fn unused_and_empty_profiles_stay_uninitialized_without_creating_state_identity_or_locks() {
    let fixture = Fixture::new();
    let frozen = fixture.capture();
    assert!(frozen.checkpoint().lan_profile.is_none());
    assert!(frozen.checkpoint().original_identity.is_none());
    assert!(frozen.state_bytes().is_none());
    assert!(names(&fixture.profile).is_empty());
    drop(frozen);
    fs::create_dir(&fixture.lan).unwrap();
    let frozen = fixture.capture();
    assert!(frozen.checkpoint().lan_profile.is_some());
    assert!(frozen.checkpoint().original_identity.is_none());
    assert!(names(&fixture.lan).is_empty());
}

#[test]
fn exact_state_and_original_identity_remain_pinned_under_the_actual_cross_runtime_lease() {
    let fixture = Fixture::new();
    fixture.initialize();
    let state = fs::read(fixture.lan.join("state.json")).unwrap();
    let identity = Zeroizing::new(fs::read(fixture.lan.join("identity.json")).unwrap());
    let initial_names = names(&fixture.lan);
    let mut frozen = fixture.capture();
    assert_eq!(frozen.state_bytes(), Some(state.as_slice()));
    assert!(StateStore::open(&fixture.lan).is_err());
    assert!(fs::write(fixture.lan.join("state.json"), b"changed").is_err());
    assert!(fs::write(fixture.lan.join("identity.json"), b"changed").is_err());
    assert!(fs::rename(&fixture.profile, fixture.root.join("moved")).is_err());
    frozen
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap();
    let expected = frozen.checkpoint().clone();
    let serialized = serde_json::to_string(&expected).unwrap();
    assert!(!serialized.contains("BEGIN"));
    assert!(!serialized.contains("PRIVATE"));
    assert!(!serialized.contains("\"key\""));
    assert!(!serialized.contains("\"cert\""));
    drop(frozen);
    let reopened = Frozen::reopen_original(
        &fixture.profile,
        &expected,
        &CancellationToken::new(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(reopened.checkpoint(), &expected);
    drop(reopened);
    assert_eq!(names(&fixture.lan), initial_names);
    assert_eq!(fs::read(fixture.lan.join("state.json")).unwrap(), state);
    assert!(fs::read(fixture.lan.join("identity.json")).unwrap() == *identity);
}

#[test]
fn active_native_state_owner_blocks_capture_without_mutating_any_original_file() {
    let fixture = Fixture::new();
    fixture.initialize();
    let original = fs::read(fixture.lan.join("state.json")).unwrap();
    let owner = StateStore::open(&fixture.lan).unwrap();
    assert!(
        Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(()))
            .err()
            .unwrap()
            .contains("另一个进程")
    );
    assert_eq!(fs::read(fixture.lan.join("state.json")).unwrap(), original);
    drop(owner);
    fixture.capture();
}

#[test]
fn any_persisted_state_without_original_identity_fails_instead_of_creating_a_new_device() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.lan).unwrap();
    for value in ["{}", "{broken", "{\"enabled\":false,\"tasks\":[]}"] {
        fs::write(fixture.lan.join("state.json"), value).unwrap();
        assert!(
            Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(()))
                .err()
                .unwrap()
                .contains("身份缺失")
        );
        assert_eq!(
            fs::read_to_string(fixture.lan.join("state.json")).unwrap(),
            value
        );
        assert!(!fixture.lan.join("identity.json").exists());
    }
    assert_eq!(names(&fixture.lan), ["state.json"]);
}

#[test]
fn copied_profile_and_replaced_identity_file_cannot_masquerade_as_the_original_native_checkpoint() {
    let fixture = Fixture::new();
    fixture.initialize();
    let frozen = fixture.capture();
    let expected = frozen.checkpoint().clone();
    drop(frozen);
    let copied = fixture.root.join("CopiedProfile");
    copy_tree(&fixture.profile, &copied);
    assert!(
        Frozen::reopen_original(&copied, &expected, &CancellationToken::new(), || Ok(())).is_err()
    );
    fs::copy(
        fixture.lan.join("identity.json"),
        fixture.lan.join("identity-copy.json"),
    )
    .unwrap();
    fs::rename(
        fixture.lan.join("identity.json"),
        fixture.lan.join("identity-original.json"),
    )
    .unwrap();
    fs::rename(
        fixture.lan.join("identity-copy.json"),
        fixture.lan.join("identity.json"),
    )
    .unwrap();
    assert!(Frozen::reopen_original(
        &fixture.profile,
        &expected,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
}

#[test]
fn changed_state_after_release_does_not_reuse_a_stale_original_checkpoint() {
    let fixture = Fixture::new();
    fixture.initialize();
    let frozen = fixture.capture();
    let expected = frozen.checkpoint().clone();
    drop(frozen);
    fs::write(
        fixture.lan.join("state.json"),
        b"{\"enabled\":false,\"tasks\":[],\"trusted\":[]}",
    )
    .unwrap();
    assert!(Frozen::reopen_original(
        &fixture.profile,
        &expected,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
    assert!(fixture.capture().checkpoint().state != expected.state);
}

#[test]
fn identity_without_state_is_reused_read_only_and_malformed_private_material_is_never_echoed() {
    let fixture = Fixture::new();
    fixture.initialize();
    fs::remove_file(fixture.lan.join("state.json")).unwrap();
    let frozen = fixture.capture();
    assert!(frozen.state_bytes().is_none());
    assert!(frozen.checkpoint().original_identity.is_some());
    drop(frozen);
    let sentinel = "never-echo-private-key-fixture";
    fs::write(
        fixture.lan.join("identity.json"),
        json!({"id":"device","fingerprint":"a".repeat(64),"cert":"bad","key":sentinel}).to_string(),
    )
    .unwrap();
    let error = Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(()))
        .err()
        .unwrap();
    assert!(!error.contains(sentinel));
    assert!(!error.contains("\"key\""));
}

#[test]
fn transient_text_and_live_task_credentials_are_rejected_without_silently_normalizing_state() {
    let fixture = Fixture::new();
    fixture.initialize();
    for mode in ["text", "view-text", "token", "controller", "running"] {
        let mut task = task();
        match mode {
            "text" => {
                task["manifest"]["text"] = json!("private transient text");
                task["view"]["text"] = json!("private transient text");
            }
            "view-text" => {
                task["view"]["text"] = json!("private transient text");
            }
            field => {
                task[field] = json!("private transient credential");
            }
        }
        let raw = json!({"enabled":true,"trusted":[],"tasks":[task]}).to_string();
        fs::write(fixture.lan.join("state.json"), &raw).unwrap();
        assert!(
            Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).is_err(),
            "{mode}"
        );
        assert_eq!(
            fs::read_to_string(fixture.lan.join("state.json")).unwrap(),
            raw
        );
    }
    let raw = json!({"enabled":true,"trusted":[],"tasks":[task()]}).to_string();
    fs::write(fixture.lan.join("state.json"), &raw).unwrap();
    assert_eq!(fixture.capture().state_bytes(), Some(raw.as_bytes()));
}

#[test]
fn cancellation_and_native_revocation_never_initialize_or_rewrite_source_files() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(Frozen::capture(&fixture.profile, &cancel, || Ok(())).is_err());
    assert!(names(&fixture.profile).is_empty());
    fixture.initialize();
    let original = fs::read(fixture.lan.join("state.json")).unwrap();
    let count = Cell::new(0);
    assert!(
        Frozen::capture(&fixture.profile, &CancellationToken::new(), || {
            count.set(count.get() + 1);
            if count.get() >= 3 {
                return Err("native revoked".into());
            }
            Ok(())
        })
        .is_err()
    );
    assert_eq!(fs::read(fixture.lan.join("state.json")).unwrap(), original);
    let mut frozen = fixture.capture();
    assert!(frozen.confirm(&cancel, || Ok(())).is_err());
}

#[test]
fn creation_of_previously_absent_lan_files_is_not_silently_omitted() {
    let fixture = Fixture::new();
    let mut frozen = fixture.capture();
    fs::create_dir(&fixture.lan).unwrap();
    assert!(frozen
        .confirm(&CancellationToken::new(), || Ok(()))
        .is_err());
    drop(frozen);
    let mut frozen = fixture.capture();
    fs::write(fixture.lan.join("state.json"), b"{}").unwrap();
    assert!(frozen
        .confirm(&CancellationToken::new(), || Ok(()))
        .is_err());
}

#[test]
fn hardlinks_writers_junctions_and_overlimit_files_fail_without_following_or_copying_them() {
    use std::os::windows::fs::OpenOptionsExt;
    for name in ["state.json", "identity.json"] {
        let fixture = Fixture::new();
        fixture.initialize();
        let target = fixture.lan.join(name);
        let link = fixture.root.join("external-link");
        fs::hard_link(&target, &link).unwrap();
        assert!(Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).is_err());
        fs::remove_file(&link).unwrap();
        let writer = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(7)
            .open(&target)
            .unwrap();
        assert!(Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).is_err());
        drop(writer);
        let limit = if name == "identity.json" {
            1024 * 1024
        } else {
            MAX_JSON_BYTES
        };
        let file = fs::OpenOptions::new().write(true).open(&target).unwrap();
        file.set_len(limit as u64 + 1).unwrap();
        drop(file);
        assert!(Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).is_err());
    }
    let fixture = Fixture::new();
    fixture.initialize();
    let held = fixture.root.join("original-lan");
    fs::rename(&fixture.lan, &held).unwrap();
    let output = Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&fixture.lan)
        .arg(&held)
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).is_err());
    assert!(held.join("identity.json").is_file());
}
