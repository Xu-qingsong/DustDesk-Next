use super::*;
use serde_json::{json, Value};
use std::{cell::Cell, path::PathBuf, process::Command};

struct Fixture {
    root: PathBuf,
    source: PathBuf,
    catalog: PathBuf,
    destination: PathBuf,
    fingerprint: String,
}

impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "dustdesk-snapshot-preparation-test-{}",
            Uuid::new_v4()
        ));
        let source = root.join("Data");
        let catalog = root.join("NativePreparation");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(&catalog).unwrap();
        let bytes = b"{\r\n  \"SchemaVersion\": 3, \"Notes\": []\r\n}\r\n";
        fs::write(source.join("workspace.json"), bytes).unwrap();
        fs::write(source.join("asset.bin"), vec![91; 256 * 1024]).unwrap();
        let destination = root.join("snapshot");
        Self {
            root,
            source,
            catalog,
            destination,
            fingerprint: hash(bytes),
        }
    }
    fn open(&self) -> Catalog {
        Catalog::open(&self.source, &self.catalog).unwrap()
    }
    fn prepare(&self, catalog: &Catalog) -> Status {
        catalog
            .prepare(
                &self.destination,
                &Uuid::new_v4().to_string(),
                &self.fingerprint,
                &CancellationToken::new(),
                || Ok(()),
            )
            .unwrap()
    }
    fn intent(&self, id: &str) -> PathBuf {
        self.catalog.join(id).join("intent.json")
    }
    fn decision(&self, id: &str) -> PathBuf {
        self.catalog.join(id).join("decision.json")
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root).unwrap();
    }
}

fn copy_tree(source: &Path, target: &Path) {
    fs::create_dir(target).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let destination = target.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &destination);
        } else {
            fs::copy(entry.path(), destination).unwrap();
        }
    }
}

#[test]
fn native_intent_precedes_copy_and_prepared_receipt_survives_reopen_without_mutating_source() {
    let fixture = Fixture::new();
    let original = fs::read(fixture.source.join("workspace.json")).unwrap();
    let catalog = fixture.open();
    let observed = Cell::new(false);
    let status = catalog
        .prepare(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
            &CancellationToken::new(),
            || {
                if fixture.destination.exists() {
                    let ids = catalog.ids()?;
                    assert_eq!(ids.len(), 1);
                    assert!(fixture.intent(&ids[0]).is_file());
                    assert!(!fixture.decision(&ids[0]).exists());
                    observed.set(true);
                }
                Ok(())
            },
        )
        .unwrap();
    assert!(observed.get());
    let verified = catalog
        .verify_prepared(&status.id, &CancellationToken::new())
        .unwrap();
    assert_eq!(verified.workspace_sha256, fixture.fingerprint);
    let decision = fs::read(fixture.decision(&status.id)).unwrap();
    assert!(catalog.decide(&status.id, Outcome::Aborted).is_err());
    assert_eq!(fs::read(fixture.decision(&status.id)).unwrap(), decision);
    drop(catalog);
    let reopened = fixture.open();
    let recovered = reopened.recover().unwrap();
    assert_eq!(recovered.len(), 1);
    assert!(matches!(recovered[0].outcome, Outcome::Prepared { .. }));
    reopened
        .verify_prepared(&status.id, &CancellationToken::new())
        .unwrap();
    assert_eq!(
        fs::read(fixture.source.join("workspace.json")).unwrap(),
        original
    );
}

#[test]
fn incomplete_intent_blocks_another_prepare_and_recovers_only_to_durable_abort() {
    let fixture = Fixture::new();
    let catalog = fixture.open();
    let id = catalog
        .begin(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
        )
        .unwrap();
    let intent = fs::read(fixture.intent(&id)).unwrap();
    assert!(catalog
        .verify_prepared(&id, &CancellationToken::new())
        .is_err());
    assert!(catalog
        .prepare(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
            &CancellationToken::new(),
            || Ok(())
        )
        .unwrap_err()
        .contains("未决"));
    assert!(!fixture.destination.exists());
    drop(catalog);
    let reopened = fixture.open();
    assert!(matches!(
        reopened.recover().unwrap()[0].outcome,
        Outcome::Aborted
    ));
    let decision = fs::read(fixture.decision(&id)).unwrap();
    assert!(matches!(
        reopened.recover().unwrap()[0].outcome,
        Outcome::Aborted
    ));
    assert_eq!(fs::read(fixture.decision(&id)).unwrap(), decision);
    assert_eq!(fs::read(fixture.intent(&id)).unwrap(), intent);
    assert!(reopened
        .verify_prepared(&id, &CancellationToken::new())
        .is_err());
    let next = fixture.prepare(&reopened);
    assert_ne!(next.id, id);
}

