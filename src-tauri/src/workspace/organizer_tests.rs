use super::*;
use serde_json::json;
struct Root(PathBuf);
impl Drop for Root {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn setup() -> (Root, WorkspaceStore, PathBuf) {
    let root = Root(std::env::temp_dir().join(format!("dustdesk-organizer-{}", Uuid::new_v4())));
    fs::create_dir(&root.0).unwrap();
    let desktop = root.0.join("Desktop");
    fs::create_dir(&desktop).unwrap();
    let mut store = WorkspaceStore::open(root.0.join("Data")).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    let mut state = super::super::normalize::default_state();
    state["Settings"]["AutomaticBackupEnabled"] = json!(false);
    state["DesktopCategories"] = json!([{"Id":"first","Name":"文档:项目","IsCollapsed":false,"ItemPaths":[],"Unknown":{"keep":7}},{"Id":"next","Name":"下一分类","IsCollapsed":true,"ItemPaths":[]}]);
    state["UnknownFileTransaction"] = json!({"keep":[1,2]});
    store.initialize(state, "organizer-test").unwrap();
    (root, store, desktop)
}
fn ticket(store: &WorkspaceStore, desktop: &Path, source: PathBuf, target: PathBuf) -> Journal {
    let mut after = match read_json(&store.path()) {
        Ok(Some(value)) => value,
        _ => panic!("missing state"),
    };
    after["OrganizerTransactionId"] = json!(Uuid::new_v4().to_string());
    let tree = Tree::read(&source).unwrap();
    Journal {
        version: 1,
        paths: Paths {
            desktop: desktop.into(),
            organizer: store.root.join("DesktopOrganizer"),
        },
        source,
        target,
        source_tree: tree.clone(),
        target_tree: tree,
        stage: None,
        rollback: None,
        desktop_position: None,
        after,
    }
}
#[test]
fn manual_collect_restore_and_persistent_undo_keep_bytes_unknown_fields_and_ownership() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("中文.bin");
    fs::write(&source, b"original bytes").unwrap();
    let (snapshot, target) = store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(&target).unwrap(), b"original bytes");
    assert_eq!(snapshot.state["DesktopCategories"][0]["Unknown"]["keep"], 7);
    assert_eq!(
        snapshot.state["UnknownFileTransaction"]["keep"],
        json!([1, 2])
    );
    assert_eq!(
        snapshot.state["DesktopCategories"][0]["ItemPaths"],
        json!([target])
    );
    let (_, restored) = store.organizer_restore("first", &target).unwrap();
    assert_eq!(Path::new(&restored), source);
    assert_eq!(fs::read(&source).unwrap(), b"original bytes");
    assert!(!Path::new(&target).exists());
    store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    let (_, undone) = store.organizer_undo().unwrap();
    assert_eq!(Path::new(&undone), source);
    assert_eq!(fs::read(source).unwrap(), b"original bytes");
    assert!(store.read().unwrap()["DesktopCategories"][0]["ItemPaths"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(!store.journal_path().exists());
}

#[test]
fn desktop_positions_survive_category_transfers_restart_renderer_saves_and_failed_restores() {
    let (root, mut store, desktop) = setup();
    let source = desktop.join("position.txt");
    fs::write(&source, b"position fixture").unwrap();
    let (_, first) = store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    let position = json!({"desktop":crate::system::path_key(desktop.to_str().unwrap()).unwrap(),"x":-120,"y":432});
    let first_key = crate::system::path_key(&first).unwrap();
    let mut state = store.read().unwrap();
    state["OrganizerDesktopPositions"] = json!({first_key.clone():position.clone()});
    store.write(&mut state, true).unwrap();
    let (_, next) = store.organizer_move("next", &first).unwrap();
    let next_key = crate::system::path_key(&next).unwrap();
    let mut draft = store.read().unwrap();
    assert_eq!(
        draft["OrganizerDesktopPositions"],
        json!({next_key.clone():position.clone()})
    );
    let previous = draft.clone();
    draft["OrganizerDesktopPositions"] = json!({});
    store.save(draft, Some(previous), "position-test").unwrap();
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"][&next_key],
        position
    );
    drop(store);
    let mut store = WorkspaceStore::open(root.0.join("Data")).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    let (_, undone) = store.organizer_undo().unwrap();
    assert_eq!(undone, first);
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"][&first_key],
        position
    );
    fs::write(&source, b"collision").unwrap();
    assert!(store.organizer_restore("first", &first).is_err());
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"][&first_key],
        position
    );
    fs::remove_file(&source).unwrap();
    fs::remove_file(store.path().with_extension("json.bak")).unwrap();
    fs::create_dir(store.path().with_extension("json.bak")).unwrap();
    assert!(store.organizer_restore("first", &first).is_err());
    assert_eq!(fs::read(&first).unwrap(), b"position fixture");
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"][&first_key],
        position
    );
    fs::remove_dir(store.path().with_extension("json.bak")).unwrap();
    store.organizer_restore("first", &first).unwrap();
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"],
        json!({})
    );
    assert_eq!(fs::read(source).unwrap(), b"position fixture");
}

