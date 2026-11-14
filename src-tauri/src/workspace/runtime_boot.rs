//! Quarantined Debug-only startup. No regular workspace IPC or background services.
use super::{
    draft_browser,
    draft_transaction::{BrowserJournal, Decision},
    WorkspaceStore,
};
use dustdesk_tauri::legacy_source::bridge::RuntimeLaunch;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio_util::sync::CancellationToken;
mod handback;
mod lan;

struct Service {
    store: Mutex<WorkspaceStore>,
    gate: tokio::sync::Mutex<()>,
    cancel: CancellationToken,
    request_id: String,
    phase: Mutex<Phase>,
    browser_start: Arc<AtomicBool>,
    generation: AtomicU64,
    stop: CancellationToken,
    exit_ready: AtomicBool,
    ownership_id: String,
    preview_root: std::path::PathBuf,
    seal: Arc<AtomicBool>,
    client_closed: CancellationToken,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Recovery,
    Import,
    Staged,
    Decided,
    Ready,
    Sealing,
}

fn emit(request: &str, event: &str, fields: Value) -> Result<(), String> {
    let mut value = json!({"event":event,"requestId":request,"productionReady":false,"migrationComplete":false});
    value
        .as_object_mut()
        .unwrap()
        .extend(fields.as_object().unwrap().clone());
    let mut output = std::io::stdout().lock();
    serde_json::to_writer(&mut output, &value).map_err(|error| error.to_string())?;
    output
        .write_all(b"\n")
        .and_then(|_| output.flush())
        .map_err(|error| error.to_string())
}

