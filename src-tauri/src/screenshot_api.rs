use crate::screenshot_output::{Action, Output, Packet};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tauri::{
    ipc::{InvokeBody, Request, Response},
    Manager, WebviewWindow,
};

fn require(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    crate::screenshot_capture::require(app, window)
}
#[tauri::command]
pub async fn screenshot_create(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<crate::screenshot::Document, String> {
    crate::toolbox::require_active(&app, &window)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("截图图片必须以二进制传输".into());
    };
    if bytes.is_empty() || bytes.len() > crate::screenshot::MAX_BYTES {
        return Err("图片无效或过大（最大 32 MB）".into());
    }
    let service = app.state::<crate::screenshot::Service>();
    let generation = service.generation()?;
    let permit = service
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        require(&app, &window)?;
        let decoded = crate::screenshot::decode(&bytes)?;
        app.state::<crate::screenshot::Service>()
            .create(generation, decoded, || require(&app, &window))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn screenshot_document(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<crate::screenshot::Document, String> {
    require(&app, &window)?;
    app.state::<crate::screenshot::Service>()
        .read_owned(&id, window.label())
        .map(|(document, _)| document)
}
#[tauri::command]
pub async fn screenshot_import(
    app: tauri::AppHandle,
    window: WebviewWindow,
    path: String,
) -> Result<crate::screenshot::Document, String> {
    crate::toolbox::require_active(&app, &window)?;
    let path = PathBuf::from(path);
    let authorized = || -> Result<(), String> {
        require(&app, &window)?;
        if !app
            .state::<crate::system::SystemService>()
            .selected(&path)?
        {
            return Err("截图文件未获原生选择或拖入授权".into());
        }
        Ok(())
    };
    authorized()?;
    let service = app.state::<crate::screenshot::Service>();
    let generation = service.generation()?;
    let permit = service
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let authorized = || {
            require(&app, &window)?;
            if !app
                .state::<crate::system::SystemService>()
                .selected(&path)?
            {
                return Err("截图文件授权已失效".into());
            }
            Ok(())
        };
        authorized()?;
        let decoded = crate::screenshot::read_file(&path)?;
        app.state::<crate::screenshot::Service>()
            .create(generation, decoded, authorized)
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub async fn screenshot_source(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<Response, String> {
    require(&app, &window)?;
    let service = app.state::<crate::screenshot::Service>();
    let generation = service.generation()?;
    let permit = service
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        require(&app, &window)?;
        let service = app.state::<crate::screenshot::Service>();
        if service.generation()? != generation {
            return Err("截图会话已失效".into());
        }
        service
            .read_owned(&id, window.label())
            .map(|(_, bytes)| Response::new(bytes.to_vec()))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[tauri::command]
pub fn screenshot_discard(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    crate::workspace::api::require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    app.state::<crate::screenshot::Service>()
        .remove_owned(&id, Some(window.label()))
}

fn active_output(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    generation: u64,
) -> Result<(), String> {
    require(app, window)?;
    if app.state::<crate::screenshot::Service>().generation()? != generation {
        return Err("截图操作已取消".into());
    }
    Ok(())
}
fn output_authority(target: &Path, root: &Path) -> Result<(), String> {
    let directory = root.join("Screenshots");
    let parent = target.parent().ok_or("截图目标目录无效")?;
    let key = |path: &Path| crate::system::path_key(path.to_str().ok_or("截图路径无效")?);
    key(target)?;
    if key(parent)? == key(&directory)? {
        return Ok(());
    }
    crate::workspace::export_file::require_external(
        target,
        root.parent().ok_or("隔离数据目录无效")?,
    )
}
fn default_output(
    root: &Path,
    settings: &serde_json::Value,
    format: Option<&str>,
) -> Result<PathBuf, String> {
    let extension = format.unwrap_or_else(|| {
        if matches!(settings["ScreenshotFormat"].as_str(), Some("jpg" | "jpeg")) {
            "jpg"
        } else {
            "png"
        }
    });
    let directory = settings["ScreenshotSaveDirectory"]
        .as_str()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("Screenshots"));
    let target = directory.join(format!(
        "DustDesk-edited-{}-{}.{}",
        chrono::Utc::now().format("%Y-%m-%dT%H-%M-%S-%3fZ"),
        uuid::Uuid::new_v4(),
        extension
    ));
    output_authority(&target, root)?;
    Ok(target)
}
async fn copy_output(
    app: tauri::AppHandle,
    window: WebviewWindow,
    generation: u64,
    packet: Arc<Packet>,
    image: Arc<image::DynamicImage>,
    primary: bool,
) -> Result<Output, String> {
    active_output(&app, &window, generation)?;
    let mut pause = crate::clipboard_monitor::pause_for_write(&app);
    pause
        .drain(&app)
        .await
        .map_err(|error| format!("复制前保存剪贴板记录失败：{error}"))?;
    let permit = app
        .state::<crate::clipboard::ClipboardService>()
        .slot
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _pause = pause;
        let _permit = permit;
        active_output(&app, &window, generation)?;
        let content = crate::clipboard::PreparedContent::Image {
            png: packet.png().to_vec(),
            dib: crate::clipboard::dib(&image),
        };
        let write = || {
            #[cfg(windows)]
            crate::platform::clipboard::write_observed(&content, |sequence| {
                crate::clipboard_monitor::ignore_written_sequence(&app, sequence)
            })?;
            #[cfg(not(windows))]
            {
                let _ = content;
                return Err("当前平台尚未接通截图复制".into());
            }
            Ok(Output {
                ok: true,
                ..Output::default()
            })
        };
        if primary {
            app.state::<crate::screenshot::Service>().transact_owned(
                generation,
                &packet,
                window.label(),
                || require(&app, &window),
                write,
            )
        } else {
            active_output(&app, &window, generation)?;
            write()
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn screenshot_finish(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<Output, String> {
    crate::toolbox::require_active(&app, &window)?;
    finish(app, window, request).await
}
pub(crate) async fn finish(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<Output, String> {
    require(&app, &window)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("截图输出必须以二进制传输".into());
    };
    finish_bytes(app, window, bytes.clone(), true).await
}
pub(crate) async fn finish_bytes(
    app: tauri::AppHandle,
    window: WebviewWindow,
    bytes: Vec<u8>,
    secondary: bool,
) -> Result<Output, String> {
    require(&app, &window)?;
    if bytes.len() > 4 + 16 * 1024 * 1024 + crate::screenshot::MAX_BYTES * 2 {
        return Err("截图输出请求过大".into());
    }
    let generation = app.state::<crate::screenshot::Service>().generation()?;
    let _queued = app
        .state::<crate::screenshot::Service>()
        .output_queue
        .clone()
        .try_acquire_owned()
        .map_err(|_| "截图输出队列已满，请等待当前操作完成")?;
    let permit = app
        .state::<crate::screenshot::Service>()
        .slot
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    let _permit = permit;
    let packet = Arc::new(
        tauri::async_runtime::spawn_blocking(move || Packet::parse(bytes))
            .await
            .map_err(|error| error.to_string())??,
    );
    active_output(&app, &window, generation)?;
    if let Some(output) = app
        .state::<crate::screenshot::Service>()
        .check_finish_owned(generation, &packet, window.label())?
    {
        return Ok(output);
    }
    if packet.metadata.action == Action::OpenEditor {
        drop(_permit);
        return crate::screenshot_editor::open(app, window, packet).await;
    }
    if !matches!(
        packet.metadata.action,
        Action::Copy | Action::Save | Action::SaveAs | Action::Pin | Action::UpdatePin
    ) {
        return Err("Tauri 迁移中，尚未接通：截图贴图输出".into());
    }
    let source = packet.clone();
    let image = Arc::new(
        tauri::async_runtime::spawn_blocking(move || source.image())
            .await
            .map_err(|error| error.to_string())??,
    );
    let handle = app.clone();
    let caller = window.clone();
    let settings = crate::workspace::commands::operation(app.clone(), move |store| {
        require(&handle, &caller)?;
        store.screenshot_settings()
    })
    .await?;
    let mut output = if matches!(packet.metadata.action, Action::Pin | Action::UpdatePin) {
        crate::screenshot_pins::publish(&app, &window, generation, packet.clone(), &settings)
            .await?
    } else if packet.metadata.action == Action::Copy {
        copy_output(
            app.clone(),
            window.clone(),
            generation,
            packet.clone(),
            image.clone(),
            true,
        )
        .await?
    } else {
        let root = app
            .state::<crate::workspace::commands::StorageState>()
            .root
            .clone();
        let default_path = default_output(&root, &settings, packet.metadata.format.as_deref())?;
        let selection = if packet.metadata.action == Action::SaveAs {
            let extension = default_path
                .extension()
                .and_then(|extension| extension.to_str())
                .unwrap_or("png")
                .to_string();
            let Some(selection) = crate::system::select_screenshot_export(
                app.clone(),
                window.clone(),
                default_path.clone(),
                extension,
            )
            .await?
            else {
                return Ok(Output {
                    ok: false,
                    canceled: Some(true),
                    ..Output::default()
                });
            };
            Some(selection)
        } else {
            None
        };
        let target = selection
            .as_ref()
            .map(|selection| selection.path.clone())
            .unwrap_or(default_path);
        output_authority(&target, &root)?;
        let handle = app.clone();
        let caller = window.clone();
        let source = packet.clone();
        let image = image.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let active = || {
                active_output(&handle, &caller, generation)?;
                if let Some(selection) = &selection {
                    selection.require_active()?;
                }
                Ok(())
            };
            active()?;
            let jpeg = target
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| {
                    extension.eq_ignore_ascii_case("jpg") || extension.eq_ignore_ascii_case("jpeg")
                });
            let converted = if jpeg {
                Some(source.jpeg_output(&image)?)
            } else {
                None
            };
            crate::workspace::checked_path(&target)?;
            std::fs::create_dir_all(target.parent().ok_or("截图目标目录无效")?)
                .map_err(|error| error.to_string())?;
            let prepared = crate::workspace::export_file::prepare_checked(
                &target,
                converted.as_deref().unwrap_or_else(|| source.png()),
                active,
            )?;
            handle.state::<crate::screenshot::Service>().transact_owned(
                generation,
                &source,
                caller.label(),
                || require(&handle, &caller),
                || {
                    prepared.publish(|| {
                        require(&handle, &caller)?;
                        if let Some(selection) = &selection {
                            selection.require_active()?;
                        }
                        Ok(())
                    })?;
                    Ok(Output {
                        ok: true,
                        path: Some(target.display().to_string()),
                        ..Output::default()
                    })
                },
            )
        })
        .await
        .map_err(|error| error.to_string())??
    };
    if secondary && packet.metadata.action != Action::Copy && settings["ScreenshotAutoCopy"] == true
    {
        if let Err(error) = copy_output(
            app.clone(),
            window.clone(),
            generation,
            packet.clone(),
            image.clone(),
            false,
        )
        .await
        {
            output.warn(format!("输出已完成，自动复制失败，可点击复制重试：{error}"));
        }
    }
    if secondary && output.ok {
        if let Err(error) = crate::screenshot_pins::remember_output(&app, &packet) {
            output.warn(format!("输出已完成，保留上次截图失败：{error}"));
        }
    }
    if secondary && settings["ScreenshotAutoAddToClipboardHistory"] == true {
        let handle = app.clone();
        let caller = window.clone();
        let source = packet.clone();
        let name = output
            .path
            .as_deref()
            .and_then(|path| Path::new(path).file_name())
            .and_then(|name| name.to_str())
            .unwrap_or("Screenshot.png")
            .to_string();
        match crate::workspace::commands::operation(app.clone(), move |store| {
            active_output(&handle, &caller, generation)?;
            store.ingest_screenshot(source.png(), &name)
        })
        .await
        {
            Ok(Some((snapshot, record))) => {
                crate::workspace::commands::broadcast(&app, &snapshot);
                if let Some(record) = record {
                    crate::clipboard_monitor::publish_record(&app, record);
                }
            }
            Ok(None) => {}
            Err(error) => output.warn(format!("输出已完成，加入剪贴板历史失败：{error}")),
        }
    }
    app.state::<crate::screenshot::Service>()
        .finish_warning(generation, &packet, &output);
    Ok(output)
}