#[test]
fn process_exit_after_intent_or_completed_manifest_never_promotes_uncommitted_snapshot() {
    const CHILD_ROOT: &str = "DUSTDESK_SNAPSHOT_PREPARATION_CRASH_ROOT";
    if let Some(root) = std::env::var_os(CHILD_ROOT) {
        let root = PathBuf::from(root);
        let source = root.join("Data");
        let destination = root.join("snapshot");
        let fingerprint = hash(&fs::read(source.join("workspace.json")).unwrap());
        let catalog = Catalog::open(&source, &root.join("NativePreparation")).unwrap();
        let stage = std::env::var("DUSTDESK_SNAPSHOT_CRASH_STAGE").unwrap();
        if stage == "prepared" {
            catalog
                .prepare(
                    &destination,
                    &Uuid::new_v4().to_string(),
                    &fingerprint,
                    &CancellationToken::new(),
                    || Ok(()),
                )
                .unwrap();
            std::process::exit(89);
        }
        catalog
            .begin(&destination, &Uuid::new_v4().to_string(), &fingerprint)
            .unwrap();
        if stage == "copied" {
            super::super::prepare(
                &source,
                &destination,
                &fingerprint,
                &CancellationToken::new(),
                || Ok(()),
            )
            .unwrap();
        }
        std::process::exit(89);
    }
    for stage in ["intent", "copied", "prepared"] {
        let fixture = Fixture::new();
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "managed_snapshot::preparation::tests::process_exit_after_intent_or_completed_manifest_never_promotes_uncommitted_snapshot", "--nocapture"])
            .env(CHILD_ROOT, &fixture.root)
            .env("DUSTDESK_SNAPSHOT_CRASH_STAGE", stage);
        let output = command.output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(89),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            fixture.destination.join("snapshot.json").exists(),
            stage != "intent"
        );
        let catalog = fixture.open();
        let statuses = catalog.recover().unwrap();
        assert_eq!(statuses.len(), 1);
        if stage == "prepared" {
            assert!(matches!(statuses[0].outcome, Outcome::Prepared { .. }));
            catalog
                .verify_prepared(&statuses[0].id, &CancellationToken::new())
                .unwrap();
        } else {
            assert!(matches!(statuses[0].outcome, Outcome::Aborted));
            assert!(catalog
                .verify_prepared(&statuses[0].id, &CancellationToken::new())
                .is_err());
        }
        assert_eq!(
            fixture.destination.join("snapshot.json").exists(),
            stage != "intent"
        );
        assert_eq!(
            hash(&fs::read(fixture.source.join("workspace.json")).unwrap()),
            fixture.fingerprint
        );
    }
}

#[test]
fn catalog_is_exclusive_and_byte_for_byte_copies_or_other_sources_are_not_native_authority() {
    let fixture = Fixture::new();
    let catalog = fixture.open();
    let status = fixture.prepare(&catalog);
    assert!(Catalog::open(&fixture.source, &fixture.catalog).is_err());
    assert!(fs::write(fixture.catalog.join("catalog.json"), b"changed").is_err());
    drop(catalog);
    let copied = fixture.root.join("copied-catalog");
    copy_tree(&fixture.catalog, &copied);
    assert!(Catalog::open(&fixture.source, &copied)
        .err()
        .unwrap()
        .contains("复制记录"));
    let another = fixture.root.join("another-data");
    copy_tree(&fixture.source, &another);
    assert!(Catalog::open(&another, &fixture.catalog)
        .err()
        .unwrap()
        .contains("复制记录"));
    fixture
        .open()
        .verify_prepared(&status.id, &CancellationToken::new())
        .unwrap();
}

