use super::{
    commands::StorageState,
    draft_transaction::{Decision, Status},
    ownership,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::File,
    sync::{atomic::Ordering, Mutex},
    time::Duration,
};
use tauri::{Manager, WebviewWindow};

pub struct Binding {
    _directory: File,
    pub fingerprint: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Snapshot {
    pub journal: Option<String>,
    pub receipts: Option<String>,
    pub values: HashMap<String, Option<String>>,
    pub error: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    id: String,
    sha256: String,
}

fn digest(value: impl AsRef<[u8]>) -> String {
    format!("{:x}", Sha256::digest(value.as_ref()))
}

pub fn binding(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<Binding, String> {
    let expected_path = match window.label() {
        "workspace-main" => "/tauri.html",
        "workspace-recovery" => "/recovery.html",
        "runtime-import" if cfg!(debug_assertions) => "/runtime-import.html",
        _ => return Err("此窗口不是原生草稿恢复入口".into()),
    };
    if !crate::main_window::current(app, window) {
        return Err("恢复窗口已失效".into());
    }
    let url = window.url().map_err(|error| error.to_string())?;
    if url.path() != expected_path || url.query().is_some() || url.fragment().is_some() {
        return Err("草稿恢复页面不是原生配置的主入口".into());
    }
    let profiles = app.state::<crate::ProbeState>().profiles.clone();
    super::checked_path(&profiles)?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0);
    }
    let directory = options.open(&profiles).map_err(|error| error.to_string())?;
    let identity = ownership::inspect_file(&directory)?;
    if !directory
        .metadata()
        .map_err(|error| error.to_string())?
        .is_dir()
        || identity.reparse
    {
        return Err("浏览器配置目录身份无效".into());
    }
    let fingerprint = digest(format!(
        "{}:{}:{}",
        identity.identity.volume,
        identity.identity.file,
        url.origin().ascii_serialization()
    ));
    Ok(Binding {
        _directory: directory,
        fingerprint,
    })
}

pub async fn snapshot(window: &WebviewWindow, keys: &[String]) -> Result<Snapshot, String> {
    let keys = serde_json::to_string(keys).map_err(|error| error.to_string())?;
    let script = format!(
        r#"(() => {{ try {{ const journal = localStorage.getItem('dustdesk:draft-migration:pending:v1'); const receipts = localStorage.getItem('dustdesk:draft-migration:receipts:v1'); const values = Object.create(null); for (const key of {keys}) {{ values[key] = localStorage.getItem(key); }} if ((journal?.length ?? 0) > 67108864 || (receipts?.length ?? 0) > 67108864) throw Error('草稿恢复存储超过大小限制'); return {{journal, receipts, values, error:null}}; }} catch (error) {{ return {{journal:null,receipts:null,values:{{}},error:String(error)}}; }} }})()"#
    );
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let sender = Mutex::new(Some(sender));
    window
        .eval_with_callback(script, move |raw| {
            if let Ok(mut sender) = sender.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(raw);
                }
            }
        })
        .map_err(|error| error.to_string())?;
    let raw = tokio::time::timeout(Duration::from_secs(15), receiver)
        .await
        .map_err(|_| "读取真实浏览器草稿超时，未解除恢复屏障")?
        .map_err(|error| error.to_string())?;
    if raw.len() > 384 * 1024 * 1024 {
        return Err("浏览器恢复响应超过大小限制".into());
    }
    let result: Snapshot =
        serde_json::from_str(&raw).map_err(|error| format!("真实浏览器恢复响应无效：{error}"))?;
    if let Some(error) = &result.error {
        return Err(error.clone());
    }
    Ok(result)
}

fn receipt_matches(raw: Option<&str>, status: &Status) -> Result<bool, String> {
    let receipts: Vec<Receipt> = match raw {
        Some(raw) => serde_json::from_str(raw).map_err(|_| "草稿恢复回执损坏")?,
        None => Vec::new(),
    };
    if receipts.len() > 4096 {
        return Err("草稿恢复回执超过上限".into());
    }
    let mut seen = std::collections::HashSet::new();
    for receipt in &receipts {
        if receipt.id.is_empty()
            || receipt.id.encode_utf16().count() > 256
            || receipt
                .id
                .chars()
                .any(|character| character < ' ' || character == '\u{7f}')
            || !super::draft_lineage::is_hash(&receipt.sha256, 64)
            || !seen.insert(&receipt.id)
        {
            return Err("草稿恢复回执无效".into());
        }
        if receipt.id == status.archive_id
            && Some(&receipt.sha256) != status.payload_sha256.as_ref()
        {
            return Err("草稿恢复回执内容与原生决定不一致".into());
        }
    }
    Ok(receipts
        .iter()
        .any(|receipt| receipt.id == status.archive_id))
}

