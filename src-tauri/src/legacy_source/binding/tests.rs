use super::*;
use crate::{
    lan::files::tests::Fixture,
    legacy_source::{catalog, FILE_PATHS},
};
use std::{fs, fs::OpenOptions, os::windows::fs::OpenOptionsExt};

mod runtime;

struct Runtime {
    fixture: Fixture,
}
impl Runtime {
    fn new() -> Self {
        let fixture = Fixture::new();
        for relative in ["installation/resources", "data", "profile"] {
            fs::create_dir_all(fixture.0.join(relative)).unwrap();
        }
        for relative in FILE_PATHS {
            fs::write(
                fixture.0.join("installation").join(relative),
                b"test-code-only",
            )
            .unwrap();
        }
        fs::write(
            fixture.0.join("data/workspace.json"),
            br#"{"SchemaVersion":3,"unknown":"preserve"}"#,
        )
        .unwrap();
        Self { fixture }
    }
    fn locations(&self) -> Locations {
        Locations {
            installation: self.fixture.0.join("installation"),
            data: self.fixture.0.join("data"),
            user_data: self.fixture.0.join("profile"),
            browser_profile: self.fixture.0.join("profile"),
            workspace_sha256: format!(
                "{:x}",
                Sha256::digest(fs::read(self.fixture.0.join("data/workspace.json")).unwrap())
            ),
        }
    }
    fn bind(&self, locations: Locations) -> Result<BoundSource, String> {
        let mut release = catalog().unwrap().releases.remove(0);
        for file in &mut release.files {
            file.size = 14;
            file.sha256 = format!("{:x}", Sha256::digest(b"test-code-only"));
        }
        let cancel = CancellationToken::new();
        let installation = PinnedInstallation::open_trusted(
            &locations.installation,
            &[release],
            &cancel,
            &|| Ok(()),
        )?;
        BoundSource::bind(installation, locations, &cancel, &|| Ok(()))
    }
    fn open(&self) -> Result<BoundSource, String> {
        self.bind(self.locations())
    }
}

#[test]
fn binds_actual_profile_workspace_and_fixed_browser_origin_without_creating_lan() {
    let runtime = Runtime::new();
    let mut source = runtime.open().unwrap();
    let proof = serde_json::to_value(source.binding()).unwrap();
    assert_eq!(proof["format"], "dustdesk-live-legacy-source-binding");
    assert_eq!(proof["scope"], "prepared-electron-runtime");
    assert_eq!(proof["userDataIdentity"], proof["browserProfileIdentity"]);
    assert!(proof["lanStorageIdentity"].is_null());
    assert_eq!(proof["productionReady"], false);
    assert_eq!(proof["migrationComplete"], false);
    assert!(proof["browserEntry"]
        .as_str()
        .unwrap()
        .ends_with("/installation/resources/app.asar/out/renderer/index.html"));
    source
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap();
    assert!(!runtime.fixture.0.join("profile/LanTransfers").exists());
}

#[test]
fn shares_workspace_reading_but_blocks_writes_and_path_substitution_for_whole_lease() {
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let path = runtime.fixture.0.join("data/workspace.json");
    let bytes = fs::read(&path).unwrap();
    assert!(fs::write(&path, b"changed").is_err());
    assert!(fs::rename(&path, path.with_extension("moved")).is_err());
    for relative in ["installation", "data", "profile"] {
        assert!(fs::rename(
            runtime.fixture.0.join(relative),
            runtime.fixture.0.join(format!("{relative}-moved"))
        )
        .is_err());
    }
    drop(source);
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::write(path, bytes).unwrap();
}

#[test]
fn supports_real_persistent_session_partition_but_not_an_unrelated_browser_profile() {
    let runtime = Runtime::new();
    let partition = runtime.fixture.0.join("profile/Partitions/selected");
    fs::create_dir_all(&partition).unwrap();
    let mut locations = runtime.locations();
    locations.browser_profile = partition;
    let mut source = runtime.bind(locations).unwrap();
    source
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap();
    drop(source);
    let mut locations = runtime.locations();
    locations.browser_profile = runtime.fixture.0.clone();
    assert!(runtime
        .bind(locations)
        .err()
        .unwrap()
        .contains("不属于当前 userData"));
}

