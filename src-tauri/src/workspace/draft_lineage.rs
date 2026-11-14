use super::{ownership, WorkspaceStore};
use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs::OpenOptions, io::Read, path::Path};
use uuid::Uuid;

const MAX_LEDGER_BYTES: u64 = 8 * 1024 * 1024;
const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Receipt {
    archive_id: String,
    archive_sha256: String,
    payload_sha256: String,
    workspace_fingerprint: String,
    runtime: String,
    app_version: String,
    created_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Ledger {
    format: String,
    version: u32,
    workspace_id: String,
    root: ownership::NativeIdentity,
    exports: Vec<Receipt>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    format: String,
    version: u32,
    payload: String,
    sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Source {
    runtime: String,
    app_version: String,
    workspace_fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Payload {
    id: String,
    created_at: String,
    source: Source,
    entries: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub(super) workspace_id: String,
    pub(super) archive_id: String,
    pub(super) archive_sha256: String,
    pub(super) workspace_fingerprint: String,
    pub(super) source_runtime: String,
}

fn invalid() -> String {
    "原生草稿谱系回执无效或不属于当前检查点，未授权迁移".into()
}

fn digest(bytes: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(bytes.as_ref()))
}

pub(super) fn is_hash(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn is_uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| {
        parsed.get_version_num() == 4
            && parsed.get_variant() == uuid::Variant::RFC4122
            && parsed.to_string() == value
    })
}

fn valid_runtime(value: &str) -> bool {
    matches!(value, "electron" | "tauri")
}

fn valid_version(value: &str) -> bool {
    !value.is_empty()
        && value.encode_utf16().count() <= 128
        && value
            .chars()
            .all(|character| character >= ' ' && character != '\u{7f}')
}

fn valid_date(value: &str) -> bool {
    value.len() <= 64
        && DateTime::parse_from_rfc3339(value).is_ok_and(|date| {
            date.with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true)
                == value
        })
}

fn read_options() -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ};
        options
            .share_mode(FILE_SHARE_READ.0)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0);
    }
    options
}

fn verify_read_identity(
    location: &Path,
    expected: &ownership::NativeIdentity,
) -> Result<(), String> {
    super::checked_path(location)?;
    let current = read_options().open(location).map_err(|error| {
        format!(
            "读取原生回执文件失败（复核路径，{}）：{error}",
            location.display()
        )
    })?;
    let observed = ownership::inspect_file(&current).map_err(|error| {
        format!(
            "复核原生回执文件身份失败（{}）：{error}",
            location.display()
        )
    })?;
    if observed.reparse || observed.links != 1 || &observed.identity != expected {
        return Err(invalid());
    }
    Ok(())
}

pub(super) fn read_bounded(location: &Path, maximum: u64) -> Result<Vec<u8>, String> {
    super::checked_path(location)?;
    let failure = |operation: &str, error: std::io::Error| {
        format!(
            "读取原生回执文件失败（{operation}，{}）：{error}",
            location.display()
        )
    };
    let file = read_options()
        .open(location)
        .map_err(|error| failure("打开", error))?;
    let metadata = file.metadata().map_err(|error| failure("元数据", error))?;
    let identity = ownership::inspect_file(&file).map_err(|error| {
        format!(
            "检查原生回执文件身份失败（{}）：{error}",
            location.display()
        )
    })?;
    if !metadata.is_file() || identity.links != 1 || identity.reparse || metadata.len() > maximum {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    (&file)
        .take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| failure("读取内容", error))?;
    if bytes.len() as u64 > maximum || bytes.len() as u64 != metadata.len() {
        return Err(invalid());
    }
    verify_read_identity(location, &identity.identity)?;
    Ok(bytes)
}

