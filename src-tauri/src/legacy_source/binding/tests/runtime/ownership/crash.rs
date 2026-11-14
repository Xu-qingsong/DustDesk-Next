use super::*;

struct ChildGuard(std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn runtime_ownership_process_exit_at_intent_grant_or_mutation_preserves_only_durable_authority() {
    const TEST: &str = "legacy_source::binding::tests::runtime::ownership::crash::runtime_ownership_process_exit_at_intent_grant_or_mutation_preserves_only_durable_authority";
    if let Some(root) = std::env::var_os("DUSTDESK_RUNTIME_OWNERSHIP_CHILD_ROOT") {
        let runtime = std::mem::ManuallyDrop::new(Runtime {
            fixture: Fixture(PathBuf::from(root)),
        });
        let preparation_id = std::env::var("DUSTDESK_RUNTIME_OWNERSHIP_PREPARATION").unwrap();
        let runtime_id = std::env::var("DUSTDESK_RUNTIME_OWNERSHIP_RUNTIME").unwrap();
        let phase = std::env::var("DUSTDESK_RUNTIME_OWNERSHIP_PHASE").unwrap();
        let cancel = CancellationToken::new();
        let source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        let claims = records(&runtime, &preparation_id)
            .join(&runtime_id)
            .join("Ownership");
        let owner = source
            .claim_runtime(&preparation_id, &runtime_id, &cancel, || {
                if phase == "intent"
                    && claims.exists()
                    && ids(&claims)
                        .iter()
                        .any(|id| claims.join(id).join("intent.json").exists())
                {
                    std::process::exit(62);
                }
                Ok(())
            })
            .unwrap();
        if phase == "mutation" {
            fs::write(owner.path().join("Assets/raw.bin"), b"post-startup bytes").unwrap();
        }
        if phase == "hold" {
            fs::write(runtime.fixture.0.join("owner-ready"), b"native pipe held").unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(20);
            while !runtime.fixture.0.join("owner-close").exists() {
                assert!(std::time::Instant::now() < deadline);
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        std::process::exit(63);
    }
    for phase in ["intent", "grant", "mutation", "hold"] {
        let (runtime, preparation_id, prepared, source) = setup();
        drop(source);
        let mut child = ChildGuard(
            Command::new(std::env::current_exe().unwrap())
                .args([TEST, "--exact", "--nocapture"])
                .env("DUSTDESK_RUNTIME_OWNERSHIP_CHILD_ROOT", &runtime.fixture.0)
                .env("DUSTDESK_RUNTIME_OWNERSHIP_PREPARATION", &preparation_id)
                .env("DUSTDESK_RUNTIME_OWNERSHIP_RUNTIME", &prepared.id)
                .env("DUSTDESK_RUNTIME_OWNERSHIP_PHASE", phase)
                .stdout(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        if phase == "hold" {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while !runtime.fixture.0.join("owner-ready").exists() {
                assert!(
                    child.0.try_wait().unwrap().is_none(),
                    "child exited before real owner ready"
                );
                assert!(
                    std::time::Instant::now() < deadline,
                    "child owner not ready"
                );
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
            let root = Directory::open(&runtime.fixture.0.join("RuntimeData")).unwrap();
            let blocked = Lease::acquire(&root).is_err();
            let output_writable = OpenOptions::new()
                .write(true)
                .open(root.path().join("workspace.json"))
                .is_ok();
            let original_blocked = OpenOptions::new()
                .write(true)
                .open(runtime.fixture.0.join("data/workspace.json"))
                .is_err();
            fs::write(runtime.fixture.0.join("owner-close"), b"exit now").unwrap();
            assert_eq!(child.0.wait().unwrap().code(), Some(63));
            assert!(blocked, "another process acquired the actual runtime pipe");
            assert!(
                output_writable,
                "output remained readonly instead of transferring real write ownership"
            );
            assert!(
                original_blocked,
                "original source was released before runtime ownership closed"
            );
            drop(root);
        } else {
            assert_eq!(
                child.0.wait().unwrap().code(),
                Some(if phase == "intent" { 62 } else { 63 })
            );
        }
        let cancel = CancellationToken::new();
        let mut source = runtime.open().unwrap().freeze(&cancel, || Ok(())).unwrap();
        let statuses = source
            .runtime_ownership_statuses(&preparation_id, &prepared.id, &cancel, || Ok(()))
            .unwrap();
        assert_eq!(statuses.len(), 1);
        let output = runtime.fixture.0.join("RuntimeData");
        if phase == "intent" {
            assert!(matches!(statuses[0].outcome, Outcome::Aborted));
            source
                .verify_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
                .unwrap();
        } else {
            assert!(matches!(statuses[0].outcome, Outcome::Granted { .. }));
            assert!(source
                .verify_runtime(&preparation_id, &prepared.id, &cancel, || Ok(()))
                .is_err());
            let mut owner = source
                .resume_runtime(
                    &preparation_id,
                    &prepared.id,
                    &statuses[0].id,
                    &cancel,
                    || Ok(()),
                )
                .unwrap();
            owner.verify().unwrap();
            assert!(Lease::acquire(&Directory::open(&output).unwrap()).is_err());
            if phase == "mutation" {
                assert_eq!(
                    fs::read(output.join("Assets/raw.bin")).unwrap(),
                    b"post-startup bytes"
                );
            }
        }
    }
}
