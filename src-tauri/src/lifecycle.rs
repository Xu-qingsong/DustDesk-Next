use serde::Serialize;
use std::collections::HashSet;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{Manager, WebviewWindow};
use uuid::Uuid;

#[derive(Default)]
enum Phase {
    #[default]
    Editing,
    Flushing {
        id: String,
        maintenance: bool,
        sender: Option<mpsc::Sender<Result<(), String>>>,
        pending: HashSet<String>,
        saved: bool,
    },
    Committing,
    DraftReady {
        id: String,
    },
}

#[derive(Default)]
pub struct QuitState {
    phase: Mutex<Phase>,
}

impl QuitState {
    pub fn require_interactive(&self) -> Result<(), String> {
        if !matches!(
            *self.phase.lock().map_err(|error| error.to_string())?,
            Phase::Editing
        ) {
            return Err("正在退出或迁移维护，不能开始新的系统操作".into());
        }
        Ok(())
    }
    pub fn require_writable(&self) -> Result<(), String> {
        if matches!(
            *self.phase.lock().map_err(|error| error.to_string())?,
            Phase::Committing | Phase::DraftReady { .. }
        ) {
            return Err("正在退出或迁移维护，不能接受新保存".into());
        }
        Ok(())
    }

    pub fn committing(&self) -> bool {
        self.phase
            .lock()
            .is_ok_and(|phase| matches!(*phase, Phase::Committing))
    }

    #[cfg(test)]
    fn begin(&self, id: String) -> Result<mpsc::Receiver<Result<(), String>>, String> {
        self.begin_for(id, HashSet::from(["workspace-main".into()]))
    }

    fn begin_for(
        &self,
        id: String,
        pending: HashSet<String>,
    ) -> Result<mpsc::Receiver<Result<(), String>>, String> {
        self.begin_flushing(id, pending, false)
    }
    pub(crate) fn begin_maintenance(
        &self,
        id: String,
        pending: HashSet<String>,
    ) -> Result<mpsc::Receiver<Result<(), String>>, String> {
        self.begin_flushing(id, pending, true)
    }
    fn begin_flushing(
        &self,
        id: String,
        pending: HashSet<String>,
        maintenance: bool,
    ) -> Result<mpsc::Receiver<Result<(), String>>, String> {
        let mut phase = self.phase.lock().map_err(|error| error.to_string())?;
        if !matches!(*phase, Phase::Editing) {
            return Err("已有退出或迁移维护请求正在处理".into());
        }
        let (sender, receiver) = mpsc::channel();
        *phase = Phase::Flushing {
            id,
            maintenance,
            sender: Some(sender),
            pending,
            saved: false,
        };
        Ok(receiver)
    }

    #[cfg(test)]
    fn acknowledge(&self, request: &str, error: Option<String>) -> Result<(), String> {
        self.acknowledge_from("workspace-main", request, error)
    }

