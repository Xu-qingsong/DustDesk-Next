#[cfg(windows)]
use super::native_record_replace::replace as replace_record;
#[cfg(not(windows))]
use super::replace_file as replace_record;
use super::{checked_path, draft_lineage, ownership, TemporaryFile, WorkspaceStore};
use serde::{Deserialize, Serialize};
use std::{fs, fs::OpenOptions, io::Write, path::PathBuf};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Pending,
    Commit,
    Abort,
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    struct ReadOnly {
        path: PathBuf,
        original: fs::Permissions,
    }
    impl ReadOnly {
        fn new(path: &std::path::Path) -> Self {
            let original = fs::metadata(path).unwrap().permissions();
            let mut protected = original.clone();
            protected.set_readonly(true);
            fs::set_permissions(path, protected).unwrap();
            Self {
                path: path.into(),
                original,
            }
        }
    }
    impl Drop for ReadOnly {
        fn drop(&mut self) {
            let _ = fs::set_permissions(&self.path, self.original.clone());
        }
    }
    struct Fixture {
        store: WorkspaceStore,
        root: Root,
        archive: String,
        fingerprint: String,
        request: String,
    }
    fn digest(bytes: impl AsRef<[u8]>) -> String {
        format!("{:x}", Sha256::digest(bytes.as_ref()))
    }
    impl Fixture {
        fn new() -> Self {
            let root = Root(
                std::env::temp_dir().join(format!("dustdesk-rust-transaction-{}", Uuid::new_v4())),
            );
            let mut store = WorkspaceStore::open(root.0.clone()).unwrap();
            store
                .initialize(super::super::normalize::default_state(), "test")
                .unwrap();
            let fingerprint = digest(fs::read(store.path()).unwrap());
            let id = Uuid::new_v4().to_string();
            let payload = json!({"id":id,"createdAt":"2026-11-10T00:00:00.000Z","source":{"runtime":"electron","appVersion":"1.0.2","workspaceFingerprint":fingerprint},"entries":[]}).to_string();
            let archive = json!({"format":"dustdesk-browser-drafts","version":1,"payload":payload,"sha256":digest(&payload)}).to_string();
            let identity = store._ownership.identity(&root.0).unwrap();
            let ledger = json!({"format":"dustdesk-draft-lineage","version":1,"workspaceId":Uuid::new_v4().to_string(),"root":identity,"exports":[{"archiveId":id,"archiveSha256":digest(&archive),"payloadSha256":digest(&payload),"workspaceFingerprint":fingerprint,"runtime":"electron","appVersion":"1.0.2","createdAt":"2026-11-10T00:00:00.000Z"}]});
            fs::create_dir(root.0.join("MigrationLineage")).unwrap();
            fs::write(
                root.0.join("MigrationLineage/lineage.json"),
                ledger.to_string(),
            )
            .unwrap();
            Self {
                store,
                root,
                archive,
                fingerprint,
                request: Uuid::new_v4().to_string(),
            }
        }
        fn begin(&self) -> Status {
            self.store
                .begin_draft_transaction(
                    &self.request,
                    &self.archive,
                    &self.fingerprint,
                    &"a".repeat(64),
                )
                .unwrap()
        }
        fn decide(&self, status: &Status, commit: bool, active: bool) -> Status {
            self.store
                .decide_draft_transaction(
                    &self.request,
                    &status.transaction_id,
                    commit,
                    active.then_some(self.fingerprint.as_str()),
                )
                .unwrap()
        }
    }

    #[test]
    fn pending_record_blocks_load_write_and_another_begin_without_changing_workspace() {
        let mut fixture = Fixture::new();
        let before = fs::read(fixture.store.path()).unwrap();
        let pending = fixture.begin();
        assert_eq!(pending.decision, Decision::Pending);
        assert_eq!(
            fixture.store.draft_transaction_status().unwrap(),
            Some(pending)
        );
        assert!(fixture.store.load("test").unwrap_err().contains("受控恢复"));
        assert!(fixture.store.initialize(json!({}), "other").is_err());
        assert!(fixture
            .store
            .begin_draft_transaction(
                &fixture.request,
                &fixture.archive,
                &fixture.fingerprint,
                &"b".repeat(64)
            )
            .is_err());
        assert_eq!(fs::read(fixture.store.path()).unwrap(), before);
    }

    #[test]
    fn commit_and_abort_decisions_are_immutable_even_after_reopen_and_opposite_requests() {
        for commit in [false, true] {
            let fixture = Fixture::new();
            let pending = fixture.begin();
            let final_status = fixture.decide(&pending, commit, true);
            assert_eq!(
                final_status.decision,
                if commit {
                    Decision::Commit
                } else {
                    Decision::Abort
                }
            );
            assert_eq!(fixture.decide(&pending, !commit, false), final_status);
            let location = fixture.root.0.clone();
            let request = fixture.request.clone();
            drop(fixture.store);
            let store = WorkspaceStore::open(location).unwrap();
            assert_eq!(
                store.draft_transaction_status().unwrap(),
                Some(final_status.clone())
            );
            assert!(store.require_draft_recovered().is_err());
            assert_eq!(
                store
                    .decide_draft_transaction(&request, &pending.transaction_id, !commit, None)
                    .unwrap(),
                final_status
            );
        }
    }

    #[test]
    fn inactive_or_mismatched_native_checkpoint_can_only_choose_abort() {
        for fingerprint in [None, Some("b".repeat(64))] {
            let fixture = Fixture::new();
            let pending = fixture.begin();
            assert_eq!(
                fixture
                    .store
                    .decide_draft_transaction(
                        &fixture.request,
                        &pending.transaction_id,
                        true,
                        fingerprint.as_deref()
                    )
                    .unwrap()
                    .decision,
                Decision::Abort
            );
        }
    }

    #[test]
    fn wrong_request_or_transaction_id_cannot_decide_or_replace_a_pending_record() {
        let fixture = Fixture::new();
        let pending = fixture.begin();
        let path = fixture.store.draft_transaction_path();
        let before = fs::read(&path).unwrap();
        assert!(fixture
            .store
            .decide_draft_transaction(
                &Uuid::new_v4().to_string(),
                &pending.transaction_id,
                true,
                Some(&fixture.fingerprint)
            )
            .is_err());
        assert!(fixture
            .store
            .decide_draft_transaction(&fixture.request, &Uuid::new_v4().to_string(), false, None)
            .is_err());
        assert_eq!(fs::read(path).unwrap(), before);
    }

    #[test]
    fn changed_workspace_before_decision_preserves_pending_for_controlled_recovery() {
        let fixture = Fixture::new();
        let pending = fixture.begin();
        let mut bytes = fs::read(fixture.store.path()).unwrap();
        bytes.push(b' ');
        fs::write(fixture.store.path(), bytes).unwrap();
        assert!(fixture
            .store
            .decide_draft_transaction(
                &fixture.request,
                &pending.transaction_id,
                true,
                Some(&fixture.fingerprint)
            )
            .unwrap_err()
            .contains("已改变"));
        assert_eq!(
            fixture
                .store
                .draft_transaction_status()
                .unwrap()
                .unwrap()
                .decision,
            Decision::Pending
        );
        assert_eq!(
            fixture.decide(&pending, false, false).decision,
            Decision::Abort
        );
    }

    #[test]
    fn passive_shared_readers_do_not_block_decisions_or_observe_partially_replaced_records() {
        use std::{io::Read, os::windows::fs::OpenOptionsExt};
        for commit in [false, true] {
            let fixture = Fixture::new();
            let pending = fixture.begin();
            let path = fixture.store.draft_transaction_path();
            let original = fs::read(&path).unwrap();
            let mut reader = OpenOptions::new()
                .read(true)
                .share_mode(7)
                .open(&path)
                .unwrap();
            let decided = fixture.decide(&pending, commit, true);
            assert_eq!(
                decided.decision,
                if commit {
                    Decision::Commit
                } else {
                    Decision::Abort
                }
            );
            let mut held_bytes = Vec::new();
            reader.read_to_end(&mut held_bytes).unwrap();
            assert_eq!(held_bytes, original);
            assert_eq!(
                fixture.store.draft_recovery_status().unwrap(),
                Some(decided)
            );
            assert!(!fs::read_dir(&fixture.root.0).unwrap().any(|entry| entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".draft-transaction-")));
        }
    }

    #[test]
    fn read_only_and_delete_denied_records_preserve_pending_decisions_and_cleanup_before_explicit_retry(
    ) {
        use std::os::windows::fs::OpenOptionsExt;
        for commit in [false, true] {
            for read_only in [false, true] {
                let fixture = Fixture::new();
                let pending = fixture.begin();
                let path = fixture.store.draft_transaction_path();
                let original = fs::read(&path).unwrap();
                let workspace = fs::read(fixture.store.path()).unwrap();
                let protected = read_only.then(|| ReadOnly::new(&path));
                let held = (!read_only).then(|| {
                    OpenOptions::new()
                        .read(true)
                        .share_mode(1)
                        .open(&path)
                        .unwrap()
                });
                let error = fixture
                    .store
                    .decide_draft_transaction(
                        &fixture.request,
                        &pending.transaction_id,
                        commit,
                        Some(&fixture.fingerprint),
                    )
                    .unwrap_err();
                assert!(error.contains("FileRenameInfoEx"), "{error}");
                assert!(error.contains("MigrationTransaction.json"), "{error}");
                assert!(
                    error.contains("os error 5") || (!read_only && error.contains("os error 32")),
                    "{error}"
                );
                assert_eq!(fs::read(&path).unwrap(), original);
                assert_eq!(fs::read(fixture.store.path()).unwrap(), workspace);
                assert_eq!(
                    fixture.store.draft_transaction_status().unwrap(),
                    Some(pending.clone())
                );
                assert!(fixture.store.require_draft_recovered().is_err());
                assert!(!fs::read_dir(&fixture.root.0).unwrap().any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".draft-transaction-")));
                drop(held);
                drop(protected);
                assert_eq!(
                    fixture.decide(&pending, commit, true).decision,
                    if commit {
                        Decision::Commit
                    } else {
                        Decision::Abort
                    }
                );
            }
        }
    }

    #[test]
    fn denied_browser_completion_preserves_the_irreversible_decision_and_requires_a_successful_native_record(
    ) {
        for commit in [false, true] {
            let fixture = Fixture::new();
            let outer: Value = serde_json::from_str(&fixture.archive).unwrap();
            let payload: Value = serde_json::from_str(outer["payload"].as_str().unwrap()).unwrap();
            let journal =
                json!({"id":payload["id"],"sha256":outer["sha256"],"writes":[]}).to_string();
            let binding = "b".repeat(64);
            let pending = fixture
                .store
                .begin_browser_transaction(
                    &fixture.request,
                    &fixture.archive,
                    &fixture.fingerprint,
                    &digest(&journal),
                    Some(BrowserJournal {
                        raw: &journal,
                        binding: &binding,
                    }),
                )
                .unwrap();
            let decision = fixture.decide(&pending, commit, true);
            let path = fixture.store.draft_transaction_path();
            let original = fs::read(&path).unwrap();
            let protected = ReadOnly::new(&path);
            let error = fixture
                .store
                .complete_draft_browser(&pending.transaction_id, &binding)
                .unwrap_err();
            assert!(
                error.contains("FileRenameInfoEx") && error.contains("os error 5"),
                "{error}"
            );
            assert_eq!(fs::read(&path).unwrap(), original);
            assert_eq!(
                fixture.store.draft_recovery_status().unwrap(),
                Some(decision.clone())
            );
            assert!(fixture.store.require_draft_recovered().is_err());
            drop(protected);
            assert_eq!(fixture.decide(&pending, !commit, false), decision);
            fixture
                .store
                .complete_draft_browser(&pending.transaction_id, &binding)
                .unwrap();
            fixture.store.require_draft_recovered().unwrap();
            assert_eq!(fixture.store.draft_transaction_status().unwrap(), None);
        }
    }

    #[test]
    fn invalid_or_unregistered_archives_cannot_publish_a_transaction() {
        let fixture = Fixture::new();
        for (request, archive, journal) in [
            ("wrong", fixture.archive.as_str(), "a".repeat(64)),
            (fixture.request.as_str(), "{}", "a".repeat(64)),
            (
                fixture.request.as_str(),
                fixture.archive.as_str(),
                "A".repeat(64),
            ),
        ] {
            assert!(fixture
                .store
                .begin_draft_transaction(request, archive, &fixture.fingerprint, &journal)
                .is_err());
            assert_eq!(fixture.store.draft_transaction_status().unwrap(), None);
        }
    }

    #[test]
    fn malformed_future_unknown_or_wrong_root_records_are_preserved_and_block_access() {
        let mut fixture = Fixture::new();
        fixture.begin();
        let path = fixture.store.draft_transaction_path();
        let original: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        for field in ["version", "extra", "root", "decision"] {
            let mut record = original.clone();
            match field {
                "version" => record[field] = json!(2),
                "root" => record[field]["file"] = json!("0000000000000000"),
                "decision" => record[field] = json!("acknowledged"),
                _ => record[field] = json!(true),
            }
            let bytes = record.to_string();
            fs::write(&path, &bytes).unwrap();
            assert!(fixture.store.draft_transaction_status().is_err());
            assert!(fixture.store.load("test").is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        }
        fs::write(&path, "{broken").unwrap();
        assert!(fixture.store.require_draft_recovered().is_err());
        assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
    }

    #[test]
    fn hardlinked_and_non_file_transaction_paths_are_rejected_without_modifying_targets() {
        let fixture = Fixture::new();
        fixture.begin();
        let path = fixture.store.draft_transaction_path();
        let alias = fixture.root.0.join("alias.json");
        fs::hard_link(&path, &alias).unwrap();
        assert!(fixture.store.draft_transaction_status().is_err());
        fs::remove_file(alias).unwrap();
        let held = fixture.root.0.join("held.json");
        fs::rename(&path, &held).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(fixture.store.draft_transaction_status().is_err());
        assert!(held.is_file());
    }

    #[test]
    fn browser_journal_binding_is_validated_before_any_native_record_is_published() {
        let fixture = Fixture::new();
        let outer: Value = serde_json::from_str(&fixture.archive).unwrap();
        let payload: Value = serde_json::from_str(outer["payload"].as_str().unwrap()).unwrap();
        let raw = json!({"id":payload["id"],"sha256":outer["sha256"],"writes":[]}).to_string();
        let begin = |raw: &str, hash: &str| {
            fixture.store.begin_browser_transaction(
                &fixture.request,
                &fixture.archive,
                &fixture.fingerprint,
                hash,
                Some(BrowserJournal {
                    raw,
                    binding: &"b".repeat(64),
                }),
            )
        };
        assert!(begin(&raw, &"c".repeat(64)).is_err());
        assert_eq!(fixture.store.draft_transaction_status().unwrap(), None);
        let mut changed: Value = serde_json::from_str(&raw).unwrap();
        changed["writes"] = json!([{"key":"access-token","value":"never import"}]);
        let changed = changed.to_string();
        assert!(begin(&changed, &digest(&changed)).is_err());
        assert_eq!(fixture.store.draft_transaction_status().unwrap(), None);
        let status = begin(&raw, &digest(&raw)).unwrap();
        assert_eq!(
            status.browser_binding.as_deref(),
            Some("b".repeat(64).as_str())
        );
        assert_eq!(status.payload_sha256.as_deref(), outer["sha256"].as_str());
    }

    #[test]
    fn electron_pending_and_uncompleted_decisions_block_current_store_without_touching_state() {
        let fixture = Fixture::new();
        fixture.begin();
        let source = fixture.store.draft_transaction_path();
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
        fs::remove_file(source).unwrap();
        record["format"] = json!("dustdesk-electron-draft-transaction");
        record["browserBinding"] = json!("b".repeat(64));
        record["payloadSha256"] = json!("c".repeat(64));
        let path = fixture.root.0.join("ElectronMigrationTransaction.json");
        let original = fs::read(fixture.store.path()).unwrap();
        for decision in ["pending", "commit", "abort"] {
            record["decision"] = json!(decision);
            let bytes = record.to_string();
            fs::write(&path, &bytes).unwrap();
            assert!(fixture
                .store
                .require_draft_recovered()
                .unwrap_err()
                .contains("Electron"));
            assert_eq!(fs::read(fixture.store.path()).unwrap(), original);
            assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        }
        for decision in ["commit", "abort"] {
            record["decision"] = json!(decision);
            record["completed"] = json!(true);
            fs::write(&path, record.to_string()).unwrap();
            fixture.store.require_draft_recovered().unwrap();
        }
    }

    #[test]
    fn rejected_electron_handoff_is_checked_before_creating_the_native_workspace_lock() {
        let fixture = Fixture::new();
        fixture.begin();
        let source = fixture.store.draft_transaction_path();
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
        fs::remove_file(source).unwrap();
        record["format"] = json!("dustdesk-electron-draft-transaction");
        record["browserBinding"] = json!("b".repeat(64));
        record["payloadSha256"] = json!("c".repeat(64));
        let original = fs::read(fixture.store.path()).unwrap();
        drop(fixture.store);
        let path = fixture.root.0.join("ElectronMigrationTransaction.json");
        let lock = fixture.root.0.join("workspace.lock");
        fs::remove_file(&lock).unwrap();
        let mut invalid = record.clone();
        invalid["version"] = json!(2);
        let mut copied = record.clone();
        copied["root"]["file"] = json!("0000000000000000");
        for bytes in [
            record.to_string(),
            invalid.to_string(),
            copied.to_string(),
            "{broken".into(),
        ] {
            fs::write(&path, &bytes).unwrap();
            assert!(WorkspaceStore::open(fixture.root.0.clone()).is_err());
            assert!(!lock.exists());
            assert_eq!(
                fs::read(fixture.root.0.join("workspace.json")).unwrap(),
                original
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), bytes);
        }
        record["completed"] = json!(true);
        record["decision"] = json!("abort");
        fs::write(&path, record.to_string()).unwrap();
        let mut store = WorkspaceStore::open(fixture.root.0.clone()).unwrap();
        store.load("handoff").unwrap();
        assert_eq!(fs::read(store.path()).unwrap(), original);
    }

    #[test]
    fn electron_handoff_rejects_hardlinks_unknown_fields_and_missing_browser_binding() {
        let fixture = Fixture::new();
        fixture.begin();
        let source = fixture.store.draft_transaction_path();
        let mut record: serde_json::Value =
            serde_json::from_slice(&fs::read(&source).unwrap()).unwrap();
        fs::remove_file(source).unwrap();
        record["format"] = json!("dustdesk-electron-draft-transaction");
        record["browserBinding"] = json!("b".repeat(64));
        record["payloadSha256"] = json!("c".repeat(64));
        record["completed"] = json!(true);
        record["decision"] = json!("commit");
        let path = fixture.root.0.join("ElectronMigrationTransaction.json");
        fs::write(&path, record.to_string()).unwrap();
        let alias = fixture.root.0.join("foreign-alias.json");
        fs::hard_link(&path, &alias).unwrap();
        assert!(fixture.store.require_draft_recovered().is_err());
        fs::remove_file(alias).unwrap();
        fixture.store.require_draft_recovered().unwrap();
        for field in ["browserBinding", "payloadSha256"] {
            let mut missing = record.clone();
            missing[field] = serde_json::Value::Null;
            fs::write(&path, missing.to_string()).unwrap();
            assert!(fixture.store.require_draft_recovered().is_err());
        }
        record["unknown"] = json!(true);
        fs::write(&path, record.to_string()).unwrap();
        assert!(fixture.store.require_draft_recovered().is_err());
    }

    #[test]
    fn bound_terminal_completion_remains_durable_and_allows_a_new_transaction_without_deleting_the_record(
    ) {
        let fixture = Fixture::new();
        let outer: Value = serde_json::from_str(&fixture.archive).unwrap();
        let payload: Value = serde_json::from_str(outer["payload"].as_str().unwrap()).unwrap();
        let raw = json!({"id":payload["id"],"sha256":outer["sha256"],"writes":[]}).to_string();
        let binding = "b".repeat(64);
        let pending = fixture
            .store
            .begin_browser_transaction(
                &fixture.request,
                &fixture.archive,
                &fixture.fingerprint,
                &digest(&raw),
                Some(BrowserJournal {
                    raw: &raw,
                    binding: &binding,
                }),
            )
            .unwrap();
        assert!(fixture
            .store
            .complete_draft_browser(&pending.transaction_id, &binding)
            .is_err());
        fixture.decide(&pending, true, true);
        assert!(fixture
            .store
            .complete_draft_browser(&pending.transaction_id, &"c".repeat(64))
            .is_err());
        fixture
            .store
            .complete_draft_browser(&pending.transaction_id, &binding)
            .unwrap();
        assert_eq!(fixture.store.draft_transaction_status().unwrap(), None);
        assert!(fixture.store.draft_transaction_path().is_file());
        fixture.store.require_draft_recovered().unwrap();
        let location = fixture.root.0.clone();
        drop(fixture.store);
        let store = WorkspaceStore::open(location).unwrap();
        assert_eq!(store.draft_transaction_status().unwrap(), None);
        assert!(store.require_draft_recovered().is_err());
        store
            .complete_draft_browser(&pending.transaction_id, &binding)
            .unwrap();
        let next = store
            .begin_browser_transaction(
                &Uuid::new_v4().to_string(),
                &fixture.archive,
                &fixture.fingerprint,
                &digest(&raw),
                Some(BrowserJournal {
                    raw: &raw,
                    binding: &binding,
                }),
            )
            .unwrap();
        assert_ne!(next.transaction_id, pending.transaction_id);
    }

    #[test]
    fn copied_native_transaction_cannot_authorize_another_physical_workspace() {
        let source = Fixture::new();
        source.begin();
        let destination = Fixture::new();
        fs::copy(
            source.store.draft_transaction_path(),
            destination.store.draft_transaction_path(),
        )
        .unwrap();
        assert!(destination.store.draft_transaction_status().is_err());
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Record {
    version: u32,
    format: String,
    root: ownership::NativeIdentity,
    transaction_id: String,
    request_id: String,
    workspace_id: String,
    archive_id: String,
    archive_sha256: String,
    workspace_fingerprint: String,
    journal_sha256: String,
    #[serde(default)]
    browser_binding: Option<String>,
    #[serde(default)]
    payload_sha256: Option<String>,
    #[serde(default)]
    writes: Vec<ExpectedWrite>,
    #[serde(default)]
    completed: bool,
    decision: Decision,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExpectedWrite {
    pub key: String,
    pub sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    id: String,
    sha256: String,
    writes: Vec<JournalEntry>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalEntry {
    key: String,
    value: String,
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub struct BrowserJournal<'a> {
    pub raw: &'a str,
    pub binding: &'a str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub transaction_id: String,
    pub request_id: String,
    pub archive_id: String,
    pub archive_sha256: String,
    pub workspace_fingerprint: String,
    pub journal_sha256: String,
    pub browser_binding: Option<String>,
    pub payload_sha256: Option<String>,
    pub writes: Vec<ExpectedWrite>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery_journal: Option<String>,
    pub decision: Decision,
    pub completed: bool,
}

impl Record {
    fn status(&self) -> Status {
        Status {
            transaction_id: self.transaction_id.clone(),
            request_id: self.request_id.clone(),
            archive_id: self.archive_id.clone(),
            archive_sha256: self.archive_sha256.clone(),
            workspace_fingerprint: self.workspace_fingerprint.clone(),
            journal_sha256: self.journal_sha256.clone(),
            browser_binding: self.browser_binding.clone(),
            payload_sha256: self.payload_sha256.clone(),
            writes: self.writes.clone(),
            recovery_journal: None,
            decision: self.decision,
            completed: self.completed,
        }
    }
}

fn read_record(
    path: &std::path::Path,
    root: &ownership::NativeIdentity,
    format: &str,
) -> Result<Option<Record>, String> {
    checked_path(path)?;
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
        Ok(_) => {}
    }
    let bytes = draft_lineage::read_bounded(path, 16 * 1024 * 1024)?;
    let record: Record = serde_json::from_slice(&bytes)
        .map_err(|_| "原生草稿事务记录损坏，禁止继续编辑或迁移".to_string())?;
    if record.version != 1
        || record.format != format
        || &record.root != root
        || !draft_lineage::is_uuid(&record.transaction_id)
        || !draft_lineage::is_uuid(&record.request_id)
        || !draft_lineage::is_uuid(&record.workspace_id)
        || !draft_lineage::is_uuid(&record.archive_id)
        || !draft_lineage::is_hash(&record.archive_sha256, 64)
        || !draft_lineage::is_hash(&record.workspace_fingerprint, 64)
        || !draft_lineage::is_hash(&record.journal_sha256, 64)
        || record
            .browser_binding
            .as_ref()
            .is_some_and(|value| !draft_lineage::is_hash(value, 64))
        || record
            .payload_sha256
            .as_ref()
            .is_some_and(|value| !draft_lineage::is_hash(value, 64))
        || record.writes.len() > 5000
        || record.writes.iter().any(|entry| {
            entry.key.encode_utf16().count() > 2048 || !draft_lineage::is_hash(&entry.sha256, 64)
        })
        || record
            .writes
            .iter()
            .map(|entry| &entry.key)
            .collect::<std::collections::HashSet<_>>()
            .len()
            != record.writes.len()
        || (record.completed
            && (record.decision == Decision::Pending
                || record.browser_binding.is_none()
                || record.payload_sha256.is_none()))
    {
        return Err("原生草稿事务记录无效或不属于当前目录，禁止继续编辑或迁移".into());
    }
    Ok(Some(record))
}

pub(super) fn require_electron_complete(
    root: &std::path::Path,
    identity: &ownership::NativeIdentity,
) -> Result<(), String> {
    let record = read_record(
        &root.join("ElectronMigrationTransaction.json"),
        identity,
        "dustdesk-electron-draft-transaction",
    )?;
    if record.is_some_and(|record| {
        !record.completed || record.browser_binding.is_none() || record.payload_sha256.is_none()
    }) {
        return Err(
            "存在尚未完成的 Electron 草稿事务，请先回到 Electron 受控恢复；未打开 Tauri 工作区"
                .into(),
        );
    }
    Ok(())
}

impl WorkspaceStore {
    fn draft_transaction_path(&self) -> PathBuf {
        self.root.join("MigrationTransaction.json")
    }

    fn read_draft_transaction(&self) -> Result<Option<Record>, String> {
        read_record(
            &self.draft_transaction_path(),
            &self._ownership.identity(&self.root)?,
            "dustdesk-draft-transaction",
        )
    }

    fn publish_draft_transaction(
        &self,
        record: &Record,
        previous: Option<&Record>,
    ) -> Result<(), String> {
        let target = self.draft_transaction_path();
        checked_path(&target)?;
        let temporary = TemporaryFile(
            self.root
                .join(format!(".draft-transaction-{}.tmp", Uuid::new_v4())),
        );
        let bytes = serde_json::to_vec(record).map_err(|error| error.to_string())?;
        if bytes.len() > 16 * 1024 * 1024 {
            return Err("原生草稿事务记录超过 16 MiB，未截断或提交".into());
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.0)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        self._ownership.identity(&self.root)?;
        if let Some(previous) = previous {
            if self.read_draft_transaction()?.as_ref() != Some(previous) {
                return Err("原生草稿事务记录在提交前已改变".into());
            }
            replace_record(&temporary.0, &target)?;
        } else {
            fs::hard_link(&temporary.0, &target).map_err(|error| error.to_string())?;
            fs::remove_file(&temporary.0).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn require_draft_recovered(&self) -> Result<(), String> {
        require_electron_complete(&self.root, &self._ownership.identity(&self.root)?)?;
        if self.read_draft_transaction()?.is_some_and(|record| {
            !record.completed
                || !self
                    .draft_browser_verified
                    .load(std::sync::atomic::Ordering::SeqCst)
        }) {
            return Err("草稿迁移事务尚未完成受控恢复，禁止编辑或修改工作区".into());
        }
        Ok(())
    }

    pub fn draft_transaction_status(&self) -> Result<Option<Status>, String> {
        self.read_draft_transaction().map(|record| {
            record
                .filter(|record| !record.completed)
                .map(|record| record.status())
        })
    }

    pub fn draft_recovery_status(&self) -> Result<Option<Status>, String> {
        self.read_draft_transaction()
            .map(|record| record.map(|record| record.status()))
    }

    #[cfg(test)]
    pub fn begin_draft_transaction(
        &self,
        request_id: &str,
        serialized: &str,
        fingerprint: &str,
        journal_sha256: &str,
    ) -> Result<Status, String> {
        self.begin_browser_transaction(request_id, serialized, fingerprint, journal_sha256, None)
    }

    pub fn begin_browser_transaction(
        &self,
        request_id: &str,
        serialized: &str,
        fingerprint: &str,
        journal_sha256: &str,
        browser: Option<BrowserJournal<'_>>,
    ) -> Result<Status, String> {
        if !draft_lineage::is_uuid(request_id) || !draft_lineage::is_hash(journal_sha256, 64) {
            return Err("草稿事务请求或暂存日志摘要无效".into());
        }
        self.require_draft_recovered()?;
        let provenance = self.verify_draft_provenance(serialized, fingerprint)?;
        let previous = self.read_draft_transaction()?;
        let mut record = Record {
            version: 1,
            format: "dustdesk-draft-transaction".into(),
            root: self._ownership.identity(&self.root)?,
            transaction_id: Uuid::new_v4().to_string(),
            request_id: request_id.into(),
            workspace_id: provenance.workspace_id,
            archive_id: provenance.archive_id,
            archive_sha256: provenance.archive_sha256,
            workspace_fingerprint: provenance.workspace_fingerprint,
            journal_sha256: journal_sha256.into(),
            browser_binding: None,
            payload_sha256: None,
            writes: Vec::new(),
            completed: false,
            decision: Decision::Pending,
        };
        if let Some(browser) = browser {
            Self::bind_draft_browser(&mut record, serialized, browser.raw, browser.binding)?;
            self.persist_browser_journal(browser.raw)?;
        }
        self.publish_draft_transaction(&record, previous.as_ref())?;
        Ok(record.status())
    }

    fn persist_browser_journal(&self, raw: &str) -> Result<(), String> {
        if raw.len() as u64 > super::MAX_BYTES {
            return Err("原生草稿日志超过大小限制".into());
        }
        let path = self.root.join("MigrationBrowserJournal.json");
        checked_path(&path)?;
        let exists = path.try_exists().map_err(|error| error.to_string())?;
        if exists {
            draft_lineage::read_bounded(&path, super::MAX_BYTES)?;
        }
        let temporary = TemporaryFile(
            self.root
                .join(format!(".draft-browser-{}.tmp", Uuid::new_v4())),
        );
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary.0)
            .map_err(|error| error.to_string())?;
        file.write_all(raw.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        self._ownership.identity(&self.root)?;
        if exists {
            draft_lineage::read_bounded(&path, super::MAX_BYTES)?;
            replace_record(&temporary.0, &path)?;
        } else {
            fs::hard_link(&temporary.0, &path).map_err(|error| error.to_string())?;
            fs::remove_file(&temporary.0).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub fn browser_recovery_journal(&self, status: &Status) -> Result<String, String> {
        if self.draft_recovery_status()?.as_ref() != Some(status)
            || status.browser_binding.is_none()
        {
            return Err("原生浏览器恢复状态已变化".into());
        }
        let raw = draft_lineage::read_bounded(
            &self.root.join("MigrationBrowserJournal.json"),
            super::MAX_BYTES,
        )?;
        if digest(&raw) != status.journal_sha256 {
            return Err("原生持久草稿日志与事务摘要不匹配，未恢复".into());
        }
        String::from_utf8(raw).map_err(|error| error.to_string())
    }

    fn bind_draft_browser(
        record: &mut Record,
        serialized: &str,
        journal: &str,
        binding: &str,
    ) -> Result<(), String> {
        if record.decision != Decision::Pending
            || record.completed
            || record.browser_binding.is_some()
            || !draft_lineage::is_hash(binding, 64)
            || digest(serialized) != record.archive_sha256
            || digest(journal) != record.journal_sha256
        {
            return Err("原生草稿事务与真实浏览器日志不匹配".into());
        }
        let archive: serde_json::Value =
            serde_json::from_str(serialized).map_err(|error| error.to_string())?;
        let payload: serde_json::Value =
            serde_json::from_str(archive["payload"].as_str().ok_or("草稿归档内容无效")?)
                .map_err(|error| error.to_string())?;
        let journal: Journal =
            serde_json::from_str(journal).map_err(|_| "真实草稿暂存日志格式无效")?;
        if journal.id != record.archive_id
            || Some(journal.sha256.as_str()) != archive["sha256"].as_str()
            || journal.writes.len() > 5000
        {
            return Err("真实草稿暂存日志不属于此原始归档".into());
        }
        let entries = payload["entries"].as_array().ok_or("归档缺少草稿条目")?;
        let mut keys = std::collections::HashSet::new();
        for entry in &journal.writes {
            if entry.key.encode_utf16().count() > 2048
                || !keys.insert(&entry.key)
                || !entries.iter().any(|original| {
                    original["key"].as_str() == Some(&entry.key)
                        && original["value"].as_str() == Some(&entry.value)
                })
            {
                return Err("真实暂存日志包含重复键或非归档草稿，未绑定".into());
            }
        }
        record.browser_binding = Some(binding.into());
        record.payload_sha256 = Some(journal.sha256);
        record.writes = journal
            .writes
            .into_iter()
            .map(|entry| ExpectedWrite {
                key: entry.key,
                sha256: digest(entry.value),
            })
            .collect();
        Ok(())
    }

    pub fn complete_draft_browser(
        &self,
        transaction_id: &str,
        binding: &str,
    ) -> Result<(), String> {
        let mut record = self.read_draft_transaction()?.ok_or("没有原生草稿事务")?;
        if record.transaction_id != transaction_id
            || record.browser_binding.as_deref() != Some(binding)
            || record.payload_sha256.is_none()
            || record.decision == Decision::Pending
        {
            return Err("原生草稿恢复状态不允许完成".into());
        }
        if record.completed {
            self.draft_browser_verified
                .store(true, std::sync::atomic::Ordering::SeqCst);
            return Ok(());
        }
        let previous = record.clone();
        record.completed = true;
        self.publish_draft_transaction(&record, Some(&previous))?;
        self.draft_browser_verified
            .store(true, std::sync::atomic::Ordering::SeqCst);
        Ok(())
    }

    pub fn decide_draft_transaction(
        &self,
        request_id: &str,
        transaction_id: &str,
        commit: bool,
        current_fingerprint: Option<&str>,
    ) -> Result<Status, String> {
        let mut record = self
            .read_draft_transaction()?
            .ok_or("没有待处理的原生草稿事务")?;
        if record.transaction_id != transaction_id || record.request_id != request_id {
            return Err("草稿事务不属于此原生维护请求".into());
        }
        if record.decision != Decision::Pending {
            return Ok(record.status());
        }
        let previous = record.clone();
        let unchanged = current_fingerprint == Some(record.workspace_fingerprint.as_str());
        if commit && unchanged {
            if record.browser_binding.is_some() {
                self.browser_recovery_journal(&record.status())?;
            }
            use sha2::{Digest, Sha256};
            let bytes = draft_lineage::read_bounded(&self.path(), super::MAX_BYTES)?;
            if format!("{:x}", Sha256::digest(bytes)) != record.workspace_fingerprint {
                return Err("提交前工作区已改变，未形成提交决定".into());
            }
            record.decision = Decision::Commit;
        } else {
            record.decision = Decision::Abort;
        }
        self.publish_draft_transaction(&record, Some(&previous))?;
        Ok(record.status())
    }
}