fn checked_ledger(bytes: &[u8], identity: &ownership::NativeIdentity) -> Result<Ledger, String> {
    let ledger: Ledger = serde_json::from_slice(bytes).map_err(|_| invalid())?;
    if ledger.format != "dustdesk-draft-lineage"
        || ledger.version != 1
        || !is_uuid(&ledger.workspace_id)
        || &ledger.root != identity
        || !is_hash(&ledger.root.volume, 16)
        || !is_hash(&ledger.root.file, 16)
        || ledger.exports.len() > 4096
    {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    for receipt in &ledger.exports {
        if !is_uuid(&receipt.archive_id)
            || !is_hash(&receipt.archive_sha256, 64)
            || !is_hash(&receipt.payload_sha256, 64)
            || !is_hash(&receipt.workspace_fingerprint, 64)
            || !valid_runtime(&receipt.runtime)
            || !valid_version(&receipt.app_version)
            || !valid_date(&receipt.created_at)
            || !seen.insert(&receipt.archive_id)
        {
            return Err(invalid());
        }
    }
    Ok(ledger)
}
fn read_optional_ledger(path: &Path) -> Result<Option<Vec<u8>>, String> {
    super::checked_path(path)?;
    match std::fs::symlink_metadata(path) {
        Ok(_) => read_bounded(path, MAX_LEDGER_BYTES).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取原生草稿回执失败：{error}")),
    }
}

impl WorkspaceStore {
    pub(crate) fn record_draft_export(
        &self,
        serialized: &str,
        native_fingerprint: &str,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Provenance, String> {
        self.require_draft_recovered()?;
        require_active()?;
        if serialized.len() > MAX_ARCHIVE_BYTES || !is_hash(native_fingerprint, 64) {
            return Err(invalid());
        }
        let identity = self._ownership.identity(&self.root)?;
        let archive: Archive = serde_json::from_str(serialized).map_err(|_| invalid())?;
        let payload: Payload = serde_json::from_str(&archive.payload).map_err(|_| invalid())?;
        if archive.format != "dustdesk-browser-drafts"
            || archive.version != 1
            || digest(&archive.payload) != archive.sha256
            || !is_hash(&archive.sha256, 64)
            || !is_uuid(&payload.id)
            || !valid_date(&payload.created_at)
            || payload.source.runtime != "tauri"
            || !valid_version(&payload.source.app_version)
            || payload.source.workspace_fingerprint != native_fingerprint
            || payload.entries.len() > 5000
        {
            return Err(invalid());
        }
        let directory = self.root.join("MigrationLineage");
        let path = directory.join("lineage.json");
        let original = read_optional_ledger(&path)?;
        let mut ledger = match &original {
            Some(bytes) => checked_ledger(bytes, &identity)?,
            None => Ledger {
                format: "dustdesk-draft-lineage".into(),
                version: 1,
                workspace_id: Uuid::new_v4().to_string(),
                root: identity.clone(),
                exports: Vec::new(),
            },
        };
        if ledger.exports.len() >= 4096
            || ledger
                .exports
                .iter()
                .any(|entry| entry.archive_id == payload.id)
        {
            return Err("草稿来源回执已达上限或导出编号重复，未删除历史记录".into());
        }
        let archive_sha256 = digest(serialized);
        ledger.exports.push(Receipt {
            archive_id: payload.id.clone(),
            archive_sha256: archive_sha256.clone(),
            payload_sha256: archive.sha256,
            workspace_fingerprint: native_fingerprint.into(),
            runtime: payload.source.runtime,
            app_version: payload.source.app_version,
            created_at: payload.created_at,
        });
        let bytes = serde_json::to_vec(&ledger).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_LEDGER_BYTES {
            return Err("原生草稿回执超过 8 MiB，未删除历史记录".into());
        }
        super::checked_path(&directory)?;
        std::fs::create_dir_all(&directory)
            .map_err(|error| format!("创建草稿回执目录失败：{error}"))?;
        let active = || {
            require_active()?;
            if self._ownership.identity(&self.root)? != identity
                || read_optional_ledger(&path)? != original
            {
                return Err("原生草稿回执在导出时变化，未覆盖".into());
            }
            if digest(read_bounded(&self.path(), super::MAX_BYTES)?) != native_fingerprint {
                return Err("当前工作区与草稿导出检查点不一致".into());
            }
            Ok(())
        };
        super::export_file::publish_checked(&path, &bytes, active)?;
        Ok(Provenance {
            workspace_id: ledger.workspace_id,
            archive_id: payload.id,
            archive_sha256,
            workspace_fingerprint: native_fingerprint.into(),
            source_runtime: "tauri".into(),
        })
    }

    pub fn verify_draft_provenance(
        &self,
        serialized: &str,
        native_fingerprint: &str,
    ) -> Result<Provenance, String> {
        if serialized.len() > MAX_ARCHIVE_BYTES || !is_hash(native_fingerprint, 64) {
            return Err(invalid());
        }
        let identity = self._ownership.identity(&self.root)?;
        #[cfg(windows)]
        if let Some(original) = self._ownership.runtime_drafts()? {
            if original.serialized() != serialized
                || original.workspace_sha256() != native_fingerprint
            {
                return Err(invalid());
            }
            let archive: Archive = serde_json::from_str(serialized).map_err(|_| invalid())?;
            let payload: Payload = serde_json::from_str(&archive.payload).map_err(|_| invalid())?;
            if archive.format != "dustdesk-browser-drafts"
                || archive.version != 1
                || digest(serialized) != original.proof().archive_sha256
                || digest(&archive.payload) != archive.sha256
                || archive.sha256 != original.proof().payload_sha256
                || payload.id != original.proof().archive_id
                || !is_uuid(&payload.id)
                || !valid_date(&payload.created_at)
                || payload.source.runtime != "electron"
                || !valid_version(&payload.source.app_version)
                || payload.source.workspace_fingerprint != native_fingerprint
                || payload.entries.len() > 5000
            {
                return Err(invalid());
            }
            if digest(read_bounded(&self.path(), super::MAX_BYTES)?) != native_fingerprint {
                return Err("运行工作区已偏离原浏览器检查点，未授权迁移".into());
            }
            if self._ownership.identity(&self.root)? != identity {
                return Err(invalid());
            }
            return Ok(Provenance {
                workspace_id: original.ownership_id().into(),
                archive_id: payload.id,
                archive_sha256: original.proof().archive_sha256.clone(),
                workspace_fingerprint: native_fingerprint.into(),
                source_runtime: "electron".into(),
            });
        }
        let bytes = read_bounded(
            &self.root.join("MigrationLineage").join("lineage.json"),
            MAX_LEDGER_BYTES,
        )?;
        let ledger = checked_ledger(&bytes, &identity)?;
        let archive_digest = digest(serialized);
        let receipt = ledger
            .exports
            .iter()
            .find(|receipt| receipt.archive_sha256 == archive_digest)
            .ok_or_else(invalid)?;
        if receipt.workspace_fingerprint != native_fingerprint {
            return Err(invalid());
        }
        let archive: Archive = serde_json::from_str(serialized).map_err(|_| invalid())?;
        if archive.format != "dustdesk-browser-drafts"
            || archive.version != 1
            || archive.sha256 != receipt.payload_sha256
            || digest(&archive.payload) != archive.sha256
        {
            return Err(invalid());
        }
        let payload: Payload = serde_json::from_str(&archive.payload).map_err(|_| invalid())?;
        if payload.id != receipt.archive_id
            || payload.created_at != receipt.created_at
            || payload.source.runtime != receipt.runtime
            || payload.source.app_version != receipt.app_version
            || payload.source.workspace_fingerprint != native_fingerprint
            || payload.entries.len() > 5000
        {
            return Err(invalid());
        }
        if digest(read_bounded(&self.path(), super::MAX_BYTES)?) != native_fingerprint {
            return Err("当前工作区与草稿导出检查点不一致，未授权迁移".into());
        }
        if self._ownership.identity(&self.root)? != identity {
            return Err(invalid());
        }
        Ok(Provenance {
            workspace_id: ledger.workspace_id,
            archive_id: receipt.archive_id.clone(),
            archive_sha256: archive_digest,
            workspace_fingerprint: native_fingerprint.into(),
            source_runtime: receipt.runtime.clone(),
        })
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{fs, path::PathBuf};

    struct Root(PathBuf);
    impl Root {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!("dustdesk-rust-lineage-{}", Uuid::new_v4())))
        }
    }
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    struct Fixture {
        store: WorkspaceStore,
        root: Root,
        archive: String,
        fingerprint: String,
        ledger: Value,
    }
    #[test]
    fn active_receipt_readers_reject_mutation_and_path_replacement_is_checked_after_release() {
        let fixture = Fixture::new();
        let path = fixture.location();
        let reader = read_options().open(&path).unwrap();
        let identity = ownership::inspect_file(&reader).unwrap().identity;
        let original = fs::read(&path).unwrap();
        assert!(OpenOptions::new().write(true).open(&path).is_err());
        let next = br#"{"changed":"new atomic generation"}"#;
        let temporary = fixture.root.0.join("next-ledger.json");
        fs::write(&temporary, next).unwrap();
        let error = super::super::replace_file(&temporary, &path).unwrap_err();
        assert!(error.contains("MoveFileExW"), "{error}");
        assert!(
            error.contains("os error 5") || error.contains("os error 32"),
            "{error}"
        );
        let mut observed = Vec::new();
        (&reader).read_to_end(&mut observed).unwrap();
        assert_eq!(observed, original);
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read(&temporary).unwrap(), next);
        drop(reader);
        super::super::replace_file(&temporary, &path).unwrap();
        assert_eq!(fs::read(&path).unwrap(), next);
        assert!(verify_read_identity(&path, &identity).is_err());
        assert_eq!(read_bounded(&path, 1024 * 1024).unwrap(), next);
    }
    #[test]
    fn final_receipt_identity_check_rejects_new_hardlinks_without_modifying_either_path() {
        let fixture = Fixture::new();
        let path = fixture.location();
        let reader = read_options().open(&path).unwrap();
        let identity = ownership::inspect_file(&reader).unwrap().identity;
        let original = fs::read(&path).unwrap();
        let alias = fixture.root.0.join("linked-ledger.json");
        fs::hard_link(&path, &alias).unwrap();
        assert!(verify_read_identity(&path, &identity).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        assert_eq!(fs::read(&alias).unwrap(), original);
        fs::remove_file(alias).unwrap();
        verify_read_identity(&path, &identity).unwrap();
    }
    impl Fixture {
        fn new() -> Self {
            let root = Root::new();
            let store = WorkspaceStore::open(root.0.clone()).unwrap();
            let workspace = br#"{"SchemaVersion":3}"#;
            fs::write(store.path(), workspace).unwrap();
            let fingerprint = digest(workspace);
            let payload = json!({"id":Uuid::new_v4().to_string(),"createdAt":"2026-11-09T23:00:00.000Z","source":{"runtime":"electron","appVersion":"1.0.2","workspaceFingerprint":fingerprint},"entries":[{"key":"widget-task-draft:v1:todo","value":"{\"title\":\"原生互认🪶\",\"requestId\":\"stable\"}"}]}).to_string();
            let payload_value: Value = serde_json::from_str(&payload).unwrap();
            let archive = json!({"format":"dustdesk-browser-drafts","version":1,"payload":payload,"sha256":digest(&payload)}).to_string();
            let identity = store._ownership.identity(&root.0).unwrap();
            let ledger = json!({"format":"dustdesk-draft-lineage","version":1,"workspaceId":Uuid::new_v4().to_string(),"root":{"volume":identity.volume,"file":identity.file},"exports":[{"archiveId":payload_value["id"],"archiveSha256":digest(&archive),"payloadSha256":digest(&payload),"workspaceFingerprint":fingerprint,"runtime":"electron","appVersion":"1.0.2","createdAt":payload_value["createdAt"]}]});
            fs::create_dir(root.0.join("MigrationLineage")).unwrap();
            let fixture = Self {
                store,
                root,
                archive,
                fingerprint,
                ledger,
            };
            fixture.write_ledger(&fixture.ledger);
            fixture
        }
        fn location(&self) -> PathBuf {
            self.root.0.join("MigrationLineage").join("lineage.json")
        }
        fn write_ledger(&self, value: &Value) {
            fs::write(self.location(), value.to_string()).unwrap();
        }
        fn verify(&self) -> Result<Provenance, String> {
            self.store
                .verify_draft_provenance(&self.archive, &self.fingerprint)
        }
    }

    #[test]
    fn native_export_appends_a_compatible_receipt_and_preserves_old_runtime_history() {
        let fixture = Fixture::new();
        let archive = native_archive(&fixture);
        let original = fixture.ledger["exports"][0].clone();
        let result = fixture
            .store
            .record_draft_export(&archive, &fixture.fingerprint, || Ok(()))
            .unwrap();
        assert_eq!(result.source_runtime, "tauri");
        assert_eq!(result.workspace_id, fixture.ledger["workspaceId"]);
        let ledger: Value = serde_json::from_slice(&fs::read(fixture.location()).unwrap()).unwrap();
        assert_eq!(ledger["exports"][0], original);
        assert_eq!(ledger["exports"].as_array().unwrap().len(), 2);
        assert_eq!(
            fixture
                .store
                .verify_draft_provenance(&archive, &fixture.fingerprint)
                .unwrap(),
            result
        );
        fixture.verify().unwrap();
    }
    #[test]
    fn export_cancellation_corrupt_history_and_changed_workspace_preserve_the_receipts() {
        let fixture = Fixture::new();
        let archive = native_archive(&fixture);
        let before = fs::read(fixture.location()).unwrap();
        let calls = std::cell::Cell::new(0);
        let result = fixture
            .store
            .record_draft_export(&archive, &fixture.fingerprint, || {
                calls.set(calls.get() + 1);
                if calls.get() >= 3 {
                    Err("cancel after staging".into())
                } else {
                    Ok(())
                }
            });
        assert!(result.unwrap_err().contains("cancel after staging"));
        assert_eq!(fs::read(fixture.location()).unwrap(), before);
        assert_eq!(
            fs::read_dir(fixture.location().parent().unwrap())
                .unwrap()
                .count(),
            1
        );
        fs::write(fixture.location(), b"{broken").unwrap();
        assert!(fixture
            .store
            .record_draft_export(&archive, &fixture.fingerprint, || Ok(()))
            .is_err());
        assert_eq!(fs::read(fixture.location()).unwrap(), b"{broken");
        fs::write(fixture.location(), &before).unwrap();
        let mut workspace = fs::read(fixture.store.path()).unwrap();
        workspace.push(b' ');
        fs::write(fixture.store.path(), workspace).unwrap();
        assert!(fixture
            .store
            .record_draft_export(&archive, &fixture.fingerprint, || Ok(()))
            .unwrap_err()
            .contains("检查点不一致"));
        assert_eq!(fs::read(fixture.location()).unwrap(), before);
    }
    fn native_archive(fixture: &Fixture) -> String {
        let mut archive: Value = serde_json::from_str(&fixture.archive).unwrap();
        let mut payload: Value =
            serde_json::from_str(archive["payload"].as_str().unwrap()).unwrap();
        payload["source"]["runtime"] = json!("tauri");
        payload["id"] = json!(Uuid::new_v4().to_string());
        let raw = payload.to_string();
        archive["sha256"] = json!(digest(&raw));
        archive["payload"] = json!(raw);
        archive.to_string()
    }
    #[test]
    fn exact_local_receipt_and_current_workspace_are_verified_without_mutation() {
        let fixture = Fixture::new();
        let ledger = fs::read(fixture.location()).unwrap();
        let workspace = fs::read(fixture.store.path()).unwrap();
        let result = fixture.verify().unwrap();
        assert_eq!(result.workspace_id, fixture.ledger["workspaceId"]);
        assert_eq!(result.archive_sha256, digest(&fixture.archive));
        assert_eq!(result.source_runtime, "electron");
        assert_eq!(fixture.verify().unwrap(), result);
        assert_eq!(fs::read(fixture.location()).unwrap(), ledger);
        assert_eq!(fs::read(fixture.store.path()).unwrap(), workspace);
    }

    #[test]
    fn archive_reformat_forgery_and_changed_native_snapshots_cannot_self_authorize() {
        let fixture = Fixture::new();
        let parsed: Value = serde_json::from_str(&fixture.archive).unwrap();
        let formatted = serde_json::to_string_pretty(&parsed).unwrap();
        assert!(fixture
            .store
            .verify_draft_provenance(&formatted, &fixture.fingerprint)
            .is_err());
        assert!(fixture
            .store
            .verify_draft_provenance(&fixture.archive, &"a".repeat(64))
            .is_err());
        let mut forged = parsed;
        let mut payload: Value = serde_json::from_str(forged["payload"].as_str().unwrap()).unwrap();
        payload["entries"][0]["value"] = json!("forged");
        forged["payload"] = json!(payload.to_string());
        forged["sha256"] = json!(digest(payload.to_string()));
        assert!(fixture
            .store
            .verify_draft_provenance(&forged.to_string(), &fixture.fingerprint)
            .is_err());
        fs::write(fixture.store.path(), b"{\"SchemaVersion\":3} ").unwrap();
        assert!(fixture.verify().unwrap_err().contains("不一致"));
    }

    #[test]
    fn invalid_unrelated_receipts_future_versions_duplicates_and_unknown_fields_fail_closed() {
        let fixture = Fixture::new();
        let mut cases = Vec::new();
        let mut changed = fixture.ledger.clone();
        changed["version"] = json!(2);
        cases.push(changed);
        let mut changed = fixture.ledger.clone();
        changed["unknown"] = json!(true);
        cases.push(changed);
        let mut changed = fixture.ledger.clone();
        changed["root"]["file"] = json!("0000000000000000");
        cases.push(changed);
        let mut changed = fixture.ledger.clone();
        let duplicate = changed["exports"][0].clone();
        changed["exports"].as_array_mut().unwrap().push(duplicate);
        cases.push(changed);
        for (field, value) in [
            ("archiveId", json!("not-uuid")),
            ("archiveSha256", json!("invalid")),
            ("createdAt", json!("2026-11-09T23:00:00Z")),
            ("runtime", json!("unknown")),
            ("appVersion", json!("\u{7f}")),
        ] {
            let mut changed = fixture.ledger.clone();
            let mut unrelated = changed["exports"][0].clone();
            unrelated["archiveId"] = json!(Uuid::new_v4().to_string());
            unrelated[field] = value;
            changed["exports"].as_array_mut().unwrap().push(unrelated);
            cases.push(changed);
        }
        for changed in cases {
            fixture.write_ledger(&changed);
            assert!(fixture.verify().is_err());
            assert_eq!(
                fs::read_to_string(fixture.location()).unwrap(),
                changed.to_string()
            );
        }
    }

    #[test]
    fn missing_corrupt_and_oversized_ledgers_are_never_reconstructed() {
        let fixture = Fixture::new();
        fs::remove_file(fixture.location()).unwrap();
        assert!(fixture.verify().is_err());
        assert!(!fixture.location().exists());
        for bytes in [
            b"{broken".to_vec(),
            vec![b' '; MAX_LEDGER_BYTES as usize + 1],
        ] {
            fs::write(fixture.location(), &bytes).unwrap();
            assert!(fixture.verify().is_err());
            assert_eq!(fs::read(fixture.location()).unwrap(), bytes);
        }
    }

    #[test]
    fn copied_ledgers_and_hardlinks_do_not_transfer_directory_authority() {
        let fixture = Fixture::new();
        let other = Root::new();
        let store = WorkspaceStore::open(other.0.clone()).unwrap();
        fs::create_dir(other.0.join("MigrationLineage")).unwrap();
        fs::copy(
            fixture.location(),
            other.0.join("MigrationLineage").join("lineage.json"),
        )
        .unwrap();
        fs::copy(fixture.store.path(), store.path()).unwrap();
        assert!(store
            .verify_draft_provenance(&fixture.archive, &fixture.fingerprint)
            .is_err());
        let alias = fixture.root.0.join("hardlink.json");
        fs::hard_link(fixture.location(), &alias).unwrap();
        assert!(fixture.verify().is_err());
        fs::remove_file(alias).unwrap();
        assert!(fixture.verify().is_ok());
        drop(store);
    }

    #[test]
    fn receipt_capacity_is_bounded_and_never_pruned() {
        let fixture = Fixture::new();
        let mut ledger = fixture.ledger.clone();
        ledger["exports"] = Value::Array(
            (0..4097)
                .map(|_| {
                    let mut receipt = fixture.ledger["exports"][0].clone();
                    receipt["archiveId"] = json!(Uuid::new_v4().to_string());
                    receipt
                })
                .collect(),
        );
        fixture.write_ledger(&ledger);
        assert!(fixture.verify().is_err());
        assert_eq!(
            fs::read_to_string(fixture.location()).unwrap(),
            ledger.to_string()
        );
    }

    #[test]
    fn native_header_rules_match_canonical_javascript_ids_versions_and_millisecond_dates() {
        assert!(valid_version(&"😀".repeat(64)));
        assert!(!valid_version(&"😀".repeat(65)));
        assert!(!valid_version("1.0.2\n"));
        assert!(!valid_version("\u{7f}"));
        assert!(valid_date("2026-11-09T23:00:00.000Z"));
        assert!(!valid_date("2026-11-09T23:00:00Z"));
        let id = Uuid::new_v4().to_string();
        assert!(is_uuid(&id));
        assert!(!is_uuid(&id.to_uppercase()));
    }
}