#[test]
fn cancellation_and_revocation_preserve_pending_intent_and_complete_objects_without_authorization()
{
    let fixture = Fixture::new();
    let catalog = fixture.open();
    let cancel = CancellationToken::new();
    cancel.cancel();
    assert!(catalog
        .prepare(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
            &cancel,
            || Ok(())
        )
        .is_err());
    assert!(catalog.ids().unwrap().is_empty());
    assert!(catalog
        .prepare(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
            &CancellationToken::new(),
            || {
                if fixture.destination.join("snapshot.json").exists() {
                    return Err("native authority revoked".into());
                }
                Ok(())
            }
        )
        .unwrap_err()
        .contains("revoked"));
    assert!(fixture.destination.join("snapshot.json").exists());
    let id = &catalog.ids().unwrap()[0];
    assert!(!fixture.decision(id).exists());
    assert!(catalog
        .verify_prepared(id, &CancellationToken::new())
        .is_err());
    assert!(matches!(
        catalog.recover().unwrap()[0].outcome,
        Outcome::Aborted
    ));
    assert!(fixture.destination.join("snapshot.json").exists());
}

#[test]
fn corrupt_objects_and_copied_destination_fail_verification_without_rewriting_historical_decisions()
{
    for copied in [false, true] {
        let fixture = Fixture::new();
        let catalog = fixture.open();
        let status = fixture.prepare(&catalog);
        let decision = fs::read(fixture.decision(&status.id)).unwrap();
        if copied {
            let retained = fixture.root.join("retained-original");
            fs::rename(&fixture.destination, &retained).unwrap();
            copy_tree(&retained, &fixture.destination);
        } else {
            fs::write(fixture.destination.join("objects/000000.bin"), b"corrupt").unwrap();
        }
        assert!(catalog
            .verify_prepared(&status.id, &CancellationToken::new())
            .is_err());
        assert!(matches!(
            catalog.recover().unwrap()[0].outcome,
            Outcome::Prepared { .. }
        ));
        assert_eq!(fs::read(fixture.decision(&status.id)).unwrap(), decision);
    }
}

#[test]
fn changed_intents_unknown_fields_oversized_records_and_mismatched_decisions_fail_closed() {
    for mode in ["intent", "decision", "unknown", "oversized", "missing"] {
        let fixture = Fixture::new();
        let catalog = fixture.open();
        let status = fixture.prepare(&catalog);
        let path = fixture.intent(&status.id);
        let original = fs::read(&path).unwrap();
        match mode {
            "intent" => {
                let mut value: Value = serde_json::from_slice(&original).unwrap();
                value["workspaceSha256"] = json!("b".repeat(64));
                fs::write(&path, value.to_string()).unwrap();
            }
            "decision" => {
                let target = fixture.decision(&status.id);
                let mut value: Value = serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
                value["intentSha256"] = json!("c".repeat(64));
                fs::write(&target, value.to_string()).unwrap();
            }
            "unknown" => {
                let mut value: Value = serde_json::from_slice(&original).unwrap();
                value["rendererAuthority"] = json!(true);
                fs::write(&path, value.to_string()).unwrap();
            }
            "oversized" => {
                fs::write(&path, vec![b' '; MAX_RECORD_BYTES + 1]).unwrap();
            }
            "missing" => {
                fs::remove_file(&path).unwrap();
            }
            _ => unreachable!(),
        }
        assert!(
            catalog
                .verify_prepared(&status.id, &CancellationToken::new())
                .is_err(),
            "{mode}"
        );
        assert!(catalog.recover().is_err(), "{mode}");
        assert!(fixture.destination.join("snapshot.json").exists());
    }
}

#[test]
fn decision_obstruction_retains_pending_and_requires_explicit_repair_then_abort_not_retry() {
    let fixture = Fixture::new();
    let catalog = fixture.open();
    let injected = Cell::new(false);
    assert!(catalog
        .prepare(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
            &CancellationToken::new(),
            || {
                if !injected.get() && fixture.destination.join("snapshot.json").exists() {
                    let id = &catalog.ids()?[0];
                    fs::create_dir(fixture.decision(id)).unwrap();
                    injected.set(true);
                }
                Ok(())
            }
        )
        .is_err());
    assert!(injected.get());
    let id = &catalog.ids().unwrap()[0];
    assert!(fixture.intent(id).is_file());
    assert!(catalog.recover().is_err());
    assert!(catalog
        .verify_prepared(id, &CancellationToken::new())
        .is_err());
    assert!(fixture.decision(id).is_dir());
    fs::remove_dir(fixture.decision(id)).unwrap();
    assert!(matches!(
        catalog.recover().unwrap()[0].outcome,
        Outcome::Aborted
    ));
    assert!(fixture.destination.join("snapshot.json").is_file());
}