#[test]
fn exact_working_data_checkpoint_is_required_and_default_paths_cannot_substitute_for_it() {
    let runtime = Runtime::new();
    let mut locations = runtime.locations();
    locations.workspace_sha256 = "0".repeat(64);
    assert!(runtime
        .bind(locations)
        .err()
        .unwrap()
        .contains("不匹配原生维护"));
    let mut locations = runtime.locations();
    locations.workspace_sha256 = "forged".into();
    assert!(
        BoundSource::open(locations, &CancellationToken::new(), || Ok(()))
            .err()
            .unwrap()
            .contains("检查点摘要无效")
    );
}

#[test]
fn source_data_profile_and_installation_cannot_physically_overlap() {
    let runtime = Runtime::new();
    for target in [
        runtime.fixture.0.clone(),
        runtime.fixture.0.join("profile"),
        runtime.fixture.0.join("installation"),
    ] {
        let mut locations = runtime.locations();
        locations.data = target;
        assert!(runtime
            .bind(locations)
            .err()
            .unwrap()
            .contains("分离的物理目录"));
    }
}

#[test]
fn existing_workspace_reader_is_allowed_but_existing_writer_is_rejected() {
    let runtime = Runtime::new();
    let path = runtime.fixture.0.join("data/workspace.json");
    let reader = OpenOptions::new()
        .read(true)
        .share_mode(1 | 2 | 4)
        .open(&path)
        .unwrap();
    runtime.open().unwrap();
    drop(reader);
    let writer = OpenOptions::new()
        .write(true)
        .share_mode(1 | 2 | 4)
        .open(&path)
        .unwrap();
    assert!(runtime.open().is_err());
    drop(writer);
    runtime.open().unwrap();
}

#[test]
fn linked_workspace_and_directory_substitutes_are_rejected_without_repairing_them() {
    let runtime = Runtime::new();
    let path = runtime.fixture.0.join("data/workspace.json");
    let alias = runtime.fixture.0.join("alias");
    fs::hard_link(&path, &alias).unwrap();
    assert!(runtime.open().is_err());
    fs::remove_file(&alias).unwrap();
    let mut locations = runtime.locations();
    locations.workspace_sha256 = "0".repeat(64);
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert!(runtime.bind(locations).is_err());
}

#[test]
fn lan_directory_is_bound_but_state_is_not_claimed_as_frozen() {
    let runtime = Runtime::new();
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    fs::create_dir(&lan).unwrap();
    fs::write(lan.join("state.json"), b"not parsed by directory binding").unwrap();
    let mut source = runtime.open().unwrap();
    assert!(serde_json::to_value(source.binding()).unwrap()["lanStorageIdentity"].is_object());
    fs::write(lan.join("state.json"), b"LAN still running").unwrap();
    source
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap();
    assert!(fs::rename(&lan, lan.with_extension("moved")).is_err());
}

#[test]
fn late_lan_initialization_revokes_the_directory_binding() {
    let runtime = Runtime::new();
    let mut source = runtime.open().unwrap();
    fs::create_dir(runtime.fixture.0.join("profile/LanTransfers")).unwrap();
    assert!(source
        .confirm(&CancellationToken::new(), || Ok(()))
        .unwrap_err()
        .contains("实际 LAN 存储目录"));
}

#[test]
fn lan_appearing_during_code_rehash_is_rejected_by_final_layout_check() {
    let runtime = Runtime::new();
    let mut source = runtime.open().unwrap();
    let checks = std::cell::Cell::new(0);
    let error = source
        .confirm(&CancellationToken::new(), || {
            checks.set(checks.get() + 1);
            if checks.get() == 8 {
                fs::create_dir(runtime.fixture.0.join("profile/LanTransfers")).unwrap();
            }
            Ok(())
        })
        .unwrap_err();
    assert!(error.contains("实际 LAN 存储目录"), "{error}");
}

#[test]
fn cancellation_and_native_authority_loss_block_confirmation_without_writing_source() {
    let runtime = Runtime::new();
    let mut source = runtime.open().unwrap();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(source.confirm(&cancel, || Ok(())).is_err());
    assert_eq!(
        source
            .confirm(&CancellationToken::new(), || Err(
                "revoked-native-authority".into()
            ))
            .unwrap_err(),
        "revoked-native-authority"
    );
    drop(source);
    runtime.open().unwrap();
}

