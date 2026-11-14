use crate::{lifecycle::QuitState, system};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicIsize, Ordering},
    Arc, Mutex,
};
use tauri::{Manager, WebviewWindow};

struct Session {
    owner: isize,
    handle: AtomicIsize,
    cancelled: AtomicBool,
}
pub struct MenuService {
    active: Mutex<Option<Arc<Session>>>,
    slots: Arc<tokio::sync::Semaphore>,
}
impl Default for MenuService {
    fn default() -> Self {
        Self {
            active: Mutex::new(None),
            slots: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}
impl MenuService {
    pub fn busy(&self) -> bool {
        self.active.lock().map_or(true, |active| active.is_some())
    }
    fn slots(&self) -> Arc<tokio::sync::Semaphore> {
        self.slots.clone()
    }
    pub fn cancel(&self) {
        if let Ok(active) = self.active.lock() {
            if let Some(session) = active.as_ref() {
                session.cancelled.store(true, Ordering::SeqCst);
                #[cfg(windows)]
                crate::platform::path_menu::cancel(session.handle.load(Ordering::SeqCst));
            }
        }
    }
    fn register(&self, owner: isize) -> Result<Arc<Session>, String> {
        let mut active = self.active.lock().map_err(|error| error.to_string())?;
        if active.is_some() {
            return Err("已有文件菜单正在处理".into());
        }
        let session = Arc::new(Session {
            owner,
            handle: AtomicIsize::new(0),
            cancelled: AtomicBool::new(false),
        });
        *active = Some(session.clone());
        Ok(session)
    }
    fn finish(&self, session: &Arc<Session>) {
        if let Ok(mut active) = self.active.lock() {
            if active
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, session))
            {
                *active = None;
            }
        }
    }
}
struct Guard {
    app: tauri::AppHandle,
    session: Arc<Session>,
}
impl Drop for Guard {
    fn drop(&mut self) {
        self.app.state::<MenuService>().finish(&self.session);
    }
}
fn error(app: &tauri::AppHandle, label: &str, message: String) {
    let _ = crate::events::emit(app, label, "system:action-error", message);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn menus_are_single_session_and_stale_completions_cannot_release_new_targets() {
        let service = MenuService::default();
        let first = service.register(0).unwrap();
        assert!(service.busy());
        assert!(service.register(0).is_err());
        service.finish(&first);
        let second = service.register(0).unwrap();
        service.finish(&first);
        assert!(service.register(0).is_err());
        service.finish(&second);
        assert!(!service.busy());
        assert!(service.register(0).is_ok());
    }
    #[test]
    fn cancellation_invalidates_queued_and_inflight_actions_before_the_menu_opens() {
        let service = MenuService::default();
        let first = service.register(0).unwrap();
        service.cancel();
        assert!(first.cancelled.load(Ordering::SeqCst));
        service.finish(&first);
        let next = service.register(0).unwrap();
        assert!(!next.cancelled.load(Ordering::SeqCst));
        service.cancel();
        assert!(next.cancelled.load(Ordering::SeqCst));
    }
}
async fn execute(
    app: tauri::AppHandle,
    label: String,
    target: String,
    action: u32,
    session: Arc<Session>,
) -> Result<(), String> {
    let _guard = Guard {
        app: app.clone(),
        session: session.clone(),
    };
    if session.cancelled.load(Ordering::SeqCst) {
        return Ok(());
    }
    app.state::<QuitState>().require_interactive()?;
    system::authorize_path_for(app.clone(), &label, &target).await?;
    crate::workspace::resource_api::require_safe_path(app.clone(), target.clone()).await?;
    system::authorize_path_for(app.clone(), &label, &target).await?;
    let permit = app
        .state::<MenuService>()
        .slots()
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    system::sta(move || {
        let _permit = permit;
        if session.cancelled.load(Ordering::SeqCst) {
            return Ok(());
        }
        app.state::<QuitState>().require_interactive()?;
        #[cfg(windows)]
        {
            match action {
                1 => crate::platform::shell::open(session.owner, target),
                2 => crate::platform::shell::reveal(&target),
                3 => crate::platform::path_menu::copy(session.owner, &target, &session.cancelled),
                _ => Err("文件菜单操作无效".into()),
            }
        }
        #[cfg(not(windows))]
        {
            let _ = (target, action);
            Err("当前平台尚未接通文件菜单".into())
        }
    })
    .await
}
#[tauri::command]
pub async fn system_path_menu(
    app: tauri::AppHandle,
    window: WebviewWindow,
    target: String,
) -> Result<Value, String> {
    crate::widgets::business(&app, &window, &["organizer", "organizer-group:"])?;
    let result = async {
        app.state::<QuitState>().require_interactive()?;
        system::authorize_path_for(app.clone(), window.label(), &target).await?;
        crate::workspace::resource_api::require_safe_path(app.clone(), target.clone()).await?;
        #[cfg(windows)]
        let owner = window.hwnd().map_err(|error| error.to_string())?.0 as isize;
        #[cfg(not(windows))]
        let owner = 0;
        let session = app.state::<MenuService>().register(owner)?;
        if let Err(error) = app.state::<QuitState>().require_interactive() {
            app.state::<MenuService>().finish(&session);
            return Err(error);
        }
        let handle = app.clone();
        let label = window.label().to_owned();
        let queued = session.clone();
        tauri::async_runtime::spawn(async move {
            let showing = queued.clone();
            let result = system::sta(move || {
                #[cfg(windows)]
                {
                    crate::platform::path_menu::show(
                        showing.owner,
                        &showing.handle,
                        &showing.cancelled,
                    )
                }
                #[cfg(not(windows))]
                {
                    let _ = showing;
                    Err("当前平台尚未接通文件菜单".into())
                }
            })
            .await;
            match result {
                Ok(action @ 1..=3) => {
                    if let Err(message) =
                        execute(handle.clone(), label.clone(), target, action, queued).await
                    {
                        error(&handle, &label, message);
                    }
                }
                Ok(_) => handle.state::<MenuService>().finish(&queued),
                Err(message) => {
                    handle.state::<MenuService>().finish(&queued);
                    error(&handle, &label, message);
                }
            }
        });
        Ok(())
    }
    .await;
    Ok(match result {
        Ok(()) => json!({"ok":true}),
        Err(error) => json!({"ok":false,"error":error}),
    })
}
