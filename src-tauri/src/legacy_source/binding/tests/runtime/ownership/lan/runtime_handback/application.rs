use super::*;
use serde_json::{json, Value};

fn archive(runtime: &str, workspace: &str, entries: Value) -> Vec<u8> {
    let payload = json!({"id":uuid::Uuid::new_v4().to_string(),"createdAt":"2026-11-14T03:40:00.000Z",
        "source":{"runtime":runtime,"appVersion":"1.0.2","workspaceFingerprint":workspace},"entries":entries}).to_string();
    json!({"format":"dustdesk-browser-drafts","version":1,"payload":payload,"sha256":format!("{:x}",Sha256::digest(payload.as_bytes()))}).to_string().into_bytes()
}

fn application_fixture() -> Held {
    let mut runtime = Runtime::new();
    let destination =
        std::env::temp_dir().join(format!("dustdesk-runtime-preview-{}", uuid::Uuid::new_v4()));
    fs::rename(&runtime.fixture.0, &destination).unwrap();
    runtime.fixture.0 = destination;
    fs::create_dir_all(runtime.fixture.0.join("data/Assets/original-empty")).unwrap();
    fs::write(runtime.fixture.0.join("data/Assets/raw.bin"), b"before").unwrap();
    let cancel = CancellationToken::new();
    let bound = runtime.open().unwrap();
    let drafts = archive(
        "electron",
        &bound.binding().workspace_sha256,
        json!([
            {"key":"widget-task-draft:v1:todo","value":"{ \"title\":\"原任务🪶\", \"requestId\":\"old\" }"},
            {"key":"widget-notes:selected","value":"old-note"},
            {"key":"widget-note:both","value":"{\"title\":\"旧标题\",\"text\":\"旧正文\",\"previousTitle\":\"\",\"previousText\":\"\"}"}
        ]),
    );
    let mut source = bound.freeze(&cancel, || Ok(())).unwrap();
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
    let mut owner = source
        .claim_runtime(&preparation.id, &prepared.id, &cancel, || Ok(()))
        .unwrap();
    let browser = owner.prepare_browser_profile().unwrap().fingerprint();
    Held {
        owner,
        runtime,
        preparation: preparation.id,
        runtime_id: prepared.id,
        browser,
    }
}

fn seal(setup: &mut Held) -> Vec<u8> {
    let workspace = b"{\r\n\"SchemaVersion\":3,\"unknownLatestField\":17\r\n}";
    fs::write(setup.owner.path().join("workspace.json"), workspace).unwrap();
    fs::remove_file(setup.owner.path().join("Assets/raw.bin")).unwrap();
    fs::write(
        setup.owner.path().join("Assets/latest.bin"),
        [0, 255, 13, 10, 1],
    )
    .unwrap();
    fs::create_dir(setup.owner.path().join("Assets/latest-empty")).unwrap();
    let fingerprint = format!("{:x}", Sha256::digest(workspace));
    let drafts = archive(
        "tauri",
        &fingerprint,
        json!([
            {"key":"widget-notes:selected","value":""},
            {"key":"widget-note:both","value":"{ \"saved\":true }"},
            {"key":"widget-note:new","value":"{ \"title\":\"新标题\", \"text\":\"\\ud800\\n中文🪶\", \"previousTitle\":\"\", \"previousText\":\"\" }"}
        ]),
    );
    setup
        .owner
        .seal_runtime_preview(&drafts, &fingerprint, &setup.browser, || Ok(()))
        .unwrap();
    drafts
}

fn root(setup: &Held) -> PathBuf {
    setup.record().with_file_name("RuntimeApplication")
}

