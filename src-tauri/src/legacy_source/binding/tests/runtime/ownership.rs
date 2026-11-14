use super::*;

mod crash;
mod lan;
mod profile;

#[test]
fn runtime_ownership_browser_archive_reads_only_original_pinned_bytes_and_observes_revocation() {
    let (runtime, preparation_id) = prepared(false);
    let cancel = CancellationToken::new();
    let original = fs::read(runtime.fixture.0.join("snapshot/browser-drafts.json")).unwrap();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let prepared = source
        .prepare_runtime(
            &preparation_id,
            &runtime.fixture.0.join("RuntimeData"),
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let mut owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let claim = owner.receipt().id.clone();
    let first = owner.browser_archive().unwrap();
    assert_eq!(first.serialized().as_bytes(), original);
    assert_eq!(first.ownership_id(), claim);
    assert_eq!(first.workspace_sha256(), owner.binding().workspace_sha256);
    assert_eq!(
        first.proof().browser_binding,
        owner.binding().browser_binding
    );
    fs::write(
        owner.path().join("browser-drafts.json"),
        b"untrusted replacement",
    )
    .unwrap();
    fs::write(
        owner.path().join("workspace.json"),
        b"legitimate runtime edit",
    )
    .unwrap();
    assert_eq!(
        owner.browser_archive().unwrap().serialized().as_bytes(),
        original
    );
    drop(owner);
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let mut owner = source
        .resume_runtime(&preparation_id, &prepared.id, &claim, &cancel, || Ok(()))
        .unwrap();
    assert_eq!(
        owner.browser_archive().unwrap().serialized().as_bytes(),
        original
    );
    let late = runtime.fixture.0.join("data/Assets/late-browser.bin");
    fs::write(&late, b"late source entry").unwrap();
    assert!(owner.browser_archive().is_err());
    fs::remove_file(late).unwrap();
    owner.browser_archive().unwrap();
    cancel.cancel();
    assert!(owner.browser_archive().is_err());
    assert!(Lease::acquire(&Directory::open(owner.path()).unwrap()).is_err());
}

#[test]
fn runtime_ownership_keeps_initialized_original_lan_files_and_native_lease_without_copying_identity(
) {
    let runtime = Runtime::new();
    let (state_bytes, identity_bytes) = initialize_snapshot_lan(&runtime);
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let cancel = CancellationToken::new();
    let source = runtime.open().unwrap();
    let drafts = snapshot_drafts(source.binding());
    let mut source = source.freeze(&cancel, || Ok(())).unwrap();
    let preparation = source
        .prepare(
            &runtime.fixture.0.join("snapshot"),
            &uuid::Uuid::new_v4().to_string(),
            &drafts,
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let output = runtime.fixture.0.join("RuntimeData");
    let prepared = source
        .prepare_runtime(&preparation.id, &output, &cancel, || Ok(()))
        .unwrap();
    let mut owner = source
        .claim_runtime(&preparation.id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    owner.verify().unwrap();
    let receipt = owner.receipt().clone();
    assert!(crate::lan::state_store::StateStore::open(&lan).is_err());
    for name in ["state.json", "identity.json"] {
        assert!(OpenOptions::new().write(true).open(lan.join(name)).is_err());
        assert!(!output.join(name).exists());
    }
    assert!(!output.join("LanTransfers").exists());
    fs::write(output.join("new-runtime.bin"), b"legitimate runtime asset").unwrap();
    owner.confirm().unwrap();
    drop(owner);
    assert_eq!(fs::read(lan.join("state.json")).unwrap(), state_bytes);
    assert_eq!(fs::read(lan.join("identity.json")).unwrap(), identity_bytes);
    assert_eq!(
        fs::read(runtime.fixture.0.join("snapshot/lan-state.json")).unwrap(),
        state_bytes
    );
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let mut owner = source
        .resume_runtime(&preparation.id, &prepared.id, &receipt.id, &cancel, || {
            Ok(())
        })
        .unwrap();
    owner.verify().unwrap();
    assert!(crate::lan::state_store::StateStore::open(&lan).is_err());
    drop(owner);
    crate::lan::state_store::StateStore::open(&lan).unwrap();
    assert_eq!(fs::read(lan.join("identity.json")).unwrap(), identity_bytes);
}

#[test]
fn runtime_ownership_keeps_source_and_snapshot_inventory_guards_after_legitimate_runtime_mutation()
{
    for in_source in [false, true] {
        let (runtime, preparation_id, prepared, source) = setup();
        let cancel = CancellationToken::new();
        let mut owner = source
            .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
            .unwrap();
        fs::write(
            owner.path().join("Assets/raw.bin"),
            b"new application bytes",
        )
        .unwrap();
        owner.verify().unwrap();
        let claim = records(&runtime, &preparation_id)
            .join(&prepared.id)
            .join("Ownership")
            .join(&owner.receipt().id);
        let added = if in_source {
            runtime.fixture.0.join("data/Assets/late-owner.bin")
        } else {
            runtime
                .fixture
                .0
                .join("snapshot/Data/objects/late-owner.bin")
        };
        fs::write(&added, b"late immutable-side entry").unwrap();
        assert!(owner.confirm().is_err());
        drop(owner);
        assert_eq!(fs::read(&added).unwrap(), b"late immutable-side entry");
        let decision: serde_json::Value =
            serde_json::from_slice(&fs::read(claim.join("decision.json")).unwrap()).unwrap();
        assert_eq!(decision["outcome"]["state"], "granted");
    }
}

#[test]
fn runtime_ownership_recovery_requires_the_original_output_parent_not_just_a_cloned_tree() {
    let (runtime, preparation_id) = prepared(false);
    let parent = runtime.fixture.0.join("TargetParent");
    let moved = runtime.fixture.0.join("OriginalParent");
    fs::create_dir(&parent).unwrap();
    let output = parent.join("Data");
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let prepared = source
        .prepare_runtime(&preparation_id, &output, &cancel, || Ok(()))
        .unwrap();
    let owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let id = owner.receipt().id.clone();
    drop(owner);
    fs::rename(&parent, &moved).unwrap();
    fs::create_dir(&parent).unwrap();
    copy_tree(&moved.join("Data"), &output);
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let error = source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .err()
        .unwrap();
    assert!(error.contains("父目录身份"), "{error}");
}
use crate::{
    lan::ownership::Lease, legacy_source::binding::snapshot::FrozenSource,
    managed_snapshot::preparation::runtime::ownership::Outcome,
};

fn setup() -> (
    Runtime,
    String,
    crate::managed_snapshot::preparation::runtime::Receipt,
    FrozenSource,
) {
    let (runtime, preparation_id) = prepared(false);
    let cancel = CancellationToken::new();
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let receipt = source
        .prepare_runtime(
            &preparation_id,
            &runtime.fixture.0.join("RuntimeData"),
            &cancel,
            || Ok(()),
        )
        .unwrap();
    (runtime, preparation_id, receipt, source)
}

#[test]
fn runtime_ownership_claims_the_actual_cross_runtime_pipe_before_releasing_only_output_files() {
    let (runtime, preparation_id, prepared, source) = setup();
    let cancel = CancellationToken::new();
    let output = runtime.fixture.0.join("RuntimeData");
    let mut owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    assert_eq!(owner.path(), output);
    assert_eq!(
        owner.receipt().destination_identity,
        prepared.destination_identity
    );
    assert!(!owner.receipt().production_ready);
    assert!(!owner.receipt().migration_complete);
    assert!(Lease::acquire(&Directory::open(&output).unwrap()).is_err());
    fs::write(
        output.join("workspace.json"),
        b"legitimate new runtime bytes",
    )
    .unwrap();
    fs::write(output.join("workspace.lock"), b"actual running lock").unwrap();
    owner.confirm().unwrap();
    assert!(fs::rename(&output, output.with_extension("moved")).is_err());
    for file in [
        runtime.fixture.0.join("data/workspace.json"),
        runtime.fixture.0.join("data/Assets/raw.bin"),
        runtime.fixture.0.join("snapshot/handoff.json"),
    ] {
        assert!(OpenOptions::new().write(true).open(file).is_err());
    }
    let runtime_record = records(&runtime, &preparation_id).join(&prepared.id);
    let claim_record = runtime_record.join("Ownership").join(&owner.receipt().id);
    for file in [
        runtime_record.join("intent.json"),
        runtime_record.join("inventory.json"),
        runtime_record.join("decision.json"),
        claim_record.join("intent.json"),
        claim_record.join("decision.json"),
    ] {
        assert!(OpenOptions::new().write(true).open(file).is_err());
    }
    drop(owner);
    Lease::acquire(&Directory::open(&output).unwrap()).unwrap();
    assert_eq!(
        fs::read(output.join("workspace.json")).unwrap(),
        b"legitimate new runtime bytes"
    );
    assert_eq!(
        fs::read(runtime.fixture.0.join("data/Assets/raw.bin")).unwrap(),
        b"before"
    );
}

#[test]
fn runtime_ownership_reopens_legitimate_mutable_data_only_from_its_original_native_grant() {
    let (runtime, preparation_id, prepared, source) = setup();
    let cancel = CancellationToken::new();
    let output = runtime.fixture.0.join("RuntimeData");
    let owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let receipt = owner.receipt().clone();
    fs::write(output.join("workspace.json"), b"later runtime state").unwrap();
    fs::write(output.join("workspace.lock"), b"runtime lock").unwrap();
    drop(owner);
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert!(source
        .verify_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap_err()
        .contains("已移交"));
    let statuses = source
        .runtime_ownership_statuses(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    assert_eq!(statuses.len(), 1);
    assert!(
        matches!(&statuses[0].outcome, Outcome::Granted { receipt: observed } if observed == &receipt)
    );
    OpenOptions::new()
        .write(true)
        .open(output.join("workspace.json"))
        .unwrap();
    let mut owner = source
        .resume_runtime(&preparation_id, &prepared.id, &receipt.id, &cancel, || {
            Ok(())
        })
        .unwrap();
    owner.confirm().unwrap();
    assert!(Lease::acquire(&Directory::open(&output).unwrap()).is_err());
    assert_eq!(
        fs::read(output.join("workspace.json")).unwrap(),
        b"later runtime state"
    );
    drop(owner);
}

#[test]
fn runtime_ownership_an_existing_native_owner_prevents_any_new_intent_or_file_release() {
    let (runtime, preparation_id, prepared, source) = setup();
    let output = runtime.fixture.0.join("RuntimeData");
    let root = Directory::open(&output).unwrap();
    let lease = Lease::acquire(&root).unwrap();
    assert!(source
        .claim_runtime(
            &preparation_id,
            &prepared.id,
            &CancellationToken::new(),
            || Ok(())
        )
        .is_err());
    assert!(!records(&runtime, &preparation_id)
        .join(&prepared.id)
        .join("Ownership")
        .exists());
    assert_eq!(fs::read(output.join("Assets/raw.bin")).unwrap(), b"before");
    drop(lease);
    drop(root);
}

#[test]
fn runtime_ownership_uncommitted_intent_only_recovers_aborted_and_allows_a_fresh_verified_retry() {
    let (runtime, preparation_id, prepared, source) = setup();
    let claims = records(&runtime, &preparation_id)
        .join(&prepared.id)
        .join("Ownership");
    let observed = Cell::new(false);
    let cancel = CancellationToken::new();
    assert!(source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || {
            if claims.exists()
                && ids(&claims)
                    .iter()
                    .any(|id| claims.join(id).join("intent.json").exists())
            {
                observed.set(true);
                return Err("native startup authority revoked".into());
            }
            Ok(())
        })
        .is_err());
    assert!(observed.get());
    let first = ids(&claims).pop().unwrap();
    assert!(!claims.join(&first).join("decision.json").exists());
    let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    let statuses = source
        .runtime_ownership_statuses(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    assert!(matches!(statuses[0].outcome, Outcome::Aborted));
    let aborted = fs::read(claims.join(&first).join("decision.json")).unwrap();
    let owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    assert_ne!(owner.receipt().id, first);
    drop(owner);
    assert_eq!(
        fs::read(claims.join(&first).join("decision.json")).unwrap(),
        aborted
    );
    assert_eq!(ids(&claims).len(), 2);
}

#[test]
fn runtime_ownership_final_source_revalidation_blocks_a_grant_after_the_native_intent() {
    let (runtime, preparation_id, prepared, source) = setup();
    let claims = records(&runtime, &preparation_id)
        .join(&prepared.id)
        .join("Ownership");
    let late = runtime.fixture.0.join("data/late-runtime-source.bin");
    let observed = Cell::new(false);
    assert!(source
        .claim_runtime(
            &preparation_id,
            &prepared.id,
            &CancellationToken::new(),
            || {
                if !observed.get()
                    && claims.exists()
                    && ids(&claims)
                        .iter()
                        .any(|id| claims.join(id).join("intent.json").exists())
                {
                    fs::write(&late, b"late source asset").unwrap();
                    observed.set(true);
                }
                Ok(())
            }
        )
        .is_err());
    assert!(observed.get());
    let id = ids(&claims).pop().unwrap();
    assert!(!claims.join(id).join("decision.json").exists());
    assert_eq!(fs::read(&late).unwrap(), b"late source asset");
}

#[test]
fn runtime_ownership_receipt_or_root_substitution_cannot_reauthorize_a_copied_directory() {
    let (runtime, preparation_id, prepared, source) = setup();
    let cancel = CancellationToken::new();
    let output = runtime.fixture.0.join("RuntimeData");
    let owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let id = owner.receipt().id.clone();
    drop(owner);
    let decision_path = records(&runtime, &preparation_id)
        .join(&prepared.id)
        .join("Ownership")
        .join(&id)
        .join("decision.json");
    let original = fs::read(&decision_path).unwrap();
    let mut tampered: serde_json::Value = serde_json::from_slice(&original).unwrap();
    tampered["outcome"]["receipt"]["productionReady"] = true.into();
    fs::write(&decision_path, serde_json::to_vec(&tampered).unwrap()).unwrap();
    let tampered = fs::read(&decision_path).unwrap();
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert!(source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .is_err());
    assert_eq!(fs::read(&decision_path).unwrap(), tampered);
    fs::write(&decision_path, &original).unwrap();
    let moved = runtime.fixture.0.join("RuntimeOriginal");
    fs::rename(&output, &moved).unwrap();
    copy_tree(&moved, &output);
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert!(source
        .resume_runtime(&preparation_id, &prepared.id, &id, &cancel, || Ok(()))
        .is_err());
    assert_eq!(fs::read(&decision_path).unwrap(), original);
}

#[test]
fn runtime_ownership_keeps_the_source_and_output_lease_until_cancellation_is_observed_and_owner_drops(
) {
    let (runtime, preparation_id, prepared, source) = setup();
    let cancel = CancellationToken::new();
    let output = runtime.fixture.0.join("RuntimeData");
    let mut owner = source
        .claim_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    cancel.cancel();
    assert!(owner.confirm().is_err());
    assert!(Lease::acquire(&Directory::open(&output).unwrap()).is_err());
    assert!(OpenOptions::new()
        .write(true)
        .open(runtime.fixture.0.join("data/workspace.json"))
        .is_err());
    drop(owner);
    Lease::acquire(&Directory::open(&output).unwrap()).unwrap();
}
