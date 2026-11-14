pub mod image_api;
pub mod image_store;
pub mod transfer_assets;

use crate::workspace::{
    commands::{operation, StorageState},
    export_file,
};
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};

const MAX_TEXT_BYTES: usize = 40 * 1024 * 1024;

fn validate_text(text: &str) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err("导出文本最多 40 MiB".into());
    }
    Ok(())
}
pub(crate) fn require_active(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    crate::workspace::api::require_workspace(window)?;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    if !crate::main_window::current(app, window) {
        return Err("主窗口已失效".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn toolbox_export_text(
    app: tauri::AppHandle,
    window: WebviewWindow,
    text: String,
) -> Result<Value, String> {
    require_active(&app, &window)?;
    validate_text(&text)?;
    let Some(selection) = crate::system::select_text_export(app.clone(), window.clone()).await?
    else {
        return Ok(json!({"canceled":true}));
    };
    let storage = app.state::<StorageState>();
    let protected = storage.root.parent().ok_or("隔离数据目录无效")?;
    export_file::require_external(&selection.path, protected)?;
    let output = selection.path.display().to_string();
    let handle = app.clone();
    operation(app, move |_store| {
        export_file::publish_checked(&selection.path, text.as_bytes(), || {
            selection.require_active()?;
            require_active(&handle, &window)
        })
    })
    .await?;
    Ok(json!({"path":output}))
}

#[tauri::command]
pub async fn toolbox_copy_text(
    app: tauri::AppHandle,
    window: WebviewWindow,
    text: String,
) -> Result<(), String> {
    require_active(&app, &window)?;
    validate_text(&text)?;
    let permit = app
        .state::<crate::clipboard::ClipboardService>()
        .slot
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        require_active(&app, &window)?;
        #[cfg(windows)]
        {
            crate::platform::clipboard::write(&crate::clipboard::PreparedContent::Text(text))
        }
        #[cfg(not(windows))]
        {
            let _ = text;
            Err("当前平台尚未接通原生剪贴板".into())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn text_limit_is_utf8_bytes_and_preserves_empty_nul_and_exact_boundary() {
        for text in ["", "中文🪶\0\r\n", "="] {
            validate_text(text).unwrap();
        }
        validate_text(&"a".repeat(MAX_TEXT_BYTES)).unwrap();
        assert!(validate_text(&"a".repeat(MAX_TEXT_BYTES + 1)).is_err());
        let unicode = "🪶".repeat(MAX_TEXT_BYTES / 4);
        validate_text(&unicode).unwrap();
        assert!(validate_text(&(unicode + "a")).is_err());
    }
}
