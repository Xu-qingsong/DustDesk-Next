use super::api::{require_workspace, ActionReply};
use super::backup::{BackupEntry, BackupPreview, BackupStatus};
use super::commands::{broadcast, operation};
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};

#[tauri::command]
pub async fn workspace_backup_create(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    require_workspace(&window)?;
    let result = operation(app, |store| Ok(store.create_backup())).await?;
    Ok(match result {
        Ok(path) => json!({"ok":true,"path":path}),
        Err(error) => json!({"ok":false,"error":error}),
    })
}

#[tauri::command]
pub async fn workspace_backup_list(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Vec<BackupEntry>, String> {
    require_workspace(&window)?;
    operation(app, |store| store.list_backups()).await
}

#[tauri::command]
pub async fn workspace_backup_preview(
    app: tauri::AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<BackupPreview, String> {
    require_workspace(&window)?;
    operation(app, move |store| store.preview_backup(&path)).await
}

#[tauri::command]
pub async fn workspace_backup_status(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<BackupStatus, String> {
    require_workspace(&window)?;
    operation(app, |store| Ok(store.backup_status())).await
}

#[tauri::command]
pub async fn workspace_backup_restore(
    app: tauri::AppHandle,
    window: WebviewWindow,
    path: Option<String>,
    fingerprint: Option<String>,
) -> Result<ActionReply, String> {
    require_workspace(&window)?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    crate::screenshot_capture::protected(&app)?;
    crate::quick_capture::protect_restore(&app)?;
    let lan = app.state::<crate::lan_host::Service>();
    let _lan_pause = lan.pause().await?;
    let _clipboard_pause = crate::clipboard_monitor::pause(&app);
    let result = operation(app.clone(), move |store| {
        Ok(store.restore_backup(path, fingerprint))
    })
    .await?;
    match result {
        Ok(snapshot) => {
            crate::clipboard_monitor::restored(&app);
            crate::screenshot_capture::reset(&app);
            app.state::<crate::file_drop::Service>().cancel_pending();
            app.state::<crate::screenshot::Service>().reset();
            app.state::<crate::system::SystemService>().release();
            app.state::<crate::toolbox::image_store::Service>().reset();
            app.state::<crate::toolbox::transfer_assets::Service>()
                .reset();
            app.state::<crate::file_search::SearchService>().release();
            app.state::<crate::desktop::DesktopService>().release();
            app.state::<crate::path_menu::MenuService>().cancel();
            app.state::<super::resource_api::ResourceService>()
                .cancel_all();
            broadcast(&app, &snapshot);
            crate::productivity_service::start(&app);
            crate::clipboard_monitor::start(&app);
            Ok(ActionReply {
                result: json!({"ok":true}),
                snapshot: Some(snapshot),
            })
        }
        Err(error) => Ok(ActionReply {
            result: json!({"ok":false,"error":error}),
            snapshot: None,
        }),
    }
}

#[tauri::command]
pub async fn workspace_note_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<Value, String> {
    let widget = crate::widgets::business(&app, &window, &["notes", "note:"])?;
    let result = operation(app, move |store| {
        if let Some(role) = widget {
            if !super::widgets::permits_note_image(&store.resource_snapshot()?, &role, &path) {
                return Err("图片不属于此便签组件".into());
            }
        }
        store.read_note_image(&path)
    })
    .await;
    Ok(match result {
        Ok(data_url) => json!({"ok":true,"dataUrl":data_url}),
        Err(error) => json!({"ok":false,"error":error}),
    })
}
