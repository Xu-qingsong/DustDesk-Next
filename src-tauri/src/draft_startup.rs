use std::{path::Path, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::watch;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq)]
enum Phase {
    Ready,
    Running(String),
    Finishing(String),
    Quitting,
    Failed(String),
}

pub struct Service {
    phase: watch::Sender<Phase>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            phase: watch::channel(Phase::Ready).0,
        }
    }
}
impl Service {
    fn begin(&self) -> Result<String, String> {
        let mut token = None;
        self.phase.send_modify(|phase| {
            if matches!(phase, Phase::Ready | Phase::Failed(_)) {
                let id = Uuid::new_v4().to_string();
                *phase = Phase::Running(id.clone());
                token = Some(id);
            }
        });
        token.ok_or("启动草稿恢复已在进行".into())
    }
    fn finish(&self, token: &str, error: Option<String>) -> bool {
        let diagnostic = error
            .as_ref()
            .map(|error| error.chars().take(2048).collect::<String>());
        let mut accepted = false;
        self.phase.send_modify(|phase| {
            if matches!(phase, Phase::Running(id) | Phase::Finishing(id) if id == token) {
                *phase = error.map_or(Phase::Ready, Phase::Failed);
                accepted = true;
            }
        });
        if accepted {
            if let Some(diagnostic) = diagnostic {
                eprintln!("启动草稿恢复失败，后台服务保持停止：{diagnostic}");
            }
        }
        accepted
    }
    fn verified(&self, token: &str) -> bool {
        let mut accepted = false;
        self.phase.send_modify(|phase| {
            if matches!(phase, Phase::Running(id) if id == token) {
                *phase = Phase::Finishing(token.into());
                accepted = true;
            }
        });
        accepted
    }
    fn interrupted(&self, token: &str, error: String) -> bool {
        let diagnostic = error.chars().take(2048).collect::<String>();
        let mut accepted = false;
        self.phase.send_modify(|phase| {
            if matches!(phase, Phase::Running(id) if id == token) {
                *phase = Phase::Failed(error);
                accepted = true;
            }
        });
        if accepted {
            eprintln!("启动草稿恢复中断，后台服务保持停止：{diagnostic}");
        }
        accepted
    }
    fn token(&self) -> Result<String, String> {
        match &*self.phase.borrow() {
            Phase::Running(id) => Ok(id.clone()),
            _ => Err("此启动恢复会话已结束".into()),
        }
    }
    pub fn require_ready(&self) -> Result<(), String> {
        if matches!(*self.phase.borrow(), Phase::Ready) {
            Ok(())
        } else {
            Err("启动草稿尚未完成受控恢复，未开放工作区操作".into())
        }
    }
    pub fn begin_failed_quit(&self) -> bool {
        let mut accepted = false;
        self.phase.send_modify(|phase| {
            if matches!(phase, Phase::Failed(_)) {
                *phase = Phase::Quitting;
                accepted = true;
            }
        });
        accepted
    }
    async fn wait(&self) -> Result<(), String> {
        let mut phase = self.phase.subscribe();
        loop {
            match phase.borrow_and_update().clone() {
                Phase::Ready => return Ok(()),
                Phase::Failed(error) => return Err(format!("启动草稿恢复被阻断：{error}")),
                Phase::Quitting => return Err("正在退出并保留恢复日志".into()),
                Phase::Running(_) | Phase::Finishing(_) => {}
            }
            phase.changed().await.map_err(|error| error.to_string())?;
        }
    }
}

pub fn needs_recovery(root: &Path) -> bool {
    ["MigrationTransaction.json", "ElectronMigrationTransaction.json"].iter().any(|name| {
        !matches!(std::fs::symlink_metadata(root.join(name)), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
    })
}

pub fn restore_services(app: &tauri::AppHandle) {
    let storage = app.state::<crate::workspace::commands::StorageState>();
    if !["workspace.json", "workspace.json.bak"]
        .iter()
        .any(|name| storage.root.join(name).is_file())
    {
        return;
    }
    crate::productivity_service::start(app);
    crate::clipboard_monitor::start(app);
    crate::hotkeys::changed(app);
    app.state::<crate::lan_host::Service>().restore();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::workspace::commands::operation(handle.clone(), |store| store.widget_load())
            .await
        {
            Ok(snapshot) => crate::widgets::changed(&handle, &snapshot),
            Err(error) => eprintln!("恢复组件布局失败：{error}"),
        }
    });
}

