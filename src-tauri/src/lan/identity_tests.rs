use super::*;
use crate::lan::{files::tests::Fixture, state_store::StateStore};

fn names(root: &std::path::Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|item| item.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn native_identity_survives_owner_restart_without_rewriting() {
    let fixture = Fixture::new();
    let store = StateStore::open(&fixture.0).unwrap();
    let cancel = CancellationToken::new();
    let first = store.ensure_identity(&cancel).unwrap();
    assert!(uuid::Uuid::parse_str(&first.id).is_ok());
    let original = std::fs::read(fixture.0.join("identity.json")).unwrap();
    let root = Directory::open(&fixture.0).unwrap();
    let loaded = ensure_with(&root, &cancel, |_| panic!("existing identity regenerated"));
    assert_eq!(loaded.unwrap().fingerprint, first.fingerprint);
    drop(store);
    let store = StateStore::open(&fixture.0).unwrap();
    let second = store.ensure_identity(&cancel).unwrap();
    assert_eq!(first.id, second.id);
    assert_eq!(first.fingerprint, second.fingerprint);
    assert!(std::fs::read(fixture.0.join("identity.json")).unwrap() == original);
    assert_eq!(names(&fixture.0), [".rust-owner.lock", "identity.json"]);
}

#[test]
fn canceled_generation_publishes_nothing_and_retry_creates_identity() {
    let fixture = Fixture::new();
    let root = Directory::open(&fixture.0).unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(ensure_with(&root, &cancel, |_| panic!("canceled generator ran")).is_err());
    assert!(names(&fixture.0).is_empty());
    let cancel = CancellationToken::new();
    let result = ensure_with(&root, &cancel, |cancel| {
        let bytes = generate(cancel)?;
        cancel.cancel();
        Ok(bytes)
    });
    assert!(result.is_err());
    assert!(names(&fixture.0).is_empty());
    assert!(ensure(&root, &CancellationToken::new()).is_ok());
}

#[test]
fn missing_identity_with_any_saved_state_requires_recovery() {
    let fixture = Fixture::new();
    let root = Directory::open(&fixture.0).unwrap();
    for bytes in [
        b"{}".as_slice(),
        b"broken",
        br#"{"trusted":["old"],"tasks":[]}"#,
    ] {
        std::fs::write(fixture.0.join("state.json"), bytes).unwrap();
        assert!(ensure_with(&root, &CancellationToken::new(), |_| panic!(
            "orphan regenerated"
        ))
        .err()
        .unwrap()
        .contains("身份缺失"));
        assert_eq!(std::fs::read(fixture.0.join("state.json")).unwrap(), bytes);
        assert!(!fixture.0.join("identity.json").exists());
    }
}

#[test]
fn corrupt_identity_and_hardlink_remain_byte_identical() {
    let fixture = Fixture::new();
    let root = Directory::open(&fixture.0).unwrap();
    let path = fixture.0.join("identity.json");
    std::fs::write(&path, b"bad-private-data").unwrap();
    assert!(ensure_with(&root, &CancellationToken::new(), |_| panic!(
        "corrupt regenerated"
    ))
    .is_err());
    assert_eq!(std::fs::read(&path).unwrap(), b"bad-private-data");
    std::fs::hard_link(&path, fixture.0.join("linked.json")).unwrap();
    assert!(ensure(&root, &CancellationToken::new()).is_err());
    assert_eq!(
        std::fs::read(fixture.0.join("linked.json")).unwrap(),
        b"bad-private-data"
    );
}

#[test]
fn external_creator_wins_without_overwrite_and_is_validated() {
    let fixture = Fixture::new();
    let root = Directory::open(&fixture.0).unwrap();
    let cancel = CancellationToken::new();
    let winner = generate(&cancel).unwrap();
    let expected = Identity::parse(&winner).unwrap();
    let created = ensure_with(&root, &cancel, |cancel| {
        let candidate = generate(cancel)?;
        std::fs::write(fixture.0.join("identity.json"), &*winner).unwrap();
        Ok(candidate)
    })
    .unwrap();
    assert_eq!(created.id, expected.id);
    assert_eq!(created.fingerprint, expected.fingerprint);
    assert!(std::fs::read(fixture.0.join("identity.json")).unwrap() == *winner);
}

#[test]
fn disk_sharing_failure_and_exclusive_owner_do_not_replace_identity() {
    use std::os::windows::fs::OpenOptionsExt;
    let fixture = Fixture::new();
    let store = StateStore::open(&fixture.0).unwrap();
    assert!(StateStore::open(&fixture.0).is_err());
    store.ensure_identity(&CancellationToken::new()).unwrap();
    let original = std::fs::read(fixture.0.join("identity.json")).unwrap();
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(fixture.0.join("identity.json"))
        .unwrap();
    assert!(store.ensure_identity(&CancellationToken::new()).is_err());
    drop(lock);
    assert!(store.ensure_identity(&CancellationToken::new()).is_ok());
    assert!(std::fs::read(fixture.0.join("identity.json")).unwrap() == original);
}

#[test]
fn temporary_guard_deletes_exact_file_on_unwind() {
    let fixture = Fixture::new();
    let root = Directory::open(&fixture.0).unwrap();
    let file = root.create(".identity-test.tmp").unwrap();
    let identity = file.identity().clone();
    let guard = Temporary(Some(file));
    assert_eq!(guard.0.as_ref().unwrap().identity(), &identity);
    drop(guard);
    assert!(names(&fixture.0).is_empty());
}
