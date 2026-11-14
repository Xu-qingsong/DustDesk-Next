use super::*;
use crate::{lan::migration::service::Services, legacy_source::binding::snapshot::RuntimeOwner};

struct Running {
    owner: RuntimeOwner,
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    original_state: Vec<u8>,
    original_identity: Vec<u8>,
}

async fn running() -> (Running, Services) {
    let Setup {
        owner,
        runtime,
        preparation,
        runtime_id,
        original_state,
        original_identity,
        ..
    } = fixture(true, true);
    let mut setup = Running {
        owner,
        runtime,
        preparation,
        runtime_id,
        original_state,
        original_identity,
    };
    let (mut store, identity) = setup.owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let mut state = store.state().clone();
    state.extra.insert("latestNativeState".into(), 19.into());
    store.commit(state).unwrap();
    let services = Services::start(
        store,
        identity,
        "Original handback".into(),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
        Arc::new(AcceptPair),
    )
    .await
    .unwrap();
    (setup, services)
}

fn journal(setup: &Running) -> PathBuf {
    record(
        &setup.runtime,
        &setup.preparation,
        &setup.runtime_id,
        &setup.owner,
    )
    .join("Handback")
}

// Drop only the actual owner while preserving fixture metadata for a new epoch.
struct Cold {
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    ownership: String,
    journal: PathBuf,
}
impl Cold {
    fn from_setup(setup: Running) -> Self {
        let journal = journal(&setup);
        let Running {
            runtime,
            preparation,
            runtime_id,
            owner,
            ..
        } = setup;
        let ownership = owner.receipt().id.clone();
        drop(owner);
        Self {
            runtime,
            preparation,
            runtime_id,
            ownership,
            journal,
        }
    }
    fn open(&self, handback: bool) -> Result<RuntimeOwner, String> {
        let cancel = CancellationToken::new();
        let source = self.runtime.open()?.freeze(&cancel, || Ok(()))?;
        if handback {
            source.resume_runtime_for_original_lan_handback(
                &self.preparation,
                &self.runtime_id,
                &self.ownership,
                &cancel,
                || Ok(()),
            )
        } else {
            source.resume_runtime_with_original_lan(
                &self.preparation,
                &self.runtime_id,
                &self.ownership,
                &cancel,
                || Ok(()),
            )
        }
    }
    fn state(&self) -> PathBuf {
        self.runtime
            .fixture
            .0
            .join("profile/LanTransfers/state.json")
    }
}

#[tokio::test]
async fn original_lan_handback_keeps_latest_state_pinned_until_release_and_permanently_closes_service_recovery(
) {
    let (mut setup, services) = running().await;
    assert!(setup
        .owner
        .resume_original_lan_handback_preview(|| Ok(()))
        .is_err());
    let receiver = services.receiver();
    receiver.set_enabled(false).await.unwrap();
    let address = services.address();
    let drained = services.stop().await.unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
    let state_path = setup
        .runtime
        .fixture
        .0
        .join("profile/LanTransfers/state.json");
    let latest = fs::read(&state_path).unwrap();
    let receipt = setup
        .owner
        .finish_original_lan_preview(&drained, || Ok(()))
        .unwrap();
    assert_eq!(
        receipt.checkpoint.state.as_ref().unwrap().sha256,
        format!("{:x}", Sha256::digest(&latest))
    );
    assert!(fs::write(&state_path, b"must stay pinned").is_err());
    assert!(StateStore::open(state_path.parent().unwrap()).is_err());
    setup.owner.verify().unwrap();
    assert_eq!(
        setup
            .owner
            .finish_original_lan_preview(&drained, || Ok(()))
            .unwrap()
            .intent_sha256,
        receipt.intent_sha256
    );
    let original_state = setup.original_state.clone();
    let original_identity = setup.original_identity.clone();
    let cold = Cold::from_setup(setup);
    // The drained witness must not keep a lease alive after actual owner release.
    StateStore::open(cold.state().parent().unwrap()).unwrap();
    assert!(cold.open(false).is_err());
    let intent = fs::read(cold.journal.join("intent.json")).unwrap();
    let decision = fs::read(cold.journal.join("decision.json")).unwrap();
    let mut owner = cold.open(true).unwrap();
    assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
    assert_eq!(
        owner
            .resume_original_lan_handback_preview(|| Ok(()))
            .unwrap()
            .intent_sha256,
        receipt.intent_sha256
    );
    owner.verify().unwrap();
    drop(owner);
    assert_eq!(fs::read(cold.state()).unwrap(), latest);
    assert_eq!(fs::read(cold.journal.join("intent.json")).unwrap(), intent);
    assert_eq!(
        fs::read(cold.journal.join("decision.json")).unwrap(),
        decision
    );
    assert_eq!(
        fs::read(cold.runtime.fixture.0.join("snapshot/lan-state.json")).unwrap(),
        original_state
    );
    assert!(
        fs::read(
            cold.runtime
                .fixture
                .0
                .join("profile/LanTransfers/identity.json")
        )
        .unwrap()
            == original_identity
    );
    drop(receiver);
    drop(drained);
}

