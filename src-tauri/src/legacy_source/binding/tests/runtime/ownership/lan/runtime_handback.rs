use super::*;
use crate::{lan::migration::service::Services, legacy_source::binding::snapshot::RuntimeOwner};
mod application;

// Close all native pins before removing a temporary fixture, including panic.
struct Held {
    owner: RuntimeOwner,
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    browser: String,
}
struct Cold {
    runtime: Runtime,
    preparation: String,
    runtime_id: String,
    ownership: String,
    record: PathBuf,
    output: PathBuf,
}
fn held(initialized: bool) -> Held {
    let Setup {
        owner,
        runtime,
        preparation,
        runtime_id,
        ..
    } = fixture(initialized, true);
    let mut held = Held {
        owner,
        runtime,
        preparation,
        runtime_id,
        browser: String::new(),
    };
    held.browser = held.owner.prepare_browser_profile().unwrap().fingerprint();
    held
}
impl Held {
    fn record(&self) -> PathBuf {
        records(&self.runtime, &self.preparation)
            .join(&self.runtime_id)
            .join("Ownership")
            .join(&self.owner.receipt().id)
            .join("RuntimeHandback")
    }
    fn archive(&self) -> (String, String) {
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(fs::read(self.owner.path().join("workspace.json")).unwrap())
        );
        let value = serde_json::json!({"title":"最新草稿", "text":"中文🪶\\ud800", "previousTitle":"", "previousText":""}).to_string();
        let payload = serde_json::json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":"2026-11-14T01:00:00.000Z",
            "source":{"runtime":"tauri","appVersion":"1.0.2","workspaceFingerprint":fingerprint},
            "entries":[{"key":"widget-note:latest-runtime", "value":value}]}).to_string();
        let archive =
            serde_json::json!({"format":"dustdesk-browser-drafts","version":1,"payload":payload,
            "sha256":format!("{:x}",Sha256::digest(payload.as_bytes()))})
            .to_string();
        (archive, fingerprint)
    }
    fn cold(self) -> Cold {
        let record = self.record();
        let output = self.owner.path().to_path_buf();
        let ownership = self.owner.receipt().id.clone();
        let Self {
            owner,
            runtime,
            preparation,
            runtime_id,
            ..
        } = self;
        drop(owner);
        Cold {
            runtime,
            preparation,
            runtime_id,
            ownership,
            record,
            output,
        }
    }
}
impl Cold {
    fn open(&self, terminal: bool) -> Result<RuntimeOwner, String> {
        let cancel = CancellationToken::new();
        let source = self.runtime.open()?.freeze(&cancel, || Ok(()))?;
        if terminal {
            source.resume_runtime_for_handback_preview(
                &self.preparation,
                &self.runtime_id,
                &self.ownership,
                &cancel,
                || Ok(()),
            )
        } else {
            source.resume_runtime(
                &self.preparation,
                &self.runtime_id,
                &self.ownership,
                &cancel,
                || Ok(()),
            )
        }
    }
}

