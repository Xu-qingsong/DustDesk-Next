use super::{
    api::{require_workspace, ActionReply},
    commands::{broadcast, operation},
};
use serde_json::{json, Value};
use tauri::{Manager, WebviewWindow};
#[tauri::command]
pub async fn workspace_organizer(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    category_id: Option<String>,
    source: Option<String>,
    plan: Option<Value>,
) -> Result<ActionReply, String> {
    require_workspace(&window)?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    let reply = operation(app.clone(), move |store| {
        if action == "plan" {
            return Ok(ActionReply {
                result: serde_json::to_value(store.organizer_plan()?)
                    .map_err(|error| error.to_string())?,
                snapshot: None,
            });
        }
        if action == "execute" {
            let (result, snapshot) = store.organizer_execute(plan);
            return Ok(ActionReply { result, snapshot });
        }
        let result = match action.as_str() {
            "move" => store.organizer_move(
                category_id.as_deref().ok_or("分类参数无效")?,
                source.as_deref().ok_or("源路径无效")?,
            ),
            "restore" => store.organizer_restore(
                category_id.as_deref().ok_or("分类参数无效")?,
                source.as_deref().ok_or("源路径无效")?,
            ),
            "undo" => store.organizer_undo(),
            _ => Err("收纳操作无效".into()),
        };
        Ok(match result {
            Ok((snapshot, path)) => ActionReply {
                result: json!({"ok":true,"path":path}),
                snapshot: Some(snapshot),
            },
            Err(error) => {
                store.organizer_failure(&action, source.as_deref(), &error);
                ActionReply {
                    result: json!({"ok":false,"error":error}),
                    snapshot: None,
                }
            }
        })
    })
    .await?;
    if let Some(snapshot) = &reply.snapshot {
        app.state::<crate::desktop::DesktopService>().release();
        broadcast(&app, snapshot);
    }
    Ok(reply)
}