#[test]
fn session_restore_retains_positions_for_recollection_without_explorer() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("session-position.txt");
    fs::write(&source, b"session fixture").unwrap();
    let (_, collected) = store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    let collected_key = crate::system::path_key(&collected).unwrap();
    let position = json!({"desktop":crate::system::path_key(desktop.to_str().unwrap()).unwrap(),"x":320,"y":240});
    let mut state = store.read().unwrap();
    state["OrganizerDesktopPositions"] = json!({collected_key.clone():position.clone()});
    store.write(&mut state, true).unwrap();
    store.organizer_restore_session().unwrap();
    assert!(source.exists());
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"][&collected_key],
        position
    );
    store.organizer_resume_session().unwrap();
    assert!(Path::new(&collected).exists());
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"][&collected_key],
        position
    );
    store.organizer_undo().unwrap();
    assert!(source.exists());
    assert_eq!(
        store.read().unwrap()["OrganizerDesktopPositions"],
        json!({})
    );
}

#[cfg(windows)]
#[test]
#[ignore = "Uses uniquely named fixture icons on the actual Explorer desktop"]
fn explorer_positions_roundtrip_files_folders_restart_undo_and_exit_restore() {
    use crate::desktop_positions;
    use std::time::{Duration, Instant};
    use windows::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Desktop, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
    };
    let desktop = unsafe {
        let value = SHGetKnownFolderPath(&FOLDERID_Desktop, KF_FLAG_DEFAULT, None).unwrap();
        let path = PathBuf::from(value.to_string().unwrap());
        CoTaskMemFree(Some(value.0.cast()));
        path
    };
    let capture = |path: &Path| {
        let end = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(position) = desktop_positions::capture(&desktop, path) {
                break position;
            }
            assert!(
                Instant::now() < end,
                "Explorer did not enumerate the fixture icon: {}",
                path.display()
            );
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    for directory in [false, true] {
        let (root, mut store, _) = setup();
        store.organizer_desktop = Some(desktop.clone());
        let source = desktop.join(format!(
            "dustdesk-position-fixture-{}{}",
            Uuid::new_v4(),
            if directory { "" } else { ".txt" }
        ));
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                if self.0.is_dir() {
                    let _ = fs::remove_dir_all(&self.0);
                } else {
                    let _ = fs::remove_file(&self.0);
                }
            }
        }
        let _fixture = Fixture(source.clone());
        if directory {
            fs::create_dir(&source).unwrap();
            fs::write(source.join("content.txt"), b"keep folder content").unwrap();
        } else {
            fs::write(&source, b"keep file content").unwrap();
        }
        let original = capture(&source);
        let (_, first) = store
            .organizer_move("first", source.to_str().unwrap())
            .unwrap();
        assert_eq!(
            store.read().unwrap()["OrganizerDesktopPositions"]
                [crate::system::path_key(&first).unwrap()],
            json!(original)
        );
        let (_, next) = store.organizer_move("next", &first).unwrap();
        drop(store);
        let mut store = WorkspaceStore::open(root.0.join("Data")).unwrap();
        store.organizer_desktop = Some(desktop.clone());
        store.organizer_restore("next", &next).unwrap();
        assert_eq!(
            capture(&source),
            original,
            "manual restore must recover the exact coordinates"
        );
        store
            .organizer_move("first", source.to_str().unwrap())
            .unwrap();
        store.organizer_undo().unwrap();
        assert_eq!(
            capture(&source),
            original,
            "undo must recover the exact coordinates"
        );
        let (_, collected) = store
            .organizer_move("first", source.to_str().unwrap())
            .unwrap();
        // Exercise renamed restoration when the original name is occupied.
        fs::write(&source, b"unrelated collision").unwrap();
        store.organizer_restore_session().unwrap();
        let state = store.read().unwrap();
        let restored = PathBuf::from(
            state["OrganizerDesktopRestores"][0]["target"]
                .as_str()
                .unwrap(),
        );
        let _renamed_fixture = Fixture(restored.clone());
        assert_ne!(restored, source);
        assert_eq!(
            capture(&restored),
            original,
            "exit restore must recover coordinates even after a name collision"
        );
        assert_eq!(fs::read(&source).unwrap(), b"unrelated collision");
        store.organizer_resume_session().unwrap();
        assert!(Path::new(&collected).exists());
        assert!(!restored.exists());
        fs::remove_file(&source).unwrap();
        store.organizer_undo().unwrap();
        assert_eq!(capture(&source), original);
        let content = if directory {
            source.join("content.txt")
        } else {
            source.clone()
        };
        assert_eq!(
            fs::read(content).unwrap(),
            if directory {
                b"keep folder content".as_slice()
            } else {
                b"keep file content".as_slice()
            }
        );
        println!(
            "verified Explorer {} at ({}, {})",
            if directory { "folder" } else { "file" },
            original.x,
            original.y
        );
    }
}
#[test]
fn category_transfer_undo_restores_deleted_category_with_its_unknown_fields() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("entry.txt");
    fs::write(&source, b"content").unwrap();
    let (_, first) = store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    let (_, next) = store.organizer_move("next", &first).unwrap();
    let mut state = store.read().unwrap();
    state["DesktopCategories"]
        .as_array_mut()
        .unwrap()
        .retain(|category| category["Id"] != "first");
    store.write(&mut state, true).unwrap();
    let (snapshot, restored) = store.organizer_undo().unwrap();
    assert_eq!(restored, first);
    assert!(!Path::new(&next).exists());
    let category = snapshot.state["DesktopCategories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|category| category["Id"] == "first")
        .unwrap();
    assert_eq!(category["Unknown"]["keep"], 7);
    assert_eq!(category["ItemPaths"], json!([first]));
}
#[test]
fn metadata_failure_rolls_back_a_same_volume_move_without_losing_source_or_advancing_undo() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("keep.txt");
    fs::write(&source, b"keep").unwrap();
    let before = fs::read(store.path()).unwrap();
    if store.backup().exists() {
        fs::remove_file(store.backup()).unwrap();
    }
    fs::create_dir(store.backup()).unwrap();
    assert!(store
        .organizer_move("first", source.to_str().unwrap())
        .is_err());
    assert_eq!(fs::read(&source).unwrap(), b"keep");
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(!store.journal_path().exists());
    assert!(!store
        .root
        .join("DesktopOrganizer/文档_项目/keep.txt")
        .exists());
}
#[test]
fn collisions_invalid_roots_and_unowned_sources_do_not_move_or_overwrite_anything() {
    let (root, mut store, desktop) = setup();
    let source = desktop.join("same.txt");
    fs::write(&source, b"source").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/same.txt");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    fs::write(&target, b"target").unwrap();
    let before = fs::read(store.path()).unwrap();
    assert!(store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap_err()
        .contains("同名"));
    assert!(store
        .organizer_move("first", root.0.to_str().unwrap())
        .is_err());
    assert!(store
        .organizer_move("missing", source.to_str().unwrap())
        .is_err());
    assert!(store
        .organizer_restore("next", target.to_str().unwrap())
        .is_err());
    let managed = store.root.clone();
    assert!(store
        .organizer_move("first", managed.to_str().unwrap())
        .is_err());
    assert_eq!(fs::read(source).unwrap(), b"source");
    assert_eq!(fs::read(target).unwrap(), b"target");
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(!store.journal_path().exists());
}
#[test]
fn forced_copy_moves_a_recursive_tree_only_after_content_and_identity_validation() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("directory");
    fs::create_dir_all(source.join("子目录/空目录")).unwrap();
    fs::write(source.join("子目录/内容.bin"), [0, 1, 2, 255]).unwrap();
    fs::write(source.join("empty"), []).unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/directory");
    let mut after = store.read().unwrap();
    after["DesktopCategories"][0]["ItemPaths"] = json!([target]);
    store
        .organizer_transaction(&desktop, source.clone(), target.clone(), after, true)
        .unwrap();
    assert!(!source.exists());
    assert_eq!(
        fs::read(target.join("子目录/内容.bin")).unwrap(),
        [0, 1, 2, 255]
    );
    assert!(target.join("子目录/空目录").is_dir());
    assert_eq!(fs::metadata(target.join("empty")).unwrap().len(), 0);
    assert!(!store.journal_path().exists());
}
#[test]
fn forced_copy_metadata_failure_keeps_the_complete_tree_and_compensates_when_reverse_rename_is_possible(
) {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("directory");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("data"), b"bytes").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/directory");
    let after = store.read().unwrap();
    if store.backup().exists() {
        fs::remove_file(store.backup()).unwrap();
    }
    fs::create_dir(store.backup()).unwrap();
    assert!(store
        .organizer_transaction(&desktop, source.clone(), target.clone(), after, true)
        .is_err());
    assert_eq!(fs::read(source.join("data")).unwrap(), b"bytes");
    assert!(!target.exists());
    assert!(!store.journal_path().exists());
}
#[test]
fn restart_rolls_back_an_uncommitted_move_and_clears_a_committed_journal_without_reversing_it() {
    let (_root, store, desktop) = setup();
    let source = desktop.join("crash.txt");
    fs::write(&source, b"recover").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/crash.txt");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let journal = ticket(&store, &desktop, source.clone(), target.clone());
    store.put_journal(&journal, true).unwrap();
    files::rename(&source, &target).unwrap();
    let data = store.root.clone();
    drop(store);
    let mut store = WorkspaceStore::open(data).unwrap();
    store.organizer_desktop = Some(desktop.clone());
    store.read().unwrap();
    assert_eq!(fs::read(&source).unwrap(), b"recover");
    assert!(!target.exists());
    assert!(!store.journal_path().exists());
    let journal = ticket(&store, &desktop, source.clone(), target.clone());
    store.put_journal(&journal, true).unwrap();
    files::rename(&source, &target).unwrap();
    let mut after = journal.after.clone();
    store.write(&mut after, true).unwrap();
    store.read().unwrap();
    assert!(!source.exists());
    assert_eq!(fs::read(target).unwrap(), b"recover");
    assert!(!store.journal_path().exists());
}
#[test]
fn prepared_noop_metadata_is_not_mistaken_for_committed_and_replacement_identities_are_not_recollected(
) {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("crash.txt");
    fs::write(&source, b"same bytes").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/crash.txt");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let journal = ticket(&store, &desktop, source.clone(), target.clone());
    store.put_journal(&journal, true).unwrap();
    store.recover_organizer().unwrap();
    assert_eq!(fs::read(&source).unwrap(), b"same bytes");
    store.put_journal(&journal, true).unwrap();
    files::rename(&source, &target).unwrap();
    fs::rename(&target, target.with_extension("original")).unwrap();
    fs::write(&target, b"same bytes").unwrap();
    assert!(store.recover_organizer().is_err());
    assert!(!source.exists());
    assert_eq!(fs::read(target).unwrap(), b"same bytes");
    assert!(store.journal_path().exists());
}
#[test]
fn corrupt_or_foreign_desktop_journals_block_reads_without_overwriting_workspace_or_external_files()
{
    let (root, mut store, desktop) = setup();
    let before = fs::read(store.path()).unwrap();
    fs::write(store.journal_path(), b"not json").unwrap();
    assert!(store.read().is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    fs::remove_file(store.journal_path()).unwrap();
    let source = desktop.join("file");
    fs::write(&source, b"source").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/file");
    let mut journal = ticket(&store, &desktop, source.clone(), target);
    journal.paths.desktop = root.0.join("outside");
    assert!(store.put_journal(&journal, true).is_err());
    assert_eq!(fs::read(source).unwrap(), b"source");
    assert_eq!(fs::read(store.path()).unwrap(), before);
}
#[test]
fn staged_or_duplicate_copies_are_removed_only_when_their_saved_identity_and_complete_source_match()
{
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("data");
    fs::write(&source, b"preserve").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/data");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let mut journal = ticket(&store, &desktop, source.clone(), target.clone());
    let stage = target
        .parent()
        .unwrap()
        .join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    fs::create_dir(&stage).unwrap();
    journal.stage = Some(stage.clone());
    journal.target_tree =
        files::copy(&source, &stage.join("payload"), &journal.source_tree).unwrap();
    store.put_journal(&journal, true).unwrap();
    store.recover_organizer().unwrap();
    assert_eq!(fs::read(&source).unwrap(), b"preserve");
    assert!(!stage.exists());
    let mut journal = ticket(&store, &desktop, source.clone(), target.clone());
    journal.target_tree = files::copy(&source, &target, &journal.source_tree).unwrap();
    store.put_journal(&journal, true).unwrap();
    store.recover_organizer().unwrap();
    assert_eq!(fs::read(source).unwrap(), b"preserve");
    assert!(!target.exists());
}
#[test]
fn an_unidentified_partial_stage_is_retained_instead_of_deleting_new_or_changed_files() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("data");
    fs::write(&source, b"source").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/data");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let mut journal = ticket(&store, &desktop, source.clone(), target);
    let stage = journal
        .target
        .parent()
        .unwrap()
        .join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    fs::create_dir(&stage).unwrap();
    fs::write(stage.join("payload"), b"partial or changed").unwrap();
    journal.stage = Some(stage.clone());
    store.put_journal(&journal, true).unwrap();
    assert!(store.recover_organizer().is_err());
    assert_eq!(fs::read(source).unwrap(), b"source");
    assert_eq!(
        fs::read(stage.join("payload")).unwrap(),
        b"partial or changed"
    );
    assert!(store.journal_path().exists());
}

