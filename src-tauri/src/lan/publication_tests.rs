use super::super::{files::tests::Fixture, protocol::fingerprint};
use super::*;
use serde_json::json;

fn setup(fixture: &Fixture) -> (StateStore, Arc<Directory>, String) {
    let profile = fixture.0.join("profile");
    std::fs::create_dir(&profile).unwrap();
    let download = fixture.0.join("download");
    std::fs::create_dir(&download).unwrap();
    let root = Directory::open(&download).unwrap();
    let staging = root.child(".dustdesk-part-transfer", true).unwrap();
    let id = format!("{}-transfer", "a".repeat(64));
    let state = State::parse(&serde_json::to_vec(&json!({"tasks":[{
        "view":{"id":id,"direction":"receive","device":"old","name":"files","total":3,"done":3,"speed":0,"status":"waiting","directory":download},
        "peer":{"id":"peer","name":"old","fingerprint":"a".repeat(64),"address":"127.0.0.1","port":12345,"lastSeen":1},
        "manifest":{"id":"transfer","name":"files","entries":[{"relative":"nested/中文.txt","size":3,"mtime":0,"hash":fingerprint(b"abc")}],"directories":["nested","nested/empty"]},
        "staging":staging.path(),"files":{},"token":"secret-that-must-not-persist"
    }]})).unwrap()).unwrap();
    let mut store = StateStore::open(&profile).unwrap();
    store.commit(state).unwrap();
    let mut file = staging.create("0.part").unwrap();
    file.append(0, b"abc", 3, &CancellationToken::new())
        .unwrap();
    (store, root, id)
}
fn part(root: &Arc<Directory>) -> OwnedFile {
    root.child(".dustdesk-part-transfer", false)
        .unwrap()
        .part("0.part")
        .unwrap()
}

#[test]
fn persisted_intent_recovers_before_rename_and_after_rename_without_duplicate() {
    for after_rename in [false, true] {
        let fixture = Fixture::new();
        let (mut store, root, id) = setup(&fixture);
        let cancel = CancellationToken::new();
        let mut pending =
            Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).unwrap();
        if after_rename {
            pending.rename(&mut store, &cancel).unwrap();
        }
        drop(pending);
        drop(store);
        let saved = std::fs::read_to_string(fixture.0.join("profile/state.json")).unwrap();
        assert!(saved.contains(JOURNAL));
        assert!(!saved.contains("secret-that"));
        let mut store = StateStore::open(&fixture.0.join("profile")).unwrap();
        let final_path = recover(&mut store, &id, root.clone(), &cancel)
            .unwrap()
            .unwrap();
        assert_eq!(std::fs::read(final_path).unwrap(), b"abc");
        assert!(!root.path().join(".dustdesk-part-transfer/0.part").exists());
        assert_eq!(
            std::fs::read_dir(root.path().join("nested"))
                .unwrap()
                .count(),
            1
        );
        assert!(recover(&mut store, &id, root.clone(), &cancel)
            .unwrap()
            .is_none());
        assert!(
            !std::fs::read_to_string(fixture.0.join("profile/state.json"))
                .unwrap()
                .contains(JOURNAL)
        );
    }
}

