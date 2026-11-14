use crate::workspace::commands::{broadcast, operation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::{ipc::Channel, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const LABEL: &str = "quick-capture";

pub struct Service {
    activated: AtomicBool,
    destroying: tokio::sync::watch::Sender<bool>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            activated: AtomicBool::new(false),
            destroying: tokio::sync::watch::channel(false).0,
        }
    }
}
pub fn destroying(app: &tauri::AppHandle, value: bool) {
    app.state::<Service>().destroying.send_replace(value);
}
pub fn destroyed(app: &tauri::AppHandle) {
    navigated(app, LABEL);
    destroying(app, false);
}
async fn wait_destroyed(app: &tauri::AppHandle) -> Result<(), String> {
    let mut state = app.state::<Service>().destroying.subscribe();
    tokio::time::timeout(Duration::from_secs(3), async {
        while *state.borrow_and_update() {
            state.changed().await.map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "快速记录窗口仍在释放，请稍后重试".to_string())?
}
pub fn navigated(app: &tauri::AppHandle, label: &str) {
    if label == LABEL {
        app.state::<Service>()
            .activated
            .store(false, Ordering::SeqCst);
    }
}

pub fn require(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if window.label() != LABEL || !crate::main_window::current(app, window) {
        return Err("此窗口无快速记录权限".into());
    }
    Ok(())
}

pub async fn show(app: &tauri::AppHandle) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    wait_destroyed(app).await?;
    // Refuse an uninitialized/corrupt workspace; never create empty data here.
    operation(app.clone(), |store| store.widget_load().map(|_| ())).await?;
    let window = if let Some(window) = app.get_webview_window(LABEL) {
        window
    } else {
        WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("quick.html".into()))
            .title("DustDesk 快速记录")
            .inner_size(520.0, 430.0)
            .min_inner_size(380.0, 360.0)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .data_directory(app.state::<crate::ProbeState>().profiles.clone())
            .build()
            .map_err(|error| error.to_string())?
    };
    crate::window_release::cancel(app, LABEL);
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

pub fn request_show(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let message = match show(&app).await {
            Ok(()) => "DustDesk".to_string(),
            Err(error) => {
                eprintln!("无法打开快速记录：{error}");
                if app.get_webview_window("workspace-main").is_some() {
                    let _ = crate::events::emit(
                        &app,
                        "workspace-main",
                        "system:action-error",
                        error.clone(),
                    );
                }
                format!(
                    "DustDesk · 快速记录未打开：{}",
                    error.chars().take(300).collect::<String>()
                )
            }
        };
        if let Some(tray) = app.tray_by_id("dustdesk-preview") {
            let _ = tray.set_tooltip(Some(message));
        }
    });
}

pub fn request_hide(app: &tauri::AppHandle) {
    if let Err(error) = crate::events::emit(app, LABEL, "quick-capture:hide", ()) {
        eprintln!("快速记录草稿接收器尚未就绪：{error}");
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Some(window) = app.get_webview_window(LABEL) {
                let _ = quick_capture_abort(app.clone(), window).await;
            }
        });
    }
}