#[test]
fn tampered_tree_paths_and_missing_parents_never_authorize_external_cleanup() {
    let (_root, store, desktop) = setup();
    let source = desktop.join("data");
    fs::write(&source, b"source").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/data");
    let original = ticket(&store, &desktop, source.clone(), target);
    let node = original.source_tree.0[""].clone();
    for relative in [
        "../outside",
        "C:/outside",
        "child/../outside",
        "file:stream",
    ] {
        let mut journal = original.clone();
        journal.target_tree.0.insert(relative.into(), node.clone());
        assert!(store.put_journal(&journal, true).is_err());
    }
    assert!(!store.journal_path().exists());
    assert_eq!(fs::read(source).unwrap(), b"source");
}

#[test]
fn pending_recovery_blocks_backup_restore_and_old_renderer_cannot_change_the_transaction_marker() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("data");
    fs::write(&source, b"source").unwrap();
    let (snapshot, _) = store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    let marker = snapshot.state["OrganizerTransactionId"].clone();
    let mut draft = snapshot.state.clone();
    draft["OrganizerTransactionId"] = json!("renderer-marker");
    super::super::preserve_owned_state(&snapshot.state, &mut draft).unwrap();
    assert_eq!(draft["OrganizerTransactionId"], marker);
    fs::write(store.journal_path(), b"corrupt recovery").unwrap();
    let before = fs::read(store.path()).unwrap();
    assert!(store.restore_backup(None, None).is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
}

