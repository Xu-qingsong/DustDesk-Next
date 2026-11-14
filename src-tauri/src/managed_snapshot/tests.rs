use super::*;
use serde_json::{json, Value};
use std::{cell::Cell, fs::OpenOptions, path::PathBuf, process::Command};

struct Fixture {
    root: PathBuf,
    data: PathBuf,
    destination: PathBuf,
    fingerprint: String,
}
impl Fixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("dustdesk-managed-snapshot-test-{}", Uuid::new_v4()));
        let data = root.join("Data");
        fs::create_dir_all(data.join("NoteBackgrounds")).unwrap();
        fs::create_dir_all(data.join("ClipboardAssets")).unwrap();
        fs::create_dir_all(data.join("DesktopOrganizer/空目录")).unwrap();
        fs::create_dir_all(data.join("Logs")).unwrap();
        let workspace = b"{\r\n  \"SchemaVersion\":3, \"QuickNote\":\"\", \"Notes\":[]\r\n}\r\n";
        fs::write(data.join("workspace.json"), workspace).unwrap();
        fs::write(data.join("workspace.json.bak"), b"{\"older\":true}\r\n").unwrap();
        fs::write(data.join("workspace.lock"), b"not snapshot content").unwrap();
        fs::write(data.join("NoteBackgrounds/背景 🌲.png"), [0, 1, 255, 128]).unwrap();
        fs::write(
            data.join("ClipboardAssets/history.bin"),
            vec![37; 1024 * 1024],
        )
        .unwrap();
        fs::write(data.join("DesktopOrganizer/说明.txt"), "完整原文\r\n\0🪶").unwrap();
        fs::write(
            data.join("Logs/organizer-move.log"),
            b"retained journal\r\n",
        )
        .unwrap();
        let destination = root.join("snapshot");
        Self {
            root,
            data,
            destination,
            fingerprint: hash(workspace),
        }
    }
    fn prepare(&self) -> Receipt {
        prepare(
            &self.data,
            &self.destination,
            &self.fingerprint,
            &CancellationToken::new(),
            || Ok(()),
        )
        .unwrap()
    }
    fn manifest(&self) -> Value {
        serde_json::from_slice(&fs::read(self.destination.join(MANIFEST)).unwrap()).unwrap()
    }
    fn write_manifest(&self, value: &Value) -> String {
        let bytes = serde_json::to_vec(value).unwrap();
        fs::write(self.destination.join(MANIFEST), &bytes).unwrap();
        hash(&bytes)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

#[test]
fn retained_read_shared_workspace_lease_is_composable_without_releasing_the_pin() {
    let fixture = Fixture::new();
    let directory = Directory::open(&fixture.data).unwrap();
    let workspace = directory.read_shared("workspace.json").unwrap();
    let original_stamp = workspace.source_stamp().unwrap();
    let receipt = fixture.prepare();
    assert_eq!(receipt.workspace_sha256, fixture.fingerprint);
    assert_eq!(workspace.source_stamp().unwrap(), original_stamp);
    assert!(OpenOptions::new()
        .write(true)
        .open(fixture.data.join("workspace.json"))
        .is_err());
    verify_receipt(&fixture.destination, &receipt, &CancellationToken::new()).unwrap();
}

#[test]
fn exact_raw_workspace_assets_empty_directories_and_journal_are_copied_without_runtime_locks() {
    let fixture = Fixture::new();
    let runtime_lock = OpenOptions::new()
        .read(true)
        .write(true)
        .open(fixture.data.join("workspace.lock"))
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&runtime_lock).unwrap();
    let receipt = fixture.prepare();
    assert_eq!(receipt.files, 6);
    assert_eq!(receipt.directories, 5);
    let manifest = verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new(),
    )
    .unwrap();
    assert_eq!(manifest.workspace_sha256, fixture.fingerprint);
    assert_eq!(manifest.excluded_runtime_files, ["workspace.lock"]);
    assert!(manifest.entries.iter().any(
        |entry| matches!(entry, Entry::Directory { path, .. } if path == "DesktopOrganizer/空目录")
    ));
    let mut total = 0;
    for entry in manifest.entries {
        if let Entry::File {
            path,
            stamp,
            object,
            sha256,
            ..
        } = entry
        {
            let original = fs::read(fixture.data.join(path)).unwrap();
            let copied = fs::read(
                fixture
                    .destination
                    .join("objects")
                    .join(object_name(object)),
            )
            .unwrap();
            assert_eq!(copied, original);
            assert_eq!(hash(&copied), sha256);
            assert_eq!(copied.len() as u64, stamp.size);
            total += stamp.size;
        }
    }
    assert_eq!(receipt.total_bytes, total);
}

