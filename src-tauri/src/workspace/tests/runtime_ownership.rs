use super::*;
use dustdesk_tauri::legacy_source::binding::{BoundSource, Locations};
use sha2::{Digest, Sha256};
use tokio_util::sync::CancellationToken;

#[test]
#[ignore = "requires the official released Windows x64 reference bytes"]
fn runtime_ownership_actual_workspace_adopts_the_original_native_lease_writes_resumes_and_revokes()
{
    let installation =
        std::env::var_os("DUSTDESK_LEGACY_REFERENCE").expect("official reference required");
    let root = TestRoot::new();
    let data = root.0.join("SourceData");
    let profile = root.0.join("OriginalProfile");
    let output = root.0.join("RuntimeData");
    fs::create_dir_all(&profile).unwrap();
    let mut original = WorkspaceStore::open(data.clone()).unwrap();
    original.initialize(fixture(), "original").unwrap();
    drop(original);
    fs::create_dir_all(data.join("Assets/Empty")).unwrap();
    fs::write(data.join("Assets/raw.bin"), [0, 255, 13, 10]).unwrap();
    let original_bytes = fs::read(data.join("workspace.json")).unwrap();
    let fingerprint = format!("{:x}", Sha256::digest(&original_bytes));
    let locations = || Locations {
        installation: PathBuf::from(&installation),
        data: data.clone(),
        user_data: profile.clone(),
        browser_profile: profile.clone(),
        workspace_sha256: fingerprint.clone(),
    };
    let cancel = CancellationToken::new();
    let payload = json!({"id":Uuid::new_v4().to_string(),"createdAt":"2026-11-13T04:00:00.000Z",
        "source":{"runtime":"electron","appVersion":"1.0.2","workspaceFingerprint":fingerprint},
        "entries":[{"key":"widget-task-draft:v1:todo","value":"{\"title\":\"original draft\"}"}]})
    .to_string();
    let drafts = json!({"format":"dustdesk-browser-drafts","version":1,"sha256":format!("{:x}",Sha256::digest(payload.as_bytes())),"payload":payload}).to_string();
    let original = WorkspaceStore::open(data.clone()).unwrap();
    let original_identity = original._ownership.identity(&data).unwrap();
    let payload_value: Value = serde_json::from_str(&payload).unwrap();
    let ledger = json!({"format":"dustdesk-draft-lineage","version":1,
        "workspaceId":Uuid::new_v4().to_string(),"root":original_identity,
        "exports":[{"archiveId":payload_value["id"],"archiveSha256":format!("{:x}",Sha256::digest(&drafts)),
        "payloadSha256":format!("{:x}",Sha256::digest(&payload)),"workspaceFingerprint":fingerprint,
        "runtime":"electron","appVersion":"1.0.2","createdAt":payload_value["createdAt"]}]});
    fs::create_dir(data.join("MigrationLineage")).unwrap();
    fs::write(
        data.join("MigrationLineage/lineage.json"),
        ledger.to_string(),
    )
    .unwrap();
    original
        .verify_draft_provenance(&drafts, &fingerprint)
        .unwrap();
    drop(original);
    let source = BoundSource::open(locations(), &cancel, || Ok(())).unwrap();
    let cloned = root.0.join("PlainClone");
    fs::create_dir_all(cloned.join("MigrationLineage")).unwrap();
    fs::write(cloned.join("workspace.json"), &original_bytes).unwrap();
    fs::write(
        cloned.join("MigrationLineage/lineage.json"),
        ledger.to_string(),
    )
    .unwrap();
    let ordinary = WorkspaceStore::open(cloned).unwrap();
    assert!(ordinary
        .verify_draft_provenance(&drafts, &fingerprint)
        .is_err());
    drop(ordinary);
    let mut source = source.freeze(&cancel, || Ok(())).unwrap();
    let preparation = source
        .prepare(
            &root.0.join("Snapshot"),
            &Uuid::new_v4().to_string(),
            drafts.as_bytes(),
            &cancel,
            || Ok(()),
        )
        .unwrap();
    let prepared = source
        .prepare_runtime(&preparation.id, &output, &cancel, || Ok(()))
        .unwrap();
    let mut owner = source
        .claim_runtime(&preparation.id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let receipt = owner.receipt().clone();
    assert_eq!(owner.browser_archive().unwrap().serialized(), drafts);
    assert!(WorkspaceStore::open(output.clone()).is_err());
    let mut store = WorkspaceStore::try_from(owner).unwrap();
    let provenance = store
        .verify_draft_provenance(&drafts, &fingerprint)
        .unwrap();
    assert_eq!(provenance.workspace_id, receipt.id);
    assert_eq!(provenance.source_runtime, "electron");
    let formatted =
        serde_json::to_string_pretty(&serde_json::from_str::<Value>(&drafts).unwrap()).unwrap();
    assert!(store
        .verify_draft_provenance(&formatted, &fingerprint)
        .is_err());
    assert!(store
        .verify_draft_provenance(&drafts, &"a".repeat(64))
        .is_err());
    let request = Uuid::new_v4().to_string();
    assert!(store
        .begin_draft_transaction(&request, &formatted, &fingerprint, &"b".repeat(64))
        .is_err());
    assert_eq!(store.draft_transaction_status().unwrap(), None);
    let snapshot = store.load("runtime").unwrap();
    assert_eq!(snapshot.state["UnknownTop"]["value"], "保留未知数据");
    let mut edited = snapshot.state.clone();
    edited["Notes"][0]["Text"] = "native runtime edit".into();
    let saved = store.save(edited, Some(snapshot.state), "runtime").unwrap();
    assert_eq!(saved.state["Notes"][0]["Text"], "native runtime edit");
    assert!(store
        .verify_draft_provenance(&drafts, &fingerprint)
        .is_err());
    assert!(WorkspaceStore::open(output.clone()).is_err());
    assert!(OpenOptions::new()
        .write(true)
        .open(data.join("workspace.json"))
        .is_err());
    assert!(OpenOptions::new()
        .write(true)
        .open(root.0.join("Snapshot/handoff.json"))
        .is_err());
    drop(store);
    assert_eq!(
        fs::read(data.join("workspace.json")).unwrap(),
        original_bytes
    );
    let source = BoundSource::open(locations(), &cancel, || Ok(()))
        .unwrap()
        .freeze(&cancel, || Ok(()))
        .unwrap();
    let owner = source
        .resume_runtime(&preparation.id, &prepared.id, &receipt.id, &cancel, || {
            Ok(())
        })
        .unwrap();
    let mut store = WorkspaceStore::try_from(owner).unwrap();
    let snapshot = store.load("resumed").unwrap();
    assert_eq!(snapshot.state["Notes"][0]["Text"], "native runtime edit");
    assert!(store
        .verify_draft_provenance(&drafts, &fingerprint)
        .is_err());
    assert_eq!(
        fs::read(output.join("Assets/raw.bin")).unwrap(),
        [0, 255, 13, 10]
    );
    let before_cancel = fs::read(output.join("workspace.json")).unwrap();
    cancel.cancel();
    assert!(store
        .verify_draft_provenance(&drafts, &fingerprint)
        .is_err());
    assert!(store.load("revoked").is_err());
    assert!(store.save(snapshot.state, None, "revoked").is_err());
    assert_eq!(
        fs::read(output.join("workspace.json")).unwrap(),
        before_cancel
    );
    assert!(WorkspaceStore::open(output.clone()).is_err());
    drop(store);
    let ordinary = WorkspaceStore::open(output).unwrap();
    assert!(ordinary
        .verify_draft_provenance(&drafts, &fingerprint)
        .is_err());
    drop(ordinary);
    let browser_cancel = CancellationToken::new();
    let mut source = BoundSource::open(locations(), &browser_cancel, || Ok(()))
        .unwrap()
        .freeze(&browser_cancel, || Ok(()))
        .unwrap();
    let browser_preparation = source
        .prepare(
            &root.0.join("BrowserSnapshot"),
            &Uuid::new_v4().to_string(),
            drafts.as_bytes(),
            &browser_cancel,
            || Ok(()),
        )
        .unwrap();
    let browser_data = source
        .prepare_runtime(
            &browser_preparation.id,
            &root.0.join("RuntimeBrowserData"),
            &browser_cancel,
            || Ok(()),
        )
        .unwrap();
    let owner = source
        .claim_runtime(
            &browser_preparation.id,
            &browser_data.id,
            &browser_cancel,
            || Ok(()),
        )
        .unwrap();
    let mut pending_store = WorkspaceStore::try_from(owner).unwrap();
    let pending = pending_store
        .begin_draft_transaction(&request, &drafts, &fingerprint, &"b".repeat(64))
        .unwrap();
    assert!(pending_store.load("before-native-decision").is_err());
    pending_store
        .decide_draft_transaction(&request, &pending.transaction_id, false, None)
        .unwrap();
    assert!(pending_store.load("before-browser-recovery").is_err());
    browser_cancel.cancel();
    assert!(pending_store
        .verify_draft_provenance(&drafts, &fingerprint)
        .is_err());
    assert_eq!(
        fs::read(data.join("workspace.json")).unwrap(),
        original_bytes
    );
}
