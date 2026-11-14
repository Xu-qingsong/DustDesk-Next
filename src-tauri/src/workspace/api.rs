use super::commands::{broadcast, operation};
use super::Snapshot;
use serde::Serialize;
use serde_json::Value;
use tauri::{Manager, WebviewWindow};

pub fn require_workspace(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "workspace-main" {
        return Err("此窗口无正式工作区命令权限".into());
    }
    Ok(())
}

#[tauri::command]
pub fn workspace_platform(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<&'static str, String> {
    crate::widgets::reader(&app, &window)?;
    Ok(match std::env::consts::OS {
        "windows" => "win32",
        "macos" => "darwin",
        "linux" => "linux",
        _ => "unsupported",
    })
}

#[tauri::command]
pub async fn workspace_load(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Snapshot, String> {
    let widget = crate::widgets::reader(&app, &window)?;
    let client = window.label().to_owned();
    let role = widget.clone();
    let auto_initialize = app.state::<super::commands::StorageState>().auto_initialize;
    let snapshot = operation(app.clone(), move |store| {
        if auto_initialize && role.is_none() {
            match store.load(&client) {
                Err(error) if error == "工作区尚未初始化" => {
                    store.initialize(super::normalize::default_state(), &client)?;
                }
                Err(error) => return Err(error),
                Ok(_) => {}
            }
        }
        store.ensure_productivity()?;
        if role.is_some() {
            store.widget_load()
        } else {
            store.load(&client)
        }
    })
    .await?;
    crate::productivity_service::start(&app);
    crate::clipboard_monitor::changed(&app, &snapshot);
    crate::clipboard_monitor::start(&app);
    if widget.is_none() {
        crate::widgets::changed(&app, &snapshot);
    }
    Ok(widget.map_or_else(
        || snapshot.clone(),
        |key| super::widgets::project(snapshot.clone(), &key),
    ))
}

#[tauri::command]
pub async fn workspace_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: Value,
    baseline: Option<Value>,
) -> Result<Snapshot, String> {
    require_workspace(&window)?;
    let client = window.label().to_owned();
    let snapshot = operation(app.clone(), move |store| {
        store.ensure_productivity()?;
        store.save(state, baseline, &client)
    })
    .await?;
    broadcast(&app, &snapshot);
    crate::productivity_service::start(&app);
    crate::clipboard_monitor::start(&app);
    Ok(snapshot)
}

#[tauri::command]
pub async fn workspace_initialize(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Snapshot, String> {
    require_workspace(&window)?;
    let snapshot = operation(app.clone(), move |store| {
        store.initialize(super::normalize::default_state(), "workspace-main")
    })
    .await?;
    broadcast(&app, &snapshot);
    crate::productivity_service::start(&app);
    crate::clipboard_monitor::start(&app);
    Ok(snapshot)
}

#[derive(Serialize)]
pub struct ActionReply {
    pub(super) result: Value,
    pub(super) snapshot: Option<Snapshot>,
}

#[tauri::command]
pub async fn workspace_productivity(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: Value,
) -> Result<ActionReply, String> {
    let widget = crate::widgets::reader(&app, &window)?;
    if let Some(key) = &widget {
        super::widgets::authorize_action(key, &action)?;
    }
    if let Err(error) = super::resource_api::preflight(app.clone(), &action).await {
        return Ok(super::resource_api::failed_preflight(error));
    }
    let result = operation(app.clone(), move |store| {
        Ok(store.productivity_action(action))
    })
    .await?;
    match result {
        Ok(snapshot) => {
            broadcast(&app, &snapshot);
            crate::productivity_service::start(&app);
            Ok(ActionReply {
                result: serde_json::json!({"ok":true}),
                snapshot: Some(widget.map_or_else(
                    || snapshot.clone(),
                    |key| super::widgets::project(snapshot.clone(), &key),
                )),
            })
        }
        Err(error) => {
            let mut result = serde_json::to_value(error).map_err(|error| error.to_string())?;
            result["ok"] = serde_json::json!(false);
            Ok(ActionReply {
                result,
                snapshot: None,
            })
        }
    }
}

#[tauri::command]
pub fn workspace_location(app: tauri::AppHandle, window: WebviewWindow) -> Result<String, String> {
    require_workspace(&window)?;
    Ok(app
        .state::<super::commands::StorageState>()
        .root
        .display()
        .to_string())
}

#[tauri::command]
pub async fn workspace_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    require_workspace(&window)?;
    crate::main_window::visibility(&app, &window, visible).await
}