#[test]
fn source_files_and_all_ancestors_remain_pinned_through_publication() {
    let fixture = Fixture::new();
    let checked = Cell::new(false);
    prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || {
            if fixture.destination.exists() && !checked.replace(true) {
                assert!(OpenOptions::new()
                    .write(true)
                    .open(fixture.data.join("workspace.json"))
                    .is_err());
                assert!(fs::rename(
                    fixture.data.join("workspace.json"),
                    fixture.data.join("renamed.json")
                )
                .is_err());
                assert!(fs::rename(&fixture.data, fixture.root.join("renamed-root")).is_err());
                assert!(fs::rename(
                    fixture.data.join("NoteBackgrounds"),
                    fixture.data.join("renamed-images")
                )
                .is_err());
            }
            Ok(())
        },
    )
    .unwrap();
    assert!(checked.get());
    assert_eq!(
        hash(&fs::read(fixture.data.join("workspace.json")).unwrap()),
        fixture.fingerprint
    );
}

#[test]
fn added_source_content_cannot_be_silently_omitted_from_a_completed_snapshot() {
    let fixture = Fixture::new();
    let inserted = Cell::new(false);
    let error = prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || {
            if fixture.destination.exists() && !inserted.replace(true) {
                fs::write(fixture.data.join("late.txt"), b"new content").unwrap();
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.contains("内容已变化"), "{error}");
    assert!(inserted.get());
    assert!(!fixture.destination.join(MANIFEST).exists());
    assert_eq!(
        fs::read(fixture.data.join("late.txt")).unwrap(),
        b"new content"
    );
}

#[test]
fn checkpoint_mismatch_and_missing_workspace_fail_before_creating_the_destination() {
    let fixture = Fixture::new();
    let cancel = CancellationToken::new();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &"a".repeat(64),
        &cancel,
        || Ok(())
    )
    .unwrap_err()
    .contains("检查点不一致"));
    assert!(!fixture.destination.exists());
    fs::remove_file(fixture.data.join("workspace.json")).unwrap();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &cancel,
        || Ok(())
    )
    .unwrap_err()
    .contains("缺少普通 workspace.json"));
    assert!(!fixture.destination.exists());
}

#[test]
fn cancellation_before_and_during_copy_never_publishes_a_completion_marker() {
    let fixture = Fixture::new();
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &cancelled,
        || Ok(())
    )
    .is_err());
    assert!(!fixture.destination.exists());
    let cancel = CancellationToken::new();
    let calls = Cell::new(0);
    let error = prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &cancel,
        || {
            if fixture.destination.exists() {
                calls.set(calls.get() + 1);
                if calls.get() == 12 {
                    cancel.cancel();
                }
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert!(error.contains("取消"), "{error}");
    assert_eq!(calls.get(), 12);
    assert!(fixture.destination.join("objects/000000.bin").exists());
    assert!(!fixture.destination.join(MANIFEST).exists());
    assert_eq!(
        hash(&fs::read(fixture.data.join("workspace.json")).unwrap()),
        fixture.fingerprint
    );
}

#[test]
fn expired_native_maintenance_authority_fails_closed_during_copy() {
    let fixture = Fixture::new();
    let calls = Cell::new(0);
    let error = prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || {
            if fixture.destination.exists() {
                calls.set(calls.get() + 1);
                if calls.get() >= 10 {
                    return Err("fixture: native lease expired".into());
                }
            }
            Ok(())
        },
    )
    .unwrap_err();
    assert_eq!(error, "fixture: native lease expired");
    assert!(!fixture.destination.join(MANIFEST).exists());
}

#[test]
fn existing_destination_is_never_overwritten_or_cleaned_up() {
    let fixture = Fixture::new();
    fs::create_dir(&fixture.destination).unwrap();
    fs::write(fixture.destination.join("mine.txt"), b"user data").unwrap();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
    assert_eq!(
        fs::read(fixture.destination.join("mine.txt")).unwrap(),
        b"user data"
    );
    assert_eq!(fs::read_dir(&fixture.destination).unwrap().count(), 1);
}

#[test]
fn destination_inside_source_is_rejected_by_physical_ancestor_identity_including_verbatim_aliases()
{
    let fixture = Fixture::new();
    for destination in [
        fixture.data.join("snapshot"),
        PathBuf::from(format!(
            r"\\?\{}",
            fixture.data.join("NoteBackgrounds/snapshot").display()
        )),
    ] {
        let error = prepare(
            &fixture.data,
            &destination,
            &fixture.fingerprint,
            &CancellationToken::new(),
            || Ok(()),
        )
        .unwrap_err();
        assert!(error.contains("源数据目录内部"), "{error}");
        assert!(!destination.exists());
    }
}