#[test]
fn atomic_rename_never_replaces_a_destination_created_after_preflight() {
    let (_root, _store, desktop) = setup();
    let source = desktop.join("source");
    let target = desktop.join("target");
    fs::write(&source, b"source").unwrap();
    fs::write(&target, b"competitor").unwrap();
    assert!(files::rename(&source, &target).is_err());
    assert_eq!(fs::read(source).unwrap(), b"source");
    assert_eq!(fs::read(target).unwrap(), b"competitor");
}

#[cfg(windows)]
#[test]
fn an_exclusively_locked_source_fails_before_metadata_or_journal_publication_and_can_retry() {
    use std::os::windows::fs::OpenOptionsExt;
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("locked");
    fs::write(&source, b"keep").unwrap();
    let before = fs::read(store.path()).unwrap();
    let locked = OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&source)
        .unwrap();
    assert!(store
        .organizer_move("first", source.to_str().unwrap())
        .is_err());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(!store.journal_path().exists());
    drop(locked);
    assert_eq!(fs::read(&source).unwrap(), b"keep");
    assert!(store
        .organizer_move("first", source.to_str().unwrap())
        .is_ok());
}

#[test]
fn partial_source_cleanup_never_discards_the_only_complete_target_copy() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("directory");
    fs::create_dir(&source).unwrap();
    fs::write(source.join("first"), b"one").unwrap();
    fs::write(source.join("second"), b"two").unwrap();
    let target = store.root.join("DesktopOrganizer/文档_项目/directory");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let mut journal = ticket(&store, &desktop, source.clone(), target.clone());
    journal.target_tree = files::copy(&source, &target, &journal.source_tree).unwrap();
    store.put_journal(&journal, true).unwrap();
    fs::remove_file(source.join("first")).unwrap();
    assert!(store.recover_organizer().is_err());
    assert_eq!(fs::read(target.join("first")).unwrap(), b"one");
    assert_eq!(fs::read(target.join("second")).unwrap(), b"two");
    assert_eq!(fs::read(source.join("second")).unwrap(), b"two");
    assert!(store.journal_path().exists());
}

