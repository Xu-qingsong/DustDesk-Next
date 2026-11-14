use super::*;
use std::{cell::Cell, fs::OpenOptions};

fn prepared(lan: bool) -> (Fixture, Receipt) {
    let fixture = Fixture::new(lan);
    let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    let cancel = CancellationToken::new();
    let mut lan = Frozen::capture(&fixture.profile, &cancel, || Ok(())).unwrap();
    let status = fixture.prepare(&catalog, &mut lan);
    let Outcome::HandoffPrepared { receipt } = status.outcome else {
        panic!("not prepared")
    };
    (fixture, receipt)
}

fn files(fixture: &Fixture) -> Vec<PathBuf> {
    let mut files = vec!["handoff.json", "browser-drafts.json", "Data/snapshot.json"]
        .into_iter()
        .map(|name| fixture.destination.join(name))
        .collect::<Vec<_>>();
    if fixture.destination.join("lan-state.json").exists() {
        files.push(fixture.destination.join("lan-state.json"));
    }
    files.extend(
        fs::read_dir(fixture.destination.join("Data/objects"))
            .unwrap()
            .map(|entry| entry.unwrap().path()),
    );
    files
}

#[test]
fn target_keeps_every_component_and_original_object_handle_across_repeated_verification() {
    for lan in [false, true] {
        let (fixture, receipt) = prepared(lan);
        let paths = files(&fixture);
        let cancel = CancellationToken::new();
        let mut target =
            VerifiedTarget::capture(&fixture.destination, &receipt, &cancel, &|| Ok(())).unwrap();
        for path in &paths {
            assert!(
                OpenOptions::new().read(true).open(path).is_err(),
                "{}",
                path.display()
            );
            assert!(
                OpenOptions::new().write(true).open(path).is_err(),
                "{}",
                path.display()
            );
            assert!(fs::remove_file(path).is_err());
            assert!(fs::rename(path, path.with_extension("moved")).is_err());
        }
        for name in ["", "Data", "Data/objects"] {
            let path = fixture.destination.join(name);
            assert!(fs::rename(&path, path.with_extension("moved")).is_err());
        }
        target.verify(&cancel, &|| Ok(())).unwrap();
        target.verify(&cancel, &|| Ok(())).unwrap();
        drop(target);
        for path in paths {
            OpenOptions::new().write(true).open(path).unwrap();
        }
    }
}

#[test]
fn target_detects_late_entries_in_all_three_directories_without_releasing_valid_pins() {
    for name in ["extra", "Data/extra", "Data/objects/999999.bin"] {
        let (fixture, receipt) = prepared(true);
        let cancel = CancellationToken::new();
        let mut target =
            VerifiedTarget::capture(&fixture.destination, &receipt, &cancel, &|| Ok(())).unwrap();
        fs::write(fixture.destination.join(name), b"late").unwrap();
        assert!(target.confirm(&cancel, &|| Ok(())).is_err(), "{name}");
        assert!(target.verify(&cancel, &|| Ok(())).is_err(), "{name}");
        assert!(OpenOptions::new()
            .write(true)
            .open(fixture.destination.join("handoff.json"))
            .is_err());
        drop(target);
        OpenOptions::new()
            .write(true)
            .open(fixture.destination.join("handoff.json"))
            .unwrap();
    }
}

#[test]
fn target_refuses_every_preexisting_component_writer_and_drops_partial_pins() {
    let (fixture, receipt) = prepared(true);
    let paths = files(&fixture);
    for path in &paths {
        let writer = OpenOptions::new().write(true).open(path).unwrap();
        assert!(
            VerifiedTarget::capture(
                &fixture.destination,
                &receipt,
                &CancellationToken::new(),
                &|| Ok(())
            )
            .is_err(),
            "{}",
            path.display()
        );
        drop(writer);
        for released in &paths {
            OpenOptions::new().write(true).open(released).unwrap();
        }
    }
}