    fn acknowledge_from(
        &self,
        label: &str,
        request: &str,
        error: Option<String>,
    ) -> Result<(), String> {
        self.acknowledge_flushing(label, request, error, false)
    }
    pub(crate) fn acknowledge_maintenance(
        &self,
        label: &str,
        request: &str,
        error: Option<String>,
    ) -> Result<(), String> {
        self.acknowledge_flushing(label, request, error, true)
    }
    pub(crate) fn acknowledge_capture(
        &self,
        label: &str,
        request: &str,
        error: Option<String>,
        maintenance: bool,
    ) -> Result<(), String> {
        self.acknowledge_flushing(label, request, error, maintenance)
    }
    fn acknowledge_flushing(
        &self,
        label: &str,
        request: &str,
        error: Option<String>,
        expected_maintenance: bool,
    ) -> Result<(), String> {
        let mut phase = self.phase.lock().map_err(|error| error.to_string())?;
        let Phase::Flushing {
            id,
            maintenance,
            sender,
            pending,
            saved,
        } = &mut *phase
        else {
            return Err("退出请求已失效".into());
        };
        if id != request || *maintenance != expected_maintenance {
            return Err("退出请求已失效".into());
        }
        if sender.is_none() || !pending.remove(label) {
            return Err("退出响应已处理或窗口未参与".into());
        }
        if error.is_none() && !pending.is_empty() {
            return Ok(());
        }
        *saved = error.is_none();
        sender
            .take()
            .ok_or("退出响应已处理")?
            .send(error.map_or(Ok(()), Err))
            .map_err(|error| error.to_string())
    }
    pub(crate) fn seal_maintenance(&self, request: &str) -> Result<(), String> {
        let mut phase = self.phase.lock().map_err(|error| error.to_string())?;
        if !matches!(&*phase, Phase::Flushing { id, maintenance: true, sender: None, pending, saved: true } if id == request && pending.is_empty())
        {
            return Err("迁移维护保存尚未完成或请求已失效".into());
        }
        *phase = Phase::DraftReady { id: request.into() };
        Ok(())
    }
    pub(crate) fn end_maintenance(&self, request: &str) -> bool {
        self.phase.lock().is_ok_and(|mut phase| {
            if matches!(&*phase, Phase::Flushing { id, maintenance: true, .. } | Phase::DraftReady { id } if id == request) {
                *phase = Phase::Editing;
                true
            } else { false }
        })
    }
    pub(crate) fn cancel_maintenance_flush(&self, request: &str, error: String) {
        if let Ok(mut phase) = self.phase.lock() {
            if let Phase::Flushing {
                id,
                maintenance: true,
                sender,
                ..
            } = &mut *phase
            {
                if id == request {
                    if let Some(sender) = sender.take() {
                        let _ = sender.send(Err(error));
                    }
                }
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct QuitRequest {
    request_id: String,
}

#[derive(Debug, PartialEq)]
enum OrganizerChoice {
    Restore,
    Keep,
    Cancel,
}

async fn organizer_choice(app: &tauri::AppHandle) -> Result<OrganizerChoice, String> {
    #[cfg(windows)]
    {
        let owner = app
            .get_webview_window("workspace-main")
            .filter(|window| window.is_visible().unwrap_or(false))
            .and_then(|window| window.hwnd().ok())
            .map(|handle| handle.0 as usize);
        tauri::async_runtime::spawn_blocking(move || {
            use windows::{core::w, Win32::{Foundation::HWND, UI::WindowsAndMessaging::{MessageBoxW, IDYES, IDNO, MB_YESNOCANCEL, MB_ICONQUESTION, MB_DEFBUTTON3, MB_SETFOREGROUND}}};
            let response = unsafe { MessageBoxW(owner.map(|handle| HWND(handle as *mut std::ffi::c_void)), w!("退出前，是否将已收纳的文件和文件夹恢复到桌面？\n\n选择“是”：恢复并退出，下次启动按原分类重新收纳。\n选择“否”：保留收纳并退出，文件继续保存在收纳分类中。\n选择“取消”：返回应用。"), w!("退出 DustDesk"), MB_YESNOCANCEL | MB_ICONQUESTION | MB_DEFBUTTON3 | MB_SETFOREGROUND) };
            if response.0 == 0 { return Err("无法显示退出确认，已取消退出".to_string()); }
            Ok(if response == IDYES { OrganizerChoice::Restore } else if response == IDNO { OrganizerChoice::Keep } else { OrganizerChoice::Cancel })
        }).await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("当前平台尚未实现桌面收纳退出确认".into())
    }
}

pub async fn request(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<QuitState>();
    let id = Uuid::new_v4().to_string();
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let starting = gate.lock().await;
    let startup = app.state::<crate::draft_startup::Service>();
    if startup.require_ready().is_err() {
        state.require_interactive()?;
        if startup.begin_failed_quit() {
            *state.phase.lock().map_err(|error| error.to_string())? = Phase::Committing;
            crate::clipboard_monitor::stop(&app);
            app.exit(0);
            return Ok(());
        }
        startup.require_ready()?;
    }
    let captures = crate::screenshot_capture::checkpoint_participants(&app)?;
    let mut participants: HashSet<String> = app
        .state::<crate::widgets::Service>()
        .labels()
        .into_iter()
        .filter(|label| app.get_webview_window(label).is_some())
        .collect();
    if app.get_webview_window("workspace-main").is_some() {
        participants.insert("workspace-main".into());
    }
    if app
        .get_webview_window(crate::quick_capture::LABEL)
        .is_some()
    {
        participants.insert(crate::quick_capture::LABEL.into());
    }
    participants.extend(captures);
    let receiver = state.begin_for(id.clone(), participants.clone())?;
    drop(starting);
    let mut clipboard_pause = crate::clipboard_monitor::pause_for_quit(&app);
    app.state::<crate::system::SystemService>().cancel_picker();
    app.state::<crate::file_drop::Service>().cancel_pending();
    app.state::<crate::screenshot::Service>().cancel_pending();
    app.state::<crate::toolbox::image_store::Service>()
        .cancel_batches();
    app.state::<crate::release_updates::Service>().cancel();
    app.state::<crate::path_menu::MenuService>().cancel();
    app.state::<crate::file_search::SearchService>().release();
    let outcome = async {
        app.state::<crate::lan_host::Service>().suspend().await?;
        if !participants.is_empty() {
            for label in &participants {
                crate::events::emit(
                    &app,
                    label,
                    "lifecycle:flush",
                    QuitRequest {
                        request_id: id.clone(),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            tauri::async_runtime::spawn_blocking(move || {
                receiver.recv_timeout(Duration::from_secs(15))
            })
            .await
            .map_err(|error| error.to_string())?
            .map_err(|_| "等待所有窗口保存超时，已取消退出".to_string())??;
        }
        crate::widgets::flush_layout(&app).await?;
        clipboard_pause.drain(&app).await?;
        crate::screenshot_capture::verify_checkpoints(&app, &participants, &id, false)?;
        *state.phase.lock().map_err(|error| error.to_string())? = Phase::Committing;
        app.state::<crate::workspace::resource_api::ResourceService>()
            .cancel_all();
        if crate::workspace::commands::organizer_quit(app.clone(), None).await? {
            match organizer_choice(&app).await? {
                OrganizerChoice::Restore => {
                    crate::workspace::commands::organizer_quit(app.clone(), Some(true)).await?;
                }
                OrganizerChoice::Keep => {}
                OrganizerChoice::Cancel => return Err("退出已取消".into()),
            }
        }
        crate::workspace::commands::drain(app.clone()).await?;
        crate::screenshot_capture::verify_checkpoints(&app, &participants, &id, false)?;
        Ok::<(), String>(())
    }
    .await;
    if let Err(error) = outcome {
        let recovery = if state.committing() {
            crate::workspace::commands::organizer_quit(app.clone(), Some(false))
                .await
                .err()
        } else {
            None
        };
        let error = recovery.map_or(error.clone(), |recovery| {
            format!("{error}；恢复收纳尚未完成：{recovery}")
        });
        *state.phase.lock().map_err(|failure| failure.to_string())? = Phase::Editing;
        app.state::<crate::lan_host::Service>().restore();
        crate::screenshot_capture::release_checkpoints(&app, &id);
        for label in &participants {
            if label.starts_with("screenshot-overlay-") {
                let _ = crate::events::emit(
                    &app,
                    label,
                    "lifecycle:resume",
                    serde_json::json!({"requestId":id,"error":error}),
                );
            } else {
                let _ = crate::events::emit(&app, label, "lifecycle:resume", error.clone());
            }
        }
        crate::widgets::resume(&app);
        if let Some(window) = app.get_webview_window("workspace-main") {
            let _ = window.show();
        }
        return Err(error);
    }
    crate::clipboard_monitor::stop(&app);
    app.exit(0);
    Ok(())
}

pub fn request_from_native(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = request(handle).await {
            eprintln!("退出取消：{error}");
        }
    });
}

#[tauri::command]
pub async fn application_quit(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    crate::workspace::api::require_workspace(&window)?;
    request(app).await
}

#[tauri::command]
pub fn application_flushed(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    error: Option<String>,
) -> Result<(), String> {
    participant(&app, &window)?;
    app.state::<QuitState>()
        .acknowledge_from(window.label(), &request_id, error)
}

pub(crate) fn participant(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if window.label() == crate::quick_capture::LABEL {
        crate::quick_capture::require(app, window)
    } else {
        crate::widgets::reader(app, window)?;
        if !crate::main_window::current(app, window) {
            return Err("参与窗口已失效".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maintenance_acknowledgements_are_purpose_bound_and_all_participants_must_save() {
        let state = QuitState::default();
        let receiver = state
            .begin_maintenance(
                "draft".into(),
                HashSet::from(["workspace-main".into(), "widget-note".into()]),
            )
            .unwrap();
        assert!(state.require_interactive().is_err());
        assert!(state.require_writable().is_ok());
        assert!(!state.committing());
        assert!(state.begin("quit".into()).is_err());
        assert!(state
            .acknowledge_from("workspace-main", "draft", None)
            .is_err());
        assert!(state
            .acknowledge_maintenance("foreign", "draft", None)
            .is_err());
        assert!(state
            .acknowledge_maintenance("workspace-main", "old", None)
            .is_err());
        assert!(state.seal_maintenance("draft").is_err());
        state
            .acknowledge_maintenance("workspace-main", "draft", None)
            .unwrap();
        assert!(state.seal_maintenance("draft").is_err());
        assert!(state
            .acknowledge_maintenance("workspace-main", "draft", None)
            .is_err());
        state
            .acknowledge_maintenance("widget-note", "draft", None)
            .unwrap();
        assert_eq!(receiver.recv().unwrap(), Ok(()));
        assert!(state.seal_maintenance("old").is_err());
        state.seal_maintenance("draft").unwrap();
        assert!(state.require_writable().is_err());
        assert!(state.require_interactive().is_err());
        assert!(!state.committing());
        assert!(!state.end_maintenance("old"));
        assert!(state.end_maintenance("draft"));
        assert!(!state.end_maintenance("draft"));
        assert!(state.require_interactive().is_ok());
        assert!(state.require_writable().is_ok());
    }

    #[test]
    fn failed_last_save_cannot_seal_even_when_pending_set_is_empty() {
        let state = QuitState::default();
        let receiver = state
            .begin_maintenance("draft".into(), HashSet::from(["workspace-main".into()]))
            .unwrap();
        state
            .acknowledge_maintenance("workspace-main", "draft", Some("disk full".into()))
            .unwrap();
        assert_eq!(receiver.recv().unwrap(), Err("disk full".into()));
        assert!(state.seal_maintenance("draft").is_err());
        assert!(state.end_maintenance("draft"));
    }

    #[test]
    fn cancellation_is_request_scoped_and_never_resets_quit_or_a_new_maintenance() {
        let state = QuitState::default();
        let first = state
            .begin_maintenance("first".into(), HashSet::from(["widget-note".into()]))
            .unwrap();
        state.cancel_maintenance_flush("old", "old failure".into());
        assert!(first.try_recv().is_err());
        state.cancel_maintenance_flush("first", "window closed".into());
        assert_eq!(first.recv().unwrap(), Err("window closed".into()));
        assert!(state.end_maintenance("first"));
        let second = state
            .begin_maintenance("second".into(), HashSet::from(["widget-note".into()]))
            .unwrap();
        assert!(!state.end_maintenance("first"));
        state.cancel_maintenance_flush("first", "late failure".into());
        assert!(second.try_recv().is_err());
        assert!(state
            .acknowledge_maintenance("widget-note", "first", None)
            .is_err());
        state
            .acknowledge_maintenance("widget-note", "second", None)
            .unwrap();
        assert_eq!(second.recv().unwrap(), Ok(()));
        state.seal_maintenance("second").unwrap();
        assert!(state.end_maintenance("second"));
        let quit = state.begin("first".into()).unwrap();
        assert!(!state.end_maintenance("first"));
        state.cancel_maintenance_flush("first", "must not cancel quit".into());
        assert!(quit.try_recv().is_err());
        assert!(state.seal_maintenance("first").is_err());
        assert!(state
            .acknowledge_maintenance("workspace-main", "first", None)
            .is_err());
        state.acknowledge("first", None).unwrap();
        assert_eq!(quit.recv().unwrap(), Ok(()));
        *state.phase.lock().unwrap() = Phase::Committing;
        assert!(!state.end_maintenance("first"));
        assert!(state.committing());
    }

    #[test]
    fn all_window_quit_requires_unique_matching_acknowledgements_and_rejects_foreign_callers() {
        let state = QuitState::default();
        let receiver = state
            .begin_for(
                "all".into(),
                HashSet::from(["workspace-main".into(), "widget-note".into()]),
            )
            .unwrap();
        assert!(state.acknowledge_from("foreign", "all", None).is_err());
        assert!(state.acknowledge_from("widget-note", "old", None).is_err());
        state
            .acknowledge_from("workspace-main", "all", None)
            .unwrap();
        assert!(receiver.try_recv().is_err());
        assert!(state
            .acknowledge_from("workspace-main", "all", None)
            .is_err());
        state.acknowledge_from("widget-note", "all", None).unwrap();
        assert_eq!(receiver.recv().unwrap(), Ok(()));
        assert!(state.acknowledge_from("widget-note", "all", None).is_err());
    }

    #[test]
    fn any_widget_save_failure_vetoes_quit_even_after_main_acknowledged() {
        let state = QuitState::default();
        let receiver = state
            .begin_for(
                "all".into(),
                HashSet::from([
                    "workspace-main".into(),
                    "widget-note".into(),
                    "widget-other".into(),
                ]),
            )
            .unwrap();
        state
            .acknowledge_from("workspace-main", "all", None)
            .unwrap();
        state
            .acknowledge_from("widget-note", "all", Some("draft disk failure".into()))
            .unwrap();
        assert_eq!(receiver.recv().unwrap(), Err("draft disk failure".into()));
        assert!(state.acknowledge_from("widget-other", "all", None).is_err());
    }

    #[test]
    fn quit_acknowledgements_are_single_use_and_bound_to_the_request() {
        let state = QuitState::default();
        let receiver = state.begin("first".into()).unwrap();
        assert!(state.begin("second".into()).is_err());
        assert!(state.acknowledge("wrong", None).is_err());
        assert!(state.require_writable().is_ok());
        assert!(state.require_interactive().is_err());
        state
            .acknowledge("first", Some("disk full".into()))
            .unwrap();
        assert!(state.acknowledge("first", None).is_err());
        assert_eq!(receiver.recv().unwrap(), Err("disk full".into()));
        *state.phase.lock().unwrap() = Phase::Committing;
        assert!(state.require_writable().is_err());
        assert!(state.committing());
        *state.phase.lock().unwrap() = Phase::Editing;
        assert!(state.require_writable().is_ok());
        assert!(state.require_interactive().is_ok());
        assert!(state.begin("retry".into()).is_ok());
    }
}