#[test]
fn hard_links_source_writer_and_directory_runtime_lock_are_not_ignored() {
    let fixture = Fixture::new();
    let original = fixture.data.join("NoteBackgrounds/背景 🌲.png");
    let alias = fixture.root.join("alias.png");
    fs::hard_link(&original, &alias).unwrap();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
    fs::remove_file(alias).unwrap();
    let writer = OpenOptions::new().write(true).open(&original).unwrap();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
    drop(writer);
    fs::remove_file(fixture.data.join("workspace.lock")).unwrap();
    fs::create_dir(fixture.data.join("workspace.lock")).unwrap();
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .unwrap_err()
    .contains("运行锁不是普通文件"));
    assert!(!fixture.destination.exists());
}

#[test]
fn source_junctions_and_junction_destination_parents_are_rejected_without_following_them() {
    let fixture = Fixture::new();
    let outside = fixture.root.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), b"outside").unwrap();
    let link = fixture.data.join("linked");
    assert!(Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&link)
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
    fs::remove_dir(&link).unwrap();
    let output_link = fixture.root.join("output-link");
    assert!(Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&output_link)
        .arg(&outside)
        .output()
        .unwrap()
        .status
        .success());
    assert!(prepare(
        &fixture.data,
        &output_link.join("snapshot"),
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .is_err());
    fs::remove_dir(&output_link).unwrap();
    assert_eq!(fs::read(outside.join("secret.txt")).unwrap(), b"outside");
    assert_eq!(fs::read_dir(outside).unwrap().count(), 1);
}

#[test]
fn sparse_oversize_source_is_rejected_without_copying_or_allocating_its_contents() {
    let fixture = Fixture::new();
    use std::os::windows::{fs::MetadataExt, io::AsRawHandle};
    use windows::Win32::{
        Foundation::HANDLE,
        System::{Ioctl::FSCTL_SET_SPARSE, IO::DeviceIoControl},
    };
    let huge_path = fixture.data.join("huge.bin");
    fs::write(&huge_path, b"").unwrap();
    let sparse = OpenOptions::new().write(true).open(&huge_path).unwrap();
    let mut returned = 0;
    unsafe {
        DeviceIoControl(
            HANDLE(sparse.as_raw_handle()),
            FSCTL_SET_SPARSE,
            None,
            0,
            None,
            0,
            Some(&mut returned),
            None,
        )
    }
    .unwrap();
    drop(sparse);
    assert_ne!(
        fs::metadata(&huge_path).unwrap().file_attributes() & 0x200,
        0
    );
    let huge = OpenOptions::new().write(true).open(&huge_path).unwrap();
    huge.set_len(MAX_TOTAL_BYTES + 1).unwrap();
    drop(huge);
    assert!(prepare(
        &fixture.data,
        &fixture.destination,
        &fixture.fingerprint,
        &CancellationToken::new(),
        || Ok(())
    )
    .unwrap_err()
    .contains("1 TiB"));
    assert!(!fixture.destination.exists());
}

#[test]
fn incomplete_changed_missing_extra_and_hard_linked_objects_fail_integrity_verification() {
    let fixture = Fixture::new();
    let receipt = fixture.prepare();
    let object = fixture.destination.join("objects/000000.bin");
    let original = fs::read(&object).unwrap();
    fs::write(&object, b"changed").unwrap();
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
    fs::write(&object, &original).unwrap();
    let extra = fixture.destination.join("objects/extra.bin");
    fs::write(&extra, b"extra").unwrap();
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
    fs::remove_file(extra).unwrap();
    let alias = fixture.root.join("object-alias");
    fs::hard_link(&object, &alias).unwrap();
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
    fs::remove_file(alias).unwrap();
    fs::remove_file(&object).unwrap();
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
    fs::write(&object, original).unwrap();
    fs::write(fixture.destination.join("unexpected"), b"extra").unwrap();
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
    fs::remove_file(fixture.destination.join("unexpected")).unwrap();
    verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new(),
    )
    .unwrap();
    fs::remove_file(fixture.destination.join(MANIFEST)).unwrap();
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
}

