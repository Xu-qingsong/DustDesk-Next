use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri::Manager;

#[derive(Default)]
pub struct ProductivityService {
    started: AtomicBool,
}

pub fn start(app: &tauri::AppHandle) {
    if app
        .state::<ProductivityService>()
        .started
        .swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let result = crate::workspace::commands::operation(app.clone(), |store| {
                let result = store.productivity_tick()?;
                store.backup_maintenance();
                Ok(result)
            })
            .await;
            match result {
                Ok((snapshot, notifications)) => {
                    if let Some(snapshot) = snapshot {
                        crate::workspace::commands::broadcast(&app, &snapshot);
                    }
                    for notification in notifications {
                        if let Err(error) = crate::notifications::show(&app, &notification) {
                            eprintln!("系统通知失败：{error}");
                        }
                    }
                }
                Err(error) => {
                    if app
                        .state::<crate::lifecycle::QuitState>()
                        .require_interactive()
                        .is_ok()
                    {
                        eprintln!("专注与回收站后台维护失败：{error}");
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}
