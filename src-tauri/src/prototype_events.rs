use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};
use tauri::{ipc::Channel, EventId, Listener, Manager, WebviewWindow};

struct Connection {
    token: String,
    listener: EventId,
}
#[derive(Default)]
pub struct Service(Mutex<HashMap<(String, String), Connection>>);

fn allowed(label: &str, event: &str) -> bool {
    match event {
        "prototype:captured" => matches!(label, "main" | "probe-pin"),
        "prototype:workspace-changed" => matches!(label, "main" | "probe-widget"),
        "tauri://drag-drop" => matches!(
            label,
            "main" | "probe-widget" | "probe-pin" | "probe-overlay"
        ),
        _ => false,
    }
}
fn require(app: &tauri::AppHandle, window: &WebviewWindow, event: &str) -> Result<(), String> {
    if !allowed(window.label(), event) || !crate::main_window::current(app, window) {
        return Err("原型事件未授权给当前窗口".into());
    }
    Ok(())
}
pub fn reset(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut connections) = app.state::<Service>().0.lock() {
        connections.retain(|(owner, _), connection| {
            if owner != label {
                return true;
            }
            app.unlisten(connection.listener);
            false
        });
    }
}
#[tauri::command]
pub fn prototype_event_attach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    event: String,
    channel: Channel<Value>,
) -> Result<String, String> {
    require(&app, &window, &event)?;
    let state = app.state::<Service>();
    let mut connections = state.0.lock().map_err(|error| error.to_string())?;
    let token = uuid::Uuid::new_v4().to_string();
    let listener = window.listen(event.clone(), move |message| {
        if let Ok(payload) = serde_json::from_str::<Value>(message.payload()) {
            let _ = channel.send(payload);
        }
    });
    if let Some(previous) = connections.insert(
        (window.label().into(), event),
        Connection {
            token: token.clone(),
            listener,
        },
    ) {
        app.unlisten(previous.listener);
    }
    Ok(token)
}
#[tauri::command]
pub fn prototype_event_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    event: String,
    token: String,
) -> Result<bool, String> {
    require(&app, &window, &event)?;
    let state = app.state::<Service>();
    let mut connections = state.0.lock().map_err(|error| error.to_string())?;
    let key = (window.label().into(), event);
    if connections
        .get(&key)
        .is_none_or(|connection| connection.token != token)
    {
        return Ok(false);
    }
    if let Some(connection) = connections.remove(&key) {
        app.unlisten(connection.listener);
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prototype_channels_are_explicit_per_role_and_cannot_subscribe_to_product_or_unknown_events()
    {
        for label in ["main", "probe-widget", "probe-pin", "probe-overlay"] {
            assert!(allowed(label, "tauri://drag-drop"));
            assert!(!allowed(label, "workspace:snapshot"));
            assert!(!allowed(label, "runtime:onClipboardChanged"));
            assert!(!allowed(label, "tauri://drag-enter"));
            assert!(!allowed(label, "unknown"));
        }
        for label in [
            "workspace-main",
            "workspace-widget-todo",
            "workspace-recovery",
            "foreign",
        ] {
            for event in [
                "prototype:captured",
                "prototype:workspace-changed",
                "tauri://drag-drop",
            ] {
                assert!(!allowed(label, event));
            }
        }
        assert!(allowed("main", "prototype:captured"));
        assert!(allowed("probe-pin", "prototype:captured"));
        assert!(!allowed("probe-widget", "prototype:captured"));
        assert!(allowed("probe-widget", "prototype:workspace-changed"));
        assert!(!allowed("probe-overlay", "prototype:workspace-changed"));
    }
}