#[test]
fn mapping_save_failure_keeps_intent_and_recovery_adopts_exact_published_identity() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let (mut store, root, id) = setup(&fixture);
    let cancel = CancellationToken::new();
    let mut pending =
        Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).unwrap();
    pending.rename(&mut store, &cancel).unwrap();
    let blocker = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(fixture.0.join("profile/state.json"))
        .unwrap();
    assert!(pending.commit(&mut store).is_err());
    assert!(store.state().tasks[0].files.as_ref().unwrap().is_empty());
    assert!(decode(&store.state().tasks[0]).unwrap().is_some());
    drop(blocker);
    drop(store);
    let mut store = StateStore::open(&fixture.0.join("profile")).unwrap();
    recover(&mut store, &id, root.clone(), &cancel)
        .unwrap()
        .unwrap();
    assert_eq!(
        std::fs::read_dir(root.path().join("nested"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn collision_is_journaled_before_rename_and_never_overwrites_existing_file() {
    let fixture = Fixture::new();
    let (mut store, root, id) = setup(&fixture);
    let cancel = CancellationToken::new();
    root.child("nested", true).unwrap();
    std::fs::write(root.path().join("nested/中文.txt"), b"keep0").unwrap();
    std::fs::write(root.path().join("nested/中文-1.txt"), b"keep1").unwrap();
    let path = Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel)
        .unwrap()
        .finish(&mut store, &cancel)
        .unwrap();
    assert_eq!(Path::new(&path).file_name().unwrap(), "中文-2.txt");
    assert_eq!(
        std::fs::read(root.path().join("nested/中文.txt")).unwrap(),
        b"keep0"
    );
    assert_eq!(
        std::fs::read(root.path().join("nested/中文-1.txt")).unwrap(),
        b"keep1"
    );
}

#[test]
fn changed_identity_is_not_adopted_even_when_bytes_are_identical() {
    let fixture = Fixture::new();
    let (mut store, root, id) = setup(&fixture);
    let cancel = CancellationToken::new();
    let mut pending =
        Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).unwrap();
    pending.rename(&mut store, &cancel).unwrap();
    drop(pending);
    std::fs::rename(
        root.path().join("nested/中文.txt"),
        root.path().join("nested/retained.txt"),
    )
    .unwrap();
    std::fs::write(root.path().join("nested/中文.txt"), b"abc").unwrap();
    assert!(recover(&mut store, &id, root.clone(), &cancel).is_err());
    assert!(decode(&store.state().tasks[0]).unwrap().is_some());
    assert!(store.state().tasks[0].files.as_ref().unwrap().is_empty());
    assert_eq!(
        std::fs::read(root.path().join("nested/retained.txt")).unwrap(),
        b"abc"
    );
}

#[test]
fn canceled_or_bad_hash_never_publishes_and_journal_cannot_escape_confirmed_root() {
    let fixture = Fixture::new();
    let (mut store, root, id) = setup(&fixture);
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).is_err());
    assert!(decode(&store.state().tasks[0]).unwrap().is_none());
    std::fs::write(root.path().join(".dustdesk-part-transfer/0.part"), b"bad").unwrap();
    let cancel = CancellationToken::new();
    assert!(Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).is_err());
    assert!(decode(&store.state().tasks[0]).unwrap().is_none());
    std::fs::write(root.path().join(".dustdesk-part-transfer/0.part"), b"abc").unwrap();
    drop(Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).unwrap());
    for key in ["candidate", "hash", "index"] {
        let mut state = store.state().clone();
        let original = state.clone();
        state.tasks[0].extra.get_mut(JOURNAL).unwrap()[key] = match key {
            "candidate" => json!("../escaped.txt"),
            "hash" => json!("b".repeat(64)),
            _ => json!(999),
        };
        store.commit(state).unwrap();
        assert!(recover(&mut store, &id, root.clone(), &cancel).is_err());
        store.commit(original).unwrap();
    }
    assert!(!fixture.0.join("escaped.txt").exists());
    recover(&mut store, &id, root, &cancel).unwrap();
}

fn legacy_link(root: &Arc<Directory>, relative: &str) -> std::path::PathBuf {
    let (parent, name) = root.parent_for(relative, true).unwrap();
    let target = parent.path().join(name);
    std::fs::hard_link(root.path().join(".dustdesk-part-transfer/0.part"), &target).unwrap();
    target
}

#[test]
fn legacy_link_before_or_after_mapping_save_recovers_without_duplicate_or_overwrite() {
    for mapped in [false, true] {
        for collision in [0, 2] {
            let fixture = Fixture::new();
            let (mut store, root, id) = setup(&fixture);
            if collision == 2 {
                root.child("nested/中文.txt", true).unwrap();
                std::fs::write(root.path().join("nested/中文-1.txt"), b"keep").unwrap();
            }
            let relative =
                candidate(&store.state().tasks[0].manifest.entries[0], collision).unwrap();
            let target = legacy_link(&root, &relative);
            if mapped {
                let mut state = store.state().clone();
                state.tasks[0]
                    .files
                    .as_mut()
                    .unwrap()
                    .insert("0".into(), json!(target));
                store.commit(state).unwrap();
            }
            assert!(root
                .parent_for(&relative, false)
                .unwrap()
                .0
                .read(target.file_name().unwrap().to_str().unwrap())
                .is_err());
            let result = recover(&mut store, &id, root.clone(), &CancellationToken::new())
                .unwrap()
                .unwrap();
            assert_eq!(Path::new(&result), target);
            assert_eq!(std::fs::read(&target).unwrap(), b"abc");
            assert!(!root.path().join(".dustdesk-part-transfer/0.part").exists());
            assert!(decode(&store.state().tasks[0]).unwrap().is_none());
            assert_eq!(
                store.state().tasks[0].files.as_ref().unwrap()["0"],
                json!(target)
            );
            assert!(
                recover(&mut store, &id, root.clone(), &CancellationToken::new())
                    .unwrap()
                    .is_none()
            );
            assert_eq!(
                std::fs::read_dir(root.path().join("nested"))
                    .unwrap()
                    .count(),
                collision + 1
            );
            if collision == 2 {
                assert!(root.path().join("nested/中文.txt").is_dir());
                assert_eq!(
                    std::fs::read(root.path().join("nested/中文-1.txt")).unwrap(),
                    b"keep"
                );
            }
        }
    }
}

