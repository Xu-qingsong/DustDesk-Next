use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{Manager, WebviewWindow};
use tokio::sync::{oneshot, watch};
use uuid::Uuid;

struct Reply {
    id: String,
    sender: Option<oneshot::Sender<bool>>,
}
struct Ticket {
    token: String,
    reply: Option<Reply>,
    cancelled: watch::Sender<bool>,
}
#[derive(Default)]
pub struct Service {
    tickets: Mutex<HashMap<String, Ticket>>,
}
impl Service {
    fn register(&self, label: &str) -> Option<String> {
        let mut tickets = self.tickets.lock().ok()?;
        if tickets.contains_key(label) {
            return None;
        }
        let token = Uuid::new_v4().to_string();
        tickets.insert(
            label.into(),
            Ticket {
                token: token.clone(),
                reply: None,
                cancelled: watch::channel(false).0,
            },
        );
        Some(token)
    }
    fn current(&self, label: &str, token: &str) -> bool {
        self.tickets.lock().is_ok_and(|tickets| {
            tickets
                .get(label)
                .is_some_and(|ticket| ticket.token == token)
        })
    }
    fn cancellation(&self, label: &str, token: &str) -> Option<watch::Receiver<bool>> {
        self.tickets
            .lock()
            .ok()?
            .get(label)
            .filter(|ticket| ticket.token == token)
            .map(|ticket| ticket.cancelled.subscribe())
    }
    fn begin(&self, label: &str, token: &str) -> Option<(String, oneshot::Receiver<bool>)> {
        let mut tickets = self.tickets.lock().ok()?;
        let ticket = tickets
            .get_mut(label)
            .filter(|ticket| ticket.token == token)?;
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        ticket.reply = Some(Reply {
            id: id.clone(),
            sender: Some(sender),
        });
        Some((id, receiver))
    }
    fn acknowledge(&self, label: &str, id: &str, ready: bool) -> bool {
        self.tickets
            .lock()
            .ok()
            .and_then(|mut tickets| {
                tickets
                    .get_mut(label)?
                    .reply
                    .as_mut()
                    .filter(|reply| reply.id == id)?
                    .sender
                    .take()
            })
            .is_some_and(|sender| sender.send(ready).is_ok())
    }
    fn finish(&self, label: &str, token: &str, id: &str) {
        if let Ok(mut tickets) = self.tickets.lock() {
            if let Some(ticket) = tickets.get_mut(label).filter(|ticket| {
                ticket.token == token && ticket.reply.as_ref().is_some_and(|reply| reply.id == id)
            }) {
                ticket.reply = None;
            }
        }
    }
    fn remove(&self, label: &str) -> Option<String> {
        self.tickets
            .lock()
            .ok()?
            .remove(label)?
            .reply
            .map(|reply| reply.id)
    }
}
fn delay() -> Duration {
    if cfg!(debug_assertions) && std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR").is_some() {
        if let Some(value) = std::env::var("DUSTDESK_TAURI_TEST_RELEASE_DELAY_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (25..=30000).contains(value))
        {
            return Duration::from_millis(value);
        }
    }
    Duration::from_secs(30)
}
pub fn cancel(app: &tauri::AppHandle, label: &str) {
    if let Some(id) = app.state::<Service>().remove(label) {
        let _ = crate::events::emit(app, label, "window:release-resume", id);
    }
}
pub fn schedule(app: &tauri::AppHandle, label: &str) {
    let Some(token) = app.state::<Service>().register(label) else {
        return;
    };
    let Some(mut cancelled) = app.state::<Service>().cancellation(label, &token) else {
        return;
    };
    let app = app.clone();
    let label = label.to_owned();
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                _ = tokio::time::sleep(delay()) => {},
                _ = cancelled.changed() => break,
            }
            if !app.state::<Service>().current(&label, &token)
                || attempt(&app, &label, &token).await
            {
                break;
            }
        }
    });
}
async fn attempt(app: &tauri::AppHandle, label: &str, token: &str) -> bool {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let starting = gate.lock().await;
    if !app.state::<Service>().current(label, token) {
        return true;
    }
    let Some(window) = app.get_webview_window(label) else {
        cancel(app, label);
        return true;
    };
    if window.is_visible().unwrap_or(true) || !eligible_window(app, &window) {
        cancel(app, label);
        return true;
    }
    if app
        .state::<crate::lifecycle::QuitState>()
        .require_interactive()
        .is_err()
        || native_busy(app, label)
    {
        return false;
    }
    if let Err(error) = checkpoint(app, &window).await {
        eprintln!("保留隐藏窗口，位置尚未保存：{error}");
        return false;
    }
    let Some((id, receiver)) = app.state::<Service>().begin(label, token) else {
        return true;
    };
    let sent = crate::events::emit(app, label, "window:release-check", id.clone()).is_ok();
    drop(starting);
    let ready = sent
        && tokio::time::timeout(Duration::from_secs(3), receiver)
            .await
            .ok()
            .and_then(Result::ok)
            == Some(true);
    let _finishing = gate.lock().await;
    let service = app.state::<Service>();
    let eligible = ready
        && service.current(label, token)
        && !native_busy(app, label)
        && app
            .state::<crate::lifecycle::QuitState>()
            .require_interactive()
            .is_ok()
        && eligible_window(app, &window)
        && !window.is_visible().unwrap_or(true);
    if eligible {
        if let Err(error) = checkpoint(app, &window).await {
            eprintln!("保留隐藏窗口，回收前位置保存失败：{error}");
        } else {
            if label == "workspace-main" {
                crate::main_window::destroying(app, true);
            }
            if label == crate::quick_capture::LABEL {
                crate::quick_capture::destroying(app, true);
            }
            if window.destroy().is_err() {
                if label == "workspace-main" {
                    crate::main_window::destroying(app, false);
                }
                if label == crate::quick_capture::LABEL {
                    crate::quick_capture::destroying(app, false);
                }
            } else {
                if label == "workspace-main" {
                    if let Err(error) = crate::main_window::wait_destroyed(app).await {
                        eprintln!("等待主窗口释放：{error}");
                    }
                }
                return true;
            }
        }
    }
    service.finish(label, token, &id);
    let _ = crate::events::emit(app, label, "window:release-resume", id);
    false
}
fn eligible_window(app: &tauri::AppHandle, window: &WebviewWindow) -> bool {
    crate::main_window::current(app, window)
        && (window.label() == "workspace-main"
            || window.label() == crate::quick_capture::LABEL
            || app
                .state::<crate::widgets::Service>()
                .key(window.label())
                .is_some())
}
fn native_busy(app: &tauri::AppHandle, label: &str) -> bool {
    app.state::<crate::path_menu::MenuService>().busy()
        || (label == "workspace-main"
            && (app.state::<crate::system::SystemService>().busy()
                || app.state::<crate::screenshot::Service>().busy()
                || app.state::<crate::screenshot_capture::Service>().busy()
                || app.state::<crate::release_updates::Service>().busy()
                || app.state::<crate::desktop::DesktopService>().busy()
                || app
                    .state::<crate::workspace::resource_api::ResourceService>()
                    .busy(label)))
}
async fn checkpoint(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "workspace-main" {
        crate::main_window::remember(app, window)
    } else if window.label() == crate::quick_capture::LABEL {
        Ok(())
    } else {
        crate::widgets::flush_window(app, window.label()).await
    }
}
#[tauri::command]
pub fn window_release_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    ready: bool,
) -> Result<bool, String> {
    crate::lifecycle::participant(&app, &window)?;
    if !crate::main_window::current(&app, &window) {
        return Ok(false);
    }
    Ok(app
        .state::<Service>()
        .acknowledge(window.label(), &request_id, ready))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn release_acknowledgements_are_bound_to_native_window_nonce_and_one_response() {
        let service = Service::default();
        let token = service.register("widget-a").unwrap();
        assert!(service.register("widget-a").is_none());
        let (id, mut receiver) = service.begin("widget-a", &token).unwrap();
        assert!(!service.acknowledge("widget-b", &id, true));
        assert!(!service.acknowledge("widget-a", "stale-id", true));
        assert!(receiver.try_recv().is_err());
        assert!(service.acknowledge("widget-a", &id, false));
        assert!(!receiver.try_recv().unwrap());
        assert!(!service.acknowledge("widget-a", &id, true));
    }
    #[test]
    fn showing_or_destroying_a_window_cancels_old_timers_and_inflight_replies() {
        let service = Service::default();
        let old = service.register("widget-a").unwrap();
        let cancelled = service.cancellation("widget-a", &old).unwrap();
        let (id, mut receiver) = service.begin("widget-a", &old).unwrap();
        assert_eq!(service.remove("widget-a"), Some(id.clone()));
        assert!(cancelled.has_changed().is_err());
        assert!(receiver.try_recv().is_err());
        let next = service.register("widget-a").unwrap();
        assert_ne!(next, old);
        assert!(!service.current("widget-a", &old));
        assert!(service.begin("widget-a", &old).is_none());
        assert!(!service.acknowledge("widget-a", &id, true));
        assert!(service.current("widget-a", &next));
    }
    #[test]
    fn retry_uses_a_fresh_nonce_and_old_completion_does_not_clear_the_next_request() {
        let service = Service::default();
        let token = service.register("widget-a").unwrap();
        let (old, _) = service.begin("widget-a", &token).unwrap();
        service.finish("widget-a", &token, &old);
        let (next, mut receiver) = service.begin("widget-a", &token).unwrap();
        service.finish("widget-a", &token, &old);
        assert!(!service.acknowledge("widget-a", &old, true));
        assert!(service.acknowledge("widget-a", &next, true));
        assert!(receiver.try_recv().unwrap());
    }
}
