use super::super::{protocol::fingerprint, state_store::StateStore, storage::State};
use super::*;

pub(crate) struct Fixture(pub PathBuf);
impl Fixture {
    pub(crate) fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("dustdesk-lan-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        Self(root)
    }
    fn directory(&self) -> Arc<Directory> {
        Directory::open(&self.0).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn exact_handle_publication_supports_long_local_paths_without_replacing_collisions() {
    let fixture = Fixture::new();
    let directory = fixture
        .directory()
        .child(
            &format!("{}/{}", "long-".repeat(30), "nested-".repeat(15)),
            true,
        )
        .unwrap();
    let destination = directory.path().join("完整原生记录.json");
    assert!(destination.as_os_str().encode_wide().count() > 260);
    let mut file = directory.create("first.part").unwrap();
    file.write_all(b"exact long-path bytes").unwrap();
    file.sync().unwrap();
    let identity = file.identity().clone();
    file.publish(&directory, "完整原生记录.json").unwrap();
    assert_eq!(file.identity(), &identity);
    let mut collision = directory.create("second.part").unwrap();
    collision.write_all(b"must not replace").unwrap();
    assert!(collision.publish(&directory, "完整原生记录.json").is_err());
    drop(collision);
    drop(file);
    assert_eq!(
        std::fs::read(destination).unwrap(),
        b"exact long-path bytes"
    );
}

#[test]
fn exact_handle_publication_preserves_bytes_identity_and_collisions() {
    let fixture = Fixture::new();
    let root = fixture.directory();
    let staging = root.child("staging", true).unwrap();
    let target = root.child("中文/empty", true).unwrap();
    let cancel = CancellationToken::new();
    let mut part = staging.create("0.part").unwrap();
    part.append(0, b"abc", 3, &cancel).unwrap();
    part.sync().unwrap();
    let identity = part.identity().clone();
    assert_eq!(part.hash(3, &cancel).unwrap(), fingerprint(b"abc"));
    std::fs::write(target.path().join("file.txt"), b"preserve").unwrap();
    assert!(part.publish(&target, "file.txt").is_err());
    assert_eq!(part.identity(), &identity);
    part.publish(&target, "file-1.txt").unwrap();
    assert!(!staging.path().join("0.part").exists());
    assert_eq!(part.identity(), &identity);
    assert_eq!(part.path(), target.path().join("file-1.txt"));
    drop(part);
    assert_eq!(
        std::fs::read(target.path().join("file.txt")).unwrap(),
        b"preserve"
    );
    assert_eq!(
        std::fs::read(target.path().join("file-1.txt")).unwrap(),
        b"abc"
    );
}

#[test]
fn every_ancestor_is_pinned_until_its_last_descendant_drops() {
    let fixture = Fixture::new();
    let root = fixture.directory();
    let child = root.child("first/second", true).unwrap();
    drop(root);
    assert!(std::fs::rename(fixture.0.join("first"), fixture.0.join("moved")).is_err());
    assert!(std::fs::rename(&fixture.0, fixture.0.with_extension("moved")).is_err());
    let part = child.create("part").unwrap();
    drop(child);
    assert!(std::fs::rename(fixture.0.join("first"), fixture.0.join("moved")).is_err());
    drop(part);
    std::fs::rename(fixture.0.join("first"), fixture.0.join("moved")).unwrap();
}

#[test]
fn directory_pin_blocks_rename_even_without_any_descendant_file_handle() {
    let fixture = Fixture::new();
    let path = fixture.0.join("empty");
    std::fs::create_dir(&path).unwrap();
    let directory = Directory::open(&path).unwrap();
    assert!(std::fs::rename(&path, fixture.0.join("moved")).is_err());
    assert!(std::fs::rename(&fixture.0, fixture.0.with_extension("moved")).is_err());
    drop(directory);
    std::fs::rename(&path, fixture.0.join("moved")).unwrap();
}

#[test]
fn rejects_hardlinked_parts_and_never_truncates_the_other_link() {
    let fixture = Fixture::new();
    let root = fixture.directory();
    std::fs::write(fixture.0.join("original"), b"preserve").unwrap();
    std::fs::hard_link(fixture.0.join("original"), fixture.0.join("part")).unwrap();
    assert!(root.part("part").is_err());
    assert!(root.read("part").is_err());
    assert!(root.create("part").is_err());
    assert_eq!(
        std::fs::read(fixture.0.join("original")).unwrap(),
        b"preserve"
    );
}

#[test]
fn open_part_excludes_other_handles_and_validates_every_append() {
    let fixture = Fixture::new();
    let root = fixture.directory();
    let cancel = CancellationToken::new();
    let mut part = root.create("part").unwrap();
    assert!(std::fs::write(part.path(), b"bad").is_err());
    assert!(std::fs::rename(part.path(), fixture.0.join("renamed")).is_err());
    for (offset, bytes, limit) in [(1, &b"a"[..], 1), (0, &b"abc"[..], 2)] {
        assert!(part.append(offset, bytes, limit, &cancel).is_err());
        assert_eq!(part.size().unwrap(), 0);
    }
    assert!(part.append(0, &vec![0; 65_537], 100_000, &cancel).is_err());
    part.append(0, b"a", 2, &cancel).unwrap();
    part.append(1, b"b", 2, &cancel).unwrap();
    assert!(part.hash(1, &cancel).is_err());
    cancel.cancel();
    assert!(part.append(2, b"c", 3, &cancel).is_err());
    assert!(part.hash(2, &cancel).is_err());
    assert_eq!(part.size().unwrap(), 2);
    part.remove().unwrap();
    assert!(!fixture.0.join("part").exists());
}

#[test]
fn unsafe_relative_names_and_nonlocal_roots_cannot_select_files() {
    let fixture = Fixture::new();
    let root = fixture.directory();
    for name in [
        "../escape",
        "/escape",
        "C:/escape",
        "a\\b",
        "a//b",
        "a/./b",
        "NUL.txt",
        "part:stream",
        "a ",
        "a.",
    ] {
        assert!(root.child(name, true).is_err(), "{name}");
        assert!(root.parent_for(name, true).is_err(), "{name}");
        assert!(root.create(name).is_err(), "{name}");
    }
    for path in [
        "relative",
        "C:relative",
        "\\\\server\\share",
        "\\\\.\\C:\\",
        "C:\\Windows\\..",
    ] {
        assert!(Directory::open(Path::new(path)).is_err(), "{path}");
    }
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 0);
}

#[test]
fn atomic_state_owner_preserves_failed_commits_and_reopens_after_owner_drops() {
    let fixture = Fixture::new();
    let mut store = StateStore::open(&fixture.0).unwrap();
    assert!(StateStore::open(&fixture.0).is_err());
    let mut next = State {
        enabled: true,
        ..State::default()
    };
    next.trusted.push("a".repeat(64));
    store.commit(next).unwrap();
    let before = std::fs::read(fixture.0.join("state.json")).unwrap();
    let blocker = OpenOptions::new()
        .read(true)
        .share_mode(1)
        .open(fixture.0.join("state.json"))
        .unwrap();
    assert!(store.commit(State::default()).is_err());
    assert!(store.state().enabled);
    assert_eq!(std::fs::read(fixture.0.join("state.json")).unwrap(), before);
    drop(blocker);
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 2);
    drop(store);
    let store = StateStore::open(&fixture.0).unwrap();
    assert!(store.state().enabled);
    assert_eq!(store.state().trusted, ["a".repeat(64)]);
}

