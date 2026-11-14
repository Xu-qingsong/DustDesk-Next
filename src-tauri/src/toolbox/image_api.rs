use super::{
    image_store::{Asset, Output, Service},
    require_active,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Manager, WebviewWindow,
};

async fn job<ResultType: Send + 'static>(
    app: tauri::AppHandle,
    window: WebviewWindow,
    callback: impl FnOnce(&Service, u64, &dyn Fn() -> Result<(), String>) -> Result<ResultType, String>
        + Send
        + 'static,
) -> Result<ResultType, String> {
    require_active(&app, &window)?;
    let epoch = app.state::<Service>().epoch();
    tauri::async_runtime::spawn_blocking(move || {
        require_active(&app, &window)?;
        callback(&app.state::<Service>(), epoch, &|| {
            require_active(&app, &window)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}
fn payload(request: &Request<'_>) -> Result<(String, Vec<u8>), String> {
    let encoded = request
        .headers()
        .get("x-dustdesk-name")
        .and_then(|header| header.to_str().ok())
        .ok_or("图片文件名无效")?;
    if encoded.len() > 4096 {
        return Err("图片文件名过长".into());
    }
    let name = String::from_utf8(STANDARD.decode(encoded).map_err(|_| "图片文件名无效")?)
        .map_err(|_| "图片文件名无效")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("图片必须以二进制传输".into());
    };
    if bytes.len() > super::image_store::MAX_BYTES {
        return Err("单张图片最多 100 MiB".into());
    }
    Ok((name, bytes.clone()))
}

#[tauri::command]
pub async fn toolbox_import_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<Asset, String> {
    require_active(&app, &window)?;
    let (name, bytes) = payload(&request)?;
    job(app, window, move |service, epoch, active| {
        service.import(epoch, bytes, &name, active)
    })
    .await
}
#[tauri::command]
pub async fn toolbox_read_asset(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<Response, String> {
    job(app, window, move |service, epoch, active| {
        service.read(epoch, &id, active).map(Response::new)
    })
    .await
}
#[tauri::command]
pub async fn toolbox_release_assets(
    app: tauri::AppHandle,
    window: WebviewWindow,
    ids: Vec<String>,
) -> Result<(), String> {
    let transfer_epoch = app.state::<super::transfer_assets::Service>().epoch()?;
    let handle = app.clone();
    job(app, window, move |service, epoch, active| {
        service.release(epoch, &ids, active)?;
        handle
            .state::<super::transfer_assets::Service>()
            .release(transfer_epoch, &ids)
    })
    .await
}
#[tauri::command]
pub async fn toolbox_register_paths(
    app: tauri::AppHandle,
    window: WebviewWindow,
    paths: Vec<String>,
    kind: String,
) -> Result<Vec<Asset>, String> {
    require_active(&app, &window)?;
    if kind == "transfer" {
        let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
        if paths.len() > 10000 {
            return Err("导入参数无效".into());
        }
        for path in &paths {
            if !app.state::<crate::system::SystemService>().selected(path)? {
                return Err("文件路径未获原生选择授权".into());
            }
        }
        return register_transfer(app, window, paths, None).await;
    }
    if kind != "image" {
        return Err("导入类型无效".into());
    }
    if paths.len() > 10000 {
        return Err("导入参数无效".into());
    }
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    for path in &paths {
        if !app.state::<crate::system::SystemService>().selected(path)? {
            return Err("图片路径未获原生选择授权".into());
        }
    }
    job(app, window, move |service, epoch, active| {
        service.register(epoch, paths, active)
    })
    .await
}
#[tauri::command]
pub async fn toolbox_pick(
    app: tauri::AppHandle,
    window: WebviewWindow,
    kind: String,
) -> Result<Vec<Asset>, String> {
    require_active(&app, &window)?;
    if kind == "files" || kind == "folder" {
        let Some(selection) =
            crate::system::select_tool_paths(app.clone(), window.clone(), kind == "folder", false)
                .await?
        else {
            return Ok(Vec::new());
        };
        return register_transfer(app, window, selection.paths.clone(), Some(selection)).await;
    }
    if kind != "image" {
        return Err("导入类型无效".into());
    }
    let Some(selection) = crate::system::select_tool_images(app.clone(), window.clone()).await?
    else {
        return Ok(Vec::new());
    };
    let handle = app.clone();
    job(app, window, move |service, epoch, active| {
        selection.require_active()?;
        let output = service.register(epoch, selection.paths.clone(), || {
            selection.require_active()?;
            active()
        })?;
        for path in &selection.paths {
            handle.state::<crate::system::SystemService>().grant(path)?;
        }
        Ok(output)
    })
    .await
}
async fn register_transfer(
    app: tauri::AppHandle,
    window: WebviewWindow,
    paths: Vec<PathBuf>,
    selection: Option<crate::system::ImageSelection>,
) -> Result<Vec<Asset>, String> {
    let epoch = app.state::<super::transfer_assets::Service>().epoch()?;
    tauri::async_runtime::spawn_blocking(move || {
        let active = || {
            require_active(&app, &window)?;
            if let Some(selection) = &selection {
                selection.require_active()?;
            }
            Ok(())
        };
        let output = app.state::<super::transfer_assets::Service>().register(
            epoch,
            paths.clone(),
            active,
        )?;
        if selection.is_some() {
            for path in &paths {
                app.state::<crate::system::SystemService>().grant(path)?;
            }
        }
        Ok(output)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn toolbox_begin_image_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
    assets: Vec<String>,
    format: String,
) -> Result<Value, String> {
    let ids = assets.clone();
    let selected_format = format.clone();
    let (name, extension) = job(
        app.clone(),
        window.clone(),
        move |service, epoch, active| service.export_name(epoch, &ids, &format, active),
    )
    .await?;
    let Some(selection) =
        crate::system::select_image_export(app.clone(), window.clone(), name, extension.clone())
            .await?
    else {
        return Ok(json!({}));
    };
    let valid = selection
        .path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case(&extension)
                || extension == "jpg" && value.eq_ignore_ascii_case("jpeg")
        });
    let target = if valid {
        selection.path.clone()
    } else {
        PathBuf::from(format!("{}.{extension}", selection.path.display()))
    };
    let storage = app.state::<crate::workspace::commands::StorageState>();
    crate::workspace::export_file::require_external(
        &target,
        storage.root.parent().ok_or("隔离数据目录无效")?,
    )?;
    let ids = assets;
    job(app, window, move |service, epoch, active| {
        selection.require_active()?;
        service.export_name(epoch, &ids, &selected_format, active)?;
        let id = service.begin(epoch, target, ids.len(), || {
            selection.require_active()?;
            active()
        })?;
        Ok(json!({"id":id}))
    })
    .await
}
#[tauri::command]
pub async fn toolbox_export_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<String, String> {
    require_active(&app, &window)?;
    let id = request
        .headers()
        .get("x-dustdesk-batch")
        .and_then(|header| header.to_str().ok())
        .filter(|value| value.len() <= 128)
        .ok_or("导出批次无效")?
        .to_string();
    let (name, bytes) = payload(&request)?;
    job(app, window, move |service, epoch, active| {
        service.write(epoch, &id, &name, &bytes, active)
    })
    .await
}
#[tauri::command]
pub async fn toolbox_end_image_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
    batch: String,
) -> Result<Output, String> {
    let handle = app.clone();
    job(app, window, move |service, epoch, active| {
        let output = service.finish(epoch, &batch, active)?;
        for path in [&output.path, &output.directory].into_iter().flatten() {
            handle
                .state::<crate::system::SystemService>()
                .grant(Path::new(path))?;
        }
        Ok(output)
    })
    .await
}