#[tokio::test]
async fn original_lan_handback_refuses_a_foreign_real_drain_witness_without_creating_records() {
    let (mut first, first_services) = running().await;
    let (second, second_services) = running().await;
    let foreign = second_services.stop().await.unwrap();
    assert!(first
        .owner
        .finish_original_lan_preview(&foreign, || Ok(()))
        .is_err());
    assert!(!journal(&first).exists());
    let drained = first_services.stop().await.unwrap();
    first
        .owner
        .finish_original_lan_preview(&drained, || Ok(()))
        .unwrap();
    drop(second);
}

#[tokio::test]
async fn original_lan_handback_recovers_intent_or_lost_success_without_replaying_old_snapshot() {
    for success in [false, true] {
        let (mut setup, services) = running().await;
        let drained = services.stop().await.unwrap();
        let journal = journal(&setup);
        let trigger = journal.join(if success {
            "decision.json"
        } else {
            "intent.json"
        });
        let reached = Cell::new(false);
        assert!(setup
            .owner
            .finish_original_lan_preview(&drained, || {
                if trigger.exists() {
                    reached.set(true);
                    Err("native handback admission revoked".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert!(reached.get());
        assert_eq!(journal.join("decision.json").exists(), success);
        assert!(fs::read(
            setup
                .runtime
                .fixture
                .0
                .join("profile/LanTransfers/state.json")
        )
        .is_err());
        let cold = Cold::from_setup(setup);
        let latest = fs::read(cold.state()).unwrap();
        let intent = fs::read(cold.journal.join("intent.json")).unwrap();
        assert!(cold.open(false).is_err());
        let mut owner = cold.open(true).unwrap();
        assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
        owner
            .resume_original_lan_handback_preview(|| Ok(()))
            .unwrap();
        drop(owner);
        assert_eq!(fs::read(cold.state()).unwrap(), latest);
        assert_eq!(fs::read(cold.journal.join("intent.json")).unwrap(), intent);
        assert!(cold.journal.join("decision.json").exists());
    }
}

#[tokio::test]
async fn original_lan_handback_rejects_tampered_pending_and_terminal_records_without_rewriting_them(
) {
    for fault in [
        "unknown",
        "missing-intent",
        "intent-format",
        "intent-version",
        "owner",
        "grant",
        "checkpoint",
        "compatibility",
        "decision-format",
        "decision-version",
        "digest",
        "production",
        "complete",
        "extra-field",
    ] {
        let (mut setup, services) = running().await;
        let drained = services.stop().await.unwrap();
        setup
            .owner
            .finish_original_lan_preview(&drained, || Ok(()))
            .unwrap();
        let cold = Cold::from_setup(setup);
        let intent_path = cold.journal.join("intent.json");
        let decision_path = cold.journal.join("decision.json");
        let mut intent: serde_json::Value =
            serde_json::from_slice(&fs::read(&intent_path).unwrap()).unwrap();
        let mut decision: serde_json::Value =
            serde_json::from_slice(&fs::read(&decision_path).unwrap()).unwrap();
        match fault {
            "intent-format" => intent["format"] = "unknown".into(),
            "intent-version" => intent["version"] = 2.into(),
            "owner" => intent["ownershipId"] = uuid::Uuid::new_v4().to_string().into(),
            "grant" => intent["grantSha256"] = "0".repeat(64).into(),
            "checkpoint" => intent["checkpoint"]["state"]["sha256"] = "0".repeat(64).into(),
            "compatibility" => intent["compatibleRuntime"] = "unknown".into(),
            _ => {}
        }
        let bytes = serde_json::to_vec(&intent).unwrap();
        decision["intentSha256"] = format!("{:x}", Sha256::digest(&bytes)).into();
        match fault {
            "decision-format" => decision["format"] = "unknown".into(),
            "decision-version" => decision["version"] = 2.into(),
            "digest" => decision["intentSha256"] = "0".repeat(64).into(),
            "production" => decision["productionReady"] = true.into(),
            "complete" => decision["migrationComplete"] = true.into(),
            "extra-field" => decision["unexpected"] = true.into(),
            _ => {}
        }
        fs::write(&intent_path, bytes).unwrap();
        fs::write(&decision_path, serde_json::to_vec(&decision).unwrap()).unwrap();
        if fault == "unknown" {
            fs::write(cold.journal.join("unknown.part"), b"preserve").unwrap();
        }
        if fault == "missing-intent" {
            fs::remove_file(&intent_path).unwrap();
        }
        let before = [fs::read(&intent_path).ok(), fs::read(&decision_path).ok()];
        let state = fs::read(cold.state()).unwrap();
        assert!(cold.open(false).is_err(), "{fault}");
        let mut owner = cold.open(true).unwrap();
        assert!(
            owner
                .resume_original_lan_handback_preview(|| Ok(()))
                .is_err(),
            "{fault}"
        );
        drop(owner);
        assert_eq!(
            [fs::read(&intent_path).ok(), fs::read(&decision_path).ok()],
            before,
            "{fault}"
        );
        assert_eq!(fs::read(cold.state()).unwrap(), state, "{fault}");
    }
}

#[tokio::test]
async fn original_lan_handback_rejects_changed_or_replaced_latest_state_after_process_release() {
    for same_bytes in [false, true] {
        let (mut setup, services) = running().await;
        let drained = services.stop().await.unwrap();
        setup
            .owner
            .finish_original_lan_preview(&drained, || Ok(()))
            .unwrap();
        let cold = Cold::from_setup(setup);
        let mut bytes = fs::read(cold.state()).unwrap();
        fs::rename(cold.state(), cold.state().with_extension("before")).unwrap();
        if !same_bytes {
            bytes.push(b' ');
        }
        fs::write(cold.state(), &bytes).unwrap();
        let mut owner = cold.open(true).unwrap();
        assert!(owner
            .resume_original_lan_handback_preview(|| Ok(()))
            .is_err());
        drop(owner);
        assert_eq!(fs::read(cold.state()).unwrap(), bytes);
    }
}

#[tokio::test]
async fn original_lan_handback_stop_failure_is_latched_and_never_yields_a_drain_witness() {
    let (setup, services) = running().await;
    let receiver = services.receiver();
    let state = setup
        .runtime
        .fixture
        .0
        .join("profile/LanTransfers/state.json");
    let original_permissions = fs::metadata(&state).unwrap().permissions();
    let mut permissions = original_permissions.clone();
    permissions.set_readonly(true);
    fs::set_permissions(&state, permissions).unwrap();
    let error = receiver.stop().await.unwrap_err();
    fs::set_permissions(&state, original_permissions).unwrap();
    assert_eq!(receiver.stop().await.unwrap_err(), error);
    assert!(services.stop().await.is_err());
    assert!(!journal(&setup).exists());
}

#[tokio::test]
async fn original_lan_handback_refuses_unfinished_publication_and_keeps_its_exact_latest_bytes() {
    let (mut setup, services) = running().await;
    let drained = services.stop().await.unwrap();
    let state_path = setup
        .runtime
        .fixture
        .0
        .join("profile/LanTransfers/state.json");
    let mut state: serde_json::Value =
        serde_json::from_slice(&fs::read(&state_path).unwrap()).unwrap();
    let pin = "b".repeat(64);
    state["tasks"] = serde_json::json!([{
        "view": {"id":format!("{pin}-pending"), "direction":"receive", "device":"Peer", "name":"Pending", "total":0, "done":0, "speed":0, "status":"paused"},
        "peer": {"id":"peer", "name":"Peer", "address":"127.0.0.1", "port":1234, "fingerprint":pin, "lastSeen":0},
        "manifest": {"id":"pending", "name":"Pending", "entries":[], "directories":[]},
        "rustPublicationV1": {"unresolved":true}
    }]);
    let bytes = serde_json::to_vec(&state).unwrap();
    fs::write(&state_path, &bytes).unwrap();
    let error = setup
        .owner
        .finish_original_lan_preview(&drained, || Ok(()))
        .unwrap_err();
    assert!(error.contains("未完成原生发布"), "{error}");
    assert!(!journal(&setup).exists());
    assert!(fs::write(&state_path, b"must remain pinned").is_err());
    drop(setup.owner);
    assert_eq!(fs::read(&state_path).unwrap(), bytes);
}

#[tokio::test]
async fn original_lan_handback_late_record_or_source_entry_revokes_the_retained_handback() {
    for source in [true, false] {
        let (mut setup, services) = running().await;
        let drained = services.stop().await.unwrap();
        setup
            .owner
            .finish_original_lan_preview(&drained, || Ok(()))
            .unwrap();
        let late = if source {
            setup.runtime.fixture.0.join("data/late.bin")
        } else {
            journal(&setup).join("late.bin")
        };
        fs::write(&late, b"unexpected").unwrap();
        assert!(setup.owner.confirm().is_err());
        fs::remove_file(late).unwrap();
        assert!(setup
            .owner
            .finish_original_lan_preview(&drained, || Ok(()))
            .is_err());
    }
}

#[tokio::test]
async fn original_lan_handback_dropped_service_handle_keeps_custody_until_supervised_join_finishes()
{
    let (setup, services) = running().await;
    let address = services.address();
    let root = setup.runtime.fixture.0.join("profile/LanTransfers");
    let owner = setup.owner;
    drop(services);
    drop(owner);
    for _ in 0..100 {
        if let Ok(store) = StateStore::open(&root) {
            assert!(tokio::net::TcpStream::connect(address).await.is_err());
            drop(store);
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("dropped service failed to drain and release its actual lease");
}
