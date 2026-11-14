use super::*;
use crate::{lan::files::tests::Fixture, managed_snapshot};
use std::{cell::Cell, fs, fs::FileTimes, fs::OpenOptions};

fn prepared(bytes: &[u8]) -> (Fixture, Arc<Directory>, Manifest) {
    let fixture = Fixture::new();
    let data = fixture.0.join("Data");
    fs::create_dir_all(data.join("Assets/空目录")).unwrap();
    let workspace = br#"{"SchemaVersion":3,"unknown":"unchanged"}"#;
    fs::write(data.join("workspace.json"), workspace).unwrap();
    fs::write(data.join("workspace.lock"), b"runtime only").unwrap();
    fs::write(data.join("Assets/raw.bin"), bytes).unwrap();
    let destination = fixture.0.join("snapshot");
    let cancel = CancellationToken::new();
    let receipt = managed_snapshot::prepare(
        &data,
        &destination,
        &managed_snapshot::hash(workspace),
        &cancel,
        || Ok(()),
    )
    .unwrap();
    let manifest = managed_snapshot::verify_receipt(&destination, &receipt, &cancel).unwrap();
    (fixture, Directory::open(&data).unwrap(), manifest)
}

#[test]
fn unchanged_complete_inventory_retains_every_file_and_empty_directory_until_drop() {
    let (_fixture, root, manifest) = prepared(b"before");
    let cancel = CancellationToken::new();
    let mut pinned = SourceInventory::capture(root.clone(), manifest, &cancel, || Ok(())).unwrap();
    let asset = root.path().join("Assets/raw.bin");
    assert!(OpenOptions::new().write(true).open(&asset).is_err());
    assert!(fs::rename(&asset, root.path().join("renamed.bin")).is_err());
    assert!(fs::remove_file(&asset).is_err());
    assert!(fs::remove_dir(root.path().join("Assets/空目录")).is_err());
    assert!(fs::rename(root.path().join("Assets/空目录"), root.path().join("moved")).is_err());
    pinned.verify(&cancel, || Ok(())).unwrap();
    drop(pinned);
    fs::write(asset, b"released").unwrap();
    fs::remove_dir(root.path().join("Assets/空目录")).unwrap();
}

#[test]
fn unchanged_workspace_cannot_cover_changed_asset_bytes_paths_types_or_directory_identity() {
    for mutation in 0..8 {
        let (fixture, root, manifest) = prepared(b"before");
        let asset = root.path().join("Assets/raw.bin");
        let empty = root.path().join("Assets/空目录");
        match mutation {
            0 => fs::write(&asset, b"AFTER!").unwrap(),
            1 => fs::write(root.path().join("Assets/added.bin"), b"extra").unwrap(),
            2 => fs::remove_file(&asset).unwrap(),
            3 => {
                fs::rename(&asset, fixture.0.join("original-outside.bin")).unwrap();
                fs::write(&asset, b"before").unwrap();
            }
            4 => {
                fs::remove_dir(&empty).unwrap();
                fs::create_dir(&empty).unwrap();
            }
            5 => {
                fs::remove_dir(&empty).unwrap();
                fs::write(&empty, b"not a directory").unwrap();
            }
            6 => fs::rename(&asset, root.path().join("Assets/RAW.bin")).unwrap(),
            7 => fs::create_dir(root.path().join("Assets/new-empty")).unwrap(),
            _ => unreachable!(),
        }
        assert!(
            SourceInventory::capture(root, manifest, &CancellationToken::new(), || Ok(())).is_err(),
            "mutation {mutation}"
        );
    }
}

#[test]
fn equal_size_identity_and_restored_last_write_time_still_require_fresh_full_digest() {
    let (_fixture, root, manifest) = prepared(b"before");
    let asset = root.path().join("Assets/raw.bin");
    let modified = fs::metadata(&asset).unwrap().modified().unwrap();
    fs::write(&asset, b"AFTER!").unwrap();
    let file = OpenOptions::new().write(true).open(&asset).unwrap();
    file.set_times(FileTimes::new().set_modified(modified))
        .unwrap();
    drop(file);
    assert_eq!(fs::metadata(&asset).unwrap().modified().unwrap(), modified);
    let error = SourceInventory::capture(root, manifest, &CancellationToken::new(), || Ok(()))
        .err()
        .unwrap();
    assert!(error.contains("完整摘要"), "{error}");
    fs::write(asset, b"released").unwrap();
}