#[test]
fn browser_binding_matches_existing_electron_native_binding_serialization() {
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let binding = source.binding();
    let expected = format!("{{\"version\":1,\"runtime\":\"electron\",\"entry\":{},\"profile\":{{\"volume\":\"{:016x}\",\"file\":\"{:016x}\"}}}}",
        serde_json::to_string(&binding.browser_entry).unwrap(), binding.browser_profile_identity.volume, binding.browser_profile_identity.index);
    assert_eq!(
        binding.browser_binding,
        format!("{:x}", Sha256::digest(expected.as_bytes()))
    );
}

fn snapshot_drafts(binding: &Binding) -> Vec<u8> {
    let payload = serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":"2026-11-13T04:00:00.000Z",
        "source":{"runtime":"electron","appVersion":"1.0.2","workspaceFingerprint":binding.workspace_sha256},
        "entries":[{"key":"widget-task-draft:v1:todo","value":"{\"title\":\"原始🪶\",\"unknown\":7}"}]}).to_string();
    serde_json::json!({"format":"dustdesk-browser-drafts","version":1,
        "sha256":format!("{:x}",Sha256::digest(payload.as_bytes())),"payload":payload})
    .to_string()
    .into_bytes()
}

fn snapshot_catalog_path(runtime: &Runtime, binding: &Binding) -> PathBuf {
    runtime
        .fixture
        .0
        .join("profile/LegacySnapshotPreparation")
        .join(format!(
            "{:016x}-{:016x}",
            binding.data_identity.volume, binding.data_identity.index
        ))
}

fn initialize_snapshot_lan(runtime: &Runtime) -> (Vec<u8>, Vec<u8>) {
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    fs::create_dir(&lan).unwrap();
    {
        let store = crate::lan::state_store::StateStore::open(&lan).unwrap();
        store.ensure_identity(&CancellationToken::new()).unwrap();
    }
    let state = b"{\r\n\"enabled\":true,\"trusted\":[],\"tasks\":[],\"future\":{\"keep\":7}\r\n}";
    fs::write(lan.join("state.json"), state).unwrap();
    (state.to_vec(), fs::read(lan.join("identity.json")).unwrap())
}

#[test]
fn live_source_snapshot_composes_actual_data_raw_browser_and_exclusively_frozen_original_lan() {
    use crate::managed_snapshot::{bundle, preparation::Outcome};
    let runtime = Runtime::new();
    let (lan_bytes, identity_bytes) = initialize_snapshot_lan(&runtime);
    fs::create_dir_all(runtime.fixture.0.join("data/Assets/空目录")).unwrap();
    fs::write(
        runtime.fixture.0.join("data/Assets/原始.bin"),
        [0, 255, 13, 10],
    )
    .unwrap();
    fs::write(
        runtime.fixture.0.join("profile/private-browser-file"),
        "not a snapshot component",
    )
    .unwrap();
    let source = runtime.open().unwrap();
    let binding = source.binding().clone();
    let drafts = snapshot_drafts(&binding);
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let lan_root = runtime.fixture.0.join("profile/LanTransfers");
    assert!(crate::lan::state_store::StateStore::open(&lan_root).is_err());
    for name in ["state.json", "identity.json"] {
        assert!(OpenOptions::new()
            .write(true)
            .open(lan_root.join(name))
            .is_err());
    }
    let destination = runtime.fixture.0.join("snapshot");
    let status = frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let Outcome::HandoffPrepared { receipt } = status.outcome else {
        panic!("not a prepared handoff")
    };
    let manifest = bundle::verify_receipt(&destination, &receipt, &cancel).unwrap();
    assert_eq!(manifest.components.source, Some(binding.clone()));
    assert_eq!(
        manifest.components.lan.app_profile,
        binding.user_data_identity
    );
    assert_eq!(
        manifest.components.lan.lan_profile,
        binding.lan_storage_identity
    );
    assert_eq!(manifest.data.files, 2);
    assert_eq!(manifest.data.directories, 2);
    assert_eq!(
        fs::read(destination.join("browser-drafts.json")).unwrap(),
        drafts
    );
    assert_eq!(
        fs::read(destination.join("lan-state.json")).unwrap(),
        lan_bytes
    );
    let mut names: Vec<_> = fs::read_dir(&destination)
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    names.sort();
    assert_eq!(
        names,
        [
            "Data",
            "browser-drafts.json",
            "handoff.json",
            "lan-state.json"
        ]
        .map(std::ffi::OsString::from)
    );
    assert_eq!(
        frozen
            .verify_prepared(&status.id, &cancel, || Ok(()))
            .unwrap(),
        receipt
    );
    assert!(OpenOptions::new()
        .write(true)
        .open(destination.join("lan-state.json"))
        .is_err());
    assert_eq!(
        frozen
            .verify_prepared(&status.id, &cancel, || Ok(()))
            .unwrap(),
        receipt
    );
    assert!(OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("data/workspace.json"))
        .is_err());
    assert!(OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("installation/DustDesk.exe"))
        .is_err());
    drop(frozen);
    assert_eq!(
        fs::read(lan_root.join("identity.json")).unwrap(),
        identity_bytes
    );
    assert_eq!(fs::read(lan_root.join("state.json")).unwrap(), lan_bytes);
    crate::lan::state_store::StateStore::open(&lan_root).unwrap();
    OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("data/workspace.json"))
        .unwrap();
}

