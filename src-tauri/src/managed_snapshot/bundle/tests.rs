use super::*;
use crate::{
    lan::state_store::StateStore,
    managed_snapshot::preparation::{Catalog, Outcome},
};
use serde_json::{json, Value};
use std::{path::PathBuf, process::Command};

mod retention;

struct Fixture {
    root: PathBuf,
    profile: PathBuf,
    data: PathBuf,
    catalog: PathBuf,
    destination: PathBuf,
    fingerprint: String,
    drafts: Vec<u8>,
    request: String,
}
impl Fixture {
    fn new(lan: bool) -> Self {
        let root =
            std::env::temp_dir().join(format!("dustdesk-handoff-bundle-test-{}", Uuid::new_v4()));
        let profile = root.join("Profile");
        let data = profile.join("Data");
        let catalog = profile.join("NativePreparation");
        fs::create_dir_all(data.join("Assets/空目录")).unwrap();
        fs::create_dir(&catalog).unwrap();
        let bytes = b"{\r\n  \"SchemaVersion\":3, \"Notes\":[]\r\n}\r\n";
        fs::write(data.join("workspace.json"), bytes).unwrap();
        fs::write(data.join("Assets/中文.bin"), [0, 255, 91]).unwrap();
        if lan {
            let lan = profile.join("LanTransfers");
            fs::create_dir(&lan).unwrap();
            let store = StateStore::open(&lan).unwrap();
            store.ensure_identity(&CancellationToken::new()).unwrap();
            fs::write(
                lan.join("state.json"),
                b"{\r\n\"enabled\":true, \"tasks\":[], \"trusted\":[], \"future\":7\r\n}",
            )
            .unwrap();
        }
        let fingerprint = hash(bytes);
        let drafts = drafts(&fingerprint);
        Self {
            destination: root.join("Handoff"),
            root,
            profile,
            data,
            catalog,
            fingerprint,
            drafts,
            request: Uuid::new_v4().to_string(),
        }
    }
    fn prepare(
        &self,
        catalog: &Catalog,
        lan: &mut Frozen,
    ) -> crate::managed_snapshot::preparation::Status {
        catalog
            .prepare_handoff(
                &self.destination,
                Inputs {
                    request_id: &self.request,
                    workspace_sha256: &self.fingerprint,
                    drafts: &self.drafts,
                    browser_binding: &"a".repeat(64),
                    lan,
                    source: None,
                },
                &CancellationToken::new(),
                || Ok(()),
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}
fn drafts(fingerprint: &str) -> Vec<u8> {
    let payload = json!({"id":Uuid::new_v4().to_string(),"createdAt":"2026-11-12T00:00:00.000Z","source":{"runtime":"tauri","appVersion":"1.0.2","workspaceFingerprint":fingerprint},"entries":[{"key":"widget-task-draft:v1:todo","value":"{\"title\":\"原文🪶\",\"requestId\":\"same-input\"}"}]}).to_string();
    json!({"format":"dustdesk-browser-drafts","version":1,"sha256":hash(payload.as_bytes()),"payload":payload}).to_string().into_bytes()
}
fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let target = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

#[test]
fn data_raw_drafts_and_lan_state_are_bound_in_one_native_decision_without_exporting_private_material(
) {
    let fixture = Fixture::new(true);
    let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    let state = fs::read(fixture.profile.join("LanTransfers/state.json")).unwrap();
    let mut lan = Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).unwrap();
    let status = fixture.prepare(&catalog, &mut lan);
    let receipt = catalog
        .verify_handoff(&status.id, &CancellationToken::new())
        .unwrap();
    assert!(catalog
        .verify_prepared(&status.id, &CancellationToken::new())
        .is_err());
    assert_eq!(
        fs::read(fixture.destination.join("browser-drafts.json")).unwrap(),
        fixture.drafts
    );
    assert_eq!(
        fs::read(fixture.destination.join("lan-state.json")).unwrap(),
        state
    );
    let manifest =
        verify_receipt(&fixture.destination, &receipt, &CancellationToken::new()).unwrap();
    assert_eq!(manifest.components.lan, *lan.checkpoint());
    assert_eq!(manifest.data.workspace_sha256, fixture.fingerprint);
    assert_eq!(manifest.identity_mode, "original-profile-only");
    assert_eq!(
        manifest.external_transfer_files,
        "original-locations-required"
    );
    let serialized = fs::read_to_string(fixture.destination.join(MANIFEST)).unwrap();
    assert!(!serialized.contains("BEGIN"));
    assert!(!serialized.contains("\"key\""));
    assert!(!fixture.destination.join("identity.json").exists());
    assert!(StateStore::open(&fixture.profile.join("LanTransfers")).is_err());
    let intent: Value = serde_json::from_slice(
        &fs::read(fixture.catalog.join(&status.id).join("intent.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(intent["version"], 2);
    assert_eq!(intent["componentsSha256"], receipt.components_sha256);
    drop(lan);
    drop(catalog);
    let reopened = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    assert!(matches!(
        reopened.recover().unwrap()[0].outcome,
        Outcome::HandoffPrepared { .. }
    ));
    reopened
        .verify_handoff(&status.id, &CancellationToken::new())
        .unwrap();
}

#[test]
fn unused_lan_remains_absent_and_a_portable_copy_has_integrity_but_no_original_directory_authority()
{
    let fixture = Fixture::new(false);
    let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    let mut lan = Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).unwrap();
    let status = fixture.prepare(&catalog, &mut lan);
    let receipt = catalog
        .verify_handoff(&status.id, &CancellationToken::new())
        .unwrap();
    assert!(!fixture.profile.join("LanTransfers").exists());
    assert!(!fixture.destination.join("lan-state.json").exists());
    let copied = fixture.root.join("copied");
    copy_tree(&fixture.destination, &copied);
    verify(&copied, &receipt.manifest_sha256, &CancellationToken::new()).unwrap();
    assert!(verify_receipt(&copied, &receipt, &CancellationToken::new()).is_err());
}

#[test]
fn completed_inner_data_or_bundle_manifest_never_substitutes_for_the_outer_native_decision_after_process_exit(
) {
    const CHILD: &str = "DUSTDESK_HANDOFF_BUNDLE_CRASH_ROOT";
    if let Some(root) = std::env::var_os(CHILD) {
        let root = PathBuf::from(root);
        let data = root.join("Profile/Data");
        let profile = root.join("Profile");
        let destination = root.join("Handoff");
        let catalog_path = root.join("Profile/NativePreparation");
        let catalog = Catalog::open(&data, &catalog_path).unwrap();
        let fingerprint = hash(&fs::read(data.join("workspace.json")).unwrap());
        let drafts = drafts(&fingerprint);
        let mut lan = Frozen::capture(&profile, &CancellationToken::new(), || Ok(())).unwrap();
        let stage = std::env::var("DUSTDESK_HANDOFF_BUNDLE_CRASH_STAGE").unwrap();
        catalog
            .prepare_handoff(
                &destination,
                Inputs {
                    request_id: &Uuid::new_v4().to_string(),
                    workspace_sha256: &fingerprint,
                    drafts: &drafts,
                    browser_binding: &"a".repeat(64),
                    lan: &mut lan,
                    source: None,
                },
                &CancellationToken::new(),
                || {
                    let intent = fs::read_dir(&catalog_path)
                        .unwrap()
                        .any(|entry| entry.unwrap().path().join("intent.json").is_file());
                    if (stage == "intent" && intent)
                        || (stage == "data" && destination.join("Data/snapshot.json").exists())
                        || (stage == "bundle" && destination.join(MANIFEST).exists())
                    {
                        std::process::exit(89);
                    }
                    Ok(())
                },
            )
            .unwrap();
        std::process::exit(89);
    }
    for stage in ["intent", "data", "bundle", "decision"] {
        let fixture = Fixture::new(true);
        let output = Command::new(std::env::current_exe().unwrap()).args(["--exact", "managed_snapshot::bundle::tests::completed_inner_data_or_bundle_manifest_never_substitutes_for_the_outer_native_decision_after_process_exit", "--nocapture"])
            .env(CHILD, &fixture.root).env("DUSTDESK_HANDOFF_BUNDLE_CRASH_STAGE", stage).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(89),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
        let statuses = catalog.recover().unwrap();
        assert_eq!(statuses.len(), 1);
        if stage == "decision" {
            assert!(matches!(
                statuses[0].outcome,
                Outcome::HandoffPrepared { .. }
            ));
            catalog
                .verify_handoff(&statuses[0].id, &CancellationToken::new())
                .unwrap();
        } else {
            assert!(matches!(statuses[0].outcome, Outcome::Aborted));
            assert!(catalog
                .verify_handoff(&statuses[0].id, &CancellationToken::new())
                .is_err());
        }
        assert_eq!(
            fixture.destination.join("Data/snapshot.json").exists(),
            stage != "intent"
        );
        assert_eq!(
            fixture.destination.join(MANIFEST).exists(),
            matches!(stage, "bundle" | "decision")
        );
    }
}

#[test]
fn altered_components_missing_or_extra_files_and_wrong_source_checkpoints_fail_verification() {
    for mode in [
        "drafts",
        "state",
        "extra",
        "missing",
        "header",
        "lan-proof",
        "data-summary",
    ] {
        let fixture = Fixture::new(true);
        let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
        let mut lan =
            Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).unwrap();
        let status = fixture.prepare(&catalog, &mut lan);
        let receipt = catalog
            .verify_handoff(&status.id, &CancellationToken::new())
            .unwrap();
        let manifest_path = fixture.destination.join(MANIFEST);
        let mut manifest: Value =
            serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
        match mode {
            "drafts" => {
                fs::write(
                    fixture.destination.join("browser-drafts.json"),
                    drafts(&"b".repeat(64)),
                )
                .unwrap();
            }
            "state" => {
                fs::write(fixture.destination.join("lan-state.json"), b"{}").unwrap();
            }
            "extra" => {
                fs::write(fixture.destination.join("identity.json"), b"never accepted").unwrap();
            }
            "missing" => {
                fs::remove_file(fixture.destination.join("browser-drafts.json")).unwrap();
            }
            "header" => {
                manifest["identityMode"] = json!("new-identity-allowed");
            }
            "lan-proof" => {
                manifest["components"]["lan"]["originalIdentity"]["file"]["sha256"] = json!("bad");
            }
            "data-summary" => {
                manifest["data"]["files"] = json!(999);
            }
            _ => unreachable!(),
        }
        let bytes = serde_json::to_vec(&manifest).unwrap();
        fs::write(&manifest_path, &bytes).unwrap();
        assert!(
            verify(
                &fixture.destination,
                &hash(&bytes),
                &CancellationToken::new()
            )
            .is_err(),
            "{mode}"
        );
        assert!(verify_receipt(&fixture.destination, &receipt, &CancellationToken::new()).is_err());
    }
}

#[test]
fn invalid_browser_binding_or_different_workspace_drafts_fail_before_creating_native_intent_or_output(
) {
    let fixture = Fixture::new(false);
    let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    let mut lan = Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).unwrap();
    for wrong in [false, true] {
        let drafts = if wrong {
            drafts(&"b".repeat(64))
        } else {
            fixture.drafts.clone()
        };
        let binding = if wrong {
            "a".repeat(64)
        } else {
            "renderer-claim".into()
        };
        assert!(catalog
            .prepare_handoff(
                &fixture.destination,
                Inputs {
                    request_id: &fixture.request,
                    workspace_sha256: &fixture.fingerprint,
                    drafts: &drafts,
                    browser_binding: &binding,
                    lan: &mut lan,
                    source: None,
                },
                &CancellationToken::new(),
                || Ok(())
            )
            .is_err());
    }
    assert!(!fixture.destination.exists());
    assert_eq!(fs::read_dir(&fixture.catalog).unwrap().count(), 2);
}

#[test]
fn mismatched_native_component_decision_is_preserved_and_blocks_recovery_without_overwriting_it() {
    let fixture = Fixture::new(false);
    let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    let mut lan = Frozen::capture(&fixture.profile, &CancellationToken::new(), || Ok(())).unwrap();
    let status = fixture.prepare(&catalog, &mut lan);
    let path = fixture.catalog.join(&status.id).join("decision.json");
    let mut decision: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    decision["outcome"]["receipt"]["componentsSha256"] = json!("b".repeat(64));
    let bytes = decision.to_string();
    fs::write(&path, &bytes).unwrap();
    assert!(catalog
        .verify_handoff(&status.id, &CancellationToken::new())
        .is_err());
    assert!(catalog.recover().is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
}
