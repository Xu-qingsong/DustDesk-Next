use super::*;
use crate::legacy_source::binding::snapshot::RuntimeOwner;

struct Cold {
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    ownership: String,
    record: PathBuf,
    original_state: Vec<u8>,
    original_identity: Vec<u8>,
}

fn granted() -> Cold {
    let Setup {
        runtime,
        preparation,
        runtime_id,
        mut owner,
        original_state,
        original_identity,
        ..
    } = fixture(true, true);
    let ownership = owner.receipt().id.clone();
    let record = record(&runtime, &preparation, &runtime_id, &owner);
    let (mut store, _) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let mut state = store.state().clone();
    state.extra.insert("currentAfterGrant".into(), 1.into());
    store.commit(state).unwrap();
    drop(store);
    drop(owner);
    Cold {
        runtime,
        preparation,
        runtime_id,
        ownership,
        record,
        original_state,
        original_identity,
    }
}

impl Cold {
    fn lan(&self) -> PathBuf {
        self.runtime.fixture.0.join("profile/LanTransfers")
    }
    fn recover(&self, cancel: &CancellationToken) -> Result<RuntimeOwner, String> {
        self.runtime
            .open()?
            .freeze(cancel, || Ok(()))?
            .resume_runtime_with_original_lan(
                &self.preparation,
                &self.runtime_id,
                &self.ownership,
                cancel,
                || Ok(()),
            )
    }
}

#[test]
fn original_lan_recovery_keeps_original_snapshot_separate_from_current_state_and_resumes_same_lease(
) {
    let cold = granted();
    let intent = fs::read(cold.record.join("intent.json")).unwrap();
    let decision = fs::read(cold.record.join("decision.json")).unwrap();
    for expected in [1, 2] {
        let cancel = CancellationToken::new();
        let mut owner = cold.recover(&cancel).unwrap();
        owner.verify().unwrap();
        assert!(StateStore::open(&cold.lan()).is_err());
        assert!(fs::write(
            cold.lan().join("state.json"),
            b"must stay pinned before adoption"
        )
        .is_err());
        assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
        assert!(owner.browser_archive().is_ok());
        let (mut store, identity) = owner.resume_original_lan_preview(|| Ok(())).unwrap();
        assert_eq!(
            identity.id,
            crate::lan::storage::Identity::parse(&cold.original_identity)
                .unwrap()
                .id
        );
        assert_eq!(store.state().extra["currentAfterGrant"], expected);
        assert!(store.ensure_identity(&cancel).is_err());
        assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
        let mut state = store.state().clone();
        state
            .extra
            .insert("currentAfterGrant".into(), (expected + 1).into());
        store.commit(state).unwrap();
        owner.verify().unwrap();
        drop(owner);
        assert!(store.commit(store.state().clone()).is_err());
        assert!(StateStore::open(&cold.lan()).is_err());
        drop(store);
        assert_eq!(
            fs::read(cold.runtime.fixture.0.join("snapshot/lan-state.json")).unwrap(),
            cold.original_state
        );
        assert!(fs::read(cold.lan().join("identity.json")).unwrap() == cold.original_identity);
        assert_eq!(fs::read(cold.record.join("intent.json")).unwrap(), intent);
        assert_eq!(
            fs::read(cold.record.join("decision.json")).unwrap(),
            decision
        );
    }
}

#[test]
fn original_lan_recovery_rejects_missing_pending_unknown_or_tampered_grants_without_changing_live_state(
) {
    for fault in [
        "missing-intent",
        "missing-decision",
        "extra",
        "intent-format",
        "intent-version",
        "owner-id",
        "owner-digest",
        "original-state",
        "decision-format",
        "decision-version",
        "intent-digest",
        "production",
        "complete",
        "unknown-field",
    ] {
        let cold = granted();
        let intent_path = cold.record.join("intent.json");
        let decision_path = cold.record.join("decision.json");
        let mut intent: serde_json::Value =
            serde_json::from_slice(&fs::read(&intent_path).unwrap()).unwrap();
        let mut decision: serde_json::Value =
            serde_json::from_slice(&fs::read(&decision_path).unwrap()).unwrap();
        match fault {
            "intent-format" => intent["format"] = "untrusted".into(),
            "intent-version" => intent["version"] = 2.into(),
            "owner-id" => intent["ownershipId"] = uuid::Uuid::new_v4().to_string().into(),
            "owner-digest" => intent["ownershipSha256"] = "0".repeat(64).into(),
            "original-state" => intent["checkpoint"]["state"]["sha256"] = "0".repeat(64).into(),
            _ => {}
        }
        let changed_intent = serde_json::to_vec(&intent).unwrap();
        decision["intentSha256"] = format!("{:x}", Sha256::digest(&changed_intent)).into();
        match fault {
            "decision-format" => decision["format"] = "untrusted".into(),
            "decision-version" => decision["version"] = 2.into(),
            "intent-digest" => decision["intentSha256"] = "0".repeat(64).into(),
            "production" => decision["productionReady"] = true.into(),
            "complete" => decision["migrationComplete"] = true.into(),
            "unknown-field" => decision["unexpected"] = true.into(),
            _ => {}
        }
        fs::write(&intent_path, &changed_intent).unwrap();
        fs::write(&decision_path, serde_json::to_vec(&decision).unwrap()).unwrap();
        match fault {
            "missing-intent" => fs::remove_file(&intent_path).unwrap(),
            "missing-decision" => fs::remove_file(&decision_path).unwrap(),
            "extra" => fs::write(cold.record.join("leftover.part"), b"preserve").unwrap(),
            _ => {}
        }
        let before = [fs::read(&intent_path).ok(), fs::read(&decision_path).ok()];
        let state = fs::read(cold.lan().join("state.json")).unwrap();
        assert!(cold.recover(&CancellationToken::new()).is_err(), "{fault}");
        assert_eq!(
            [fs::read(&intent_path).ok(), fs::read(&decision_path).ok()],
            before,
            "{fault}"
        );
        assert_eq!(
            fs::read(cold.lan().join("state.json")).unwrap(),
            state,
            "{fault}"
        );
        assert!(fs::read(cold.lan().join("identity.json")).unwrap() == cold.original_identity);
        StateStore::open(&cold.lan()).unwrap();
    }
}