pub fn verify_snapshot(
    status: &Status,
    binding: &str,
    snapshot: &Snapshot,
    finishing: bool,
) -> Result<(), String> {
    if status.browser_binding.as_deref() != Some(binding) || status.payload_sha256.is_none() {
        return Err("原生草稿事务未绑定当前浏览器配置，禁止自动恢复".into());
    }
    let committed = receipt_matches(snapshot.receipts.as_deref(), status)?;
    if status.decision == Decision::Abort && committed {
        return Err("原生中止决定与浏览器完成回执冲突，未删除草稿".into());
    }
    if let Some(journal) = &snapshot.journal {
        if digest(journal) != status.journal_sha256 {
            return Err("真实浏览器暂存日志与原生事务不匹配，未改动存储".into());
        }
        if finishing {
            return Err("浏览器暂存日志尚未清理，未确认恢复完成".into());
        }
    } else if status.decision == Decision::Commit && !committed && status.recovery_journal.is_none()
    {
        return Err("原生提交决定缺少暂存日志或完成回执，未恢复".into());
    }
    if finishing {
        if status.decision == Decision::Pending
            || (status.decision == Decision::Commit && !committed)
        {
            return Err("草稿尚未达到原生决定的恢复终态".into());
        }
        for write in &status.writes {
            let value = snapshot
                .values
                .get(&write.key)
                .ok_or("原生草稿结果缺少键")?;
            let unchanged = value
                .as_ref()
                .is_some_and(|value| digest(value) == write.sha256);
            if (status.decision == Decision::Commit) != unchanged {
                return Err("真实草稿存储结果与原生决定不一致，未解除屏障".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::draft_transaction::ExpectedWrite;
    use super::*;
    fn fixture() -> (Status, Snapshot) {
        let status = Status {
            transaction_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            archive_id: uuid::Uuid::new_v4().to_string(),
            archive_sha256: "a".repeat(64),
            workspace_fingerprint: "b".repeat(64),
            journal_sha256: digest("journal"),
            browser_binding: Some("c".repeat(64)),
            payload_sha256: Some("d".repeat(64)),
            writes: vec![ExpectedWrite {
                key: "widget-task-draft:v1:todo".into(),
                sha256: digest("value"),
            }],
            decision: Decision::Commit,
            recovery_journal: None,
            completed: false,
        };
        let snapshot = Snapshot {
            journal: Some("journal".into()),
            receipts: None,
            values: HashMap::from([("widget-task-draft:v1:todo".into(), Some("value".into()))]),
            error: None,
        };
        (status, snapshot)
    }
    fn receipt(status: &Status) -> String {
        serde_json::json!([{"id":status.archive_id,"sha256":status.payload_sha256}]).to_string()
    }

    #[test]
    fn native_completion_requires_actual_receipt_removed_journal_and_exact_committed_values() {
        let (status, mut snapshot) = fixture();
        let binding = "c".repeat(64);
        verify_snapshot(&status, &binding, &snapshot, false).unwrap();
        assert!(verify_snapshot(&status, &binding, &snapshot, true).is_err());
        snapshot.journal = None;
        assert!(verify_snapshot(&status, &binding, &snapshot, true).is_err());
        snapshot.receipts = Some(receipt(&status));
        verify_snapshot(&status, &binding, &snapshot, true).unwrap();
        snapshot
            .values
            .insert("widget-task-draft:v1:todo".into(), Some("changed".into()));
        assert!(verify_snapshot(&status, &binding, &snapshot, true).is_err());
    }

    #[test]
    fn abort_completion_preserves_changed_values_but_rejects_unchanged_imports_or_commit_receipts()
    {
        let (mut status, mut snapshot) = fixture();
        status.decision = Decision::Abort;
        snapshot.journal = None;
        let binding = "c".repeat(64);
        assert!(verify_snapshot(&status, &binding, &snapshot, true).is_err());
        snapshot
            .values
            .insert("widget-task-draft:v1:todo".into(), None);
        verify_snapshot(&status, &binding, &snapshot, true).unwrap();
        snapshot.values.insert(
            "widget-task-draft:v1:todo".into(),
            Some("later input".into()),
        );
        verify_snapshot(&status, &binding, &snapshot, true).unwrap();
        snapshot.receipts = Some(receipt(&status));
        assert!(verify_snapshot(&status, &binding, &snapshot, true).is_err());
    }

    #[test]
    fn changed_profile_journal_and_malformed_or_duplicate_receipts_never_authorize_completion() {
        let (status, mut snapshot) = fixture();
        let binding = "c".repeat(64);
        assert!(verify_snapshot(&status, &"e".repeat(64), &snapshot, false).is_err());
        snapshot.journal = Some("changed".into());
        assert!(verify_snapshot(&status, &binding, &snapshot, false).is_err());
        snapshot.journal = None;
        for raw in ["{broken".into(), serde_json::json!([{"id":status.archive_id,"sha256":"f".repeat(64)}]).to_string(), serde_json::json!([{"id":status.archive_id,"sha256":status.payload_sha256},{"id":status.archive_id,"sha256":status.payload_sha256}]).to_string()] {
            snapshot.receipts = Some(raw); assert!(verify_snapshot(&status, &binding, &snapshot, true).is_err());
        }
    }
}

#[tauri::command]
pub async fn drafts_recovery(
    app: tauri::AppHandle,
    window: WebviewWindow,
    finish: Option<bool>,
) -> Result<Option<Status>, String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    let binding =
        binding(&app, &window).map_err(|error| format!("绑定草稿恢复浏览器配置失败：{error}"))?;
    crate::platform::legacy_processes::require_stopped()
        .map_err(|error| format!("草稿恢复检查旧版进程失败：{error}"))?;
    let handle = app.clone();
    let finishing = finish.unwrap_or(false);
    let status = tauri::async_runtime::spawn_blocking(move || {
        let storage = handle.state::<StorageState>();
        let mut slot = storage.store.lock().map_err(|error| error.to_string())?;
        if slot.is_none() {
            *slot = Some(
                super::WorkspaceStore::open(storage.root.clone()).map_err(|error| {
                    format!(
                        "打开草稿恢复工作区失败（{}）：{error}",
                        storage.root.display()
                    )
                })?,
            );
        }
        let store = slot.as_ref().unwrap();
        let status = store
            .draft_recovery_status()
            .map_err(|error| format!("读取原生草稿恢复记录失败：{error}"))?;
        let result = match status {
            Some(status) if status.decision == Decision::Pending && finishing => {
                Err("原生事务尚无恢复终态，未确认完成".into())
            }
            Some(status) if status.decision == Decision::Pending => store
                .decide_draft_transaction(&status.request_id, &status.transaction_id, false, None)
                .map_err(|error| format!("持久化草稿中止决定失败：{error}"))
                .map(Some),
            status => Ok(status),
        }?;
        result
            .map(|mut status| {
                status.recovery_journal = Some(
                    store
                        .browser_recovery_journal(&status)
                        .map_err(|error| format!("读取浏览器草稿恢复副本失败：{error}"))?,
                );
                Ok::<Status, String>(status)
            })
            .transpose()
    })
    .await
    .map_err(|error| error.to_string())??;
    let Some(status) = status else {
        if snapshot(&window, &[]).await?.journal.is_some() {
            return Err(
                "浏览器存在没有原生决定的草稿暂存日志，未打开编辑器；请保留数据等待受控恢复".into(),
            );
        }
        return Ok(None);
    };
    app.state::<crate::draft_maintenance::Service>()
        .unresolved
        .store(true, Ordering::SeqCst);
    let keys = status
        .writes
        .iter()
        .map(|entry| entry.key.clone())
        .collect::<Vec<_>>();
    let snapshot = snapshot(&window, &keys)
        .await
        .map_err(|error| format!("检查实际浏览器草稿存储失败：{error}"))?;
    if !crate::main_window::current(&app, &window)
        || self::binding(&app, &window)
            .map_err(|error| format!("复核草稿恢复浏览器配置失败：{error}"))?
            .fingerprint
            != binding.fingerprint
    {
        return Err("草稿恢复窗口或浏览器配置已改变".into());
    }
    let already_acknowledged = status.completed
        && snapshot.journal.is_none()
        && match status.decision {
            Decision::Commit => receipt_matches(snapshot.receipts.as_deref(), &status)?,
            // Once abort completion was durably verified, later user input may
            // legitimately equal the old staged text. Do not replay rollback.
            Decision::Abort => !receipt_matches(snapshot.receipts.as_deref(), &status)?,
            Decision::Pending => false,
        };
    verify_snapshot(
        &status,
        &binding.fingerprint,
        &snapshot,
        finish.unwrap_or(false) && !already_acknowledged,
    )?;
    if finish.unwrap_or(false) || already_acknowledged {
        crate::platform::legacy_processes::require_stopped()?;
        let handle = app.clone();
        let mut expected = status.clone();
        expected.recovery_journal = None;
        let fingerprint = binding.fingerprint.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let storage = handle.state::<StorageState>();
            let slot = storage.store.lock().map_err(|error| error.to_string())?;
            let store = slot.as_ref().ok_or("工作区未打开")?;
            if store.draft_recovery_status()?.as_ref() != Some(&expected) {
                return Err("原生草稿恢复状态已改变".to_string());
            }
            store
                .complete_draft_browser(&expected.transaction_id, &fingerprint)
                .map_err(|error| format!("持久化草稿恢复完成记录失败：{error}"))
        })
        .await
        .map_err(|error| error.to_string())??;
        app.state::<crate::draft_maintenance::Service>()
            .unresolved
            .store(false, Ordering::SeqCst);
        crate::draft_maintenance::recovered(&app, &status.request_id);
    }
    Ok(if already_acknowledged {
        None
    } else {
        Some(status)
    })
}