#[test]
fn pre_epoch_file_dates_are_retained_and_do_not_overflow_identity_checks() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("old-file");
    fs::write(&source, b"old bytes").unwrap();
    let date = std::time::UNIX_EPOCH - std::time::Duration::from_secs(365 * 24 * 60 * 60);
    let file = fs::File::options().write(true).open(&source).unwrap();
    file.set_times(fs::FileTimes::new().set_modified(date))
        .unwrap();
    drop(file);
    let (_, target) = store
        .organizer_move("first", source.to_str().unwrap())
        .unwrap();
    assert_eq!(fs::metadata(&target).unwrap().modified().unwrap(), date);
    assert_eq!(fs::read(target).unwrap(), b"old bytes");
}

fn reverse_fixture() -> (Root, WorkspaceStore, PathBuf, Journal) {
    let (root, store, desktop) = setup();
    let source = desktop.join("reverse-directory");
    fs::create_dir_all(source.join("nested/empty")).unwrap();
    fs::write(source.join("nested/data"), b"complete original bytes").unwrap();
    fs::write(source.join("zero"), []).unwrap();
    let target = store
        .root
        .join("DesktopOrganizer/文档_项目/reverse-directory");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let mut journal = ticket(&store, &desktop, source.clone(), target);
    journal.target_tree = files::copy(&source, &journal.target, &journal.source_tree).unwrap();
    journal.source_tree.remove_exact(&source).unwrap();
    let stage = journal
        .target
        .parent()
        .unwrap()
        .join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    fs::create_dir(&stage).unwrap();
    journal.stage = Some(stage);
    (root, store, desktop, journal)
}