#[test]
fn original_lan_recovery_rejects_replaced_identity_or_lan_root_even_when_bytes_are_identical() {
    for replace_root in [false, true] {
        let cold = granted();
        if replace_root {
            let moved = cold.runtime.fixture.0.join("original-lan-moved");
            fs::rename(cold.lan(), &moved).unwrap();
            copy_tree(&moved, &cold.lan());
        } else {
            fs::rename(
                cold.lan().join("identity.json"),
                cold.lan().join("identity-before.json"),
            )
            .unwrap();
            fs::write(cold.lan().join("identity.json"), &cold.original_identity).unwrap();
        }
        let state = fs::read(cold.lan().join("state.json")).unwrap();
        assert!(cold.recover(&CancellationToken::new()).is_err());
        assert_eq!(fs::read(cold.lan().join("state.json")).unwrap(), state);
    }
}

#[test]
fn original_lan_recovery_keeps_snapshot_and_original_source_inventory_guards_and_revokes_writes() {
    for snapshot in [false, true] {
        let cold = granted();
        let mut owner = cold.recover(&CancellationToken::new()).unwrap();
        let (mut store, _) = owner.resume_original_lan_preview(|| Ok(())).unwrap();
        let late = cold.runtime.fixture.0.join(if snapshot {
            "snapshot/Data/objects/late-recovery.bin"
        } else {
            "data/late-recovery.bin"
        });
        let state = fs::read(cold.lan().join("state.json")).unwrap();
        fs::write(&late, b"late source-side entry").unwrap();
        assert!(owner.confirm().is_err());
        assert!(store.commit(store.state().clone()).is_err());
        fs::remove_file(&late).unwrap();
        assert!(store.commit(store.state().clone()).is_err());
        assert_eq!(fs::read(cold.lan().join("state.json")).unwrap(), state);
    }
}

#[test]
fn original_lan_recovery_rechecks_native_admission_after_pinning_the_durable_grant() {
    let cold = granted();
    let before = fs::read(cold.record.join("decision.json")).unwrap();
    let state = fs::read(cold.lan().join("state.json")).unwrap();
    let cancel = CancellationToken::new();
    let source = cold
        .runtime
        .open()
        .unwrap()
        .freeze(&cancel, || Ok(()))
        .unwrap();
    let reached = Cell::new(false);
    let result = source.resume_runtime_with_original_lan(
        &cold.preparation,
        &cold.runtime_id,
        &cold.ownership,
        &cancel,
        || match fs::read(cold.record.join("decision.json")) {
            Ok(_) => Ok(()),
            Err(error) => {
                assert_eq!(error.raw_os_error(), Some(32));
                reached.set(true);
                Err("native recovery admission revoked".into())
            }
        },
    );
    assert!(result.is_err());
    assert!(reached.get());
    assert_eq!(fs::read(cold.record.join("decision.json")).unwrap(), before);
    assert_eq!(fs::read(cold.lan().join("state.json")).unwrap(), state);
    cold.recover(&CancellationToken::new())
        .unwrap()
        .verify()
        .unwrap();
}

#[test]
fn original_lan_recovery_cancellation_before_service_adoption_keeps_current_state_pinned() {
    let cold = granted();
    let cancel = CancellationToken::new();
    let mut owner = cold.recover(&cancel).unwrap();
    cancel.cancel();
    assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
    assert!(StateStore::open(&cold.lan()).is_err());
    assert!(fs::write(cold.lan().join("state.json"), b"must stay pinned").is_err());
    drop(owner);
    StateStore::open(&cold.lan()).unwrap();
}
