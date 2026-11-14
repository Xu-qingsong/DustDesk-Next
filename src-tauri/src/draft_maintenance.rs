use crate::lifecycle::QuitState;
use serde::Serialize;
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
use uuid::Uuid;

struct Session {
    id: String,
    participants: HashSet<String>,
    ready: bool,
    fingerprint: Option<String>,
    expires: Option<Instant>,
    cancelled: bool,
    pause: Option<crate::clipboard_monitor::Pause>,
    refresh: bool,
}
#[derive(Default)]
pub struct Service {
    session: Mutex<Option<Session>>,
    pub(crate) unresolved: AtomicBool,
}
impl Service {
    pub(crate) fn with_ready_decision<T>(
        &self,
        request: &str,
        action: impl FnOnce(Option<&str>) -> Result<T, String>,
    ) -> Result<T, String> {
        let slot = self.session.lock().map_err(|error| error.to_string())?;
        let fingerprint = slot
            .as_ref()
            .filter(|session| {
                session.id == request
                    && session.ready
                    && !session.cancelled
                    && session
                        .expires
                        .is_some_and(|expires| Instant::now() < expires)
            })
            .and_then(|session| session.fingerprint.as_deref());
        action(fingerprint)
    }
    pub fn ready_fingerprint(&self, request: &str) -> Result<String, String> {
        let slot = self.session.lock().map_err(|error| error.to_string())?;
        let session = slot
            .as_ref()
            .filter(|session| session.id == request && session.ready && !session.cancelled)
            .ok_or("迁移维护检查点已失效")?;
        if session
            .expires
            .is_none_or(|expires| Instant::now() >= expires)
        {
            return Err("迁移维护检查点已过期".into());
        }
        session
            .fingerprint
            .clone()
            .ok_or("迁移维护检查点尚未封存".into())
    }
    pub fn active(&self, request: &str) -> bool {
        self.session.lock().is_ok_and(|session| {
            session
                .as_ref()
                .is_some_and(|session| session.id == request && !session.cancelled)
        })
    }
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub(crate) request_id: String,
    pub(crate) workspace_fingerprint: String,
    lease_milliseconds: u64,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Flush {
    request_id: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Resume {
    request_id: String,
    error: String,
    reload: bool,
}
fn ready_lease() -> Duration {
    if cfg!(debug_assertions) && std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR").is_some() {
        if let Some(value) = std::env::var("DUSTDESK_TAURI_TEST_DRAFT_LEASE_MS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .filter(|value| (1000..=120000).contains(value))
        {
            return Duration::from_millis(value);
        }
    }
    Duration::from_secs(120)
}
fn finish(app: &tauri::AppHandle, request: &str, error: &str) -> bool {
    finish_with_reload(app, request, error, false)
}

fn finish_with_reload(app: &tauri::AppHandle, request: &str, error: &str, recovered: bool) -> bool {
    let service = app.state::<Service>();
    if service.unresolved.load(Ordering::SeqCst) {
        return false;
    }
    let session = service.session.lock().ok().and_then(|mut slot| {
        if slot.as_ref().is_some_and(|session| session.id == request) {
            slot.take()
        } else {
            None
        }
    });
    let Some(session) = session else {
        return false;
    };
    let released = app.state::<QuitState>().end_maintenance(request);
    drop(session.pause);
    if released {
        app.state::<crate::lan_host::Service>().restore();
        if recovered && session.refresh {
            crate::screenshot_capture::preserve_on_draft_refresh(app, request);
        }
        crate::screenshot_capture::release_checkpoints(app, request);
        for label in session.participants {
            let _ = crate::events::emit(
                app,
                &label,
                "drafts:resume",
                Resume {
                    request_id: request.into(),
                    error: error.into(),
                    reload: recovered
                        && session.refresh
                        && !label.starts_with("screenshot-overlay-"),
                },
            );
        }
        crate::widgets::resume(app);
    }
    released
}

pub(crate) fn recovered(app: &tauri::AppHandle, request: &str) {
    finish_with_reload(app, request, "", true);
}

#[tauri::command]
pub async fn drafts_prepare(
    app: tauri::AppHandle,
    window: WebviewWindow,
    refresh: Option<bool>,
) -> Result<Checkpoint, String> {
    crate::workspace::api::require_workspace(&window)?;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let starting = gate.lock().await;
    if app.state::<Service>().unresolved.load(Ordering::SeqCst) {
        return Err("原生草稿事务尚未恢复，不能开始另一维护请求".into());
    }
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    app.state::<QuitState>().require_interactive()?;
    crate::platform::legacy_processes::require_stopped()?;
    let captures = crate::screenshot_capture::checkpoint_participants(&app)?;
    let mut participants: HashSet<String> = app
        .state::<crate::widgets::Service>()
        .labels()
        .into_iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .collect();
    participants.insert(window.label().into());
    participants.extend(captures);
    if app
        .get_webview_window(crate::quick_capture::LABEL)
        .is_some()
    {
        participants.insert(crate::quick_capture::LABEL.into());
    }
    let id = Uuid::new_v4().to_string();
    let receiver = app
        .state::<QuitState>()
        .begin_maintenance(id.clone(), participants.clone())?;
    let registered = app
        .state::<Service>()
        .session
        .lock()
        .map(|mut slot| {
            if slot.is_some() {
                return false;
            }
            *slot = Some(Session {
                id: id.clone(),
                participants: participants.clone(),
                ready: false,
                fingerprint: None,
                expires: None,
                cancelled: false,
                pause: None,
                refresh: refresh.unwrap_or(false),
            });
            true
        })
        .unwrap_or(false);
    if !registered {
        app.state::<QuitState>().end_maintenance(&id);
        return Err("迁移维护服务不可用".into());
    }
    let mut pause = Some(crate::clipboard_monitor::pause_for_quit(&app));
    app.state::<crate::system::SystemService>().cancel_picker();
    app.state::<crate::file_drop::Service>().cancel_pending();
    app.state::<crate::screenshot::Service>().cancel_pending();
    app.state::<crate::toolbox::image_store::Service>()
        .cancel_batches();
    app.state::<crate::release_updates::Service>().cancel();
    app.state::<crate::path_menu::MenuService>().cancel();
    app.state::<crate::file_search::SearchService>().release();
    app.state::<crate::workspace::resource_api::ResourceService>()
        .cancel_all();
    drop(starting);
    let preparing = async {
        app.state::<crate::lan_host::Service>().suspend().await?;
        for label in &participants {
            crate::events::emit(
                &app,
                label,
                "drafts:flush",
                Flush {
                    request_id: id.clone(),
                },
            )?;
        }
        tauri::async_runtime::spawn_blocking(move || {
            receiver.recv_timeout(Duration::from_secs(15))
        })
        .await
        .map_err(|error| error.to_string())?
        .map_err(|_| "等待所有窗口保存超时，已取消迁移维护".to_string())??;
        if !app.state::<Service>().active(&id) {
            return Err("迁移维护参与窗口已关闭".into());
        }
        crate::widgets::flush_layout(&app).await?;
        pause
            .as_mut()
            .ok_or("剪贴板维护状态失效")?
            .drain(&app)
            .await?;
        let _sealing = gate.lock().await;
        crate::screenshot_capture::verify_checkpoints(&app, &participants, &id, true)?;
        if !crate::main_window::current(&app, &window) || !app.state::<Service>().active(&id) {
            return Err("迁移维护参与窗口已关闭".into());
        }
        let fingerprint =
            crate::workspace::commands::seal_draft_checkpoint(app.clone(), id.clone()).await?;
        let service = app.state::<Service>();
        let mut slot = service.session.lock().map_err(|error| error.to_string())?;
        let session = slot
            .as_mut()
            .filter(|session| session.id == id && !session.cancelled)
            .ok_or("迁移维护请求已失效")?;
        session.ready = true;
        session.fingerprint = Some(fingerprint.clone());
        session.expires = Some(Instant::now() + ready_lease());
        session.pause = pause.take();
        Ok::<String, String>(fingerprint)
    };
    let result = tokio::time::timeout(Duration::from_secs(35), preparing)
        .await
        .map_err(|_| "迁移维护准备超时，未允许切换".to_string())
        .and_then(|result| result);
    match result {
        Ok(workspace_fingerprint) => {
            let lease = ready_lease();
            let handle = app.clone();
            let request = id.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(lease).await;
                let gate = handle.state::<crate::widgets::Service>().gate.clone();
                let _guard = gate.lock().await;
                finish(
                    &handle,
                    &request,
                    "迁移维护租约已到期，请重新准备；尚未允许切换",
                );
            });
            let handle = app.clone();
            let request = id.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    if !handle.state::<Service>().active(&request) {
                        return;
                    }
                    if let Err(error) = crate::platform::legacy_processes::require_stopped() {
                        let gate = handle.state::<crate::widgets::Service>().gate.clone();
                        let _guard = gate.lock().await;
                        finish(&handle, &request, &error);
                        return;
                    }
                }
            });
            Ok(Checkpoint {
                request_id: id,
                workspace_fingerprint,
                lease_milliseconds: lease.as_millis() as u64,
            })
        }
        Err(error) => {
            drop(pause);
            let _guard = gate.lock().await;
            finish(&app, &id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn drafts_verify(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    serialized: String,
) -> Result<crate::workspace::draft_lineage::Provenance, String> {
    crate::workspace::api::require_workspace(&window)?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let result =
        crate::workspace::commands::verify_draft_provenance(app.clone(), request_id, serialized)
            .await?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    Ok(result)
}

#[tauri::command]
pub async fn drafts_transaction(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: Option<String>,
    serialized: Option<String>,
    journal_sha256: Option<String>,
    transaction_id: Option<String>,
    commit: Option<bool>,
) -> Result<Option<crate::workspace::draft_transaction::Status>, String> {
    crate::workspace::api::require_workspace(&window)?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let result = crate::workspace::commands::draft_transaction(
        window.clone(),
        request_id,
        serialized,
        journal_sha256,
        transaction_id,
        commit,
    )
    .await?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效；原生事务记录仍保留，未解除恢复屏障".into());
    }
    Ok(result)
}

#[tauri::command]
pub fn drafts_checkpoint_ready(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    error: Option<String>,
) -> Result<(), String> {
    crate::lifecycle::participant(&app, &window)?;
    if !crate::main_window::current(&app, &window) || !app.state::<Service>().active(&request_id) {
        return Err("迁移维护响应已失效".into());
    }
    app.state::<QuitState>()
        .acknowledge_maintenance(window.label(), &request_id, error)
}

#[tauri::command]
pub async fn drafts_end(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<bool, String> {
    crate::workspace::api::require_workspace(&window)?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let ready = app
        .state::<Service>()
        .session
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .is_some_and(|session| session.id == request_id && session.ready);
    if !ready {
        return Ok(false);
    }
    Ok(finish(&app, &request_id, ""))
}

pub fn participant_lost(app: &tauri::AppHandle, label: &str) {
    let request = app
        .state::<Service>()
        .session
        .lock()
        .ok()
        .and_then(|mut slot| {
            let session = slot
                .as_mut()
                .filter(|session| session.participants.contains(label))?;
            session.cancelled = true;
            Some((session.id.clone(), session.ready))
        });
    if let Some((request, ready)) = request {
        if ready {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let gate = app.state::<crate::widgets::Service>().gate.clone();
                let _guard = gate.lock().await;
                finish(&app, &request, "迁移维护参与窗口已关闭，未允许切换");
            });
        } else {
            app.state::<QuitState>()
                .cancel_maintenance_flush(&request, "迁移维护参与窗口已关闭".into());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready_service() -> Service {
        Service {
            unresolved: AtomicBool::new(false),
            session: Mutex::new(Some(Session {
                id: "current".into(),
                participants: HashSet::new(),
                ready: true,
                fingerprint: Some("a".repeat(64)),
                expires: Some(Instant::now() + Duration::from_secs(10)),
                cancelled: false,
                pause: None,
                refresh: false,
            })),
        }
    }

    #[test]
    fn native_fingerprint_is_available_only_for_the_current_ready_request() {
        let service = ready_service();
        assert_eq!(
            service.ready_fingerprint("current").unwrap(),
            "a".repeat(64)
        );
        assert!(service.ready_fingerprint("old").is_err());
        service.session.lock().unwrap().as_mut().unwrap().ready = false;
        assert!(service.ready_fingerprint("current").is_err());
        service.session.lock().unwrap().as_mut().unwrap().ready = true;
        service.session.lock().unwrap().as_mut().unwrap().cancelled = true;
        assert!(service.ready_fingerprint("current").is_err());
    }

    #[test]
    fn deadline_is_authoritative_even_before_the_background_timer_releases_the_session() {
        let service = ready_service();
        service.session.lock().unwrap().as_mut().unwrap().expires =
            Some(Instant::now() - Duration::from_millis(1));
        assert!(service.active("current"));
        assert!(service
            .ready_fingerprint("current")
            .unwrap_err()
            .contains("过期"));
        service.session.lock().unwrap().as_mut().unwrap().expires = None;
        assert!(service.ready_fingerprint("current").is_err());
    }

    #[test]
    fn decision_boundary_has_no_fingerprint_after_expiry_cancellation_or_wrong_request() {
        let service = ready_service();
        assert!(service
            .with_ready_decision("current", |fingerprint| Ok(fingerprint.is_some()))
            .unwrap());
        assert!(!service
            .with_ready_decision("old", |fingerprint| Ok(fingerprint.is_some()))
            .unwrap());
        service.session.lock().unwrap().as_mut().unwrap().cancelled = true;
        assert!(!service
            .with_ready_decision("current", |fingerprint| Ok(fingerprint.is_some()))
            .unwrap());
        service.session.lock().unwrap().as_mut().unwrap().cancelled = false;
        service.session.lock().unwrap().as_mut().unwrap().expires =
            Some(Instant::now() - Duration::from_millis(1));
        assert!(!service
            .with_ready_decision("current", |fingerprint| Ok(fingerprint.is_some()))
            .unwrap());
    }

    #[test]
    fn decision_publication_holds_the_session_lock_against_concurrent_cancellation() {
        let service = std::sync::Arc::new(ready_service());
        let (started, entered) = std::sync::mpsc::channel();
        let (resume, resumed) = std::sync::mpsc::channel();
        let worker = service.clone();
        let thread = std::thread::spawn(move || {
            worker
                .with_ready_decision("current", |fingerprint| {
                    assert!(fingerprint.is_some());
                    started.send(()).unwrap();
                    resumed.recv_timeout(Duration::from_secs(5)).unwrap();
                    Ok(())
                })
                .unwrap()
        });
        entered.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(service.session.try_lock().is_err());
        resume.send(()).unwrap();
        thread.join().unwrap();
        assert!(service.session.try_lock().is_ok());
    }
}