#[test]
fn runtime_handback_seals_latest_data_assets_and_browser_then_blocks_writable_replay() {
    let mut setup = held(false);
    let latest = b"{\n\"SchemaVersion\":3,\"unknownLatestField\":17\n}";
    fs::write(setup.owner.path().join("workspace.json"), latest).unwrap();
    fs::create_dir_all(setup.owner.path().join("Assets/latest-empty")).unwrap();
    fs::write(
        setup.owner.path().join("Assets/latest.bin"),
        b"new runtime asset",
    )
    .unwrap();
    let (archive, fingerprint) = setup.archive();
    let receipt = setup
        .owner
        .seal_runtime_preview(archive.as_bytes(), &fingerprint, &setup.browser, || Ok(()))
        .unwrap();
    assert!(!receipt.production_ready && !receipt.migration_complete);
    assert!(setup.owner.confirm().is_err());
    assert!(setup.owner.browser_archive().is_err());
    assert!(fs::write(setup.owner.path().join("workspace.json"), b"changed").is_err());
    assert!(fs::write(setup.owner.path().join("Assets/latest.bin"), b"changed").is_err());
    assert!(fs::remove_dir(setup.owner.path().join("Assets/latest-empty")).is_err());
    assert_eq!(
        serde_json::to_value(
            setup
                .owner
                .resume_runtime_handback_preview(|| Ok(()))
                .unwrap()
        )
        .unwrap(),
        serde_json::to_value(&receipt).unwrap()
    );
    let late = setup.owner.path().join("late.bin");
    fs::write(&late, b"late addition").unwrap();
    assert!(setup
        .owner
        .resume_runtime_handback_preview(|| Ok(()))
        .is_err());
    fs::remove_file(late).unwrap();
    setup
        .owner
        .resume_runtime_handback_preview(|| Ok(()))
        .unwrap();
    let cold = setup.cold();
    assert_eq!(
        fs::read(cold.output.join("workspace.json")).unwrap(),
        latest
    );
    assert_eq!(
        fs::read(cold.record.join("browser-drafts.json")).unwrap(),
        archive.as_bytes()
    );
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(cold.record.join("data.json")).unwrap()).unwrap();
    assert!(manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == "Assets/latest.bin"));
    assert!(manifest["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["path"] == "Assets/latest-empty"));
    let decision = fs::read(cold.record.join("decision.json")).unwrap();
    assert!(cold.open(false).is_err());
    let mut owner = cold.open(true).unwrap();
    assert!(owner.confirm().is_err());
    assert_eq!(
        serde_json::to_value(owner.resume_runtime_handback_preview(|| Ok(())).unwrap()).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    drop(owner);
    assert_eq!(
        fs::read(cold.record.join("decision.json")).unwrap(),
        decision
    );
    assert_eq!(
        fs::read(cold.output.join("workspace.json")).unwrap(),
        latest
    );
}

#[tokio::test]
async fn runtime_handback_requires_real_original_lan_drain_and_binds_latest_terminal_state() {
    let mut setup = held(true);
    let (mut store, identity) = setup.owner.prepare_original_lan_preview(|| Ok(())).unwrap();
    let mut state = store.state().clone();
    state
        .extra
        .insert("latestRuntimeHandback".into(), 73.into());
    store.commit(state).unwrap();
    let services = Services::start(
        store,
        identity,
        "Runtime handback".into(),
        SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0),
        Arc::new(AcceptPair),
    )
    .await
    .unwrap();
    let (archive, fingerprint) = setup.archive();
    assert!(setup
        .owner
        .seal_runtime_preview(archive.as_bytes(), &fingerprint, &setup.browser, || Ok(()))
        .is_err());
    assert!(!setup.record().exists());
    let address = services.address();
    let drained = services.stop().await.unwrap();
    assert!(tokio::net::TcpStream::connect(address).await.is_err());
    let lan = setup
        .owner
        .finish_original_lan_preview(&drained, || Ok(()))
        .unwrap();
    let receipt = setup
        .owner
        .seal_runtime_preview(archive.as_bytes(), &fingerprint, &setup.browser, || Ok(()))
        .unwrap();
    assert_eq!(
        serde_json::to_value(&receipt).unwrap()["lan"]["handbackIntentSha256"],
        lan.intent_sha256
    );
    let cold = setup.cold();
    let state_path = cold
        .runtime
        .fixture
        .0
        .join("profile/LanTransfers/state.json");
    let latest = fs::read(&state_path).unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&latest).unwrap()["latestRuntimeHandback"],
        73
    );
    for release_only in [false, true] {
        let cancel = CancellationToken::new();
        let source = cold
            .runtime
            .open()
            .unwrap()
            .freeze(&cancel, || Ok(()))
            .unwrap();
        if release_only {
            assert!(source
                .resume_runtime_for_original_lan_release(
                    &cold.preparation,
                    &cold.runtime_id,
                    &cold.ownership,
                    &cancel,
                    || Ok(())
                )
                .is_err());
        } else {
            assert!(source
                .resume_runtime_with_original_lan(
                    &cold.preparation,
                    &cold.runtime_id,
                    &cold.ownership,
                    &cancel,
                    || Ok(())
                )
                .is_err());
        }
    }
    let mut owner = cold.open(true).unwrap();
    assert!(owner.resume_original_lan_preview(|| Ok(())).is_err());
    assert_eq!(
        serde_json::to_value(owner.resume_runtime_handback_preview(|| Ok(())).unwrap()).unwrap(),
        serde_json::to_value(receipt).unwrap()
    );
    drop(owner);
    assert_eq!(fs::read(state_path).unwrap(), latest);
}