#[test]
fn reverse_copy_compensation_restores_full_bytes_before_discarding_the_failed_target() {
    let (_root, mut store, _desktop, mut journal) = reverse_fixture();
    let before = fs::read(store.path()).unwrap();
    store.put_journal(&journal, true).unwrap();
    store.begin_reverse_copy(&mut journal).unwrap();
    assert_eq!(
        fs::read(journal.source.join("nested/data")).unwrap(),
        b"complete original bytes"
    );
    assert!(journal.source.join("nested/empty").is_dir());
    assert_eq!(fs::read(store.path()).unwrap(), before);
    assert!(!journal.target.exists());
    assert!(!journal.stage.unwrap().exists());
    assert!(!journal.rollback.unwrap().stage.exists());
    assert!(!store.journal_path().exists());
}

#[test]
fn reverse_copy_restart_resumes_each_durable_boundary_without_overwriting_metadata() {
    for phase in 0..6 {
        let (_root, store, desktop, mut journal) = reverse_fixture();
        let before = fs::read(store.path()).unwrap();
        let stage = desktop.join(format!(".dustdesk-move-{}", Uuid::new_v4()));
        journal.rollback = Some(Rollback {
            stage: stage.clone(),
            tree: None,
        });
        if phase >= 1 {
            fs::create_dir(&stage).unwrap();
        }
        if phase >= 2 {
            let tree = files::copy(
                &journal.target,
                &stage.join("payload"),
                &journal.target_tree,
            )
            .unwrap();
            journal.rollback.as_mut().unwrap().tree = Some(tree);
        }
        if phase >= 3 {
            files::rename(&stage.join("payload"), &journal.source).unwrap();
        }
        if phase >= 4 {
            journal.target_tree.remove_exact(&journal.target).unwrap();
        }
        if phase >= 5 {
            fs::remove_dir(&stage).unwrap();
        }
        store.put_journal(&journal, true).unwrap();
        let data = store.root.clone();
        drop(store);
        let mut reopened = WorkspaceStore::open(data).unwrap();
        reopened.organizer_desktop = Some(desktop);
        reopened
            .read()
            .unwrap_or_else(|error| panic!("phase {phase}: {error}"));
        assert_eq!(
            fs::read(journal.source.join("nested/data")).unwrap(),
            b"complete original bytes",
            "phase {phase}"
        );
        assert!(journal.source.join("nested/empty").is_dir());
        assert_eq!(fs::metadata(journal.source.join("zero")).unwrap().len(), 0);
        assert_eq!(fs::read(reopened.path()).unwrap(), before);
        assert!(!journal.target.exists());
        assert!(!stage.exists());
        assert!(!reopened.journal_path().exists());
    }
}