pub fn start(app: &tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("workspace-recovery").is_some() {
        return Err("上次恢复工作页仍在关闭，请稍后重试".into());
    }
    let token = app.state::<Service>().begin()?;
    let owner = app.clone();
    let generation = token.clone();
    let window = WebviewWindowBuilder::new(
        app,
        "workspace-recovery",
        WebviewUrl::App("recovery.html".into()),
    )
    .title("DustDesk · 草稿恢复")
    .visible(false)
    .skip_taskbar(true)
    .decorations(false)
    .focused(false)
    .data_directory(app.state::<crate::ProbeState>().profiles.clone())
    .on_navigation(|url| {
        url.path() == "/recovery.html"
            && url.query().is_none()
            && url.fragment().is_none()
            && url
                .host_str()
                .is_some_and(|host| ["tauri.localhost", "127.0.0.1"].contains(&host))
    })
    .build();
    let window = window.map_err(|error| {
        app.state::<Service>()
            .finish(&token, Some(error.to_string()));
        error.to_string()
    })?;
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            owner.state::<Service>().interrupted(
                &generation,
                "恢复工作页已关闭，未恢复编辑器或后台服务".into(),
            );
        }
    });
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(45)).await;
        if handle
            .state::<Service>()
            .interrupted(&token, "恢复工作页超时，数据和日志已保留".into())
            && crate::main_window::current(&handle, &window)
        {
            let _ = window.destroy();
        }
    });
    Ok(())
}

fn require_worker(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "workspace-recovery"
        || !crate::main_window::current(app, window)
        || window.url().map_err(|error| error.to_string())?.path() != "/recovery.html"
    {
        return Err("此窗口不是原生启动恢复工作页".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn drafts_startup_done(
    app: tauri::AppHandle,
    window: WebviewWindow,
    error: Option<String>,
) -> Result<(), String> {
    require_worker(&app, &window)?;
    let token = app.state::<Service>().token()?;
    if let Some(error) = error {
        app.state::<Service>()
            .finish(&token, Some(error.chars().take(2048).collect()));
        let _ = window.destroy();
        return Ok(());
    }
    if crate::workspace::draft_browser::drafts_recovery(app.clone(), window.clone(), None)
        .await?
        .is_some()
    {
        return Err("真实浏览器尚未完成原生恢复，未放行启动".into());
    }
    require_worker(&app, &window)?;
    if !app.state::<Service>().verified(&token) {
        return Err("启动恢复会话已失效，未恢复服务".into());
    }
    if let Err(error) = window.destroy() {
        app.state::<Service>()
            .finish(&token, Some(error.to_string()));
        return Err(error.to_string());
    }
    app.state::<Service>().finish(&token, None);
    restore_services(&app);
    Ok(())
}

#[tauri::command]
pub async fn drafts_startup_wait(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::workspace::api::require_workspace(&window)?;
    app.state::<Service>().wait().await
}

#[tauri::command]
pub async fn drafts_startup_retry(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::workspace::api::require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    let phase = app.state::<Service>().phase.borrow().clone();
    match phase {
        Phase::Ready => Ok(()),
        Phase::Running(_) | Phase::Finishing(_) => Err("启动恢复仍在进行，未重复创建工作页".into()),
        Phase::Quitting => Err("正在退出，不能重试恢复".into()),
        Phase::Failed(_) => start(&app),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_current_running_generation_can_finish_or_timeout() {
        let service = Service::default();
        let first = service.begin().unwrap();
        assert!(service.begin().is_err());
        assert!(!service.finish("wrong", None));
        assert!(service.finish(&first, Some("failure".into())));
        let next = service.begin().unwrap();
        assert_ne!(first, next);
        assert!(!service.finish(&first, None));
        assert_eq!(service.token().unwrap(), next);
        assert!(service.finish(&next, None));
        assert!(service.token().is_err());
    }
    #[test]
    fn successful_completion_cannot_be_changed_by_a_late_failure() {
        let service = Service::default();
        let token = service.begin().unwrap();
        assert!(service.verified(&token));
        assert!(service.begin().is_err());
        assert!(!service.interrupted(&token, "late timeout".into()));
        assert!(service.finish(&token, None));
        assert!(!service.finish(&token, Some("late timeout".into())));
        assert_eq!(*service.phase.borrow(), Phase::Ready);
    }
    #[test]
    fn blocked_startup_wait_preserves_the_native_error_until_explicit_retry() {
        let service = Service::default();
        let token = service.begin().unwrap();
        service.finish(&token, Some("preserved failure".into()));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        assert!(runtime
            .block_on(service.wait())
            .unwrap_err()
            .contains("preserved failure"));
        service.begin().unwrap();
        assert!(matches!(*service.phase.borrow(), Phase::Running(_)));
    }
    #[test]
    fn only_failed_startup_can_exit_without_editors_and_cannot_be_retried_after_quit() {
        let service = Service::default();
        assert!(service.require_ready().is_ok());
        assert!(!service.begin_failed_quit());
        let token = service.begin().unwrap();
        assert!(service.require_ready().is_err());
        assert!(!service.begin_failed_quit());
        service.finish(&token, Some("blocked".into()));
        assert!(service.require_ready().is_err());
        assert!(service.begin_failed_quit());
        assert!(service.begin().is_err());
        assert!(service.require_ready().is_err());
        assert!(!service.finish(&token, None));
    }
}