#[test]
fn runtime_application_copies_latest_pinned_assets_and_records_exact_overwrite_deletion_and_empty_values(
) {
    let mut setup = application_fixture();
    let original = fs::read(setup.runtime.fixture.0.join("data/workspace.json")).unwrap();
    let drafts = seal(&mut setup);
    let record = root(&setup);
    let receipt = setup
        .owner
        .prepare_runtime_application_preview(|| Ok(()))
        .unwrap();
    assert!(
        !receipt.application_ready && !receipt.original_data_applied && !receipt.session_applied
    );
    assert!(!receipt.production_ready && !receipt.migration_complete);
    assert!(fs::write(
        record.join("Incoming/Assets/latest.bin"),
        b"must remain pinned"
    )
    .is_err());
    assert!(fs::write(
        setup.runtime.fixture.0.join("data/Assets/raw.bin"),
        b"must remain original"
    )
    .is_err());
    assert!(setup.owner.confirm().is_err());
    assert_eq!(
        setup
            .owner
            .prepare_runtime_application_preview(|| Ok(()))
            .unwrap(),
        receipt
    );
    let cold = setup.cold();
    assert_eq!(
        fs::read(cold.runtime.fixture.0.join("data/workspace.json")).unwrap(),
        original
    );
    assert_eq!(
        fs::read(record.join("Incoming/Assets/latest.bin")).unwrap(),
        [0, 255, 13, 10, 1]
    );
    assert!(record.join("Incoming/Assets/latest-empty").is_dir());
    assert!(!record.join("Incoming/Assets/raw.bin").exists());
    assert_eq!(fs::read(record.join("latest-drafts.json")).unwrap(), drafts);
    let plan: Vec<Value> =
        serde_json::from_slice(&fs::read(record.join("draft-plan.json")).unwrap()).unwrap();
    assert_eq!(plan.len(), 4);
    let by_key = |key: &str| plan.iter().find(|entry| entry["key"] == key).unwrap();
    assert_eq!(by_key("widget-notes:selected")["before"], "old-note");
    assert_eq!(by_key("widget-notes:selected")["after"], "");
    assert!(by_key("widget-task-draft:v1:todo")["after"].is_null());
    assert!(by_key("widget-note:new")["before"].is_null());
    assert_eq!(by_key("widget-note:both")["after"], "{ \"saved\":true }");
    assert!(
        !String::from_utf8(fs::read(record.join("draft-plan.json")).unwrap())
            .unwrap()
            .contains("private-unrelated-key")
    );
    let decision = fs::read(record.join("decision.json")).unwrap();
    for _ in 0..2 {
        let mut owner = cold.open(true).unwrap();
        assert_eq!(
            owner.resume_runtime_application_preview(|| Ok(())).unwrap(),
            receipt
        );
        assert!(owner.confirm().is_err());
    }
    assert_eq!(fs::read(record.join("decision.json")).unwrap(), decision);
}

#[test]
fn runtime_application_complete_payload_interruption_can_only_finish_the_same_prepared_decision() {
    let mut setup = application_fixture();
    seal(&mut setup);
    let record = root(&setup);
    let error = setup
        .owner
        .prepare_runtime_application_preview(|| {
            if record.join("staged-data.json").exists() {
                Err("injected interruption after staged manifest".into())
            } else {
                Ok(())
            }
        })
        .unwrap_err();
    assert!(error.contains("injected interruption"));
    assert!(!record.join("decision.json").exists());
    let cold = setup.cold();
    let mut owner = cold.open(true).unwrap();
    let receipt = owner.resume_runtime_application_preview(|| Ok(())).unwrap();
    assert!(!receipt.application_ready);
    assert!(owner.confirm().is_err());
    drop(owner);
    assert!(record.join("decision.json").exists());
}

#[test]
fn runtime_application_incomplete_copy_or_unknown_record_remains_blocked_without_repair() {
    for unknown in [false, true] {
        let mut setup = application_fixture();
        seal(&mut setup);
        let record = root(&setup);
        if unknown {
            setup
                .owner
                .prepare_runtime_application_preview(|| Ok(()))
                .unwrap();
        } else {
            assert!(setup
                .owner
                .prepare_runtime_application_preview(|| {
                    if record.join("preparing.json").exists() {
                        Err("injected before copy".into())
                    } else {
                        Ok(())
                    }
                })
                .is_err());
        }
        let cold = setup.cold();
        if unknown {
            fs::write(record.join("foreign.part"), b"preserve unknown evidence").unwrap();
        }
        let before = fs::read(record.join("preparing.json")).unwrap();
        let mut owner = cold.open(true).unwrap();
        assert!(owner.resume_runtime_application_preview(|| Ok(())).is_err());
        assert!(owner.confirm().is_err());
        drop(owner);
        assert_eq!(fs::read(record.join("preparing.json")).unwrap(), before);
        if !unknown {
            assert!(!record.join("Incoming").exists());
            assert!(!record.join("decision.json").exists());
        } else {
            assert_eq!(
                fs::read(record.join("foreign.part")).unwrap(),
                b"preserve unknown evidence"
            );
        }
    }
}

#[test]
fn runtime_application_changed_copy_original_or_plan_cannot_reuse_a_prepared_receipt() {
    for target in [
        "Incoming/Assets/latest.bin",
        "draft-plan.json",
        "original-data.json",
        "latest-drafts.json",
    ] {
        let mut setup = application_fixture();
        seal(&mut setup);
        let record = root(&setup);
        setup
            .owner
            .prepare_runtime_application_preview(|| Ok(()))
            .unwrap();
        let cold = setup.cold();
        fs::write(record.join(target), b"unknown replacement").unwrap();
        let mut owner = cold.open(true).unwrap();
        assert!(
            owner.resume_runtime_application_preview(|| Ok(())).is_err(),
            "{target}"
        );
        assert!(owner.confirm().is_err());
    }
}