#[test]
fn reverse_copy_collisions_unidentified_partial_copies_and_replaced_copies_are_retained() {
    for phase in 0..3 {
        let (_root, mut store, desktop, mut journal) = reverse_fixture();
        let stage = desktop.join(format!(".dustdesk-move-{}", Uuid::new_v4()));
        fs::create_dir(&stage).unwrap();
        journal.rollback = Some(Rollback {
            stage: stage.clone(),
            tree: None,
        });
        if phase == 0 {
            fs::write(&journal.source, b"new unrelated file").unwrap();
        } else if phase == 1 {
            fs::write(stage.join("payload"), b"unidentified partial data").unwrap();
        } else {
            let tree = files::copy(
                &journal.target,
                &stage.join("payload"),
                &journal.target_tree,
            )
            .unwrap();
            journal.rollback.as_mut().unwrap().tree = Some(tree);
            files::rename(&stage.join("payload"), &stage.join("old-payload")).unwrap();
            files::copy(
                &journal.target,
                &stage.join("payload"),
                &journal.target_tree,
            )
            .unwrap();
        }
        store.put_journal(&journal, true).unwrap();
        assert!(store.read().is_err(), "phase {phase}");
        assert!(journal.target_tree.matches(&journal.target));
        assert!(store.journal_path().exists());
        if phase == 0 {
            assert_eq!(fs::read(&journal.source).unwrap(), b"new unrelated file");
        } else {
            assert!(stage.join("payload").exists());
        }
    }
}

#[test]
fn reverse_copy_does_not_delete_changed_targets_or_accept_foreign_stages_and_overlapping_paths() {
    let (_root, mut store, desktop, mut journal) = reverse_fixture();
    let stage = desktop.join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    fs::create_dir(&stage).unwrap();
    let tree = files::copy(
        &journal.target,
        &stage.join("payload"),
        &journal.target_tree,
    )
    .unwrap();
    files::rename(&stage.join("payload"), &journal.source).unwrap();
    journal.rollback = Some(Rollback {
        stage: stage.clone(),
        tree: Some(tree),
    });
    store.put_journal(&journal, true).unwrap();
    fs::write(journal.target.join("nested/data"), b"new target content").unwrap();
    assert!(store.read().is_err());
    assert_eq!(
        fs::read(journal.source.join("nested/data")).unwrap(),
        b"complete original bytes"
    );
    assert_eq!(
        fs::read(journal.target.join("nested/data")).unwrap(),
        b"new target content"
    );
    assert!(store.journal_path().exists());
    journal.rollback.as_mut().unwrap().stage = store
        .root
        .join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    assert!(store.put_journal(&journal, false).is_err());
    journal.rollback = None;
    journal.target = journal.source.clone();
    assert!(store.put_journal(&journal, false).is_err());
    journal.target = journal.source.join("nested");
    assert!(store.put_journal(&journal, false).is_err());
}

