use super::*;
use crate::{
    lan::migration::{service::Services, ReleaseKind},
    legacy_source::binding::snapshot::RuntimeOwner,
};

// Owner first: native handles must close before the temporary fixture is removed,
// including when an assertion fails.
struct Held {
    owner: RuntimeOwner,
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
}
struct Cold {
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    ownership: String,
    record: PathBuf,
}
fn held(initialized: bool) -> Held {
    let Setup {
        owner,
        runtime,
        preparation,
        runtime_id,
        ..
    } = fixture(initialized, true);
    Held {
        owner,
        runtime,
        preparation,
        runtime_id,
    }
}
impl Held {
    fn record(&self) -> PathBuf {
        record(
            &self.runtime,
            &self.preparation,
            &self.runtime_id,
            &self.owner,
        )
    }
    fn cold(self) -> Cold {
        let record = self.record();
        let Held {
            owner,
            runtime,
            preparation,
            runtime_id,
        } = self;
        let ownership = owner.receipt().id.clone();
        drop(owner);
        Cold {
            runtime,
            preparation,
            runtime_id,
            ownership,
            record,
        }
    }
}
impl Cold {
    fn lan(&self) -> PathBuf {
        self.runtime.fixture.0.join("profile/LanTransfers")
    }
    fn recover(&self) -> Result<(RuntimeOwner, ReleaseKind), String> {
        let cancel = CancellationToken::new();
        self.runtime
            .open()?
            .freeze(&cancel, || Ok(()))?
            .resume_runtime_for_original_lan_release(
                &self.preparation,
                &self.runtime_id,
                &self.ownership,
                &cancel,
                || Ok(()),
            )
    }
}

#[test]
fn original_lan_release_without_grant_preserves_initialized_or_absent_lan_and_all_pins() {
    for initialized in [false, true] {
        let setup = held(initialized);
        let cold = setup.cold();
        let before = fs::read(cold.lan().join("state.json")).ok();
        for _ in 0..2 {
            let (mut owner, kind) = cold.recover().unwrap();
            assert!(matches!(kind, ReleaseKind::NotStarted));
            owner.confirm_original_lan_not_started_preview().unwrap();
            assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
            owner.verify().unwrap();
            if initialized {
                assert!(fs::write(cold.lan().join("state.json"), b"replacement").is_err());
            } else {
                assert!(!cold.lan().exists());
            }
            assert!(!cold.record.exists());
            drop(owner);
        }
        assert_eq!(fs::read(cold.lan().join("state.json")).ok(), before);
    }
}

#[test]
fn original_lan_release_empty_or_intent_only_becomes_durable_idempotent_abort_without_grant() {
    for intent in [false, true] {
        let mut setup = held(true);
        let record = setup.record();
        if intent {
            assert!(setup
                .owner
                .prepare_original_lan_preview(|| {
                    if record.join("intent.json").exists() {
                        Err("stop before grant".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err());
        } else {
            fs::create_dir(&record).unwrap();
        }
        let cold = setup.cold();
        let before = fs::read(cold.lan().join("state.json")).unwrap();
        let mut abort = None;
        for _ in 0..2 {
            let (mut owner, kind) = cold.recover().unwrap();
            assert!(matches!(kind, ReleaseKind::NotStarted));
            owner.confirm_original_lan_not_started_preview().unwrap();
            assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
            assert!(!record.join("decision.json").exists());
            assert!(fs::write(record.join("aborted.json"), b"changed").is_err());
            owner.verify().unwrap();
            drop(owner);
            let bytes = fs::read(record.join("aborted.json")).unwrap();
            if let Some(previous) = &abort {
                assert_eq!(previous, &bytes);
            }
            abort = Some(bytes);
        }
        assert_eq!(fs::read(cold.lan().join("state.json")).unwrap(), before);
    }
}

#[tokio::test]
async fn original_lan_release_live_grant_drains_latest_state_without_listener_and_recovers_terminal_handback(
) {
    let mut setup = held(true);
    let (mut store, _) = setup.owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let mut state = store.state().clone();
    state.extra.insert("latestBeforeRelease".into(), 37.into());
    store.commit(state).unwrap();
    drop(store);
    let cold = setup.cold();
    let intent = fs::read(cold.record.join("intent.json")).unwrap();
    let (mut owner, kind) = cold.recover().unwrap();
    assert!(matches!(kind, ReleaseKind::Drain));
    assert!(owner.confirm_original_lan_not_started_preview().is_err());
    let (store, identity) = owner.resume_original_lan_preview(|| Ok(())).unwrap();
    assert_eq!(store.state().extra["latestBeforeRelease"], 37);
    let drained = Services::drain_recovered(store, identity).await.unwrap();
    let receipt = owner
        .finish_original_lan_preview(&drained, || Ok(()))
        .unwrap();
    owner.verify().unwrap();
    assert!(fs::write(cold.lan().join("state.json"), b"changed").is_err());
    drop(owner);
    let latest = fs::read(cold.lan().join("state.json")).unwrap();
    assert_eq!(
        receipt.checkpoint.state.as_ref().unwrap().sha256,
        format!("{:x}", Sha256::digest(&latest))
    );
    let (mut owner, kind) = cold.recover().unwrap();
    assert!(matches!(kind, ReleaseKind::Handback));
    assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
    assert_eq!(
        serde_json::to_value(
            owner
                .resume_original_lan_handback_preview(|| Ok(()))
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    drop(owner);
    assert_eq!(fs::read(cold.lan().join("state.json")).unwrap(), latest);
    assert_eq!(fs::read(cold.record.join("intent.json")).unwrap(), intent);
}

#[test]
fn original_lan_release_rejects_unknown_or_orphan_records_without_mutation() {
    for name in [
        "unknown.bin",
        "aborted.json",
        "decision.json",
        ".publish.tmp",
    ] {
        let setup = held(true);
        let record = setup.record();
        fs::create_dir(&record).unwrap();
        fs::write(record.join(name), b"preserve untrusted record").unwrap();
        let cold = setup.cold();
        assert!(cold.recover().is_err());
        assert_eq!(
            fs::read(record.join(name)).unwrap(),
            b"preserve untrusted record"
        );
        assert_eq!(fs::read_dir(record).unwrap().count(), 1);
    }
}

#[test]
fn original_lan_release_rejects_changed_ungranted_state_or_foreign_intent_and_abort() {
    for change in ["state", "intent", "abort"] {
        let mut setup = held(true);
        let record = setup.record();
        assert!(setup
            .owner
            .prepare_original_lan_preview(|| {
                if record.join("intent.json").exists() {
                    Err("stop before grant".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        let cold = setup.cold();
        let target = match change {
            "state" => cold.lan().join("state.json"),
            "intent" => record.join("intent.json"),
            _ => record.join("aborted.json"),
        };
        let bytes = if change == "state" {
            let mut state: serde_json::Value =
                serde_json::from_slice(&fs::read(&target).unwrap()).unwrap();
            state["foreignChange"] = true.into();
            serde_json::to_vec(&state).unwrap()
        } else {
            b"{}".to_vec()
        };
        fs::write(&target, &bytes).unwrap();
        assert!(cold.recover().is_err());
        assert_eq!(fs::read(target).unwrap(), bytes);
        assert!(!record.join("decision.json").exists());
    }
}