#[test]
fn malformed_manifests_are_rejected_even_when_the_caller_recomputes_the_checksum() {
    let fixture = Fixture::new();
    fixture.prepare();
    let original = fixture.manifest();
    for variant in 0..14 {
        let mut manifest = original.clone();
        match variant {
            0 => manifest["version"] = json!(2),
            1 => manifest["format"] = json!("other"),
            2 => manifest["entries"][0]["path"] = json!("../escape"),
            3 => manifest["entries"][0]["path"] = json!("folder:stream"),
            4 => manifest["entries"][0]["path"] = json!("CON.txt"),
            5 => manifest["entries"][0]["path"] = json!("workspace.lock"),
            6 => manifest["entries"].as_array_mut().unwrap().swap(0, 1),
            7 => {
                let duplicate = manifest["entries"][0].clone();
                manifest["entries"]
                    .as_array_mut()
                    .unwrap()
                    .insert(1, duplicate);
            }
            8 => {
                manifest["entries"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|entry| entry["kind"] == "file")
                    .unwrap()["object"] = json!(9)
            }
            9 => manifest["workspaceSha256"] = json!("a".repeat(64)),
            10 => manifest["unknown"] = json!(true),
            11 => manifest["excludedRuntimeFiles"] = json!(["identity.json"]),
            12 => manifest["entries"][0]["path"] = json!("missing/parent/file"),
            13 => manifest["id"] = json!("00000000-0000-4000-0000-000000000000"),
            _ => unreachable!(),
        }
        let checksum = fixture.write_manifest(&manifest);
        assert!(
            verify(&fixture.destination, &checksum, &CancellationToken::new()).is_err(),
            "variant {variant}"
        );
    }
}

#[test]
fn application_version_is_metadata_not_a_same_version_only_migration_gate() {
    let fixture = Fixture::new();
    fixture.prepare();
    let mut manifest = fixture.manifest();
    manifest["appVersion"] = json!("1.0.1");
    let checksum = fixture.write_manifest(&manifest);
    verify(&fixture.destination, &checksum, &CancellationToken::new()).unwrap();
}

#[test]
fn cancelled_verification_and_oversized_manifest_never_count_as_verified() {
    let fixture = Fixture::new();
    let receipt = fixture.prepare();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(verify(&fixture.destination, &receipt.manifest_sha256, &cancel).is_err());
    let manifest = OpenOptions::new()
        .write(true)
        .open(fixture.destination.join(MANIFEST))
        .unwrap();
    manifest.set_len(MAX_MANIFEST_BYTES as u64 + 1).unwrap();
    drop(manifest);
    assert!(verify(
        &fixture.destination,
        &receipt.manifest_sha256,
        &CancellationToken::new()
    )
    .is_err());
}

#[test]
fn manifest_list_limits_are_enforced_while_deserializing_not_after_unbounded_allocation() {
    let fixture = Fixture::new();
    fixture.prepare();
    let original = fixture.manifest();
    let mut manifest = original.clone();
    manifest["entries"] = json!(vec![original["entries"][0].clone(); MAX_ENTRIES + 1]);
    let checksum = fixture.write_manifest(&manifest);
    let error = verify(&fixture.destination, &checksum, &CancellationToken::new()).unwrap_err();
    assert!(error.contains("列表条目超限"), "{error}");
    let mut manifest = original;
    manifest["excludedRuntimeFiles"] = json!(["workspace.lock", "workspace.lock"]);
    let checksum = fixture.write_manifest(&manifest);
    assert!(
        verify(&fixture.destination, &checksum, &CancellationToken::new())
            .unwrap_err()
            .contains("列表条目超限")
    );
}

#[test]
fn native_receipt_checks_physical_destination_identity_and_every_summary_field_not_only_portable_checksums(
) {
    let fixture = Fixture::new();
    let receipt = fixture.prepare();
    let cancel = CancellationToken::new();
    verify_receipt(&fixture.destination, &receipt, &cancel).unwrap();
    let cloned = fixture.root.join("cloned-snapshot");
    fs::create_dir_all(cloned.join("objects")).unwrap();
    fs::copy(fixture.destination.join(MANIFEST), cloned.join(MANIFEST)).unwrap();
    for entry in fs::read_dir(fixture.destination.join("objects")).unwrap() {
        let entry = entry.unwrap();
        fs::copy(entry.path(), cloned.join("objects").join(entry.file_name())).unwrap();
    }
    verify(&cloned, &receipt.manifest_sha256, &cancel).unwrap();
    assert!(verify_receipt(&cloned, &receipt, &cancel)
        .unwrap_err()
        .contains("物理目录"));
    for variant in 0..6 {
        let mut changed = receipt.clone();
        match variant {
            0 => changed.id = Uuid::new_v4().to_string(),
            1 => changed.source_identity.index += 1,
            2 => changed.workspace_sha256 = "a".repeat(64),
            3 => changed.files += 1,
            4 => changed.directories += 1,
            5 => changed.total_bytes += 1,
            _ => unreachable!(),
        }
        assert!(verify_receipt(&fixture.destination, &changed, &cancel).is_err());
    }
}