fn current(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<String, String> {
    let service = app.state::<Service>();
    if service.cancel.is_cancelled()
        || service.stop.is_cancelled()
        || window.label() != "runtime-import"
    {
        return Err("原生运行准备已撤权".into());
    }
    let url = window.url().map_err(|error| error.to_string())?;
    if url.origin().ascii_serialization() != "http://tauri.localhost" {
        return Err("运行导入不属于持久绑定来源".into());
    }
    Ok(draft_browser::binding(app, window)?.fingerprint)
}

#[tauri::command]
async fn runtime_drafts_step(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
) -> Result<Value, String> {
    let service = app.state::<Service>();
    let _guard = service.gate.lock().await;
    let generation = service.generation.load(Ordering::SeqCst);
    if action == "recover" {
        tokio::time::timeout(Duration::from_secs(45), async {
            while !service.browser_start.load(Ordering::SeqCst) {
                if service.cancel.is_cancelled() || service.stop.is_cancelled() {
                    return Err("运行准备客户端已断开".to_string());
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Ok(())
        })
        .await
        .map_err(|_| "客户端尚未确认启动浏览器导入")??;
    }
    if !service.browser_start.load(Ordering::SeqCst)
        || service.generation.load(Ordering::SeqCst) != generation
    {
        return Err("运行导入尚未获准或页面已重载".into());
    }
    let phase = *service.phase.lock().map_err(|error| error.to_string())?;
    if phase == Phase::Ready && !["recover", "finish"].contains(&action.as_str()) {
        return Err("本轮导入已完成，未开启第二次写入".into());
    }
    let binding = current(&app, &window)?;
    let status = {
        let store = service.store.lock().map_err(|error| error.to_string())?;
        store._ownership.confirm_runtime()?;
        store.draft_recovery_status()?
    };
    let keys = status
        .as_ref()
        .map(|status| {
            status
                .writes
                .iter()
                .map(|write| write.key.clone())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let snapshot = draft_browser::snapshot(&window, &keys).await?;
    if current(&app, &window)? != binding || service.generation.load(Ordering::SeqCst) != generation
    {
        return Err("运行浏览器配置已改变".into());
    }
    let store = service.store.lock().map_err(|error| error.to_string())?;
    store._ownership.confirm_runtime()?;
    if store.draft_recovery_status()? != status {
        return Err("原生草稿决定已改变".into());
    }
    match action.as_str() {
        "recover" => {
            let Some(mut status) = status else {
                if phase == Phase::Ready
                    || snapshot.journal.is_some()
                    || snapshot.receipts.is_some()
                {
                    return Err("全新配置存在无原生决定的浏览器迁移状态".into());
                }
                *service.phase.lock().map_err(|error| error.to_string())? = Phase::Import;
                return Ok(Value::Null);
            };
            if status.decision == Decision::Pending {
                status = store.decide_draft_transaction(
                    &status.request_id,
                    &status.transaction_id,
                    false,
                    None,
                )?;
            }
            status.recovery_journal = Some(store.browser_recovery_journal(&status)?);
            draft_browser::verify_snapshot(&status, &binding, &snapshot, false)?;
            if phase != Phase::Ready {
                *service.phase.lock().map_err(|error| error.to_string())? = Phase::Recovery;
            }
            Ok(serde_json::to_value(status).map_err(|error| error.to_string())?)
        }
        "source" => {
            if phase != Phase::Import || snapshot.journal.is_some() {
                return Err("尚未核验启动恢复状态，未提供导入来源".into());
            }
            store.require_draft_recovered()?;
            let archive = store._ownership.runtime_drafts()?.ok_or("未持有运行来源")?;
            store.verify_draft_provenance(archive.serialized(), archive.workspace_sha256())?;
            Ok(
                json!({"serialized":archive.serialized(),"workspaceFingerprint":archive.workspace_sha256()}),
            )
        }
        "begin" => {
            if phase != Phase::Import {
                return Err("本轮尚未进入原生导入阶段".into());
            }
            let raw = snapshot
                .journal
                .as_deref()
                .ok_or("真实浏览器尚无暂存日志")?;
            let archive = store._ownership.runtime_drafts()?.ok_or("未持有运行来源")?;
            let status = store.begin_browser_transaction(
                &service.request_id,
                archive.serialized(),
                archive.workspace_sha256(),
                &format!("{:x}", Sha256::digest(raw)),
                Some(BrowserJournal {
                    raw,
                    binding: &binding,
                }),
            )?;
            *service.phase.lock().map_err(|error| error.to_string())? = Phase::Staged;
            Ok(serde_json::to_value(status).map_err(|error| error.to_string())?)
        }
        "decide" => {
            if phase != Phase::Staged {
                return Err("只能决定本次启动实际暂存的事务；旧 pending 必须先恢复".into());
            }
            let status = status.ok_or("尚无原生事务")?;
            if status.request_id != service.request_id {
                return Err("事务不属于本轮启动".into());
            }
            draft_browser::verify_snapshot(&status, &binding, &snapshot, false)?;
            for write in &status.writes {
                if snapshot
                    .values
                    .get(&write.key)
                    .and_then(|value| value.as_ref())
                    .is_none_or(|value| format!("{:x}", Sha256::digest(value)) != write.sha256)
                {
                    return Err("实际暂存草稿与原生决定不匹配".into());
                }
            }
            let archive = store._ownership.runtime_drafts()?.ok_or("未持有运行来源")?;
            let decided = store.decide_draft_transaction(
                &status.request_id,
                &status.transaction_id,
                true,
                Some(archive.workspace_sha256()),
            )?;
            *service.phase.lock().map_err(|error| error.to_string())? = Phase::Decided;
            Ok(serde_json::to_value(decided).map_err(|error| error.to_string())?)
        }
        "finish" => {
            let status = status.ok_or("尚无原生事务，未开放运行")?;
            // Completed abort must not replay old rollback against later text.
            let acknowledged_abort = status.completed
                && status.decision == Decision::Abort
                && snapshot.journal.is_none();
            draft_browser::verify_snapshot(&status, &binding, &snapshot, !acknowledged_abort)?;
            store.complete_draft_browser(&status.transaction_id, &binding)?;
            store._ownership.confirm_runtime()?;
            let ready = status.decision == Decision::Commit;
            *service.phase.lock().map_err(|error| error.to_string())? =
                if ready { Phase::Ready } else { Phase::Import };
            if ready && phase != Phase::Ready {
                emit(
                    &service.request_id,
                    "runtimeBrowserReady",
                    json!({"ownershipId":store._ownership.runtime_drafts()?.ok_or("未持有来源")?.ownership_id(),"businessServicesStarted":false}),
                )?;
            }
            Ok(json!({"ready":ready}))
        }
        _ => Err("未知运行导入步骤".into()),
    }
}

pub fn run(mut launch: RuntimeLaunch) -> Result<(), String> {
    let original_lan = launch.original_lan;
    let lan_start = launch.lan_start.clone();
    let ownership_id = launch.owner.receipt().id.clone();
    let preview_root = launch
        .owner
        .path()
        .parent()
        .ok_or("隔离运行根缺失")?
        .to_path_buf();
    let binding = launch.owner.resume_browser_profile()?;
    let profiles = binding.path().to_path_buf();
    let store = WorkspaceStore::try_from(launch.owner)?;
    let cancel = launch.cancel.clone();
    let request = launch.request_id.clone();
    tauri::Builder::default()
        .manage(Service {
            store: Mutex::new(store),
            gate: tokio::sync::Mutex::new(()),
            cancel: launch.cancel,
            request_id: launch.request_id,
            phase: Mutex::new(Phase::Recovery),
            browser_start: launch.browser_start,
            generation: AtomicU64::new(0),
            stop: launch.stop,
            exit_ready: AtomicBool::new(false),
            ownership_id,
            preview_root,
            seal: launch.seal,
            client_closed: launch.client_closed,
        })
        .manage(crate::ProbeState {
            profiles: profiles.clone(),
            ..Default::default()
        })
        .invoke_handler(tauri::generate_handler![runtime_drafts_step])
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                webview
                    .state::<Service>()
                    .generation
                    .fetch_add(1, Ordering::SeqCst);
            }
        })
        .setup(move |app| {
            WebviewWindowBuilder::new(
                app,
                "runtime-import",
                WebviewUrl::App("runtime-import.html".into()),
            )
            .title("DustDesk · 隔离启动恢复")
            .data_directory(profiles)
            .visible(false)
            .on_navigation(|url| url.as_str() == "http://tauri.localhost/runtime-import.html")
            .build()?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut running = None;
                let mut attempted = false;
                loop {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let service = handle.state::<Service>();
                    let valid = !service.cancel.is_cancelled()
                        && !service.stop.is_cancelled()
                        && service
                            .store
                            .lock()
                            .is_ok_and(|store| store._ownership.confirm_runtime().is_ok());
                    if !valid {
                        break;
                    }
                    if original_lan
                        && !attempted
                        && lan_start.load(Ordering::SeqCst)
                        && *service.phase.lock().unwrap() == Phase::Ready
                    {
                        let _gate = service.gate.lock().await;
                        attempted = true;
                        match lan::start(&handle).await {
                            Ok(value) => running = value,
                            Err(error) => {
                                eprintln!("隔离原 LAN 启动失败：{error}");
                                break;
                            }
                        }
                    }
                }
                let service = handle.state::<Service>();
                service.stop.cancel();
                let _gate = service.gate.lock().await;
                let mut result = if original_lan {
                    lan::finish(&handle, running).await
                } else {
                    Ok(())
                };
                if result.is_ok() && service.seal.load(Ordering::SeqCst) {
                    result = handback::seal(&handle).await;
                }
                if let Err(error) = &result {
                    eprintln!("隔离运行未完成交还：{error}");
                }
                service.exit_ready.store(true, Ordering::SeqCst);
                handle.exit(if result.is_ok() { 0 } else { 1 });
            });
            emit(
                &request,
                "runtimeBrowserStarting",
                json!({"profile":binding,"businessServicesStarted":false}),
            )?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .map_err(|error| error.to_string())?
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let service = app.state::<Service>();
                if !service.exit_ready.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    service.stop.cancel();
                }
            }
        });
    cancel.cancel();
    Ok(())
}
