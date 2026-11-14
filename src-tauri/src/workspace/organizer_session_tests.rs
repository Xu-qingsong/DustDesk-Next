use super::*;
use std::fs;
struct Root(PathBuf);
#[test]
fn legacy_birthtime_json_roundtrips_preserve_exact_node_identity_without_tolerance() {
    for fractional_tick in 0..10000 {
        let birth = 1794268800000.0 + f64::from(fractional_tick) / 10000.0;
        let original = json!({"ino":281474976710655.0,"birthtimeMs":birth});
        let serialized = serde_json::to_string(&original).unwrap();
        let parsed: Value = serde_json::from_str(&serialized).unwrap();
        assert_eq!(
            parsed["birthtimeMs"].as_f64().unwrap().to_bits(),
            birth.to_bits(),
            "{serialized}"
        );
        assert_eq!(parsed["ino"], original["ino"]);
    }
}

#[cfg(windows)]
#[test]
fn legacy_record_with_fractional_creation_time_recollects_the_exact_same_file_after_json_reload() {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::{
        Foundation::{FILETIME, HANDLE},
        Storage::FileSystem::SetFileTime,
    };
    let root =
        Root(std::env::temp_dir().join(format!("dustdesk-identity-precision-{}", Uuid::new_v4())));
    let desktop = root.0.join("Desktop");
    fs::create_dir_all(&desktop).unwrap();
    let mut store = WorkspaceStore::open(root.0.join("Data")).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    let mut state = super::super::normalize::default_state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(false);
    state["DesktopCategories"] =
        json!([{"Id":"work","Name":"工作","IsCollapsed":false,"ItemPaths":[]}]);
    store.initialize(state, "identity-precision-test").unwrap();
    let target = desktop.join("original.txt");
    fs::write(&target, b"original bytes").unwrap();
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(&target)
        .unwrap();
    let ticks = 116444736000000000u64 + 17942688000000015u64;
    let creation = FILETIME {
        dwLowDateTime: ticks as u32,
        dwHighDateTime: (ticks >> 32) as u32,
    };
    unsafe {
        SetFileTime(HANDLE(file.as_raw_handle()), Some(&creation), None, None).unwrap();
    }
    drop(file);
    let (_, managed) = store
        .organizer_move("work", target.to_str().unwrap())
        .unwrap();
    store.organizer_restore_session().unwrap();
    let (inode, birth) = Tree::read(&target).unwrap().legacy_identity().unwrap();
    assert_eq!(birth, 1794268800000.0015);
    let mut state = store.read().unwrap();
    let record = state["OrganizerDesktopRestores"][0]
        .as_object_mut()
        .unwrap();
    record.insert("ino".into(), json!(inode));
    record.insert("birthtimeMs".into(), json!(birth));
    record.remove("NativeTree");
    record.remove("NativeRestoreId");
    store.write(&mut state, true).unwrap();
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopRestores"][0]["birthtimeMs"].as_f64(),
        Some(birth)
    );
    store.organizer_resume_session().unwrap();
    assert_eq!(fs::read(managed).unwrap(), b"original bytes");
    assert!(!target.exists());
}
impl Drop for Root {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn renamed_categories_and_directory_edits_keep_original_storage_paths_on_automatic_startup() {
    let (_root, mut store, desktop, managed) = setup();
    let directory = desktop.join("directory");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("old.txt"), b"old").unwrap();
    let (_, managed_directory) = store
        .organizer_move("work", directory.to_str().unwrap())
        .unwrap();
    let mut state = store.read().unwrap();
    state["DesktopCategories"][0]["Name"] = json!("renamed category");
    store.write(&mut state, true).unwrap();
    store.organizer_restore_session().unwrap();
    fs::remove_file(directory.join("old.txt")).unwrap();
    fs::write(directory.join("new.txt"), b"new child").unwrap();
    let data = store.root.clone();
    drop(store);
    let mut store = WorkspaceStore::open(data).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    let resumed = store.read().unwrap();
    assert_eq!(resumed["DesktopCategories"][0]["Name"], "renamed category");
    assert_eq!(resumed["OrganizerDesktopRestores"], json!([]));
    assert_eq!(fs::read(managed).unwrap(), b"original bytes");
    assert_eq!(
        fs::read(Path::new(&managed_directory).join("new.txt")).unwrap(),
        b"new child"
    );
    assert!(!directory.exists());
}