#[test]
fn state_owner_does_not_replace_corrupt_or_hardlinked_state() {
    let fixture = Fixture::new();
    std::fs::write(fixture.0.join("state.json"), b"corrupt").unwrap();
    assert!(StateStore::open(&fixture.0).is_err());
    assert_eq!(
        std::fs::read(fixture.0.join("state.json")).unwrap(),
        b"corrupt"
    );
    std::fs::write(fixture.0.join("state.json"), b"{}").unwrap();
    std::fs::hard_link(fixture.0.join("state.json"), fixture.0.join("alias")).unwrap();
    assert!(StateStore::open(&fixture.0).is_err());
    assert_eq!(std::fs::read(fixture.0.join("alias")).unwrap(), b"{}");
}

#[test]
fn native_file_index_uses_lossless_hex_strings_across_javascript_json() {
    let identity = FileIdentity {
        volume: u32::MAX,
        index: u64::MAX,
    };
    let value = serde_json::to_value(&identity).unwrap();
    assert_eq!(value["index"], "ffffffffffffffff");
    assert_eq!(
        serde_json::from_value::<FileIdentity>(value).unwrap(),
        identity
    );
    for value in [
        serde_json::json!(0),
        serde_json::json!("0"),
        serde_json::json!("0000000000000000"),
        serde_json::json!("FFFFFFFFFFFFFFFF"),
    ] {
        assert!(serde_json::from_value::<FileIdentity>(
            serde_json::json!({"volume":1,"index":value})
        )
        .is_err());
    }
}

#[test]
fn canceled_state_commit_keeps_disk_memory_and_directory_unchanged() {
    let fixture = Fixture::new();
    let mut store = StateStore::open(&fixture.0).unwrap();
    store.commit(State::default()).unwrap();
    let before = std::fs::read(fixture.0.join("state.json")).unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(store
        .commit_cancellable(
            State {
                enabled: true,
                ..State::default()
            },
            &[&cancel]
        )
        .is_err());
    assert!(!store.state().enabled);
    assert_eq!(std::fs::read(fixture.0.join("state.json")).unwrap(), before);
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 2);
}