#[test]
fn copied_live_root_is_not_the_original_physical_source() {
    let (fixture, _root, manifest) = prepared(b"before");
    let copied = fixture.0.join("copied");
    fs::create_dir(&copied).unwrap();
    let error = SourceInventory::capture(
        Directory::open(&copied).unwrap(),
        manifest,
        &CancellationToken::new(),
        || Ok(()),
    )
    .err()
    .unwrap();
    assert!(error.contains("物理工作区"));
}

#[test]
fn existing_live_asset_writer_blocks_capture_and_is_never_bypassed() {
    let (_fixture, root, manifest) = prepared(b"before");
    let asset = root.path().join("Assets/raw.bin");
    let writer = OpenOptions::new().write(true).open(&asset).unwrap();
    assert!(
        SourceInventory::capture(root, manifest, &CancellationToken::new(), || Ok(())).is_err()
    );
    drop(writer);
    fs::write(asset, b"released").unwrap();
}

#[test]
fn entries_added_after_enumeration_are_rejected_and_partial_file_pins_are_released() {
    let (_fixture, root, manifest) = prepared(b"before");
    let asset = root.path().join("Assets/raw.bin");
    let added = Cell::new(false);
    let result =
        SourceInventory::capture(root.clone(), manifest, &CancellationToken::new(), || {
            if !added.get() && OpenOptions::new().write(true).open(&asset).is_err() {
                fs::write(root.path().join("Assets/late.bin"), b"late").unwrap();
                added.set(true);
            }
            Ok(())
        });
    assert!(added.get());
    assert!(result.is_err());
    fs::write(asset, b"released").unwrap();
}

#[test]
fn retained_inventory_rechecks_names_after_all_original_files_were_pinned() {
    let (_fixture, root, manifest) = prepared(b"before");
    let cancel = CancellationToken::new();
    let pinned = SourceInventory::capture(root.clone(), manifest, &cancel, || Ok(())).unwrap();
    fs::write(root.path().join("Assets/空目录/new.bin"), b"new").unwrap();
    assert!(pinned.confirm(&cancel, || Ok(())).is_err());
    drop(pinned);
    fs::write(root.path().join("Assets/raw.bin"), b"released").unwrap();
}

#[test]
fn cancellation_and_authority_loss_are_checked_during_bounded_source_hashing() {
    for cancellation in [true, false] {
        let (_fixture, root, manifest) = prepared(&vec![37; 8 * 1024 * 1024]);
        let asset = root.path().join("Assets/raw.bin");
        let cancel = CancellationToken::new();
        let calls = Cell::new(0);
        let result = SourceInventory::capture(root, manifest, &cancel, || {
            calls.set(calls.get() + 1);
            if calls.get() == 64 {
                if cancellation {
                    cancel.cancel();
                } else {
                    return Err("source authority lost during hash".into());
                }
            }
            Ok(())
        });
        let error = result.err().unwrap();
        assert!(calls.get() >= 64);
        assert!(
            if cancellation {
                error.contains("取消")
            } else {
                error.contains("source authority lost during hash")
            },
            "{error}"
        );
        fs::write(asset, b"released").unwrap();
    }
}

#[test]
fn readonly_attribute_changes_revoke_the_old_prepared_inventory() {
    let (_fixture, root, manifest) = prepared(b"before");
    let asset = root.path().join("Assets/raw.bin");
    let original = fs::metadata(&asset).unwrap().permissions();
    let mut readonly = original.clone();
    readonly.set_readonly(true);
    fs::set_permissions(&asset, readonly).unwrap();
    let error =
        SourceInventory::capture(root, manifest, &CancellationToken::new(), || Ok(())).err();
    fs::set_permissions(asset, original).unwrap();
    assert!(error.unwrap().contains("只读属性"));
}

#[test]
fn workspace_runtime_lock_bytes_do_not_become_asset_content_or_identity_authority() {
    let (_fixture, root, manifest) = prepared(b"before");
    let runtime = root.path().join("workspace.lock");
    let writer = OpenOptions::new()
        .read(true)
        .write(true)
        .open(&runtime)
        .unwrap();
    let cancel = CancellationToken::new();
    let mut pinned = SourceInventory::capture(root, manifest, &cancel, || Ok(())).unwrap();
    fs::write(runtime, b"new runtime bytes").unwrap();
    pinned.verify(&cancel, || Ok(())).unwrap();
    drop(writer);
}
