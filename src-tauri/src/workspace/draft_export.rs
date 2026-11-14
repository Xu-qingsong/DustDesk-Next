//! Native export of the current browser checkpoint. Renderer IPC supplies no
//! entries, source headers, expected fingerprint, or destination path.
use super::{commands::StorageState, draft_browser, draft_lineage, export_file};
use chrono::{SecondsFormat, Utc};
use serde::Deserialize;
#[cfg(test)]
use serde_json::value::RawValue;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewWindow};

const MAX_BYTES: usize = 64 * 1024 * 1024;
#[cfg(test)]
use dustdesk_tauri::managed_snapshot::drafts::text;
use dustdesk_tauri::managed_snapshot::drafts::{validate, Entry};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Collected {
    entries: Vec<Entry>,
    error: Option<String>,
}
fn invalid() -> String {
    "草稿数据无效或超出白名单，未截断或导出".into()
}
fn archive(
    mut entries: Vec<Entry>,
    fingerprint: &str,
    version: &str,
) -> Result<(String, usize), String> {
    if entries.len() > 5000 || !draft_lineage::is_hash(fingerprint, 64) {
        return Err(invalid());
    }
    let mut seen = HashSet::new();
    let mut bytes = 0;
    for entry in &entries {
        validate(entry)?;
        if !seen.insert(&entry.key) {
            return Err(invalid());
        }
        bytes += serde_json::to_vec(entry)
            .map_err(|error| error.to_string())?
            .len();
        if bytes > MAX_BYTES {
            return Err("草稿迁移包超过 64 MiB，未截断或导出".into());
        }
    }
    entries.sort_by(|a, b| a.key.encode_utf16().cmp(b.key.encode_utf16()));
    let count = entries.len();
    let payload = serde_json::to_string(&json!({
        "id":uuid::Uuid::new_v4().to_string(), "createdAt":Utc::now().to_rfc3339_opts(SecondsFormat::Millis,true),
        "source":{"runtime":"tauri","appVersion":version,"workspaceFingerprint":fingerprint}, "entries":entries
    })).map_err(|error| error.to_string())?;
    let serialized = serde_json::to_string(&json!({"format":"dustdesk-browser-drafts","version":1,"sha256":format!("{:x}",Sha256::digest(payload.as_bytes())),"payload":payload})).map_err(|error| error.to_string())?;
    if serialized.len() > MAX_BYTES {
        return Err("草稿迁移包超过 64 MiB，未截断或导出".into());
    }
    Ok((serialized, count))
}
async fn collect(window: &WebviewWindow) -> Result<Vec<Entry>, String> {
    let script = r#"(() => { try {
      if (localStorage.getItem('dustdesk:draft-migration:pending:v1') !== null) throw Error('存在未恢复草稿事务，未导出');
      const length = localStorage.length, keys = Array.from({length}, (_,index) => localStorage.key(index)), entries = [];
      let bytes = 0;
      for (const key of keys) {
        if (key === null) throw Error('草稿在读取时发生变化');
        if (!key.startsWith('widget-note:') && !['widget-task-draft:v1:todo','quick-capture-draft','widget-notes:selected'].includes(key)) continue;
        const value = localStorage.getItem(key);
        if (value === null) throw Error('草稿在读取时发生变化');
        const entry = {key,value}; bytes += new TextEncoder().encode(JSON.stringify(entry)).length;
        if (bytes > 67108864 || entries.length >= 5000) throw Error('草稿超过导出上限，未截断');
        entries.push(entry);
      }
      if (localStorage.length !== length || keys.some((key,index) => localStorage.key(index) !== key) || entries.some(({key,value}) => localStorage.getItem(key) !== value)) throw Error('草稿在读取时发生变化');
      return {entries,error:null};
    } catch(error) { return {entries:[],error:String(error)}; } })()"#;
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
        .map_err(|_| "读取实际浏览器草稿超时，未导出")?
        .map_err(|error| error.to_string())?;
    if raw.len() > 384 * 1024 * 1024 {
        return Err(invalid());
    }
    let result: Collected = serde_json::from_str(&raw).map_err(|_| invalid())?;
    if let Some(error) = result.error {
        return Err(error);
    }
    Ok(result.entries)
}

pub(crate) async fn collect_archive(
    window: &WebviewWindow,
    fingerprint: &str,
    version: &str,
) -> Result<(String, usize), String> {
    archive(collect(window).await?, fingerprint, version)
}

