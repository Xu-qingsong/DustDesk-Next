use super::*;
use std::{fs, io::Read, path::PathBuf};
use uuid::Uuid;

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    target: PathBuf,
    permissions: fs::Permissions,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("dustdesk-native-record-replace-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = root.join("replacement.tmp");
        let target = root.join("MigrationTransaction.json");
        fs::write(&source, b"new record").unwrap();
        fs::write(&target, b"old record").unwrap();
        let permissions = fs::metadata(&target).unwrap().permissions();
        Self {
            root,
            source,
            target,
            permissions,
        }
    }
    fn unchanged(&self) {
        assert_eq!(fs::read(&self.source).unwrap(), b"new record");
        assert_eq!(fs::read(&self.target).unwrap(), b"old record");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        if self.target.is_file() {
            let _ = fs::set_permissions(&self.target, self.permissions.clone());
        }
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn one_handle_publication_preserves_passive_old_readers_and_exposes_only_complete_new_bytes() {
    for name in ["MigrationTransaction.json", "MigrationBrowserJournal.json"] {
        let mut fixture = Fixture::new();
        if name != "MigrationTransaction.json" {
            fs::rename(&fixture.target, fixture.root.join(name)).unwrap();
            fixture.target = fixture.root.join(name);
        }
        let mut held = OpenOptions::new()
            .read(true)
            .share_mode(7)
            .open(&fixture.target)
            .unwrap();
        replace(&fixture.source, &fixture.target).unwrap();
        assert!(!fixture.source.exists());
        assert_eq!(fs::read(&fixture.target).unwrap(), b"new record");
        let mut old = Vec::new();
        held.read_to_end(&mut old).unwrap();
        assert_eq!(old, b"old record");
    }
}

#[test]
fn actual_source_or_target_writers_and_delete_denied_readers_fail_without_changing_either_file() {
    for target in [false, true] {
        for writer in [false, true] {
            let fixture = Fixture::new();
            let path = if target {
                &fixture.target
            } else {
                &fixture.source
            };
            let held = OpenOptions::new()
                .read(!writer)
                .write(writer)
                .share_mode(if writer { 7 } else { 1 })
                .open(path)
                .unwrap();
            let error = replace(&fixture.source, &fixture.target).unwrap_err();
            assert!(
                error.contains("FileRenameInfoEx") && error.contains("os error 32"),
                "{error}"
            );
            fixture.unchanged();
            drop(held);
            replace(&fixture.source, &fixture.target).unwrap();
            assert_eq!(fs::read(&fixture.target).unwrap(), b"new record");
        }
    }
}

#[test]
fn readonly_target_is_not_cleared_ignored_or_replaced() {
    let fixture = Fixture::new();
    let mut permissions = fs::metadata(&fixture.target).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&fixture.target, permissions).unwrap();
    let error = replace(&fixture.source, &fixture.target).unwrap_err();
    assert!(error.contains("os error 5"), "{error}");
    fixture.unchanged();
    assert!(fs::metadata(&fixture.target)
        .unwrap()
        .permissions()
        .readonly());
}

#[test]
fn missing_targets_and_unknown_or_cross_directory_paths_never_create_or_replace_a_record() {
    let fixture = Fixture::new();
    let unknown = fixture.root.join("unknown.json");
    fs::write(&unknown, b"unrelated").unwrap();
    assert!(replace(&fixture.source, &unknown).is_err());
    assert_eq!(fs::read(&unknown).unwrap(), b"unrelated");
    assert!(replace(&fixture.target, &fixture.target).is_err());
    let subdirectory = fixture.root.join("Subdirectory");
    fs::create_dir(&subdirectory).unwrap();
    assert!(replace(
        &fixture.source,
        &subdirectory.join("MigrationTransaction.json")
    )
    .is_err());
    fixture.unchanged();
    fs::remove_file(&fixture.target).unwrap();
    assert!(replace(&fixture.source, &fixture.target).is_err());
    assert!(!fixture.target.exists());
    assert_eq!(fs::read(&fixture.source).unwrap(), b"new record");
}

#[test]
fn source_and_target_hardlinks_are_rejected_without_touching_the_other_link() {
    for target in [false, true] {
        let fixture = Fixture::new();
        let linked = if target {
            &fixture.target
        } else {
            &fixture.source
        };
        let alias = fixture.root.join("alias.bin");
        fs::hard_link(linked, &alias).unwrap();
        let before = fs::read(&alias).unwrap();
        assert!(replace(&fixture.source, &fixture.target).is_err());
        fixture.unchanged();
        assert_eq!(fs::read(&alias).unwrap(), before);
    }
}

#[test]
fn junction_ancestors_and_non_file_targets_fail_without_following_or_removing_them() {
    let fixture = Fixture::new();
    let alias = fixture.root.join("redirect");
    let status = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&alias)
        .arg(&fixture.root)
        .output()
        .unwrap();
    assert!(status.status.success());
    assert!(replace(
        &alias.join("replacement.tmp"),
        &alias.join("MigrationTransaction.json")
    )
    .is_err());
    fixture.unchanged();
    fs::remove_dir(&alias).unwrap();
    fs::remove_file(&fixture.target).unwrap();
    fs::create_dir(&fixture.target).unwrap();
    assert!(replace(&fixture.source, &fixture.target).is_err());
    assert!(fixture.target.is_dir());
    assert_eq!(fs::read(&fixture.source).unwrap(), b"new record");
}