#[test]
fn legacy_alias_proof_blocks_actual_write_rename_and_delete_through_target() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let (_store, root, _id) = setup(&fixture);
    let target = legacy_link(&root, "nested/中文.txt");
    let directory = root.child(".dustdesk-part-transfer", false).unwrap();
    let part = directory.legacy_part("0.part").unwrap().unwrap();
    let pin = root
        .child("nested", false)
        .unwrap()
        .legacy_target("中文.txt")
        .unwrap();
    assert_eq!(pin.identity(), part.identity());
    assert!(std::fs::OpenOptions::new()
        .write(true)
        .share_mode(1 | 2 | 4)
        .open(&target)
        .is_err());
    assert!(std::fs::rename(&target, root.path().join("moved.txt")).is_err());
    assert!(std::fs::remove_file(&target).is_err());
    drop(part);
    drop(pin);
    std::fs::remove_file(&target).unwrap();
    assert_eq!(
        std::fs::read(directory.path().join("0.part")).unwrap(),
        b"abc"
    );
}

#[test]
fn legacy_extra_alias_bad_hash_and_conflicting_mapping_preserve_all_files() {
    for fault in ["extra-alias", "bad-hash", "mapping"] {
        let fixture = Fixture::new();
        let (mut store, root, id) = setup(&fixture);
        let target = legacy_link(&root, "nested/中文.txt");
        match fault {
            "extra-alias" => std::fs::hard_link(&target, fixture.0.join("third-link")).unwrap(),
            "bad-hash" => std::fs::write(&target, b"bad").unwrap(),
            _ => {
                let mut state = store.state().clone();
                state.tasks[0]
                    .files
                    .as_mut()
                    .unwrap()
                    .insert("0".into(), json!(root.path().join("elsewhere.txt")));
                store.commit(state).unwrap();
            }
        }
        let before = std::fs::read(fixture.0.join("profile/state.json")).unwrap();
        assert!(recover(&mut store, &id, root.clone(), &CancellationToken::new()).is_err());
        assert_eq!(
            std::fs::read(fixture.0.join("profile/state.json")).unwrap(),
            before
        );
        assert!(root.path().join(".dustdesk-part-transfer/0.part").exists());
        assert_eq!(
            std::fs::read(&target).unwrap(),
            if fault == "bad-hash" { b"bad" } else { b"abc" }
        );
    }
}

#[test]
fn legacy_same_bytes_at_different_identity_are_not_adopted() {
    let fixture = Fixture::new();
    let (mut store, root, id) = setup(&fixture);
    let alias = legacy_link(&root, "not-a-published-candidate.txt");
    root.child("nested", true).unwrap();
    std::fs::write(root.path().join("nested/中文.txt"), b"abc").unwrap();
    let before = std::fs::read(fixture.0.join("profile/state.json")).unwrap();
    assert!(recover(&mut store, &id, root.clone(), &CancellationToken::new()).is_err());
    assert_eq!(
        std::fs::read(fixture.0.join("profile/state.json")).unwrap(),
        before
    );
    assert!(root.path().join(".dustdesk-part-transfer/0.part").exists());
    assert_eq!(std::fs::read(alias).unwrap(), b"abc");
    assert_eq!(
        std::fs::read(root.path().join("nested/中文.txt")).unwrap(),
        b"abc"
    );
}

