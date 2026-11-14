use super::*;

mod ownership;
use crate::lan::files::Directory;
use std::{
    cell::Cell,
    fs::FileTimes,
    path::{Path, PathBuf},
    process::Command,
};

fn read_only(path: &Path, value: bool) {
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_readonly(value);
    fs::set_permissions(path, permissions).unwrap();
}

struct ReadOnlyReset {
    paths: Vec<PathBuf>,
    permissions: fs::Permissions,
}

impl Drop for ReadOnlyReset {
    fn drop(&mut self) {
        for path in &self.paths {
            if path.exists() {
                let _ = fs::set_permissions(path, self.permissions.clone());
            }
        }
    }
}

fn prepared(readonly: bool) -> (Runtime, String) {
    let runtime = Runtime::new();
    fs::create_dir_all(runtime.fixture.0.join("data/Assets/空目录")).unwrap();
    fs::write(runtime.fixture.0.join("data/Assets/raw.bin"), b"before").unwrap();
    fs::write(
        runtime.fixture.0.join("data/workspace.lock"),
        b"fixture runtime lock is not migration authority",
    )
    .unwrap();
    read_only(&runtime.fixture.0.join("data/Assets/raw.bin"), readonly);
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let cancel = CancellationToken::new();
    let mut source = source.freeze(&cancel, || Ok(())).unwrap();
    let status = source
        .prepare(
            &runtime.fixture.0.join("snapshot"),
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    drop(source);
    (runtime, status.id)
}

fn records(runtime: &Runtime, preparation_id: &str) -> PathBuf {
    let identity = Directory::open(&runtime.fixture.0.join("data"))
        .unwrap()
        .identity()
        .unwrap();
    runtime
        .fixture
        .0
        .join("profile/LegacySnapshotPreparation")
        .join(format!("{:016x}-{:016x}", identity.volume, identity.index))
        .join(preparation_id)
        .join("RuntimePreparation")
}

fn ids(root: &Path) -> Vec<String> {
    fs::read_dir(root)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect()
}

fn copy_tree(source: &Path, destination: &Path) {
    fs::create_dir(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = destination.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}

#[test]
fn runtime_data_native_receipt_tampering_is_rejected_without_rewriting_decisions() {
    let (runtime, preparation_id) = prepared(false);
    let output = runtime.fixture.0.join("RuntimeData");
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let receipt = source
        .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
        .unwrap();
    drop(source);
    let decision_path = records(&runtime, &preparation_id)
        .join(&receipt.id)
        .join("decision.json");
    let original = fs::read(&decision_path).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&original).unwrap();
    for field in [
        "workspaceSha256",
        "files",
        "directories",
        "totalBytes",
        "snapshotReceiptSha256",
        "inventorySha256",
        "productionReady",
        "migrationComplete",
    ] {
        let mut changed = value.clone();
        let payload = &mut changed["outcome"]["receipt"];
        match field {
            "files" | "directories" | "totalBytes" => {
                payload[field] = serde_json::json!(payload[field].as_u64().unwrap() + 1)
            }
            "productionReady" | "migrationComplete" => payload[field] = serde_json::json!(true),
            _ => payload[field] = serde_json::json!("0".repeat(64)),
        }
        let bytes = serde_json::to_vec(&changed).unwrap();
        fs::write(&decision_path, &bytes).unwrap();
        let mut reopened = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        assert!(
            reopened
                .verify_runtime(&preparation_id, &receipt.id, &cancel, || Ok(()))
                .is_err(),
            "{field}"
        );
        drop(reopened);
        assert_eq!(fs::read(&decision_path).unwrap(), bytes);
        OpenOptions::new()
            .write(true)
            .open(output.join("workspace.json"))
            .unwrap();
    }
    fs::write(decision_path, original).unwrap();
}

#[test]
fn runtime_data_native_status_recovers_lost_responses_without_granting_live_output_permission() {
    use crate::managed_snapshot::preparation::runtime::Outcome;
    let (runtime, preparation_id) = prepared(false);
    let output = runtime.fixture.0.join("RuntimeData");
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert!(source
        .runtime_statuses(&preparation_id, &cancel, || Ok(()))
        .unwrap()
        .is_empty());
    assert!(!records(&runtime, &preparation_id).exists());
    let receipt = source
        .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
        .unwrap();
    let statuses = source
        .runtime_statuses(&preparation_id, &cancel, || Ok(()))
        .unwrap();
    assert_eq!(statuses.len(), 1);
    assert!(
        matches!(&statuses[0].outcome, Outcome::Prepared { receipt:observed } if observed == &receipt)
    );
    drop(source);
    let mut reopened = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let statuses = reopened
        .runtime_statuses(&preparation_id, &cancel, || Ok(()))
        .unwrap();
    assert_eq!(statuses[0].id, receipt.id);
    assert!(
        matches!(&statuses[0].outcome, Outcome::Prepared { receipt:observed } if observed == &receipt)
    );
    let asset = output.join("Assets/raw.bin");
    let modified = fs::metadata(&asset).unwrap().modified().unwrap();
    fs::write(&asset, b"AFTER!").unwrap();
    OpenOptions::new()
        .write(true)
        .open(&asset)
        .unwrap()
        .set_times(FileTimes::new().set_modified(modified))
        .unwrap();
    assert!(reopened
        .verify_runtime(&preparation_id, &statuses[0].id, &cancel, || Ok(()))
        .is_err());
}

#[test]
fn runtime_data_is_materialized_from_original_locked_objects_and_native_records_survive_reopen() {
    let (runtime, preparation_id) = prepared(false);
    let original = fs::read(runtime.fixture.0.join("data/workspace.json")).unwrap();
    let modified = fs::metadata(runtime.fixture.0.join("data/Assets/raw.bin"))
        .unwrap()
        .modified()
        .unwrap();
    let output = runtime.fixture.0.join("RuntimeData");
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let receipt = source
        .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
        .unwrap();
    assert_eq!(receipt.format, "dustdesk-runtime-data-prepared");
    assert_eq!(receipt.files, 2);
    assert_eq!(receipt.directories, 2);
    assert!(!receipt.production_ready && !receipt.migration_complete);
    for name in ["workspace.json", "Assets/raw.bin"] {
        assert!(OpenOptions::new()
            .read(true)
            .open(output.join(name))
            .is_err());
        assert!(OpenOptions::new()
            .write(true)
            .open(output.join(name))
            .is_err());
    }
    assert!(OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("snapshot/Data/objects/000000.bin"))
        .is_err());
    assert!(fs::rename(output.join("Assets/空目录"), output.join("Assets/moved")).is_err());
    for name in ["intent.json", "inventory.json", "decision.json"] {
        assert!(OpenOptions::new()
            .write(true)
            .open(
                records(&runtime, &preparation_id)
                    .join(&receipt.id)
                    .join(name)
            )
            .is_err());
    }
    assert_eq!(
        source
            .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
            .unwrap(),
        receipt
    );
    assert_eq!(
        source
            .verify_runtime(&preparation_id, &receipt.id, &cancel, || Ok(()))
            .unwrap(),
        receipt
    );
    assert!(source
        .verify_runtime(
            &preparation_id,
            &uuid::Uuid::new_v4().to_string(),
            &cancel,
            || Ok(())
        )
        .is_err());
    assert!(source
        .prepare_runtime(
            &preparation_id,
            &runtime.fixture.0.join("another"),
            &cancel,
            || Ok(())
        )
        .is_err());
    assert!(!runtime.fixture.0.join("another").exists());
    assert_eq!(ids(&records(&runtime, &preparation_id)).len(), 1);
    drop(source);
    assert_eq!(fs::read(output.join("workspace.json")).unwrap(), original);
    assert_eq!(fs::read(output.join("Assets/raw.bin")).unwrap(), b"before");
    assert_eq!(
        fs::metadata(output.join("Assets/raw.bin"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert_eq!(
        fs::read_dir(output.join("Assets/空目录")).unwrap().count(),
        0
    );
    for name in [
        "objects",
        "snapshot.json",
        "browser-drafts.json",
        "lan-state.json",
        "workspace.lock",
    ] {
        assert!(!output.join(name).exists());
    }
    let decision = fs::read(
        records(&runtime, &preparation_id)
            .join(&receipt.id)
            .join("decision.json"),
    )
    .unwrap();
    let inventory = fs::read(
        records(&runtime, &preparation_id)
            .join(&receipt.id)
            .join("inventory.json"),
    )
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(&inventory)),
        receipt.inventory_sha256
    );
    let mut reopened = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert_eq!(
        reopened
            .verify_runtime(&preparation_id, &receipt.id, &cancel, || Ok(()))
            .unwrap(),
        receipt
    );
    assert!(OpenOptions::new()
        .write(true)
        .open(output.join("workspace.json"))
        .is_err());
    drop(reopened);
    assert_eq!(
        fs::read(
            records(&runtime, &preparation_id)
                .join(&receipt.id)
                .join("decision.json")
        )
        .unwrap(),
        decision
    );
    OpenOptions::new()
        .write(true)
        .open(output.join("workspace.json"))
        .unwrap();
}

#[test]
fn runtime_data_preserves_real_readonly_and_exact_last_write_time_after_all_handles_close() {
    let (runtime, preparation_id) = prepared(true);
    let _reset = ReadOnlyReset {
        paths: vec![
            runtime.fixture.0.join("data/Assets/raw.bin"),
            runtime.fixture.0.join("RuntimeData/Assets/raw.bin"),
        ],
        permissions: fs::metadata(runtime.fixture.0.join("data/workspace.json"))
            .unwrap()
            .permissions(),
    };
    let original = runtime.fixture.0.join("data/Assets/raw.bin");
    let output = runtime.fixture.0.join("RuntimeData");
    let modified = fs::metadata(&original).unwrap().modified().unwrap();
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let receipt = source
        .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
        .unwrap();
    assert!(fs::metadata(output.join("Assets/raw.bin"))
        .unwrap()
        .permissions()
        .readonly());
    source
        .verify_runtime(&preparation_id, &receipt.id, &cancel, || Ok(()))
        .unwrap();
    drop(source);
    assert!(OpenOptions::new()
        .write(true)
        .open(output.join("Assets/raw.bin"))
        .is_err());
    assert_eq!(
        fs::metadata(output.join("Assets/raw.bin"))
            .unwrap()
            .modified()
            .unwrap(),
        modified
    );
    assert_eq!(fs::read(output.join("Assets/raw.bin")).unwrap(), b"before");
    read_only(&original, false);
    read_only(&output.join("Assets/raw.bin"), false);
}

#[test]
fn runtime_data_never_overwrites_existing_directories_or_creates_inside_protected_sources() {
    let (runtime, preparation_id) = prepared(false);
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    for name in [
        "data/forbidden",
        "profile/forbidden",
        "installation/forbidden",
        "snapshot/forbidden",
    ] {
        let path = runtime.fixture.0.join(name);
        assert!(
            source
                .prepare_runtime(&preparation_id, &path, &cancel, || Ok(()))
                .is_err(),
            "{name}"
        );
        assert!(!path.exists());
    }
    let output = runtime.fixture.0.join("existing");
    fs::create_dir(&output).unwrap();
    fs::write(output.join("keep.bin"), b"do not touch").unwrap();
    assert!(source
        .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
        .is_err());
    assert_eq!(fs::read(output.join("keep.bin")).unwrap(), b"do not touch");
    assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
}

#[test]
fn runtime_data_partial_cancellation_and_authority_loss_release_output_but_never_promote_intent() {
    for cancellation in [false, true] {
        let (runtime, preparation_id) = prepared(false);
        let cancel = CancellationToken::new();
        let output = runtime.fixture.0.join("RuntimeData");
        let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        let observed = Cell::new(false);
        let current = || {
            if output.join("Assets/raw.bin").exists() {
                observed.set(true);
                if cancellation {
                    cancel.cancel();
                } else {
                    return Err("native source closed".into());
                }
            }
            Ok(())
        };
        assert!(source
            .prepare_runtime(&preparation_id, &output, &cancel, current)
            .is_err());
        assert!(observed.get());
        OpenOptions::new()
            .write(true)
            .open(output.join("Assets/raw.bin"))
            .unwrap();
        assert!(OpenOptions::new()
            .write(true)
            .open(runtime.fixture.0.join("data/Assets/raw.bin"))
            .is_err());
        drop(source);
        let runtime_id = ids(&records(&runtime, &preparation_id)).pop().unwrap();
        assert!(!records(&runtime, &preparation_id)
            .join(&runtime_id)
            .join("decision.json")
            .exists());
        let cancel = CancellationToken::new();
        let mut reopened = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        assert!(reopened
            .verify_runtime(&preparation_id, &runtime_id, &cancel, || Ok(()))
            .is_err());
        drop(reopened);
        let decision: serde_json::Value = serde_json::from_slice(
            &fs::read(
                records(&runtime, &preparation_id)
                    .join(&runtime_id)
                    .join("decision.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(decision["outcome"]["state"], "aborted");
        assert!(!output.join("workspace.json").exists());
    }
}

#[test]
fn runtime_data_final_source_revalidation_blocks_success_even_after_complete_inventory_publication()
{
    let (runtime, preparation_id) = prepared(false);
    let root = records(&runtime, &preparation_id);
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let observed = Cell::new(false);
    let current = || {
        if !observed.get()
            && root.exists()
            && ids(&root)
                .iter()
                .any(|id| root.join(id).join("inventory.json").exists())
        {
            fs::write(
                runtime.fixture.0.join("data/late.bin"),
                b"late source asset",
            )
            .unwrap();
            observed.set(true);
        }
        Ok(())
    };
    let output = runtime.fixture.0.join("RuntimeData");
    assert!(source
        .prepare_runtime(&preparation_id, &output, &cancel, current)
        .is_err());
    assert!(observed.get());
    drop(source);
    let id = ids(&root).pop().unwrap();
    assert!(root.join(&id).join("inventory.json").exists());
    assert!(!root.join(&id).join("decision.json").exists());
    assert_eq!(
        fs::read(output.join("workspace.json")).unwrap(),
        fs::read(runtime.fixture.0.join("data/workspace.json")).unwrap()
    );
}

#[test]
fn runtime_data_reopen_requires_original_physical_tree_and_fresh_hashes_not_only_native_receipt() {
    for mutation in [
        "bytes",
        "extra",
        "directory",
        "copy",
        "hardlink",
        "readonly",
    ] {
        let (runtime, preparation_id) = prepared(false);
        let output = runtime.fixture.0.join("RuntimeData");
        let cancel = CancellationToken::new();
        let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        let receipt = source
            .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
            .unwrap();
        drop(source);
        let decision_path = records(&runtime, &preparation_id)
            .join(&receipt.id)
            .join("decision.json");
        let decision = fs::read(&decision_path).unwrap();
        let asset = output.join("Assets/raw.bin");
        match mutation {
            "bytes" => {
                let modified = fs::metadata(&asset).unwrap().modified().unwrap();
                fs::write(&asset, b"AFTER!").unwrap();
                OpenOptions::new()
                    .write(true)
                    .open(&asset)
                    .unwrap()
                    .set_times(FileTimes::new().set_modified(modified))
                    .unwrap();
            }
            "extra" => fs::write(output.join("late.bin"), b"extra").unwrap(),
            "directory" => {
                fs::rename(
                    output.join("Assets/空目录"),
                    runtime.fixture.0.join("old-empty"),
                )
                .unwrap();
                fs::create_dir(output.join("Assets/空目录")).unwrap();
            }
            "copy" => {
                let old = runtime.fixture.0.join("old-output");
                fs::rename(&output, &old).unwrap();
                copy_tree(&old, &output);
            }
            "hardlink" => fs::hard_link(&asset, runtime.fixture.0.join("alias.bin")).unwrap(),
            _ => read_only(&asset, true),
        }
        let mut reopened = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        assert!(
            reopened
                .verify_runtime(&preparation_id, &receipt.id, &cancel, || Ok(()))
                .is_err(),
            "{mutation}"
        );
        drop(reopened);
        assert_eq!(fs::read(&decision_path).unwrap(), decision);
        if mutation == "readonly" {
            read_only(&asset, false);
        }
    }
}

#[test]
fn runtime_data_late_lock_file_or_asset_revokes_retained_confirmation() {
    for name in ["workspace.lock", "Assets/空目录/late.bin"] {
        let (runtime, preparation_id) = prepared(false);
        let output = runtime.fixture.0.join("RuntimeData");
        let cancel = CancellationToken::new();
        let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        source
            .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
            .unwrap();
        fs::write(output.join(name), b"not in the prepared runtime tree").unwrap();
        assert!(source.confirm(&cancel, || Ok(())).is_err(), "{name}");
        drop(source);
        OpenOptions::new()
            .write(true)
            .open(output.join("workspace.json"))
            .unwrap();
    }
}

#[test]
fn runtime_data_process_exit_at_intent_partial_data_inventory_or_decision_never_guesses_commit() {
    const CHILD: &str = "DUSTDESK_RUNTIME_DATA_CRASH_ROOT";
    if let Ok(root) = std::env::var(CHILD) {
        let runtime = std::mem::ManuallyDrop::new(Runtime {
            fixture: Fixture(root.into()),
        });
        let preparation_id = std::env::var("DUSTDESK_RUNTIME_DATA_PREPARATION_ID").unwrap();
        let stage = std::env::var("DUSTDESK_RUNTIME_DATA_CRASH_STAGE").unwrap();
        let output = runtime.fixture.0.join("RuntimeData");
        let record_root = records(&runtime, &preparation_id);
        let cancel = CancellationToken::new();
        let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        let current = || {
            if record_root.exists() {
                for id in ids(&record_root) {
                    let record = record_root.join(id);
                    let reached = match stage.as_str() {
                        "intent" => record.join("intent.json").exists() && !output.exists(),
                        "data" => {
                            output.join("Assets/raw.bin").exists()
                                && !output.join("workspace.json").exists()
                        }
                        "inventory" => {
                            record.join("inventory.json").exists()
                                && !record.join("decision.json").exists()
                        }
                        "decision" => record.join("decision.json").exists(),
                        _ => false,
                    };
                    if reached {
                        std::process::exit(93);
                    }
                }
            }
            Ok(())
        };
        source
            .prepare_runtime(&preparation_id, &output, &cancel, current)
            .unwrap();
        panic!("expected process interruption at {stage}");
    }
    for stage in ["intent", "data", "inventory", "decision"] {
        let (runtime, preparation_id) = prepared(false);
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "legacy_source::binding::tests::runtime::runtime_data_process_exit_at_intent_partial_data_inventory_or_decision_never_guesses_commit", "--nocapture"])
            .env(CHILD, &runtime.fixture.0).env("DUSTDESK_RUNTIME_DATA_PREPARATION_ID", &preparation_id)
            .env("DUSTDESK_RUNTIME_DATA_CRASH_STAGE", stage).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(93),
            "{stage}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let root = records(&runtime, &preparation_id);
        let cancel = CancellationToken::new();
        let mut reopened = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        let statuses = reopened
            .runtime_statuses(&preparation_id, &cancel, || Ok(()))
            .unwrap();
        assert_eq!(statuses.len(), 1);
        let id = statuses[0].id.clone();
        let result = reopened.verify_runtime(&preparation_id, &id, &cancel, || Ok(()));
        if stage == "decision" {
            assert!(result.is_ok());
        } else {
            assert!(result.is_err(), "{stage}");
        }
        drop(reopened);
        let decision: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join(&id).join("decision.json")).unwrap())
                .unwrap();
        assert_eq!(
            decision["outcome"]["state"],
            if stage == "decision" {
                "prepared"
            } else {
                "aborted"
            }
        );
        assert_eq!(
            fs::read(runtime.fixture.0.join("data/Assets/raw.bin")).unwrap(),
            b"before"
        );
    }
}