#[test]
fn no_overwrite_publication_retains_existing_intent_and_the_unpublished_temporary_record() {
    let fixture = Fixture::new();
    let catalog = fixture.open();
    let id = catalog
        .begin(
            &fixture.destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
        )
        .unwrap();
    let original = fs::read(fixture.intent(&id)).unwrap();
    let directory = catalog.root.child(&id, false).unwrap();
    assert!(publish(
        &directory,
        "intent.json",
        &json!({"untrusted":"replacement"})
    )
    .is_err());
    assert_eq!(fs::read(fixture.intent(&id)).unwrap(), original);
    assert!(fs::read_dir(directory.path()).unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".part")));
    assert!(matches!(
        catalog.recover().unwrap()[0].outcome,
        Outcome::Aborted
    ));
    assert!(!fixture.destination.exists());
}

#[test]
fn overlapping_roots_existing_targets_and_unknown_catalog_content_are_never_overwritten() {
    let fixture = Fixture::new();
    assert!(Catalog::open(&fixture.source, &fixture.source).is_err());
    assert!(Catalog::open(&fixture.source, &fixture.root).is_err());
    let nested = fixture.source.join("nested");
    fs::create_dir(&nested).unwrap();
    assert!(Catalog::open(&fixture.source, &nested).is_err());
    let catalog = fixture.open();
    for target in [
        fixture.source.join("snapshot"),
        fixture.catalog.join("snapshot"),
        fixture.root.clone(),
    ] {
        assert!(catalog
            .prepare(
                &target,
                &Uuid::new_v4().to_string(),
                &fixture.fingerprint,
                &CancellationToken::new(),
                || Ok(())
            )
            .is_err());
    }
    assert!(catalog.ids().unwrap().is_empty());
    fs::write(fixture.catalog.join("unexpected.json"), b"preserve me").unwrap();
    assert!(catalog.recover().is_err());
    assert_eq!(
        fs::read(fixture.catalog.join("unexpected.json")).unwrap(),
        b"preserve me"
    );
}

#[test]
fn pending_recovery_preserves_external_destination_and_does_not_follow_replaced_parent() {
    let fixture = Fixture::new();
    let parent = fixture.root.join("selected-parent");
    fs::create_dir(&parent).unwrap();
    let destination = parent.join("snapshot");
    let catalog = fixture.open();
    let id = catalog
        .begin(
            &destination,
            &Uuid::new_v4().to_string(),
            &fixture.fingerprint,
        )
        .unwrap();
    fs::rename(&parent, fixture.root.join("original-parent")).unwrap();
    fs::create_dir(&parent).unwrap();
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("external.txt"), b"do not touch").unwrap();
    assert!(matches!(
        catalog.recover().unwrap()[0].outcome,
        Outcome::Aborted
    ));
    assert!(catalog
        .verify_prepared(&id, &CancellationToken::new())
        .is_err());
    assert_eq!(
        fs::read(destination.join("external.txt")).unwrap(),
        b"do not touch"
    );
}

#[test]
fn hard_linked_native_records_and_invalid_ids_never_authorize_or_escape_the_catalog() {
    let fixture = Fixture::new();
    let catalog = fixture.open();
    let status = fixture.prepare(&catalog);
    for id in ["../Data", "", "catalog.json", "C:\\Windows"] {
        assert!(catalog
            .verify_prepared(id, &CancellationToken::new())
            .is_err());
    }
    fs::hard_link(
        fixture.intent(&status.id),
        fixture.root.join("linked-intent.json"),
    )
    .unwrap();
    assert!(catalog
        .verify_prepared(&status.id, &CancellationToken::new())
        .is_err());
    assert!(catalog.recover().is_err());
}