#[test]
fn legacy_state_save_failure_and_cancellation_never_unlink_before_durable_intent() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let (mut store, root, id) = setup(&fixture);
    let target = legacy_link(&root, "nested/中文.txt");
    let blocker = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(fixture.0.join("profile/state.json"))
        .unwrap();
    assert!(recover(&mut store, &id, root.clone(), &CancellationToken::new()).is_err());
    assert!(decode(&store.state().tasks[0]).unwrap().is_none());
    assert!(root.path().join(".dustdesk-part-transfer/0.part").exists());
    drop(blocker);
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(recover(&mut store, &id, root.clone(), &cancel).is_err());
    assert!(decode(&store.state().tasks[0]).unwrap().is_none());
    assert!(root.path().join(".dustdesk-part-transfer/0.part").exists());
    recover(&mut store, &id, root, &CancellationToken::new()).unwrap();
    assert_eq!(std::fs::read(target).unwrap(), b"abc");
}

#[test]
fn legacy_intent_restarts_before_or_after_unlink_and_refuses_replaced_target() {
    for step in ["before-unlink", "after-unlink", "replaced-target"] {
        let fixture = Fixture::new();
        let (mut store, root, id) = setup(&fixture);
        let target = legacy_link(&root, "nested/中文.txt");
        let directory = root.child(".dustdesk-part-transfer", false).unwrap();
        let part = directory.legacy_part("0.part").unwrap().unwrap();
        let intent = Intent {
            index: 0,
            identity: part.identity().clone(),
            size: 3,
            hash: fingerprint(b"abc"),
            candidate: "nested/中文.txt".into(),
            collision: 0,
            legacy_link: true,
        };
        save_intent(&mut store, &id, &intent, &CancellationToken::new()).unwrap();
        if step != "before-unlink" {
            part.remove().unwrap();
        } else {
            drop(part);
        }
        if step == "replaced-target" {
            std::fs::rename(&target, root.path().join("retained.txt")).unwrap();
            std::fs::write(&target, b"abc").unwrap();
        }
        drop(store);
        let mut store = StateStore::open(&fixture.0.join("profile")).unwrap();
        let result = recover(&mut store, &id, root.clone(), &CancellationToken::new());
        if step == "replaced-target" {
            assert!(result.is_err());
            assert!(decode(&store.state().tasks[0]).unwrap().is_some());
            assert!(store.state().tasks[0].files.as_ref().unwrap().is_empty());
            assert_eq!(
                std::fs::read(root.path().join("retained.txt")).unwrap(),
                b"abc"
            );
        } else {
            assert_eq!(Path::new(&result.unwrap().unwrap()), target);
            assert!(!directory.path().join("0.part").exists());
            assert!(decode(&store.state().tasks[0]).unwrap().is_none());
        }
        assert_eq!(std::fs::read(target).unwrap(), b"abc");
    }
}

#[test]
fn missing_staging_after_publication_can_finish_intent_and_repeat_cleanup() {
    for legacy in [false, true] {
        let fixture = Fixture::new();
        let (mut store, root, id) = setup(&fixture);
        let cancel = CancellationToken::new();
        if legacy {
            legacy_link(&root, "nested/中文.txt");
            let directory = root.child(".dustdesk-part-transfer", false).unwrap();
            let part = directory.legacy_part("0.part").unwrap().unwrap();
            let intent = Intent {
                index: 0,
                identity: part.identity().clone(),
                size: 3,
                hash: fingerprint(b"abc"),
                candidate: "nested/中文.txt".into(),
                collision: 0,
                legacy_link: true,
            };
            save_intent(&mut store, &id, &intent, &cancel).unwrap();
            part.remove().unwrap();
        } else {
            let mut prepared =
                Prepared::begin(&mut store, &id, 0, root.clone(), part(&root), &cancel).unwrap();
            prepared.rename(&mut store, &cancel).unwrap();
        }
        std::fs::remove_dir(root.path().join(".dustdesk-part-transfer")).unwrap();
        assert_eq!(
            Path::new(
                &recover(&mut store, &id, root.clone(), &cancel)
                    .unwrap()
                    .unwrap()
            ),
            root.path().join("nested/中文.txt")
        );
        assert!(recover(&mut store, &id, root.clone(), &cancel)
            .unwrap()
            .is_none());
        assert!(!root.path().join(".dustdesk-part-transfer").exists());
        assert_eq!(
            std::fs::read(root.path().join("nested/中文.txt")).unwrap(),
            b"abc"
        );
    }
}