#[test]
fn live_source_snapshot_without_lan_does_not_initialize_identity_or_capture_browser_profile_files()
{
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let destination = runtime.fixture.0.join("snapshot");
    let status = frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let receipt = frozen
        .verify_prepared(&status.id, &cancel, || Ok(()))
        .unwrap();
    drop(frozen);
    let manifest =
        crate::managed_snapshot::bundle::verify_receipt(&destination, &receipt, &cancel).unwrap();
    assert!(manifest.components.lan.lan_profile.is_none());
    assert!(manifest.components.lan.original_identity.is_none());
    assert!(!runtime.fixture.0.join("profile/LanTransfers").exists());
    assert!(!destination.join("lan-state.json").exists());
}

#[test]
fn live_source_snapshot_refuses_actual_lan_owner_or_writer_and_releases_consumed_source() {
    let runtime = Runtime::new();
    initialize_snapshot_lan(&runtime);
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let owner = crate::lan::state_store::StateStore::open(&lan).unwrap();
    assert!(runtime
        .open()
        .unwrap()
        .freeze(&CancellationToken::new(), || Ok(()))
        .is_err());
    drop(owner);
    let writer = OpenOptions::new()
        .write(true)
        .open(lan.join("state.json"))
        .unwrap();
    assert!(runtime
        .open()
        .unwrap()
        .freeze(&CancellationToken::new(), || Ok(()))
        .is_err());
    drop(writer);
    runtime
        .open()
        .unwrap()
        .freeze(&CancellationToken::new(), || Ok(()))
        .unwrap();
    assert!(!runtime
        .fixture
        .0
        .join("profile/LegacySnapshotPreparation")
        .exists());
}

#[test]
fn live_source_snapshot_rejects_protected_destinations_and_late_lan_before_publishing() {
    for relative in ["installation/snapshot", "data/snapshot", "profile/snapshot"] {
        let runtime = Runtime::new();
        let source = runtime.open().unwrap();
        let drafts = snapshot_drafts(source.binding());
        let mut frozen = source.freeze(&CancellationToken::new(), || Ok(())).unwrap();
        assert!(frozen
            .prepare(
                &runtime.fixture.0.join(relative),
                &uuid::Uuid::new_v4().to_string(),
                &drafts,
                &CancellationToken::new(),
                || Ok(())
            )
            .is_err());
        assert!(!runtime.fixture.0.join(relative).exists());
        assert!(!runtime
            .fixture
            .0
            .join("profile/LegacySnapshotPreparation")
            .exists());
    }
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let mut frozen = source.freeze(&CancellationToken::new(), || Ok(())).unwrap();
    fs::create_dir(runtime.fixture.0.join("profile/LanTransfers")).unwrap();
    let destination = runtime.fixture.0.join("snapshot");
    assert!(frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &CancellationToken::new(),
            || Ok(())
        )
        .is_err());
    assert!(!destination.exists());
}

