use super::{
    api::{require_workspace, ActionReply},
    commands::{broadcast, operation},
    note_images,
};
use serde_json::json;
use std::time::Duration;
use tauri::{Manager, WebviewWindow};

fn failure(error: String) -> ActionReply {
    ActionReply {
        result: json!({"ok":false,"error":error}),
        snapshot: None,
    }
}
async fn import(
    app: tauri::AppHandle,
    id: String,
    source: String,
    expected: Option<Option<String>>,
) -> Result<ActionReply, String> {
    let check_id = id.clone();
    let check_expected = expected.clone();
    if let Err(error) = operation(app.clone(), move |store| {
        store.check_note_image(&check_id, &check_expected)
    })
    .await
    {
        return Ok(failure(error));
    }
    let slots = app
        .state::<super::resource_api::ResourceService>()
        .file_slots();
    let image = tokio::time::timeout(Duration::from_secs(6), async move {
        let permit = slots
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let _permit = permit;
            note_images::read_source(&source)
        })
        .await
        .map_err(|error| error.to_string())?
    })
    .await;
    let image = match image {
        Ok(Ok(image)) => image,
        Ok(Err(error)) => return Ok(failure(error)),
        Err(_) => return Ok(failure("图片读取超时，请检查磁盘连接后重试".into())),
    };
    let outcome = operation(app.clone(), move |store| {
        Ok(store.import_note_image(&id, image, expected))
    })
    .await?;
    Ok(match outcome {
        Ok((snapshot, result)) => {
            broadcast(&app, &snapshot);
            ActionReply {
                result,
                snapshot: Some(snapshot),
            }
        }
        Err(error) => failure(error),
    })
}

#[tauri::command]
pub async fn workspace_note_import(
    app: tauri::AppHandle,
    window: WebviewWindow,
    note_id: String,
    source: String,
    expected_path: Option<String>,
    check_expected: bool,
) -> Result<ActionReply, String> {
    require_workspace(&window)?;
    import(
        app,
        note_id,
        source,
        check_expected.then_some(expected_path),
    )
    .await
}
#[tauri::command]
pub async fn workspace_note_pick(
    app: tauri::AppHandle,
    window: WebviewWindow,
    note_id: String,
    expected_path: Option<String>,
    check_expected: bool,
) -> Result<ActionReply, String> {
    require_workspace(&window)?;
    let expected = check_expected.then_some(expected_path);
    let check_id = note_id.clone();
    let check_expected = expected.clone();
    if let Err(error) = operation(app.clone(), move |store| {
        store.check_note_image(&check_id, &check_expected)
    })
    .await
    {
        return Ok(failure(error));
    }
    let selected = crate::system::pick_image(app.clone(), window).await?;
    if selected["ok"] != true {
        return Ok(ActionReply {
            result: selected,
            snapshot: None,
        });
    }
    import(
        app,
        note_id,
        selected["path"].as_str().ok_or("图片选择结果无效")?.into(),
        expected,
    )
    .await
}
#[tauri::command]
pub async fn workspace_note_clear(
    app: tauri::AppHandle,
    window: WebviewWindow,
    note_id: String,
    expected_path: Option<String>,
    check_expected: bool,
) -> Result<ActionReply, String> {
    require_workspace(&window)?;
    let outcome = operation(app.clone(), move |store| {
        Ok(store.clear_note_image(&note_id, check_expected.then_some(expected_path)))
    })
    .await?;
    Ok(match outcome {
        Ok(snapshot) => {
            broadcast(&app, &snapshot);
            ActionReply {
                result: json!({"ok":true}),
                snapshot: Some(snapshot),
            }
        }
        Err(error) => failure(error),
    })
}
