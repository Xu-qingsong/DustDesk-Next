use super::*;
use crate::lan::{
    protocol::Device,
    receiver::{Approvals, Decision, ReceivePrompt, Receiver},
    state_store::StateStore,
    transport::{Limits, Server},
};
use std::{
    net::{Ipv4Addr, SocketAddrV4},
    sync::Arc,
};

mod handback;
mod recovery;
mod release;
mod runtime_handback;

struct Setup {
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    owner: super::super::super::super::snapshot::RuntimeOwner,
    cancel: CancellationToken,
    original_state: Vec<u8>,
    original_identity: Vec<u8>,
}

fn fixture(initialized: bool, isolated: bool) -> Setup {
    let mut runtime = Runtime::new();
    if isolated {
        let destination =
            std::env::temp_dir().join(format!("dustdesk-runtime-preview-{}", uuid::Uuid::new_v4()));
        fs::rename(&runtime.fixture.0, &destination).unwrap();
        runtime.fixture.0 = destination;
    }
    let (original_state, original_identity) = if initialized {
        initialize_snapshot_lan(&runtime)
    } else {
        (vec![], vec![])
    };
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
    let prepared = source
        .prepare_runtime(
            &preparation.id,
            &runtime.fixture.0.join("RuntimeData"),
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let owner = source
        .claim_runtime(&preparation.id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    Setup {
        runtime,
        preparation: preparation.id,
        runtime_id: prepared.id,
        owner,
        cancel,
        original_state,
        original_identity,
    }
}

fn record(
    runtime: &Runtime,
    preparation: &str,
    runtime_id: &str,
    owner: &super::super::super::super::snapshot::RuntimeOwner,
) -> PathBuf {
    records(runtime, preparation)
        .join(runtime_id)
        .join("Ownership")
        .join(&owner.receipt().id)
        .join("OriginalLan")
}

#[test]
fn original_lan_handover_keeps_same_lease_identity_and_snapshot_after_real_state_mutation() {
    let Setup {
        runtime,
        preparation,
        runtime_id,
        mut owner,
        original_state,
        original_identity,
        ..
    } = fixture(true, true);
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let record = record(&runtime, &preparation, &runtime_id, &owner);
    let (mut store, identity) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    assert_eq!(
        identity.id,
        crate::lan::storage::Identity::parse(&original_identity)
            .unwrap()
            .id
    );
    let ownership_id = owner.receipt().id.clone();
    assert!(StateStore::open(&lan).is_err());
    assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
    let mut candidate = store.state().clone();
    candidate.extra.insert("handoverTest".into(), true.into());
    store.commit(candidate).unwrap();
    assert_ne!(fs::read(lan.join("state.json")).unwrap(), original_state);
    owner.verify().unwrap();
    assert!(fs::write(lan.join("identity.json"), b"replacement").is_err());
    for path in [
        record.join("intent.json"),
        record.join("decision.json"),
        runtime.fixture.0.join("data/workspace.json"),
        runtime.fixture.0.join("snapshot/lan-state.json"),
    ] {
        assert!(OpenOptions::new().write(true).open(path).is_err());
    }
    let saved = fs::read(lan.join("state.json")).unwrap();
    drop(owner);
    assert!(store.commit(store.state().clone()).is_err());
    assert!(StateStore::open(&lan).is_err());
    assert!(fs::write(lan.join("identity.json"), b"replacement").is_err());
    drop(store);
    let intent_bytes = fs::read(record.join("intent.json")).unwrap();
    let intent: serde_json::Value = serde_json::from_slice(&intent_bytes).unwrap();
    let decision: serde_json::Value =
        serde_json::from_slice(&fs::read(record.join("decision.json")).unwrap()).unwrap();
    assert_eq!(intent["ownershipId"], ownership_id);
    assert_eq!(
        decision["intentSha256"],
        format!("{:x}", Sha256::digest(&intent_bytes))
    );
    assert_eq!(decision["productionReady"], false);
    assert!(!intent.to_string().contains("PRIVATE"));
    assert_eq!(
        fs::read(runtime.fixture.0.join("snapshot/lan-state.json")).unwrap(),
        original_state
    );
    let reopened = StateStore::open(&lan).unwrap();
    assert_eq!(reopened.state().extra["handoverTest"], true);
    assert_eq!(fs::read(lan.join("state.json")).unwrap(), saved);
    assert_eq!(
        fs::read(lan.join("identity.json")).unwrap(),
        original_identity
    );
}

#[test]
fn original_lan_handover_revocation_preserves_last_committed_state_without_releasing_custody() {
    let Setup {
        runtime,
        mut owner,
        cancel,
        ..
    } = fixture(true, true);
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let (mut store, _) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let original = fs::read(lan.join("state.json")).unwrap();
    cancel.cancel();
    let mut candidate = store.state().clone();
    candidate.enabled = !candidate.enabled;
    assert!(store.commit(candidate).is_err());
    assert_eq!(fs::read(lan.join("state.json")).unwrap(), original);
    assert!(owner.confirm().is_err());
    assert!(StateStore::open(&lan).is_err());
    drop(store);
    assert!(StateStore::open(&lan).is_err());
}

#[test]
fn original_lan_handover_refuses_uninitialized_or_non_preview_sources_without_creating_identity_or_record(
) {
    for (initialized, isolated) in [(false, true), (true, false)] {
        let Setup {
            runtime,
            preparation,
            runtime_id,
            mut owner,
            ..
        } = fixture(initialized, isolated);
        let record = record(&runtime, &preparation, &runtime_id, &owner);
        assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
        assert!(!record.exists());
        if !initialized {
            assert!(!runtime.fixture.0.join("profile/LanTransfers").exists());
        }
        owner.verify().unwrap();
    }
}

#[test]
fn original_lan_handover_does_not_overwrite_pending_granted_or_unknown_records() {
    for name in ["intent.json", "decision.json", "unknown.bin"] {
        let Setup {
            runtime,
            preparation,
            runtime_id,
            mut owner,
            original_state,
            ..
        } = fixture(true, true);
        let record = record(&runtime, &preparation, &runtime_id, &owner);
        fs::create_dir(&record).unwrap();
        fs::write(
            record.join(name),
            b"preserve incomplete or untrusted record",
        )
        .unwrap();
        let lan = runtime.fixture.0.join("profile/LanTransfers");
        assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
        assert_eq!(
            fs::read(record.join(name)).unwrap(),
            b"preserve incomplete or untrusted record"
        );
        assert_eq!(fs::read_dir(&record).unwrap().count(), 1);
        assert!(fs::write(lan.join("state.json"), b"replacement").is_err());
        owner.verify().unwrap();
        drop(owner);
        assert_eq!(fs::read(lan.join("state.json")).unwrap(), original_state);
    }
}

#[test]
fn original_lan_handover_keeps_the_lease_after_service_store_is_dropped_and_rejects_second_owner() {
    let Setup {
        runtime, mut owner, ..
    } = fixture(true, true);
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let (store, _) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    drop(store);
    owner.verify().unwrap();
    assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
    assert!(StateStore::open(&lan).is_err());
    drop(owner);
    StateStore::open(&lan).unwrap();
}

#[test]
fn original_lan_handover_changed_state_requires_fresh_recovery_and_never_reuses_original_snapshot()
{
    let Setup {
        runtime,
        preparation,
        runtime_id,
        mut owner,
        cancel,
        ..
    } = fixture(true, true);
    let ownership = owner.receipt().id.clone();
    let record = record(&runtime, &preparation, &runtime_id, &owner);
    let (mut store, _) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let mut state = store.state().clone();
    state.extra.insert("afterHandover".into(), 5.into());
    store.commit(state).unwrap();
    drop(store);
    drop(owner);
    let original_decision = fs::read(record.join("decision.json")).unwrap();
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let latest = fs::read(lan.join("state.json")).unwrap();
    let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
    assert!(source
        .resume_runtime(&preparation, &runtime_id, &ownership, &cancel, || Ok(()))
        .is_err());
    assert_eq!(fs::read(lan.join("state.json")).unwrap(), latest);
    assert_eq!(
        fs::read(record.join("decision.json")).unwrap(),
        original_decision
    );
}

#[test]
fn original_lan_handover_failed_source_supervision_permanently_revokes_service_commits() {
    for full_verify in [false, true] {
        let Setup {
            runtime, mut owner, ..
        } = fixture(true, true);
        let (mut store, _) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
        let lan = runtime.fixture.0.join("profile/LanTransfers");
        let original = fs::read(lan.join("state.json")).unwrap();
        let late = runtime.fixture.0.join("data/late-after-lan.bin");
        fs::write(&late, b"unexpected source change").unwrap();
        assert!(if full_verify {
            owner.verify()
        } else {
            owner.confirm()
        }
        .is_err());
        assert!(store.commit(store.state().clone()).is_err());
        fs::remove_file(&late).unwrap();
        assert!(owner.confirm().is_err());
        assert!(store.commit(store.state().clone()).is_err());
        assert_eq!(fs::read(lan.join("state.json")).unwrap(), original);
        assert!(StateStore::open(&lan).is_err());
    }
}

#[test]
fn original_lan_handover_cancellation_before_begin_creates_no_record_and_keeps_original_pins() {
    let Setup {
        runtime,
        preparation,
        runtime_id,
        mut owner,
        cancel,
        ..
    } = fixture(true, true);
    let record = record(&runtime, &preparation, &runtime_id, &owner);
    cancel.cancel();
    assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
    assert!(!record.exists());
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    assert!(StateStore::open(&lan).is_err());
    assert!(fs::write(lan.join("state.json"), b"replacement").is_err());
}

#[test]
fn original_lan_handover_rechecks_admission_after_intent_and_after_durable_grant_without_unpinning_state(
) {
    for after_decision in [false, true] {
        let Setup {
            runtime,
            preparation,
            runtime_id,
            mut owner,
            original_state,
            ..
        } = fixture(true, true);
        let record = record(&runtime, &preparation, &runtime_id, &owner);
        let revoked = Cell::new(false);
        assert!(owner
            .prepare_original_lan_preview(|| {
                let trigger = record
                    .join(if after_decision {
                        "decision.json"
                    } else {
                        "intent.json"
                    })
                    .exists();
                if trigger {
                    revoked.set(true);
                    Err("native admission revoked at persistence boundary".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert!(revoked.get());
        assert!(record.join("intent.json").exists());
        assert_eq!(record.join("decision.json").exists(), after_decision);
        let lan = runtime.fixture.0.join("profile/LanTransfers");
        assert!(fs::write(lan.join("state.json"), b"replacement").is_err());
        assert!(owner.prepare_original_lan_preview(|| Ok(())).is_err());
        owner.verify().unwrap();
        drop(owner);
        assert_eq!(fs::read(lan.join("state.json")).unwrap(), original_state);
        let intent = fs::read(record.join("intent.json")).unwrap();
        assert!(!intent.is_empty());
        if after_decision {
            let decision: serde_json::Value =
                serde_json::from_slice(&fs::read(record.join("decision.json")).unwrap()).unwrap();
            assert_eq!(decision["format"], "dustdesk-original-lan-handover-granted");
        }
    }
}

struct AcceptPair;
impl Approvals for AcceptPair {
    fn pair(&self, _: Device, _: String) -> Decision<bool> {
        Box::pin(async { Ok(true) })
    }
    fn receive(&self, _: ReceivePrompt) -> Decision<Option<PathBuf>> {
        Box::pin(async { Ok(None) })
    }
}

#[tokio::test]
async fn original_lan_handover_runs_actual_receiver_pairing_and_joins_before_releasing_the_original_lease(
) {
    let Setup {
        runtime,
        preparation,
        runtime_id,
        mut owner,
        original_identity,
        original_state,
        ..
    } = fixture(true, true);
    let lan = runtime.fixture.0.join("profile/LanTransfers");
    let (store, identity) = owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let receiver = Receiver::start_owned(
        store,
        identity.clone(),
        "Migrated original".into(),
        Arc::new(AcceptPair),
    )
    .await
    .unwrap();
    let server = Server::bind(
        identity.clone(),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
        Limits::default(),
        Arc::new(receiver.clone()),
    )
    .await
    .unwrap();
    receiver.set_port(server.address().port());
    let peer_root = runtime.fixture.0.join("peer");
    fs::create_dir(&peer_root).unwrap();
    let peer_store = StateStore::open(&peer_root).unwrap();
    let peer_identity = Arc::new(
        peer_store
            .ensure_identity(&CancellationToken::new())
            .unwrap(),
    );
    let peer = Receiver::start_owned(
        peer_store,
        peer_identity.clone(),
        "Peer".into(),
        Arc::new(AcceptPair),
    )
    .await
    .unwrap();
    let peer_server = Server::bind(
        peer_identity.clone(),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
        Limits::default(),
        Arc::new(peer.clone()),
    )
    .await
    .unwrap();
    peer.set_port(peer_server.address().port());
    let pairing = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        peer.connect_device("127.0.0.1", server.address().port(), None),
    )
    .await;
    let receiver_stop = receiver.stop().await;
    let server_stop = server.stop().await;
    let peer_stop = peer.stop().await;
    let peer_server_stop = peer_server.stop().await;
    assert_eq!(pairing.unwrap().unwrap().fingerprint, identity.fingerprint);
    receiver_stop.unwrap();
    server_stop.unwrap();
    peer_stop.unwrap();
    peer_server_stop.unwrap();
    let latest = fs::read(lan.join("state.json")).unwrap();
    assert!(crate::lan::storage::State::parse(&latest)
        .unwrap()
        .trusted
        .contains(&peer_identity.fingerprint));
    assert_ne!(latest, original_state);
    owner.verify().unwrap();
    assert!(StateStore::open(&lan).is_err());
    assert!(fs::write(lan.join("identity.json"), b"replacement").is_err());
    let record = record(&runtime, &preparation, &runtime_id, &owner);
    assert!(record.join("decision.json").exists());
    drop(owner);
    StateStore::open(&lan).unwrap();
    assert_eq!(
        fs::read(lan.join("identity.json")).unwrap(),
        original_identity
    );
    assert_eq!(
        fs::read(runtime.fixture.0.join("snapshot/lan-state.json")).unwrap(),
        original_state
    );
}