#[test]
fn live_source_snapshot_lost_authority_during_copy_leaves_only_aborted_native_intent() {
    use crate::managed_snapshot::preparation::{Catalog, Outcome};
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let binding = source.binding().clone();
    let drafts = snapshot_drafts(&binding);
    let mut frozen = source.freeze(&CancellationToken::new(), || Ok(())).unwrap();
    let destination = runtime.fixture.0.join("snapshot");
    let error = frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &CancellationToken::new(),
            || {
                if destination.join("Data/objects").exists() {
                    Err("native-maintenance-revoked".into())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();
    assert_eq!(error, "native-maintenance-revoked");
    assert!(!destination.join("handoff.json").exists());
    let catalog = Catalog::open(
        &runtime.fixture.0.join("data"),
        &snapshot_catalog_path(&runtime, &binding),
    )
    .unwrap();
    let statuses = catalog.recover().unwrap();
    assert_eq!(statuses.len(), 1);
    assert!(matches!(statuses[0].outcome, Outcome::Aborted));
    assert!(catalog
        .verify_handoff(&statuses[0].id, &CancellationToken::new())
        .is_err());
}

#[test]
fn live_source_snapshot_prepared_record_cannot_reauthorize_a_replaced_browser_profile() {
    let runtime = Runtime::new();
    let profile = runtime.fixture.0.join("profile/Partitions/source");
    fs::create_dir_all(&profile).unwrap();
    let mut locations = runtime.locations();
    locations.browser_profile = profile.clone();
    let source = runtime.bind(locations).unwrap();
    let drafts = snapshot_drafts(source.binding());
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let destination = runtime.fixture.0.join("snapshot");
    let status = frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    frozen
        .verify_prepared(&status.id, &cancel, || Ok(()))
        .unwrap();
    drop(frozen);
    fs::rename(&profile, profile.with_extension("old")).unwrap();
    fs::create_dir(&profile).unwrap();
    let mut locations = runtime.locations();
    locations.browser_profile = profile;
    let mut replacement = runtime
        .bind(locations)
        .unwrap()
        .freeze(&cancel, || Ok(()))
        .unwrap();
    let error = replacement
        .verify_prepared(&status.id, &cancel, || Ok(()))
        .unwrap_err();
    assert!(error.contains("不属于当前仍存活的来源"), "{error}");
}

#[test]
fn live_source_snapshot_prepared_record_cannot_reauthorize_changed_original_lan_state() {
    let runtime = Runtime::new();
    initialize_snapshot_lan(&runtime);
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let status = frozen
        .prepare(
            &runtime.fixture.0.join("snapshot"),
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    drop(frozen);
    fs::write(
        runtime.fixture.0.join("profile/LanTransfers/state.json"),
        b"{\"enabled\":false,\"trusted\":[],\"tasks\":[]}",
    )
    .unwrap();
    let mut replacement = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let error = replacement
        .verify_prepared(&status.id, &cancel, || Ok(()))
        .unwrap_err();
    assert!(error.contains("不属于当前仍存活的来源"), "{error}");
}

#[test]
fn live_source_snapshot_tampered_component_source_is_not_made_consistent_by_manifest_rehash() {
    use crate::managed_snapshot::{bundle, preparation::Outcome};
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let destination = runtime.fixture.0.join("snapshot");
    let status = frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let Outcome::HandoffPrepared { receipt } = status.outcome else {
        panic!("not prepared")
    };
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(destination.join("handoff.json")).unwrap()).unwrap();
    for field in [
        "dataIdentity",
        "userDataIdentity",
        "browserProfileIdentity",
        "workspace",
        "browserBinding",
        "scope",
    ] {
        let mut value = original.clone();
        let binding = &mut value["components"]["source"];
        match field {
            "workspace" => binding[field]["size"] = serde_json::json!(1),
            "scope" => binding[field] = serde_json::json!("historical-profile-authenticated"),
            "browserBinding" => binding[field] = serde_json::json!("0".repeat(64)),
            _ => binding[field]["index"] = serde_json::json!("0000000000000001"),
        }
        let bytes = serde_json::to_vec(&value).unwrap();
        fs::write(destination.join("handoff.json"), &bytes).unwrap();
        let digest = format!("{:x}", Sha256::digest(&bytes));
        assert!(
            bundle::verify(&destination, &digest, &cancel).is_err(),
            "{field}"
        );
        assert!(bundle::verify_receipt(&destination, &receipt, &cancel).is_err());
    }
}

#[test]
fn live_source_snapshot_rejects_non_electron_archives_and_cancelled_native_authority() {
    let runtime = Runtime::new();
    let source = runtime.open().unwrap();
    let mut archive: serde_json::Value =
        serde_json::from_slice(&snapshot_drafts(source.binding())).unwrap();
    let mut payload: serde_json::Value =
        serde_json::from_str(archive["payload"].as_str().unwrap()).unwrap();
    payload["source"]["runtime"] = serde_json::json!("tauri");
    let payload = payload.to_string();
    archive["payload"] = serde_json::json!(payload);
    archive["sha256"] = serde_json::json!(format!("{:x}", Sha256::digest(payload.as_bytes())));
    let drafts = serde_json::to_vec(&archive).unwrap();
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let destination = runtime.fixture.0.join("snapshot");
    assert!(frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(())
        )
        .is_err());
    assert!(!destination.exists());
    cancel.cancel();
    assert!(frozen
        .prepare(
            &destination,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(())
        )
        .is_err());
    assert!(!destination.exists());
}

fn prepared_runtime_with_asset() -> (Runtime, String) {
    let runtime = Runtime::new();
    fs::create_dir_all(runtime.fixture.0.join("data/Assets/空目录")).unwrap();
    fs::write(runtime.fixture.0.join("data/Assets/raw.bin"), b"before").unwrap();
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let cancel = CancellationToken::new();
    let mut frozen = source.freeze(&cancel, || Ok(())).unwrap();
    let status = frozen
        .prepare(
            &runtime.fixture.0.join("snapshot"),
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    drop(frozen);
    (runtime, status.id)
}

#[test]
fn live_source_snapshot_reopened_preparation_rejects_changed_asset_bytes() {
    let (runtime, id) = prepared_runtime_with_asset();
    fs::write(runtime.fixture.0.join("data/Assets/raw.bin"), b"AFTER!").unwrap();
    let cancel = CancellationToken::new();
    let mut frozen = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert!(frozen.verify_prepared(&id, &cancel, || Ok(())).is_err());
}

#[test]
fn live_source_snapshot_verified_inventory_keeps_asset_handles_until_close() {
    let (runtime, id) = prepared_runtime_with_asset();
    let asset = runtime.fixture.0.join("data/Assets/raw.bin");
    let cancel = CancellationToken::new();
    let mut frozen = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let receipt = frozen.verify_prepared(&id, &cancel, || Ok(())).unwrap();
    let target = runtime.fixture.0.join("snapshot");
    for relative in [
        "handoff.json",
        "browser-drafts.json",
        "Data/snapshot.json",
        "Data/objects/000000.bin",
    ] {
        let path = target.join(relative);
        assert!(
            OpenOptions::new().write(true).open(&path).is_err(),
            "verified target handle was released: {relative}"
        );
        assert!(fs::remove_file(&path).is_err(), "{relative}");
    }
    let identity = &frozen.binding().data_identity;
    let catalog = runtime
        .fixture
        .0
        .join("profile/LegacySnapshotPreparation")
        .join(format!("{:016x}-{:016x}", identity.volume, identity.index));
    for relative in ["intent.json", "decision.json"] {
        assert!(OpenOptions::new()
            .write(true)
            .open(catalog.join(&id).join(relative))
            .is_err());
    }
    assert!(OpenOptions::new().write(true).open(&asset).is_err());
    assert!(fs::remove_file(&asset).is_err());
    assert!(frozen
        .verify_prepared(&uuid::Uuid::new_v4().to_string(), &cancel, || Ok(()))
        .is_err());
    let rejected = runtime.fixture.0.join("second-snapshot");
    let drafts = snapshot_drafts(frozen.binding());
    assert!(frozen
        .prepare(
            &rejected,
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(())
        )
        .is_err());
    assert!(!rejected.exists());
    assert_eq!(
        frozen.verify_prepared(&id, &cancel, || Ok(())).unwrap(),
        receipt
    );
    drop(frozen);
    fs::write(asset, b"released").unwrap();
    OpenOptions::new()
        .write(true)
        .open(target.join("handoff.json"))
        .unwrap();
    OpenOptions::new()
        .write(true)
        .open(catalog.join(&id).join("decision.json"))
        .unwrap();
}

#[test]
fn live_source_snapshot_target_late_entry_revokes_the_retained_session() {
    let (runtime, id) = prepared_runtime_with_asset();
    let cancel = CancellationToken::new();
    let mut frozen = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    frozen.verify_prepared(&id, &cancel, || Ok(())).unwrap();
    fs::write(
        runtime.fixture.0.join("snapshot/Data/objects/late.bin"),
        b"extra",
    )
    .unwrap();
    assert!(frozen.confirm(&cancel, || Ok(())).is_err());
    assert!(frozen.verify_prepared(&id, &cancel, || Ok(())).is_err());
    assert!(OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("snapshot/handoff.json"))
        .is_err());
    drop(frozen);
    OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("snapshot/handoff.json"))
        .unwrap();
}
