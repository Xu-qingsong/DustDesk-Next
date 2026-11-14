use serde::Serialize;
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex};
use tauri::{ipc::Channel, Emitter, Manager, WebviewWindow};
use uuid::Uuid;

#[derive(Clone, Serialize)]
pub struct Packet {
    token: String,
    event: String,
    payload: Value,
}
#[derive(Clone)]
struct Connection {
    token: String,
    role: String,
    channel: Channel<Packet>,
}
#[derive(Default)]
pub struct Service {
    connections: Mutex<HashMap<String, Connection>>,
}
impl Service {
    pub(crate) fn connected(&self, label: &str, token: &str) -> bool {
        self.connections.lock().is_ok_and(|connections| {
            connections
                .get(label)
                .is_some_and(|connection| connection.token == token)
        })
    }
    pub(crate) fn attach(
        &self,
        label: &str,
        role: String,
        channel: Channel<Packet>,
    ) -> Result<String, String> {
        let token = Uuid::new_v4().to_string();
        self.connections
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                label.into(),
                Connection {
                    token: token.clone(),
                    role,
                    channel,
                },
            );
        Ok(token)
    }
    pub(crate) fn detach(&self, label: &str, token: &str) -> bool {
        self.connections.lock().is_ok_and(|mut connections| {
            if connections
                .get(label)
                .is_some_and(|connection| connection.token == token)
            {
                connections.remove(label);
                true
            } else {
                false
            }
        })
    }
    fn send(&self, label: &str, event: &str, payload: Value) -> Result<(), String> {
        let connection = self
            .connections
            .lock()
            .map_err(|error| error.to_string())?
            .get(label)
            .cloned()
            .ok_or("组件事件通道尚未就绪")?;
        let Some(payload) = scoped(&connection.role, event, payload)? else {
            return Ok(());
        };
        connection
            .channel
            .send(Packet {
                token: connection.token.clone(),
                event: event.into(),
                payload,
            })
            .map_err(|error| {
                self.detach(label, &connection.token);
                error.to_string()
            })
    }
    pub fn destroyed(&self, label: &str) {
        if let Ok(mut connections) = self.connections.lock() {
            connections.remove(label);
        }
    }
}
fn scoped(role: &str, event: &str, mut payload: Value) -> Result<Option<Value>, String> {
    if role == "screenshot-overlay" {
        return match event {
            "lifecycle:flush" | "lifecycle:resume" | "drafts:flush" | "drafts:resume" => {
                Ok(Some(payload))
            }
            _ => Err("截图检查点事件类型未授权".into()),
        };
    }
    if role == crate::quick_capture::LABEL {
        return match event {
            "lifecycle:flush"
            | "lifecycle:resume"
            | "drafts:flush"
            | "drafts:resume"
            | "window:release-check"
            | "window:release-resume"
            | "quick-capture:hide" => Ok(Some(payload)),
            _ => Err("快速记录事件类型未授权".into()),
        };
    }
    match event {
        "workspace:snapshot" => {
            let revision = payload["revision"].as_u64().ok_or("组件快照版本无效")?;
            let state = payload["state"].take();
            if !state.is_object() {
                return Err("组件快照状态无效".into());
            }
            payload = serde_json::to_value(crate::workspace::widgets::project(
                crate::workspace::Snapshot {
                    state,
                    revision,
                    path: String::new(),
                },
                role,
            ))
            .map_err(|error| error.to_string())?;
        }
        "runtime:onClipboardChanged" if role != "clipboard" => return Ok(None),
        "runtime:onWidgetVisibilityChanged" if payload[0] != role => return Ok(None),
        "lifecycle:flush"
        | "lifecycle:resume"
        | "drafts:flush"
        | "drafts:resume"
        | "window:release-check"
        | "window:release-resume"
        | "system:action-error"
        | "runtime:onWidgetAppearance"
        | "runtime:onWidgetVisibilityChanged"
        | "runtime:onClipboardChanged" => {}
        _ => return Err("组件事件类型未授权".into()),
    }
    Ok(Some(payload))
}
pub fn emit(
    app: &tauri::AppHandle,
    label: &str,
    event: &str,
    payload: impl Serialize + Clone,
) -> Result<(), String> {
    if label.starts_with("screenshot-pin-") {
        crate::screenshot_pins::emit(
            app,
            label,
            event,
            serde_json::to_value(payload).map_err(|error| error.to_string())?,
        )
    } else if label.starts_with("workspace-widget-")
        || label == crate::quick_capture::LABEL
        || label.starts_with("screenshot-overlay-")
    {
        app.state::<Service>().send(
            label,
            event,
            serde_json::to_value(payload).map_err(|error| error.to_string())?,
        )
    } else {
        app.emit_to(label, event, payload)
            .map_err(|error| error.to_string())
    }
}
#[tauri::command]
pub async fn widget_events_attach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    channel: Channel<Packet>,
) -> Result<String, String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    let role = crate::widgets::reader(&app, &window)?.ok_or("此窗口不使用组件事件通道")?;
    let token = app
        .state::<Service>()
        .attach(window.label(), role.clone(), channel)?;
    if app
        .state::<crate::widgets::Service>()
        .key(window.label())
        .as_ref()
        != Some(&role)
    {
        app.state::<Service>().detach(window.label(), &token);
        return Err("组件窗口已失效".into());
    }
    Ok(token)
}
#[tauri::command]
pub fn widget_events_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<bool, String> {
    crate::widgets::reader(&app, &window)?.ok_or("此窗口不使用组件事件通道")?;
    Ok(app.state::<Service>().detach(window.label(), &token))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Arc;
    #[test]
    fn screenshot_channel_only_receives_own_lifecycle_events() {
        for event in [
            "lifecycle:flush",
            "lifecycle:resume",
            "drafts:flush",
            "drafts:resume",
        ] {
            assert_eq!(
                scoped("screenshot-overlay", event, json!({"requestId":"own"})).unwrap(),
                Some(json!({"requestId":"own"}))
            );
        }
        for event in [
            "workspace:snapshot",
            "runtime:onClipboardChanged",
            "system:action-error",
            "window:release-check",
            "quick-capture:hide",
            "screenshot:editor",
            "unknown",
        ] {
            assert!(scoped("screenshot-overlay", event, json!({"private":"secret"})).is_err());
        }
    }
    #[test]
    fn quick_capture_channel_cannot_receive_workspace_or_clipboard_records() {
        for event in [
            "workspace:snapshot",
            "runtime:onClipboardChanged",
            "system:action-error",
            "runtime:onWidgetVisibilityChanged",
            "unknown",
        ] {
            assert!(scoped(
                crate::quick_capture::LABEL,
                event,
                json!({"private":"secret"})
            )
            .is_err());
        }
        for event in [
            "lifecycle:flush",
            "lifecycle:resume",
            "drafts:flush",
            "drafts:resume",
            "window:release-check",
            "window:release-resume",
            "quick-capture:hide",
        ] {
            assert_eq!(
                scoped(
                    crate::quick_capture::LABEL,
                    event,
                    json!({"requestId":"own"})
                )
                .unwrap(),
                Some(json!({"requestId":"own"}))
            );
        }
    }
    fn collector() -> (Channel<Packet>, Arc<Mutex<Vec<Value>>>) {
        let packets = Arc::new(Mutex::new(Vec::new()));
        let output = packets.clone();
        let channel = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(body) = body else {
                panic!("expected JSON event");
            };
            output
                .lock()
                .unwrap()
                .push(serde_json::from_str(&body).unwrap());
            Ok(())
        });
        (channel, packets)
    }
    #[test]
    fn event_scope_cannot_expand_a_widget_snapshot_even_if_a_native_producer_passes_the_full_workspace(
    ) {
        let service = Service::default();
        let (channel, packets) = collector();
        let token = service
            .attach("task-window", "todo".into(), channel)
            .unwrap();
        service.send("task-window", "workspace:snapshot", json!({"state":{"SchemaVersion":3,"Settings":{},"Todos":[{"Id":"task"}],"Notes":[{"Id":"private","Text":"secret"}],"UnknownPrivate":{"secret":"hidden"}},"revision":17,"path":"private-workspace"})).unwrap();
        let output = packets.lock().unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0]["token"], token);
        assert_eq!(output[0]["payload"]["revision"], 17);
        assert_eq!(
            output[0]["payload"]["state"]["Todos"],
            json!([{"Id":"task"}])
        );
        assert_eq!(output[0]["payload"]["state"]["Notes"], json!([]));
        assert_eq!(output[0]["payload"]["state"]["UnknownPrivate"], json!({}));
        assert_eq!(output[0]["payload"]["path"], "");
    }
    #[test]
    fn channels_are_native_window_owned_and_stale_or_foreign_detach_cannot_remove_a_replacement() {
        let service = Service::default();
        let (first, old_packets) = collector();
        let old = service.attach("window-a", "todo".into(), first).unwrap();
        let (next, packets) = collector();
        let token = service.attach("window-a", "todo".into(), next).unwrap();
        assert_ne!(token, old);
        assert!(!service.detach("window-b", &token));
        assert!(!service.detach("window-a", &old));
        service
            .send("window-a", "lifecycle:flush", json!({"requestId":"quit"}))
            .unwrap();
        assert!(old_packets.lock().unwrap().is_empty());
        assert_eq!(packets.lock().unwrap().len(), 1);
        assert!(service.detach("window-a", &token));
        assert!(service
            .send("window-a", "lifecycle:flush", json!({}))
            .is_err());
    }
    #[test]
    fn role_events_are_explicit_and_clipboard_records_and_other_widget_keys_are_not_broadcast() {
        let service = Service::default();
        let (task, task_packets) = collector();
        let (clipboard, clipboard_packets) = collector();
        service.attach("task-window", "todo".into(), task).unwrap();
        service
            .attach("clipboard-window", "clipboard".into(), clipboard)
            .unwrap();
        service
            .send(
                "task-window",
                "runtime:onClipboardChanged",
                json!([{"Id":"private"}]),
            )
            .unwrap();
        service
            .send(
                "task-window",
                "runtime:onWidgetVisibilityChanged",
                json!(["notes", true]),
            )
            .unwrap();
        assert!(task_packets.lock().unwrap().is_empty());
        service
            .send(
                "task-window",
                "runtime:onWidgetVisibilityChanged",
                json!(["todo", false]),
            )
            .unwrap();
        service
            .send(
                "clipboard-window",
                "runtime:onClipboardChanged",
                json!([{"Id":"record"}]),
            )
            .unwrap();
        assert_eq!(task_packets.lock().unwrap().len(), 1);
        assert_eq!(clipboard_packets.lock().unwrap().len(), 1);
        assert!(service
            .send("task-window", "resources:progress", json!({}))
            .is_err());
        assert!(service
            .send("task-window", "unregistered-event", json!({}))
            .is_err());
    }
    #[test]
    fn reconnecting_does_not_accumulate_native_channels_and_destroy_releases_the_last_connection() {
        let service = Service::default();
        for _ in 0..128 {
            let (channel, _) = collector();
            service
                .attach("same-window", "todo".into(), channel)
                .unwrap();
            assert_eq!(service.connections.lock().unwrap().len(), 1);
        }
        service.destroyed("same-window");
        assert!(service.connections.lock().unwrap().is_empty());
    }
}