#[test]
fn runtime_application_does_not_promote_unvalidated_legacy_fixture_drafts_into_an_application_plan()
{
    let mut setup = held(false);
    let (archive, fingerprint) = setup.archive();
    setup
        .owner
        .seal_runtime_preview(archive.as_bytes(), &fingerprint, &setup.browser, || Ok(()))
        .unwrap();
    assert!(setup
        .owner
        .prepare_runtime_application_preview(|| Ok(()))
        .unwrap_err()
        .contains("草稿数据无效"));
    assert!(!root(&setup).exists());
}

#[test]
fn runtime_application_preserves_read_only_metadata_and_historical_control_record_bytes() {
    let mut setup = application_fixture();
    let output = setup.owner.path().to_path_buf();
    let asset = output.join("Assets/readonly.bin");
    fs::write(&asset, b"read-only exact bytes").unwrap();
    let mut permissions = fs::metadata(&asset).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&asset, permissions).unwrap();
    let modified = fs::metadata(&asset).unwrap().modified().unwrap();
    let controls = [
        (
            "MigrationTransaction.json",
            b"{ \"historical\": 1 }\r\n".as_slice(),
        ),
        (
            "ElectronMigrationTransaction.json",
            b"{\"historical\":2}\n".as_slice(),
        ),
        (
            "MigrationLineage/lineage.json",
            b"{ \"historical\": 3 }".as_slice(),
        ),
    ];
    fs::create_dir(output.join("MigrationLineage")).unwrap();
    for (name, bytes) in controls {
        fs::write(output.join(name), bytes).unwrap();
    }
    seal(&mut setup);
    let record = root(&setup);
    let receipt = setup
        .owner
        .prepare_runtime_application_preview(|| Ok(()))
        .unwrap();
    let cold = setup.cold();
    let copied = record.join("Incoming/Assets/readonly.bin");
    assert_eq!(fs::read(&copied).unwrap(), b"read-only exact bytes");
    assert!(fs::metadata(&copied).unwrap().permissions().readonly());
    assert_eq!(fs::metadata(&copied).unwrap().modified().unwrap(), modified);
    for (name, bytes) in controls {
        assert_eq!(fs::read(record.join("Incoming").join(name)).unwrap(), bytes);
    }
    let mut owner = cold.open(true).unwrap();
    assert_eq!(
        owner.resume_runtime_application_preview(|| Ok(())).unwrap(),
        receipt
    );
    assert!(!receipt.application_ready && !receipt.original_data_applied);
}

#[test]
fn runtime_application_recovery_rejects_same_size_time_bytes_and_replaced_empty_directory() {
    for directory in [false, true] {
        let mut setup = application_fixture();
        seal(&mut setup);
        let record = root(&setup);
        setup
            .owner
            .prepare_runtime_application_preview(|| Ok(()))
            .unwrap();
        let cold = setup.cold();
        let decision = fs::read(record.join("decision.json")).unwrap();
        if directory {
            // Retain the old directory so the filesystem cannot reuse its ID.
            let path = record.join("Incoming/Assets/latest-empty");
            fs::rename(&path, record.join("displaced-empty")).unwrap();
            fs::create_dir(&path).unwrap();
            fs::remove_dir(record.join("displaced-empty")).unwrap();
        } else {
            let path = record.join("Incoming/Assets/latest.bin");
            let original = fs::metadata(&path).unwrap();
            fs::write(&path, [1, 255, 13, 10, 0]).unwrap();
            let file = fs::OpenOptions::new().write(true).open(&path).unwrap();
            file.set_times(fs::FileTimes::new().set_modified(original.modified().unwrap()))
                .unwrap();
            drop(file);
            let changed = fs::metadata(&path).unwrap();
            assert_eq!(original.len(), changed.len());
            assert_eq!(original.modified().unwrap(), changed.modified().unwrap());
        }
        let mut owner = cold.open(true).unwrap();
        let error = owner
            .resume_runtime_application_preview(|| Ok(()))
            .unwrap_err();
        assert!(
            error.contains(if directory {
                "物理身份"
            } else {
                "完整摘要"
            }),
            "{error}"
        );
        assert!(owner.confirm().is_err());
        drop(owner);
        assert_eq!(fs::read(record.join("decision.json")).unwrap(), decision);
    }
}
