use dustdesk_tauri::legacy_source::PinnedInstallation;
use serde_json::{json, Value};
use std::path::Path;
use tauri::WebviewWindow;
use tokio_util::sync::CancellationToken;

#[tauri::command]
pub async fn legacy_source_inspect(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    crate::toolbox::require_active(&app, &window)?;
    let selected = crate::system::system_pick(
        app.clone(),
        window.clone(),
        true,
        Some("选择正式旧版安装目录（仅校验，不运行或迁移）".into()),
    )
    .await?;
    crate::toolbox::require_active(&app, &window)?;
    if selected["canceled"] == true {
        return Ok(json!({"canceled":true}));
    }
    let path = selected["path"]
        .as_str()
        .filter(|_| selected["ok"] == true)
        .ok_or_else(|| {
            selected["error"]
                .as_str()
                .unwrap_or("未取得旧版安装目录")
                .to_owned()
        })?
        .to_owned();
    tokio::task::spawn_blocking(move || {
        let current = || crate::toolbox::require_active(&app, &window);
        let cancel = CancellationToken::new();
        let mut source = PinnedInstallation::open(Path::new(&path), &cancel, current)?;
        source.confirm(&cancel, current)?;
        current()?;
        serde_json::to_value(source.inspection()).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}