#[test]
fn runtime_handback_recovers_persisted_payloads_or_lost_success_without_changing_intent() {
    for boundary in ["payloads", "decision"] {
        let mut setup = held(false);
        let record = setup.record();
        let (archive, fingerprint) = setup.archive();
        let result = setup.owner.seal_runtime_preview(
            archive.as_bytes(),
            &fingerprint,
            &setup.browser,
            || {
                let reached = if boundary == "payloads" {
                    record.join("browser-drafts.json").exists()
                } else {
                    record.join("decision.json").exists()
                };
                if reached {
                    Err("explicit boundary interruption".into())
                } else {
                    Ok(())
                }
            },
        );
        assert!(result.is_err());
        assert!(setup.owner.confirm().is_err());
        let cold = setup.cold();
        let intent = fs::read(cold.record.join("intent.json")).unwrap();
        assert_eq!(
            cold.record.join("decision.json").exists(),
            boundary == "decision"
        );
        assert!(cold.open(false).is_err());
        let mut owner = cold.open(true).unwrap();
        owner.resume_runtime_handback_preview(|| Ok(())).unwrap();
        drop(owner);
        assert_eq!(fs::read(cold.record.join("intent.json")).unwrap(), intent);
        assert_eq!(
            fs::read(cold.record.join("browser-drafts.json")).unwrap(),
            archive.as_bytes()
        );
        assert!(cold.record.join("decision.json").exists());
    }
}

#[test]
fn runtime_handback_rejects_empty_unknown_or_incomplete_records_without_repair() {
    for name in [
        None,
        Some("unknown.bin"),
        Some("decision.json"),
        Some("intent.json"),
    ] {
        let setup = held(false);
        let record = setup.record();
        fs::create_dir(&record).unwrap();
        if let Some(name) = name {
            fs::write(record.join(name), b"preserve incomplete record").unwrap();
        }
        let cold = setup.cold();
        assert!(cold.open(false).is_err());
        if let Ok(mut owner) = cold.open(true) {
            assert!(owner.resume_runtime_handback_preview(|| Ok(())).is_err());
        }
        let names = fs::read_dir(&record)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(
            names,
            name.into_iter()
                .map(std::ffi::OsString::from)
                .collect::<Vec<_>>()
        );
        if let Some(name) = name {
            assert_eq!(
                fs::read(record.join(name)).unwrap(),
                b"preserve incomplete record"
            );
        }
    }
}

#[test]
fn runtime_handback_rejects_changed_current_files_archives_profiles_and_extra_records() {
    for mutation in ["asset", "drafts", "profile", "extra", "intent"] {
        let mut setup = held(false);
        let profile = setup
            .owner
            .prepare_browser_profile()
            .unwrap()
            .path()
            .to_path_buf();
        fs::write(setup.owner.path().join("asset.bin"), b"before").unwrap();
        let (archive, fingerprint) = setup.archive();
        setup
            .owner
            .seal_runtime_preview(archive.as_bytes(), &fingerprint, &setup.browser, || Ok(()))
            .unwrap();
        let cold = setup.cold();
        let decision = fs::read(cold.record.join("decision.json")).unwrap();
        match mutation {
            "asset" => {
                let asset = cold.output.join("asset.bin");
                let modified = fs::metadata(&asset).unwrap().modified().unwrap();
                fs::write(&asset, b"AFTER!").unwrap();
                OpenOptions::new()
                    .write(true)
                    .open(asset)
                    .unwrap()
                    .set_times(FileTimes::new().set_modified(modified))
                    .unwrap();
            }
            "drafts" => fs::write(cold.record.join("browser-drafts.json"), b"changed").unwrap(),
            "profile" => {
                fs::rename(&profile, profile.with_extension("old")).unwrap();
                fs::create_dir(&profile).unwrap();
            }
            "extra" => fs::write(cold.record.join("unknown.bin"), b"preserve").unwrap(),
            "intent" => {
                let file = cold.record.join("intent.json");
                let mut intent: serde_json::Value =
                    serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
                intent["ownershipId"] = serde_json::json!(uuid::Uuid::new_v4().to_string());
                fs::write(file, serde_json::to_vec(&intent).unwrap()).unwrap();
            }
            _ => unreachable!(),
        }
        if let Ok(mut owner) = cold.open(true) {
            assert!(
                owner.resume_runtime_handback_preview(|| Ok(())).is_err(),
                "{mutation}"
            );
        }
        assert!(cold.open(false).is_err());
        assert_eq!(
            fs::read(cold.record.join("decision.json")).unwrap(),
            decision
        );
    }
}

#[test]
fn runtime_handback_rejects_foreign_browser_or_stale_workspace_before_persisting_a_terminal_record()
{
    let mut setup = held(false);
    let (archive, fingerprint) = setup.archive();
    assert!(setup
        .owner
        .seal_runtime_preview(archive.as_bytes(), &fingerprint, &"0".repeat(64), || Ok(()))
        .is_err());
    assert!(!setup.record().exists());
    fs::write(
        setup.owner.path().join("workspace.json"),
        b"legitimate newer workspace",
    )
    .unwrap();
    assert!(setup
        .owner
        .seal_runtime_preview(archive.as_bytes(), &fingerprint, &setup.browser, || Ok(()))
        .is_err());
    assert!(!setup.record().exists());
    setup.owner.confirm().unwrap();
}