#[test]
fn target_cannot_be_constructed_from_tampered_receipts_or_a_copied_bundle() {
    let (fixture, receipt) = prepared(true);
    for field in ["root", "data", "id", "components", "manifest"] {
        let mut changed = receipt.clone();
        match field {
            "root" => changed.destination_identity.index ^= 1,
            "data" => changed.data.destination_identity.index ^= 1,
            "id" => changed.id = Uuid::new_v4().to_string(),
            "components" => changed.components_sha256 = "0".repeat(64),
            _ => changed.manifest_sha256 = "0".repeat(64),
        }
        assert!(
            VerifiedTarget::capture(
                &fixture.destination,
                &changed,
                &CancellationToken::new(),
                &|| Ok(())
            )
            .is_err(),
            "{field}"
        );
        for path in files(&fixture) {
            OpenOptions::new().write(true).open(path).unwrap();
        }
    }
    let copy = fixture.root.join("copy");
    copy_tree(&fixture.destination, &copy);
    assert!(verify(&copy, &receipt.manifest_sha256, &CancellationToken::new()).is_ok());
    assert!(
        VerifiedTarget::capture(&copy, &receipt, &CancellationToken::new(), &|| Ok(())).is_err()
    );
}

#[test]
fn target_capture_checks_cancellation_and_native_authority_after_partial_pinning() {
    for cancellation in [false, true] {
        let (fixture, receipt) = prepared(true);
        let cancel = CancellationToken::new();
        let observed = Cell::new(false);
        let object = fixture.destination.join("Data/objects/000000.bin");
        let current = || {
            if OpenOptions::new().write(true).open(&object).is_err() {
                observed.set(true);
                if cancellation {
                    cancel.cancel();
                } else {
                    return Err("native authority closed".into());
                }
            }
            Ok(())
        };
        assert!(
            VerifiedTarget::capture(&fixture.destination, &receipt, &cancel, &current).is_err()
        );
        assert!(observed.get());
        for path in files(&fixture) {
            OpenOptions::new().write(true).open(path).unwrap();
        }
    }
}

#[test]
fn target_repeat_checks_authority_and_cancellation_without_reopening_locked_files() {
    let (fixture, receipt) = prepared(true);
    let cancel = CancellationToken::new();
    let mut target =
        VerifiedTarget::capture(&fixture.destination, &receipt, &cancel, &|| Ok(())).unwrap();
    assert!(target
        .verify(&cancel, &|| Err("native authority closed".into()))
        .is_err());
    target.verify(&cancel, &|| Ok(())).unwrap();
    cancel.cancel();
    assert!(target.confirm(&cancel, &|| Ok(())).is_err());
    assert!(target.verify(&cancel, &|| Ok(())).is_err());
    for path in files(&fixture) {
        assert!(OpenOptions::new().write(true).open(&path).is_err());
    }
    drop(target);
    for path in files(&fixture) {
        OpenOptions::new().write(true).open(path).unwrap();
    }
}

#[test]
fn target_browser_read_is_bounded_cancelable_between_chunks_and_restarts_from_original_handle() {
    let mut fixture = Fixture::new(false);
    let mut archive: Value = serde_json::from_slice(&fixture.drafts).unwrap();
    let mut payload: Value = serde_json::from_str(archive["payload"].as_str().unwrap()).unwrap();
    payload["entries"][0]["value"] = "raw draft data".repeat(20_000).into();
    let payload = payload.to_string();
    archive["sha256"] = hash(payload.as_bytes()).into();
    archive["payload"] = payload.into();
    fixture.drafts = serde_json::to_vec_pretty(&archive).unwrap();
    let catalog = Catalog::open(&fixture.data, &fixture.catalog).unwrap();
    let cancel = CancellationToken::new();
    let mut lan = Frozen::capture(&fixture.profile, &cancel, || Ok(())).unwrap();
    let Outcome::HandoffPrepared { receipt } = fixture.prepare(&catalog, &mut lan).outcome else {
        panic!("not prepared")
    };
    let mut target =
        VerifiedTarget::capture(&fixture.destination, &receipt, &cancel, &|| Ok(())).unwrap();
    assert!(target
        .drafts
        .read_verified(fixture.drafts.len() - 1, &cancel, &|| Ok(()))
        .is_err());
    for cancellation in [false, true] {
        let cancel = CancellationToken::new();
        let calls = Cell::new(0);
        let current = || {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                if cancellation {
                    cancel.cancel();
                } else {
                    return Err("native client disconnected between chunks".into());
                }
            }
            Ok(())
        };
        assert!(target
            .drafts
            .read_verified(MAX_DRAFTS, &cancel, &current)
            .is_err());
        assert_eq!(calls.get(), 3);
        assert!(OpenOptions::new()
            .read(true)
            .open(fixture.destination.join("browser-drafts.json"))
            .is_err());
        let (raw, proof) = target
            .browser_archive(&CancellationToken::new(), &|| Ok(()))
            .unwrap();
        assert_eq!(*raw, fixture.drafts);
        assert_eq!(proof.archive_sha256, hash(&fixture.drafts));
    }
}