#[tauri::command]
pub async fn quick_capture_abort(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    require(&app, &window)?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    // Before the channel is installed no editor has mounted and there is no
    // in-memory draft to flush. An error page may close without discarding disk data.
    if app.state::<Service>().activated.load(Ordering::SeqCst) {
        return Err("快速记录编辑器已就绪，必须先保存草稿再收起".into());
    }
    destroying(&app, true);
    if let Err(error) = window.destroy() {
        destroying(&app, false);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn protect_restore(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Err("请先收起快速记录并等待草稿窗口释放，再恢复备份".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn quick_capture_show(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::workspace::api::require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    show(&app).await
}

#[tauri::command]
pub async fn quick_capture_hide(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    require(&app, &window)?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    window.hide().map_err(|error| error.to_string())?;
    crate::window_release::schedule(&app, LABEL);
    Ok(())
}

#[tauri::command]
pub fn quick_capture_request_hide(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::workspace::api::require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    if app.get_webview_window(LABEL).is_some() {
        crate::events::emit(&app, LABEL, "quick-capture:hide", ())?;
    }
    Ok(())
}

fn validate_request(id: &str) -> Result<(), String> {
    if crate::workspace::productivity::trim(id).is_empty() || id.encode_utf16().count() > 100 {
        return Err("记录请求标识无效".into());
    }
    Ok(())
}

pub fn committed(state: &Value, id: &str) -> bool {
    ["Todos", "Notes"].iter().any(|key| {
        state[*key]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["Id"] == id))
    }) || state["RecycleBin"].as_array().is_some_and(|items| {
        items.iter().any(|item| {
            matches!(item["kind"].as_str(), Some("task" | "note")) && item["value"]["Id"] == id
        })
    })
}

#[tauri::command]
pub async fn quick_capture_committed(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<bool, String> {
    require(&app, &window)?;
    validate_request(&request_id)?;
    operation(app, move |store| {
        Ok(committed(&store.widget_load()?.state, &request_id))
    })
    .await
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    kind: Kind,
    title: String,
    text: String,
    request_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Task,
    Note,
}

#[tauri::command]
pub async fn quick_capture_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    draft: Draft,
) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    require(&app, &window)?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    validate_request(&draft.request_id)?;
    let mut action = serde_json::to_value(draft).map_err(|error| error.to_string())?;
    action["type"] = json!("capture");
    let snapshot = operation(app.clone(), move |store| {
        store
            .productivity_action(action)
            .map_err(|error| error.error)
    })
    .await?;
    broadcast(&app, &snapshot);
    crate::productivity_service::start(&app);
    Ok(())
}

#[tauri::command]
pub async fn quick_capture_events_attach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    channel: Channel<crate::events::Packet>,
) -> Result<String, String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    require(&app, &window)?;
    let token = app
        .state::<crate::events::Service>()
        .attach(LABEL, LABEL.into(), channel)?;
    app.state::<Service>()
        .activated
        .store(true, Ordering::SeqCst);
    Ok(token)
}
#[tauri::command]
pub fn quick_capture_events_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<bool, String> {
    require(&app, &window)?;
    Ok(app.state::<crate::events::Service>().detach(LABEL, &token))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_ids_preserve_legacy_values_and_the_shared_utf16_bound() {
        assert!(validate_request("legacy-capture-request").is_ok());
        assert!(validate_request(&"中".repeat(100)).is_ok());
        assert!(validate_request(&"😀".repeat(50)).is_ok());
        assert!(validate_request(&"😀".repeat(51)).is_err());
        assert!(validate_request("\u{3000}\t").is_err());
        assert!(validate_request("").is_err());
    }
    #[test]
    fn capture_draft_cannot_smuggle_an_action_or_source_note() {
        let valid = json!({"kind":"note","title":"标题","text":"正文","requestId":uuid::Uuid::new_v4().to_string()});
        assert!(serde_json::from_value::<Draft>(valid.clone()).is_ok());
        for field in ["type", "sourceNoteId", "id"] {
            let mut bad = valid.clone();
            bad[field] = json!("private");
            assert!(serde_json::from_value::<Draft>(bad).is_err());
        }
        let mut bad = valid;
        bad["kind"] = json!("project");
        assert!(serde_json::from_value::<Draft>(bad).is_err());
    }
    #[test]
    fn reconciliation_checks_only_productivity_records_including_recycle_bin() {
        let state = json!({"Todos":[{"Id":"a"}],"Notes":[{"Id":"b"}],"RecycleBin":[{"kind":"note","value":{"Id":"c"}},{"kind":"task","value":{"Id":"d"}},{"kind":"project","value":{"Id":"e"}}],"Projects":[{"Id":"f"}]});
        for id in ["a", "b", "c", "d"] {
            assert!(committed(&state, id));
        }
        for id in ["e", "f", "missing"] {
            assert!(!committed(&state, id));
        }
    }
}
