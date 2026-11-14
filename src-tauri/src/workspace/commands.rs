use super::{Snapshot, WorkspaceStore};
use serde_json::Value;
use std::{path::PathBuf, sync::Mutex};
use tauri::{Emitter, Manager, WebviewWindow};

pub struct StorageState {
    pub root: PathBuf,
    pub(super) auto_initialize: bool,
    pub(super) store: Mutex<Option<WorkspaceStore>>,
}

impl StorageState {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            auto_initialize: false,
            store: Mutex::new(None),
        }
    }
    pub fn application(root: PathBuf) -> Self {
        Self {
            auto_initialize: true,
            ..Self::new(root)
        }
    }
}

pub async fn drain(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageState>();
        let mut slot = state.store.lock().map_err(|error| error.to_string())?;
        if let Some(store) = slot.as_mut() {
            if let Some(snapshot) = store.stop_productivity()? {
                broadcast(&app, &snapshot);
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn verify_draft_provenance(
    app: tauri::AppHandle,
    request: String,
    serialized: String,
) -> Result<super::draft_lineage::Provenance, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let storage = app.state::<StorageState>();
        let slot = storage.store.lock().map_err(|error| error.to_string())?;
        let service = app.state::<crate::draft_maintenance::Service>();
        let fingerprint = service.ready_fingerprint(&request)?;
        crate::platform::legacy_processes::require_stopped()?;
        let store = slot.as_ref().ok_or("工作区尚未读取，不能核验迁移回执")?;
        let result = store.verify_draft_provenance(&serialized, &fingerprint)?;
        crate::platform::legacy_processes::require_stopped()?;
        if service.ready_fingerprint(&request)? != fingerprint {
            return Err("迁移维护检查点已变化".into());
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn draft_transaction(
    window: WebviewWindow,
    request: Option<String>,
    serialized: Option<String>,
    journal_sha256: Option<String>,
    transaction_id: Option<String>,
    commit: Option<bool>,
) -> Result<Option<super::draft_transaction::Status>, String> {
    let app = window.app_handle().clone();
    let browser = if serialized.is_some() {
        let binding = super::draft_browser::binding(&app, &window)?;
        let snapshot = super::draft_browser::snapshot(&window, &[]).await?;
        let raw = snapshot
            .journal
            .ok_or("真实浏览器尚无草稿暂存日志，未创建原生事务")?;
        Some((binding, raw))
    } else {
        None
    };
    if !crate::main_window::current(&app, &window) {
        return Err("原生草稿事务窗口已失效".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        use std::sync::atomic::Ordering;
        let storage = app.state::<StorageState>();
        let mut slot = storage.store.lock().map_err(|error| error.to_string())?;
        if slot.is_none() {
            *slot = Some(WorkspaceStore::open(storage.root.clone())?);
        }
        let store = slot.as_ref().unwrap();
        let service = app.state::<crate::draft_maintenance::Service>();
        let existing = store.draft_transaction_status();
        if !matches!(&existing, Ok(None)) {
            service.unresolved.store(true, Ordering::SeqCst);
        }
        if request.is_none()
            && serialized.is_none()
            && journal_sha256.is_none()
            && transaction_id.is_none()
            && commit.is_none()
        {
            return existing;
        }
        let request = request.ok_or("缺少原生维护请求")?;
        match (serialized, journal_sha256, transaction_id, commit) {
            (Some(serialized), Some(journal), None, None) => {
                service.unresolved.store(true, Ordering::SeqCst);
                let result = service.with_ready_decision(&request, |fingerprint| {
                    let fingerprint = fingerprint.ok_or("原生迁移检查点已失效或过期")?;
                    crate::platform::legacy_processes::require_stopped()?;
                    let (binding, raw) = browser.as_ref().ok_or("尚未读取真实浏览器日志")?;
                    store.begin_browser_transaction(
                        &request,
                        &serialized,
                        fingerprint,
                        &journal,
                        Some(super::draft_transaction::BrowserJournal {
                            raw,
                            binding: &binding.fingerprint,
                        }),
                    )
                });
                if result.is_err() && matches!(store.draft_transaction_status(), Ok(None)) {
                    service.unresolved.store(false, Ordering::SeqCst);
                }
                result.map(Some)
            }
            (None, None, Some(transaction), Some(commit)) => {
                service.with_ready_decision(&request, |fingerprint| {
                    let fingerprint =
                        if crate::platform::legacy_processes::require_stopped().is_ok() {
                            fingerprint
                        } else {
                            None
                        };
                    store
                        .decide_draft_transaction(&request, &transaction, commit, fingerprint)
                        .map(Some)
                })
            }
            _ => Err("原生草稿事务参数组合无效".into()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) async fn seal_draft_checkpoint(
    app: tauri::AppHandle,
    request: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use sha2::{Digest, Sha256};
        let storage = app.state::<StorageState>();
        let mut slot = storage.store.lock().map_err(|error| error.to_string())?;
        if !app
            .state::<crate::draft_maintenance::Service>()
            .active(&request)
        {
            return Err("迁移维护请求已失效".into());
        }
        crate::platform::legacy_processes::require_stopped()?;
        let store = slot.as_mut().ok_or("工作区尚未读取，不能准备迁移")?;
        store.load("workspace-main")?;
        let path = storage.root.join("workspace.json");
        super::checked_path(&path)?;
        let metadata = std::fs::metadata(&path).map_err(|error| error.to_string())?;
        if !metadata.is_file() || metadata.len() > 64 * 1024 * 1024 {
            return Err("迁移工作区文件无效或超过大小限制".into());
        }
        use std::io::Read;
        let mut bytes = Vec::new();
        std::fs::File::open(path)
            .map_err(|error| error.to_string())?
            .take(64 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        if bytes.len() > 64 * 1024 * 1024 {
            return Err("迁移工作区超过大小限制".into());
        }
        let fingerprint = format!("{:x}", Sha256::digest(&bytes));
        app.state::<crate::lifecycle::QuitState>()
            .seal_maintenance(&request)?;
        Ok(fingerprint)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn require_editor(window: &WebviewWindow) -> Result<(), String> {
    if !["main", "probe-widget"].contains(&window.label()) {
        return Err("此窗口无工作区访问权限".into());
    }
    Ok(())
}

pub(crate) async fn operation<T: Send + 'static>(
    app: tauri::AppHandle,
    callback: impl FnOnce(&mut WorkspaceStore) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<StorageState>();
        let mut slot = state.store.lock().map_err(|error| error.to_string())?;
        app.state::<crate::draft_startup::Service>()
            .require_ready()?;
        if let Some(store) = slot.as_ref() {
            store.require_draft_recovered()?;
        }
        app.state::<crate::lifecycle::QuitState>()
            .require_writable()?;
        if slot.is_none() {
            *slot = Some(WorkspaceStore::open(state.root.clone())?);
        }
        slot.as_ref().unwrap().require_draft_recovered()?;
        slot.as_mut().unwrap().organizer_desktop =
            Some(app.state::<crate::desktop::DesktopService>().root());
        callback(slot.as_mut().unwrap())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub async fn organizer_quit(app: tauri::AppHandle, restore: Option<bool>) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !app.state::<crate::lifecycle::QuitState>().committing() {
            return Err("退出阶段已失效".into());
        }
        let storage = app.state::<StorageState>();
        let mut slot = storage.store.lock().map_err(|error| error.to_string())?;
        if !storage.root.join("workspace.json").exists()
            && !storage.root.join("workspace.json.bak").exists()
        {
            return Ok(false);
        }
        if slot.is_none() {
            *slot = Some(WorkspaceStore::open(storage.root.clone())?);
        }
        let store = slot.as_mut().unwrap();
        store.organizer_desktop = Some(app.state::<crate::desktop::DesktopService>().root());
        if let Some(restore) = restore {
            let snapshot = if restore {
                store.organizer_restore_session()?
            } else {
                store.organizer_resume_session()?
            };
            if let Some(snapshot) = snapshot {
                broadcast(&app, &snapshot);
            }
            app.state::<crate::desktop::DesktopService>().release();
            return Ok(false);
        }
        store.organizer_has_items()
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn broadcast(app: &tauri::AppHandle, snapshot: &Snapshot) {
    crate::hotkeys::changed(app);
    crate::widgets::changed(app, snapshot);
    crate::clipboard_monitor::changed(app, snapshot);
    for label in ["main", "probe-widget"] {
        if app.get_webview_window(label).is_some() {
            if let Err(error) = app.emit_to(label, "prototype:workspace-changed", snapshot) {
                eprintln!("工作区已保存，广播失败：{error}");
            }
        }
    }
    if app.get_webview_window("workspace-main").is_some() {
        if let Err(error) = app.emit_to("workspace-main", "workspace:snapshot", snapshot) {
            eprintln!("工作区已保存，主页面广播失败：{error}");
        }
    }
}

#[tauri::command]
pub async fn prototype_workspace_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    require_editor(&window)?;
    let bytes = operation(app, move |store| store.image(&id)).await?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn prototype_workspace_initialize(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: Value,
) -> Result<Snapshot, String> {
    if window.label() != "main" {
        return Err("只有主窗口可初始化隔离工作区".into());
    }
    let client = window.label().to_owned();
    let snapshot = operation(app.clone(), move |store| store.initialize(state, &client)).await?;
    broadcast(&app, &snapshot);
    Ok(snapshot)
}

#[tauri::command]
pub async fn prototype_workspace_load(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Snapshot, String> {
    require_editor(&window)?;
    let client = window.label().to_owned();
    operation(app, move |store| store.load(&client)).await
}

#[tauri::command]
pub async fn prototype_workspace_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: Value,
    baseline: Option<Value>,
) -> Result<Snapshot, String> {
    require_editor(&window)?;
    let client = window.label().to_owned();
    let snapshot = operation(app.clone(), move |store| {
        store.save(state, baseline, &client)
    })
    .await?;
    broadcast(&app, &snapshot);
    Ok(snapshot)
}