#[tauri::command]
pub async fn drafts_export(app: tauri::AppHandle, window: WebviewWindow) -> Result<Value, String> {
    crate::toolbox::require_active(&app, &window)?;
    let Some(selection) = crate::system::select_draft_export(app.clone(), window.clone()).await?
    else {
        return Ok(json!({"canceled":true}));
    };
    let target = selection.finish_selection()?;
    if target
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("json"))
    {
        return Err("请选择 JSON 草稿迁移包".into());
    }
    let protected = app
        .state::<StorageState>()
        .root
        .parent()
        .ok_or("隔离目录无效")?
        .to_path_buf();
    export_file::require_external(&target, &protected)?;
    let checkpoint =
        crate::draft_maintenance::drafts_prepare(app.clone(), window.clone(), Some(false)).await?;
    let request = checkpoint.request_id.clone();
    let result = async {
        let binding = draft_browser::binding(&app, &window)?;
        let entries = collect(&window).await?;
        if draft_browser::binding(&app, &window)?.fingerprint != binding.fingerprint { return Err("浏览器草稿来源已变化".into()); }
        let gate = app.state::<crate::widgets::Service>().gate.clone();
        let _guard = gate.lock().await;
        let handle = app.clone();
        let window = window.clone();
        tokio::task::spawn_blocking(move || {
            let _binding = binding;
            let storage = handle.state::<StorageState>();
            let slot = storage.store.lock().map_err(|error| error.to_string())?;
            let store = slot.as_ref().ok_or("工作区尚未读取")?;
            let service = handle.state::<crate::draft_maintenance::Service>();
            let active = || {
                if !crate::main_window::current(&handle, &window) || service.ready_fingerprint(&checkpoint.request_id)? != checkpoint.workspace_fingerprint { return Err("草稿导出维护检查点已失效".into()); }
                crate::platform::legacy_processes::require_stopped()
            };
            active()?;
            export_file::require_external(&target, &protected)?;
            let (serialized, count) = archive(entries, &checkpoint.workspace_fingerprint, &handle.package_info().version.to_string())?;
            let prepared = export_file::prepare_checked(&target, serialized.as_bytes(), active)?;
            // Reserve the exact native receipt before publishing the external
            // file. A failed/cancelled publish may leave an unused receipt; it
            // never leaves a file claimed complete without its provenance.
            let provenance = store.record_draft_export(&serialized, &checkpoint.workspace_fingerprint, active)?;
            prepared.publish(active)?;
            Ok::<_,String>(json!({"path":target.display().to_string(),"entries":count,"provenance":provenance}))
        }).await.map_err(|error| error.to_string())?
    }.await;
    let ended = crate::draft_maintenance::drafts_end(app, window, request).await;
    match result {
        Ok(mut result) => {
            if let Err(error) = ended {
                result["warning"] = json!(format!(
                    "文件与来源回执已写入，维护收尾需要重新核验：{error}"
                ));
            }
            Ok(result)
        }
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn entry(key: &str, value: &str) -> Entry {
        Entry {
            key: key.into(),
            value: value.into(),
        }
    }
    #[test]
    fn native_archive_preserves_exact_values_and_javascript_utf16_key_order() {
        let raw = "{ \"title\":\"中文🪶\",\"text\":\"a\\r\\nb\",\"previousTitle\":\"\",\"previousText\":\"\" }";
        let entries = vec![
            entry("widget-note:\u{e000}", raw),
            entry("widget-note:🪶", raw),
            entry("widget-note:v2:notes:id", r#"{"saved":true}"#),
            entry(
                "widget-task-draft:v1:todo",
                r#"{"title":"","requestId":"same-request"}"#,
            ),
            entry(
                "quick-capture-draft",
                r#"{"kind":"note","title":"","text":"原文"}"#,
            ),
            entry("widget-notes:selected", ""),
        ];
        let (serialized, count) = archive(entries, &"a".repeat(64), "1.0.2").unwrap();
        let outer: Value = serde_json::from_str(&serialized).unwrap();
        let payload = outer["payload"].as_str().unwrap();
        assert_eq!(
            outer["sha256"],
            format!("{:x}", Sha256::digest(payload.as_bytes()))
        );
        let payload: Value = serde_json::from_str(payload).unwrap();
        assert_eq!(payload["source"]["runtime"], "tauri");
        assert_eq!(payload["source"]["workspaceFingerprint"], "a".repeat(64));
        assert_eq!(count, 6);
        let notes = payload["entries"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|entry| entry["value"] == raw)
            .collect::<Vec<_>>();
        assert_eq!(notes[0]["key"], "widget-note:🪶");
        assert_eq!(notes[1]["key"], "widget-note:\u{e000}");
        assert!(draft_lineage::is_uuid(payload["id"].as_str().unwrap()));
    }
    #[test]
    fn whitelist_requires_canonical_owners_exact_fields_and_safe_utf16_lengths() {
        let draft = r#"{"title":"","text":"","previousTitle":"","previousText":""}"#;
        for key in [
            "widget-note:id",
            "widget-note:v2:notes:%E4%B8%AD%E6%96%87",
            "widget-note:v2:note%3Aid:id",
        ] {
            validate(&entry(key, draft)).unwrap();
        }
        for key in [
            "cookie",
            "widget-note:v3:id",
            "widget-note:v02:id",
            "widget-note:v2:other:id",
            "widget-note:v2:note%3Aother:id",
            "widget-note:v2:notes:%e4%b8%ad",
            "widget-note:v2:notes:%ZZ",
            "widget-note:v2:notes:a:b",
        ] {
            assert!(validate(&entry(key, draft)).is_err(), "{key}");
        }
        for value in [
            r#"{"saved":true,"text":"keep"}"#,
            r#"{"saved":false}"#,
            r#"{"title":"","text":"","previousTitle":"","previousText":null}"#,
        ] {
            assert!(validate(&entry("widget-note:id", value)).is_err());
        }
        let task = |title: &str| {
            serde_json::to_string(&json!({"title":title,"requestId":"stable"})).unwrap()
        };
        validate(&entry(
            "widget-task-draft:v1:todo",
            &task(&"🪶".repeat(150)),
        ))
        .unwrap();
        assert!(validate(&entry(
            "widget-task-draft:v1:todo",
            &task(&"🪶".repeat(151))
        ))
        .is_err());
        assert!(validate(&entry(
            "quick-capture-draft",
            r#"{"kind":"task","title":"","text":"","requestId":""}"#
        ))
        .is_err());
        assert!(validate(&entry("widget-notes:selected", "bad\0id")).is_err());
    }
    #[test]
    fn javascript_escaped_surrogates_keep_original_json_and_exact_code_unit_limits() {
        let raw = r#"{ "title":"\ud800\ud83e\udeb6\udfff","text":"\\ud800", "previousTitle":"", "previousText":"" }"#;
        let (serialized, _) = archive(
            vec![entry("widget-note:unicode", raw)],
            &"a".repeat(64),
            "1.0.2",
        )
        .unwrap();
        let outer: Value = serde_json::from_str(&serialized).unwrap();
        let payload: Value = serde_json::from_str(outer["payload"].as_str().unwrap()).unwrap();
        assert_eq!(payload["entries"][0]["value"], raw);
        for (encoded, expected) in [
            (r#""\ud800""#, 1),
            (r#""\udfff""#, 1),
            (r#""\ud83e\udeb6""#, 2),
            (r#""\\ud800""#, 6),
            (r#""中文🪶""#, 4),
        ] {
            let parsed: Box<RawValue> = serde_json::from_str(encoded).unwrap();
            text(&parsed, expected, true).unwrap();
            assert!(text(&parsed, expected - 1, true).is_err());
        }
        let title = "\\ud800".repeat(300);
        let task = format!(r#"{{"title":"{title}","requestId":"\udfff"}}"#);
        validate(&entry("widget-task-draft:v1:todo", &task)).unwrap();
        assert!(validate(&entry(
            "widget-task-draft:v1:todo",
            &task.replace(&title, &(title.clone() + "\\ud800"))
        ))
        .is_err());
        for raw in [
            r#"{"title":[],"requestId":"id"}"#,
            r#"{"title":null,"requestId":"id"}"#,
            r#"{"title":"\uZZZZ","requestId":"id"}"#,
        ] {
            assert!(validate(&entry("widget-task-draft:v1:todo", raw)).is_err());
        }
    }
    #[test]
    fn duplicate_keys_invalid_checkpoints_and_entry_overflow_do_not_create_archives() {
        assert!(archive(
            vec![
                entry("widget-notes:selected", ""),
                entry("widget-notes:selected", "")
            ],
            &"a".repeat(64),
            "1.0.2"
        )
        .is_err());
        assert!(archive(Vec::new(), "renderer-fingerprint", "1.0.2").is_err());
        assert!(archive(
            (0..5001)
                .map(|_| entry("widget-notes:selected", ""))
                .collect(),
            &"a".repeat(64),
            "1.0.2"
        )
        .is_err());
    }
}