#[test]
fn recollection_boundary_rejects_a_same_content_replacement_and_keeps_original_workspace() {
    let (_root, mut store, desktop, managed) = setup();
    store.organizer_restore_session().unwrap();
    let source = desktop.join("original.txt");
    let expected = Tree::read(&source).unwrap();
    fs::rename(&source, desktop.join("original-kept.txt")).unwrap();
    fs::write(&source, b"original bytes").unwrap();
    let before = fs::read(store.path()).unwrap();
    let mut after = store.read().unwrap();
    after["OrganizerDesktopRestores"] = json!([]);
    assert!(store
        .organizer_recollect_transaction(&desktop, source.clone(), managed.clone(), after, expected)
        .is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert_eq!(fs::read(source).unwrap(), b"original bytes");
    assert!(!managed.exists());
}

#[cfg(windows)]
#[test]
fn locked_desktop_startup_keeps_pending_identity_and_retries_before_exposing_a_workspace() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_root, mut store, desktop, managed) = setup();
    store.organizer_restore_session().unwrap();
    let before = fs::read(store.path()).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(desktop.join("original.txt"))
        .unwrap();
    let data = store.root.clone();
    drop(store);
    let mut store = WorkspaceStore::open(data).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    assert!(store.read().unwrap_err().contains("无法重新收纳"));
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(!store.organizer_session_ready);
    assert!(!managed.exists());
    drop(lock);
    let state = store.read().unwrap();
    assert_eq!(state["OrganizerDesktopRestores"], json!([]));
    assert!(store.organizer_session_ready);
    assert_eq!(fs::read(managed).unwrap(), b"original bytes");
}