#[test]
fn old_version_one_journals_without_reverse_copy_fields_still_recover() {
    let (_root, mut store, desktop) = setup();
    let source = desktop.join("old-journal-file");
    fs::write(&source, b"old journal bytes").unwrap();
    let target = store
        .root
        .join("DesktopOrganizer/文档_项目/old-journal-file");
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let journal = ticket(&store, &desktop, source.clone(), target.clone());
    let mut serialized = serde_json::to_value(&journal).unwrap();
    serialized.as_object_mut().unwrap().remove("rollback");
    fs::write(
        store.journal_path(),
        serde_json::to_vec(&serialized).unwrap(),
    )
    .unwrap();
    files::rename(&source, &target).unwrap();
    store.read().unwrap();
    assert_eq!(fs::read(source).unwrap(), b"old journal bytes");
    assert!(!target.exists());
    assert!(!store.journal_path().exists());
}

#[test]
fn session_restore_crashes_before_or_after_identity_sealing_keep_only_the_committed_direction() {
    for phase in 0..3 {
        let (_root, mut store, desktop) = setup();
        let source = desktop.join("session-crash.txt");
        fs::write(&source, b"session crash bytes").unwrap();
        let (_, managed) = store
            .organizer_move("first", source.to_str().unwrap())
            .unwrap();
        let managed = PathBuf::from(managed);
        let mut journal = ticket(&store, &desktop, managed.clone(), source.clone());
        let id = Uuid::new_v4().to_string();
        journal.after["OrganizerDesktopRestores"] = json!([{"source":managed.to_str().unwrap(),"target":source.to_str().unwrap(),"categoryId":"first","NativeRestoreId":id}]);
        super::super::organizer_session::seal_restore(
            &mut journal.after,
            &id,
            &journal.source_tree,
        )
        .unwrap();
        store.put_journal(&journal, true).unwrap();
        files::rename(&managed, &source).unwrap();
        if phase >= 1 {
            super::super::organizer_session::seal_restore(
                &mut journal.after,
                &id,
                &journal.target_tree,
            )
            .unwrap();
            store.put_journal(&journal, false).unwrap();
        }
        if phase == 2 {
            store.write(&mut journal.after.clone(), true).unwrap();
        }
        let data = store.root.clone();
        drop(store);
        let mut store = WorkspaceStore::open(data).unwrap();
        store.organizer_desktop = Some(desktop.clone());
        store.recover_organizer().unwrap();
        assert_eq!(source.exists(), phase == 2);
        assert_eq!(managed.exists(), phase != 2);
        assert!(!store.journal_path().exists());
        let state = store.read().unwrap();
        assert_eq!(fs::read(managed).unwrap(), b"session crash bytes");
        assert!(!source.exists());
        if phase == 2 {
            assert_eq!(state["OrganizerDesktopRestores"], json!([]));
        }
    }
}

#[test]
fn stages_must_never_alias_original_or_destination_even_with_a_valid_temporary_name() {
    let (_root, store, desktop) = setup();
    let source = desktop.join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    fs::create_dir(&source).unwrap();
    let target = store
        .root
        .join("DesktopOrganizer/文档_项目")
        .join(format!(".dustdesk-move-{}", Uuid::new_v4()));
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let mut journal = ticket(&store, &desktop, source.clone(), target.clone());
    journal.stage = Some(target.clone());
    assert!(store
        .put_journal(&journal, true)
        .unwrap_err()
        .contains("重叠"));
    journal.stage = None;
    journal.rollback = Some(Rollback {
        stage: source.clone(),
        tree: Some(journal.source_tree.clone()),
    });
    assert!(store
        .put_journal(&journal, true)
        .unwrap_err()
        .contains("重叠"));
    assert!(source.is_dir());
    assert!(!store.journal_path().exists());
}