#[cfg(windows)]
#[test]
fn a_partial_quit_failure_recollects_prior_successes_without_touching_the_locked_item() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_root, mut store, desktop, managed) = setup();
    let source = desktop.join("locked.txt");
    fs::write(&source, b"locked bytes").unwrap();
    let (_, locked_path) = store
        .organizer_move("work", source.to_str().unwrap())
        .unwrap();
    let before = store.read().unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&locked_path)
        .unwrap();
    assert!(store.organizer_restore_session().is_err());
    assert_eq!(
        fs::read(desktop.join("original.txt")).unwrap(),
        b"original bytes"
    );
    store.organizer_resume_session().unwrap();
    assert_eq!(fs::read(&managed).unwrap(), b"original bytes");
    let after = store.read().unwrap();
    assert_eq!(after["OrganizerDesktopRestores"], json!([]));
    assert_eq!(after["DesktopCategories"], before["DesktopCategories"]);
    assert_eq!(after["OrganizerUndoStack"], before["OrganizerUndoStack"]);
    drop(lock);
    assert_eq!(fs::read(locked_path).unwrap(), b"locked bytes");
}
fn setup() -> (Root, WorkspaceStore, PathBuf, PathBuf) {
    let root = Root(std::env::temp_dir().join(format!("dustdesk-session-{}", Uuid::new_v4())));
    let desktop = root.0.join("Desktop");
    fs::create_dir_all(&desktop).unwrap();
    let mut store = WorkspaceStore::open(root.0.join("Data")).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    let mut state = super::super::normalize::default_state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(false);
    state["DesktopCategories"] =
        json!([{"Id":"work","Name":"工作","IsCollapsed":false,"ItemPaths":[],"Unknown":7}]);
    store.initialize(state, "session-test").unwrap();
    let source = desktop.join("original.txt");
    fs::write(&source, b"original bytes").unwrap();
    let (_, managed) = store
        .organizer_move("work", source.to_str().unwrap())
        .unwrap();
    (root, store, desktop, PathBuf::from(managed))
}
#[test]
fn temporary_desktop_restore_retains_classification_undo_and_unknowns_then_recollects_edits_after_reopen(
) {
    let (_root, mut store, desktop, managed) = setup();
    let before = store.read().unwrap();
    assert!(store.organizer_has_items().unwrap());
    store.organizer_restore_session().unwrap();
    assert!(!managed.exists());
    let after = store.read().unwrap();
    assert_eq!(after["DesktopCategories"], before["DesktopCategories"]);
    assert_eq!(after["OrganizerUndoStack"], before["OrganizerUndoStack"]);
    let record = &after["OrganizerDesktopRestores"][0];
    assert_eq!(record["source"], managed.to_str().unwrap());
    assert!(record["ino"].is_number());
    assert!(record["NativeTree"].is_object());
    fs::write(desktop.join("original.txt"), b"edited while closed").unwrap();
    let data = store.root.clone();
    drop(store);
    let mut store = WorkspaceStore::open(data).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    store.organizer_resume_session().unwrap();
    assert_eq!(fs::read(&managed).unwrap(), b"edited while closed");
    assert!(!desktop.join("original.txt").exists());
    let resumed = store.read().unwrap();
    assert_eq!(resumed["DesktopCategories"], before["DesktopCategories"]);
    assert_eq!(resumed["OrganizerUndoStack"], before["OrganizerUndoStack"]);
    assert_eq!(resumed["OrganizerDesktopRestores"], json!([]));
    store.organizer_undo().unwrap();
    assert_eq!(
        fs::read(desktop.join("original.txt")).unwrap(),
        b"edited while closed"
    );
}
#[test]
fn same_name_files_and_directories_restore_with_safe_suffixes_and_replacements_are_never_recollected(
) {
    let (_root, mut store, desktop, managed) = setup();
    fs::write(desktop.join("original.txt"), b"unrelated").unwrap();
    let directory = desktop.join("directory.ext");
    fs::create_dir(&directory).unwrap();
    fs::write(directory.join("child"), b"nested").unwrap();
    let (_, managed_directory) = store
        .organizer_move("work", directory.to_str().unwrap())
        .unwrap();
    fs::create_dir(&directory).unwrap();
    store.organizer_restore_session().unwrap();
    assert_eq!(
        fs::read(desktop.join("original (1).txt")).unwrap(),
        b"original bytes"
    );
    assert_eq!(
        fs::read(desktop.join("directory.ext (1)/child")).unwrap(),
        b"nested"
    );
    fs::rename(
        desktop.join("original (1).txt"),
        desktop.join("kept-original.txt"),
    )
    .unwrap();
    fs::write(desktop.join("original (1).txt"), b"replacement same name").unwrap();
    store.organizer_resume_session().unwrap();
    assert!(!managed.exists());
    assert_eq!(
        fs::read(desktop.join("original (1).txt")).unwrap(),
        b"replacement same name"
    );
    assert_eq!(
        fs::read(desktop.join("original.txt")).unwrap(),
        b"unrelated"
    );
    assert_eq!(
        fs::read(PathBuf::from(managed_directory).join("child")).unwrap(),
        b"nested"
    );
    assert_eq!(store.read().unwrap()["OrganizerDesktopRestores"], json!([]));
}
#[test]
fn old_electron_identity_records_recollect_without_native_tree_and_never_overwrite_a_managed_namesake(
) {
    let (_root, mut store, desktop, managed) = setup();
    store.organizer_restore_session().unwrap();
    let mut state = store.read().unwrap();
    state["OrganizerDesktopRestores"][0]
        .as_object_mut()
        .unwrap()
        .remove("NativeTree");
    state["OrganizerDesktopRestores"][0]
        .as_object_mut()
        .unwrap()
        .remove("NativeRestoreId");
    store.write(&mut state, true).unwrap();
    store.organizer_resume_session().unwrap();
    assert_eq!(fs::read(&managed).unwrap(), b"original bytes");
    store.organizer_restore_session().unwrap();
    fs::write(&managed, b"new managed occupant").unwrap();
    store.organizer_resume_session().unwrap();
    assert_eq!(fs::read(&managed).unwrap(), b"new managed occupant");
    assert_eq!(
        fs::read(desktop.join("original.txt")).unwrap(),
        b"original bytes"
    );
}
#[test]
fn invalid_foreign_records_block_without_touching_external_files_and_metadata_failure_compensates()
{
    let (root, mut store, desktop, managed) = setup();
    let before = fs::read(store.path()).unwrap();
    if store.backup().exists() {
        fs::remove_file(store.backup()).unwrap();
    }
    fs::create_dir(store.backup()).unwrap();
    assert!(store.organizer_restore_session().is_err());
    assert_eq!(fs::read(&managed).unwrap(), b"original bytes");
    assert!(!desktop.join("original.txt").exists());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_dir(store.backup()).unwrap();
    store.organizer_restore_session().unwrap();
    let outside = root.0.join("outside.txt");
    fs::write(&outside, b"private").unwrap();
    let mut state = store.read().unwrap();
    state["OrganizerDesktopRestores"][0]["target"] = json!(outside.to_str().unwrap());
    store.write(&mut state, true).unwrap();
    assert!(store.organizer_resume_session().is_err());
    assert_eq!(fs::read(outside).unwrap(), b"private");
    assert_eq!(
        fs::read(desktop.join("original.txt")).unwrap(),
        b"original bytes"
    );
}
