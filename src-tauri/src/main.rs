#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app_paths;
mod clipboard;
mod clipboard_monitor;
mod desktop;
mod desktop_positions;
mod draft_maintenance;
mod draft_startup;
mod events;
mod file_drop;
mod file_search;
mod hotkeys;
mod icons;
mod lan_host;
mod lifecycle;
mod main_window;
mod metrics;
mod notifications;
mod path_menu;
mod platform;
mod productivity_service;
mod prototype_events;
mod quick_capture;
mod release_updates;
mod screenshot;
mod screenshot_api;
mod screenshot_capture;
mod screenshot_editor;
mod screenshot_output;
mod screenshot_pins;
mod screenshot_windows;
mod startup;
mod system;
mod toolbox;
mod widgets;
mod window_release;
mod workspace;
use lifecycle::{application_flushed, application_quit, QuitState};
use system::{system_cancel_picker, system_open, system_pick, SystemService};
use workspace::api::{
    workspace_initialize, workspace_load, workspace_location, workspace_platform,
    workspace_productivity, workspace_save, workspace_window,
};
use workspace::backup_api::{
    workspace_backup_create, workspace_backup_list, workspace_backup_preview,
    workspace_backup_restore, workspace_backup_status, workspace_note_image,
};
use workspace::commands::{
    prototype_workspace_image, prototype_workspace_initialize, prototype_workspace_load,
    prototype_workspace_save, StorageState,
};
use workspace::note_image_api::{workspace_note_clear, workspace_note_import, workspace_note_pick};
use workspace::resource_api::{
    workspace_resources_cancel, workspace_resources_check, ResourceService,
};

use platform::CaptureRect;
use serde::{Deserialize, Serialize};
use std::{path::PathBuf, sync::Mutex};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

#[derive(Default)]
struct ProbeState {
    profiles: PathBuf,
    capture: Mutex<Option<Vec<u8>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
    label: String,
    visible: bool,
    always_on_top: bool,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
    mouse_through: bool,
    opacity: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct MonitorInfo {
    name: String,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    version: String,
    platform: String,
    preview: bool,
    profile_directory: String,
    windows: Vec<WindowInfo>,
    monitors: Vec<MonitorInfo>,
    shortcut_error: Option<String>,
}

fn require_main(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != "main" {
        return Err("此窗口无权调用主窗口命令".into());
    }
    Ok(())
}

fn open_main(app: &tauri::AppHandle) -> Result<(), String> {
    if !std::env::args().any(|argument| argument == "--prototype") {
        main_window::request_show(app);
        return Ok(());
    }
    if !cfg!(debug_assertions) {
        return Err("正式构建不提供原型窗口".into());
    }
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
    }
    let state = app.state::<ProbeState>();
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("prototype.html".into()))
        .title("DustDesk · Tauri 迁移验证")
        .inner_size(1060.0, 740.0)
        .min_inner_size(760.0, 560.0)
        .data_directory(state.profiles.clone())
        .build()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
async fn prototype_open_workspace(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    require_main(&window)?;
    main_window::show(&app).await
}

#[tauri::command]
async fn prototype_diagnostics(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, ProbeState>,
) -> Result<Diagnostics, String> {
    let mut windows = Vec::new();
    for (label, target) in app.webview_windows() {
        let position = target.outer_position().map_err(|error| error.to_string())?;
        let size = target.inner_size().map_err(|error| error.to_string())?;
        let (mouse_through, opacity) = platform::window_flags(&target)?;
        windows.push(WindowInfo {
            label,
            visible: target.is_visible().map_err(|error| error.to_string())?,
            always_on_top: target
                .is_always_on_top()
                .map_err(|error| error.to_string())?,
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            scale_factor: target.scale_factor().map_err(|error| error.to_string())?,
            mouse_through,
            opacity,
        });
    }
    windows.sort_by(|left, right| left.label.cmp(&right.label));
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|monitor| MonitorInfo {
            name: monitor.name().cloned().unwrap_or_default(),
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
            scale_factor: monitor.scale_factor(),
        })
        .collect();
    Ok(Diagnostics {
        version: app.package_info().version.to_string(),
        platform: std::env::consts::OS.into(),
        preview: true,
        profile_directory: state.profiles.display().to_string(),
        windows,
        monitors,
        shortcut_error: hotkeys::error(&app),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowOptions {
    topmost: Option<bool>,
    mouse_through: Option<bool>,
    opacity: Option<u8>,
    x: Option<i32>,
    y: Option<i32>,
    width: Option<u32>,
    height: Option<u32>,
    visible: Option<bool>,
    close: Option<bool>,
}

impl WindowOptions {
    fn validate(&self) -> Result<(), String> {
        if self.opacity.is_some_and(|value| value < 26) {
            return Err("透明度不能低于 10%".into());
        }
        match (self.x, self.y) {
            (Some(x), Some(y)) if x.unsigned_abs() <= 65536 && y.unsigned_abs() <= 65536 => {}
            (None, None) => {}
            _ => return Err("窗口坐标无效".into()),
        }
        match (self.width, self.height) {
            (Some(width), Some(height))
                if (160..=8192).contains(&width) && (100..=8192).contains(&height) => {}
            (None, None) => {}
            _ => return Err("窗口尺寸无效".into()),
        }
        Ok(())
    }
}

#[tauri::command]
async fn prototype_open_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    state: tauri::State<'_, ProbeState>,
    kind: String,
    monitor: Option<usize>,
) -> Result<String, String> {
    require_main(&window)?;
    if !["widget", "pin", "overlay"].contains(&kind.as_str()) {
        return Err("未知原型窗口".into());
    }
    let label = format!("probe-{kind}");
    if let Some(target) = app.get_webview_window(&label) {
        target.show().map_err(|error| error.to_string())?;
        return Ok(label);
    }
    let mut builder = WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::App(format!("prototype.html?probe={kind}").into()),
    )
    .title(format!("DustDesk {kind} 验证"))
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .content_protected(kind == "overlay")
    .inner_size(360.0, 240.0)
    .min_inner_size(160.0, 100.0)
    .data_directory(state.profiles.clone());
    if kind == "overlay" {
        let monitors = window
            .available_monitors()
            .map_err(|error| error.to_string())?;
        let target = monitors.get(monitor.unwrap_or(0)).ok_or("显示器不存在")?;
        let scale = target.scale_factor();
        builder = builder
            .position(
                f64::from(target.position().x) / scale,
                f64::from(target.position().y) / scale,
            )
            .inner_size(
                f64::from(target.size().width) / scale,
                f64::from(target.size().height) / scale,
            )
            .resizable(false);
    }
    let target = builder
        .visible(false)
        .build()
        .map_err(|error| error.to_string())?;
    if kind == "overlay" {
        let monitors = window
            .available_monitors()
            .map_err(|error| error.to_string())?;
        let monitor = monitors.get(monitor.unwrap_or(0)).ok_or("显示器不存在")?;
        target
            .set_position(*monitor.position())
            .map_err(|error| error.to_string())?;
        target
            .set_size(*monitor.size())
            .map_err(|error| error.to_string())?;
    }
    target.show().map_err(|error| error.to_string())?;
    target.set_focus().map_err(|error| error.to_string())?;
    Ok(label)
}

#[tauri::command]
async fn prototype_control_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    label: String,
    options: WindowOptions,
) -> Result<(), String> {
    options.validate()?;
    if window.label() != "main" && window.label() != label {
        return Err("不能控制其他窗口".into());
    }
    if !["main", "probe-widget", "probe-pin", "probe-overlay"].contains(&label.as_str()) {
        return Err("未知窗口".into());
    }
    if label == "main" && (options.mouse_through == Some(true) || options.close == Some(true)) {
        return Err("不能穿透或销毁主控制窗口".into());
    }
    let target = app.get_webview_window(&label).ok_or("窗口不存在")?;
    if let Some(topmost) = options.topmost {
        target
            .set_always_on_top(topmost)
            .map_err(|error| error.to_string())?;
    }
    if let Some(value) = options.mouse_through {
        target
            .set_ignore_cursor_events(value)
            .map_err(|error| error.to_string())?;
    }
    if let Some(value) = options.opacity {
        if value < 26 {
            return Err("透明度不能低于 10%".into());
        }
        platform::set_opacity(&target, value)?;
    }
    match (options.x, options.y) {
        (Some(x), Some(y)) if x.unsigned_abs() <= 65536 && y.unsigned_abs() <= 65536 => target
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| error.to_string())?,
        (None, None) => {}
        _ => return Err("窗口坐标无效".into()),
    }
    match (options.width, options.height) {
        (Some(width), Some(height))
            if (160..=8192).contains(&width) && (100..=8192).contains(&height) =>
        {
            target
                .set_size(tauri::PhysicalSize::new(width, height))
                .map_err(|error| error.to_string())?
        }
        (None, None) => {}
        _ => return Err("窗口尺寸无效".into()),
    }
    if let Some(visible) = options.visible {
        if visible {
            target.show()
        } else {
            target.hide()
        }
        .map_err(|error| error.to_string())?;
    }
    if options.close == Some(true) {
        target.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn prototype_capture_region(
    app: tauri::AppHandle,
    window: WebviewWindow,
    rect: CaptureRect,
) -> Result<tauri::ipc::Response, String> {
    if !["main", "probe-overlay"].contains(&window.label()) {
        return Err("此窗口无截图权限".into());
    }
    rect.validate()?;
    if let Some(overlay) = app.get_webview_window("probe-overlay") {
        overlay.hide().map_err(|error| error.to_string())?;
        for _attempt in 0..100 {
            if !overlay.is_visible().map_err(|error| error.to_string())? {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        if overlay.is_visible().map_err(|error| error.to_string())? {
            return Err("框选窗口尚未隐藏，请重试截图".into());
        }
    }
    let captured = tauri::async_runtime::spawn_blocking(move || platform::capture_region(rect))
        .await
        .map_err(|error| error.to_string())
        .and_then(|result| result);
    let bytes = match captured {
        Ok(bytes) => bytes,
        Err(error) => {
            if let Some(overlay) = app.get_webview_window("probe-overlay") {
                let _ = overlay.show();
                let _ = overlay.set_focus();
            }
            return Err(error);
        }
    };
    *app.state::<ProbeState>()
        .capture
        .lock()
        .map_err(|error| error.to_string())? = Some(bytes.clone());
    if window.label() == "probe-overlay" {
        open_main(&app)?;
        app.emit_to("main", "prototype:captured", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn prototype_read_capture(
    window: WebviewWindow,
    state: tauri::State<'_, ProbeState>,
) -> Result<tauri::ipc::Response, String> {
    if !["main", "probe-pin"].contains(&window.label()) {
        return Err("此窗口无图片读取权限".into());
    }
    let bytes = state
        .capture
        .lock()
        .map_err(|error| error.to_string())?
        .clone()
        .ok_or("尚未捕获图片")?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn prototype_capture_window(
    app: tauri::AppHandle,
    window: WebviewWindow,
    label: String,
) -> Result<tauri::ipc::Response, String> {
    require_main(&window)?;
    if !["probe-widget", "probe-pin"].contains(&label.as_str()) {
        return Err("原型仅允许捕获已创建的验证窗口".into());
    }
    let target = app.get_webview_window(&label).ok_or("窗口不存在")?;
    if !target.is_visible().map_err(|error| error.to_string())? {
        return Err("窗口已隐藏，无法捕获".into());
    }
    #[cfg(windows)]
    let handle = target.hwnd().map_err(|error| error.to_string())?.0 as isize;
    #[cfg(not(windows))]
    let handle = 0isize;
    let bytes = tauri::async_runtime::spawn_blocking(move || platform::capture_window(handle))
        .await
        .map_err(|error| error.to_string())??;
    *app.state::<ProbeState>()
        .capture
        .lock()
        .map_err(|error| error.to_string())? = Some(bytes.clone());
    app.emit_to("main", "prototype:captured", ())
        .map_err(|error| error.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn prototype_update_capture(
    app: tauri::AppHandle,
    window: WebviewWindow,
    png: Vec<u8>,
) -> Result<(), String> {
    require_main(&window)?;
    if png.len() > 48 * 1024 * 1024 {
        return Err("图片超过大小限制".into());
    }
    let decoder = png::Decoder::new(std::io::Cursor::new(&png));
    let mut reader = decoder.read_info().map_err(|error| error.to_string())?;
    let info = reader.info();
    CaptureRect {
        x: 0,
        y: 0,
        width: info.width,
        height: info.height,
    }
    .validate()?;
    if reader.output_buffer_size() > 160_000_000 {
        return Err("图片解码超过限制".into());
    }
    let mut pixels = vec![0; reader.output_buffer_size()];
    reader
        .next_frame(&mut pixels)
        .map_err(|error| error.to_string())?;
    *app.state::<ProbeState>()
        .capture
        .lock()
        .map_err(|error| error.to_string())? = Some(png);
    if app.get_webview_window("probe-pin").is_some() {
        app.emit_to("probe-pin", "prototype:captured", ())
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn restore_windows(app: &tauri::AppHandle) -> Result<(), String> {
    screenshot_pins::restore_all(app)?;
    for (label, window) in app.webview_windows() {
        if label.starts_with("screenshot-pin-") {
            continue;
        }
        if label == "workspace-main" {
            main_window::request_restore(app);
            continue;
        }
        if label == "probe-overlay" {
            window.hide().map_err(|error| error.to_string())?;
            continue;
        }
        window
            .set_ignore_cursor_events(false)
            .map_err(|error| error.to_string())?;
        platform::set_opacity(&window, 255)?;
        window.show().map_err(|error| error.to_string())?;
    }
    open_main(app)
}

#[tauri::command]
async fn prototype_restore_windows(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    require_main(&window)?;
    restore_windows(&app)
}

#[tauri::command]
async fn prototype_quit(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_main(&window)?;
    lifecycle::request(app).await
}

pub(crate) fn refresh_tray(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(tray) = app.tray_by_id("dustdesk-preview") {
        let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let restore =
            MenuItem::with_id(app, "restore", "恢复所有窗口的鼠标操作", true, None::<&str>)
                .map_err(|error| error.to_string())?;
        let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let quit = MenuItem::with_id(app, "quit", "退出 DustDesk", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let quick = MenuItem::with_id(app, "quick-capture", "快速记录", true, None::<&str>)
            .map_err(|error| error.to_string())?;
        let widgets = MenuItem::with_id(
            app,
            "widgets-toggle",
            "显示/隐藏指定桌面组件",
            true,
            None::<&str>,
        )
        .map_err(|error| error.to_string())?;
        let pins = screenshot_pins::tray(app)?;
        let capture = screenshot_capture::tray(app)?;
        let menu = Menu::with_items(
            app,
            &[
                &show, &restore, &update, &quick, &widgets, &capture, &pins, &quit,
            ],
        )
        .map_err(|error| error.to_string())?;
        tray.set_menu(Some(menu))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn setup_services(
    app: &mut tauri::App,
    root: &std::path::Path,
    profiles: PathBuf,
    storage: StorageState,
) -> Result<(), Box<dyn std::error::Error>> {
    app.manage(storage);
    app.manage(QuitState::default());
    app.manage(draft_maintenance::Service::default());
    app.manage(draft_startup::Service::default());
    app.manage(widgets::Service::default());
    app.manage(window_release::Service::default());
    app.manage(main_window::Service::default());
    app.manage(quick_capture::Service::default());
    app.manage(hotkeys::Service::default());
    app.manage(events::Service::default());
    app.manage(screenshot::Service::default());
    app.manage(screenshot_capture::Service::default());
    app.manage(screenshot_editor::Service::default());
    app.manage(screenshot_pins::Service::default());
    app.manage(prototype_events::Service::default());
    app.manage(SystemService::default());
    app.manage(lan_host::Service::new(
        app.handle().clone(),
        root.to_path_buf(),
    ));
    app.manage(file_drop::Service::default());
    app.manage(toolbox::image_store::Service::default());
    app.manage(toolbox::transfer_assets::Service::default());
    app.manage(release_updates::Service::default());
    let desktop = match std::env::var_os("DUSTDESK_TEST_DESKTOP_DIR") {
        Some(value) => PathBuf::from(value),
        None if std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR").is_some() => root.join("Desktop"),
        None => app.path().desktop_dir()?,
    };
    app.manage(desktop::DesktopService::new(desktop)?);
    app.manage(path_menu::MenuService::default());
    app.manage(icons::IconService::default());
    app.manage(file_search::SearchService::default());
    app.manage(metrics::MetricsService::default());
    app.manage(startup::StartupService::new());
    app.manage(clipboard::ClipboardService::default());
    app.manage(clipboard_monitor::MonitorService::default());
    app.manage(ResourceService::default());
    app.manage(productivity_service::ProductivityService::default());
    std::fs::create_dir_all(&profiles)?;
    app.manage(ProbeState {
        profiles,
        ..Default::default()
    });
    Ok(())
}

fn setup_tray(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show = MenuItem::with_id(app, "show", "打开主窗口", true, None::<&str>)?;
    let restore = MenuItem::with_id(app, "restore", "恢复所有窗口的鼠标操作", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 DustDesk", true, None::<&str>)?;
    let update = MenuItem::with_id(app, "update", "检查更新", true, None::<&str>)?;
    let quick = MenuItem::with_id(app, "quick-capture", "快速记录", true, None::<&str>)?;
    let widgets = MenuItem::with_id(
        app,
        "widgets-toggle",
        "显示/隐藏指定桌面组件",
        true,
        None::<&str>,
    )?;
    let pins = screenshot_pins::tray(app)?;
    let capture = screenshot_capture::tray(app)?;
    let menu = Menu::with_items(
        app,
        &[
            &show, &restore, &update, &quick, &widgets, &capture, &pins, &quit,
        ],
    )?;
    TrayIconBuilder::with_id("dustdesk-preview")
        .icon(app.default_window_icon().ok_or("缺少应用图标")?.clone())
        .tooltip("DustDesk")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let _ = open_main(app);
            }
            "restore" => {
                let _ = restore_windows(app);
            }
            "quit" => lifecycle::request_from_native(app),
            "update" => release_updates::request_from_tray(app),
            "quick-capture" => quick_capture::request_show(app),
            "widgets-toggle" => widgets::request_toggle_configured(app),
            _ => {
                screenshot_capture::request_native(app, event.id.as_ref());
                screenshot_pins::request_native(app, event.id.as_ref());
            }
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } | TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                let _ = open_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn application_builder() -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            prototype_diagnostics,
            prototype_open_window,
            prototype_control_window,
            prototype_capture_region,
            prototype_read_capture,
            prototype_capture_window,
            prototype_update_capture,
            prototype_restore_windows,
            prototype_quit,
            prototype_open_workspace,
            workspace_load,
            workspace_save,
            workspace_initialize,
            workspace_location,
            workspace_platform,
            workspace_productivity,
            hotkeys::hotkeys_set,
            hotkeys::hotkeys_status,
            quick_capture::quick_capture_show,
            quick_capture::quick_capture_hide,
            quick_capture::quick_capture_abort,
            quick_capture::quick_capture_request_hide,
            quick_capture::quick_capture_committed,
            quick_capture::quick_capture_save,
            quick_capture::quick_capture_events_attach,
            quick_capture::quick_capture_events_detach,
            workspace_backup_create,
            workspace_backup_list,
            workspace_backup_preview,
            workspace_backup_restore,
            workspace_backup_status,
            workspace_note_image,
            workspace_note_import,
            workspace_note_pick,
            workspace_note_clear,
            workspace_resources_check,
            workspace_resources_cancel,
            system_open,
            system_pick,
            icons::system_icon,
            desktop::system_desktop_entries,
            workspace::organizer_api::workspace_organizer,
            file_search::system_search_files,
            file_search::system_search_cancel,
            metrics::system_sample,
            startup::system_startup,
            clipboard::clipboard_read,
            clipboard::clipboard_write,
            clipboard::clipboard_preview,
            path_menu::system_path_menu,
            system_cancel_picker,
            workspace_window,
            widgets::widgets_visibility,
            widgets::widgets_set,
            widgets::widgets_options,
            widgets::widgets_geometry,
            widgets::widgets_presets,
            window_release::window_release_ready,
            events::widget_events_attach,
            screenshot_api::screenshot_create,
            screenshot_api::screenshot_import,
            screenshot_api::screenshot_document,
            screenshot_api::screenshot_source,
            screenshot_api::screenshot_discard,
            screenshot_api::screenshot_finish,
            screenshot_editor::screenshot_editor_pending,
            screenshot_editor::screenshot_editor_received,
            screenshot_pins::screenshot_pin_info,
            screenshot_pins::screenshot_pin_source,
            screenshot_pins::screenshot_pin_control,
            screenshot_pins::screenshot_pin_save,
            screenshot_pins::screenshot_pin_attach,
            screenshot_pins::screenshot_pin_detach,
            screenshot_windows::screenshot_windows,
            screenshot_windows::screenshot_capture_window,
            screenshot_capture::screenshot_start,
            screenshot_capture::screenshot_overlay_document,
            screenshot_capture::screenshot_overlay_source,
            screenshot_capture::screenshot_overlay_finish,
            screenshot_capture::screenshot_overlay_cancel,
            screenshot_capture::screenshot_overlay_region,
            screenshot_capture::screenshot_overlay_adopt,
            screenshot_capture::screenshot_overlay_events_attach,
            screenshot_capture::screenshot_overlay_events_detach,
            screenshot_capture::screenshot_overlay_checkpoint,
            prototype_events::prototype_event_attach,
            prototype_events::prototype_event_detach,
            events::widget_events_detach,
            application_quit,
            application_flushed,
            draft_maintenance::drafts_prepare,
            draft_maintenance::drafts_checkpoint_ready,
            draft_maintenance::drafts_end,
            draft_maintenance::drafts_transaction,
            workspace::draft_browser::drafts_recovery,
            workspace::draft_import::drafts_pick,
            workspace::draft_export::drafts_export,
            workspace::snapshot_preparation::data_snapshot_prepare,
            workspace::handoff_snapshot::handoff_snapshot_prepare,
            workspace::legacy_source::legacy_source_inspect,
            workspace::draft_import::drafts_import_state,
            workspace::project_export::projects_export,
            toolbox::toolbox_export_text,
            toolbox::toolbox_copy_text,
            lan_host::toolbox_lan_attach,
            lan_host::toolbox_lan_snapshot,
            lan_host::toolbox_lan_enable,
            lan_host::toolbox_lan_connect,
            lan_host::toolbox_lan_send,
            lan_host::toolbox_lan_control,
            file_drop::file_drop_attach,
            file_drop::file_drop_detach,
            toolbox::image_api::toolbox_pick,
            toolbox::image_api::toolbox_register_paths,
            toolbox::image_api::toolbox_import_image,
            toolbox::image_api::toolbox_read_asset,
            toolbox::image_api::toolbox_release_assets,
            toolbox::image_api::toolbox_begin_image_export,
            toolbox::image_api::toolbox_export_image,
            toolbox::image_api::toolbox_end_image_export,
            release_updates::release_check,
            draft_startup::drafts_startup_done,
            draft_startup::drafts_startup_wait,
            draft_startup::drafts_startup_retry,
            draft_maintenance::drafts_verify,
            prototype_workspace_initialize,
            prototype_workspace_load,
            prototype_workspace_save,
            prototype_workspace_image
        ])
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                prototype_events::reset(webview.app_handle(), webview.label());
                if webview.label() == quick_capture::LABEL {
                    quick_capture::navigated(webview.app_handle(), webview.label());
                    window_release::cancel(webview.app_handle(), webview.label());
                    webview
                        .app_handle()
                        .state::<events::Service>()
                        .destroyed(webview.label());
                }
                screenshot_capture::navigated(webview.app_handle(), webview.label());
                screenshot_editor::cancel_window(webview.app_handle(), webview.label());
                if webview.label() == "workspace-main" {
                    webview
                        .app_handle()
                        .state::<lan_host::Service>()
                        .navigated();
                    webview
                        .app_handle()
                        .state::<toolbox::transfer_assets::Service>()
                        .reset();
                    screenshot_capture::reset_main(webview.app_handle());
                    webview.app_handle().state::<file_drop::Service>().reset();
                    webview
                        .app_handle()
                        .state::<screenshot::Service>()
                        .reset_main();
                    webview
                        .app_handle()
                        .state::<toolbox::image_store::Service>()
                        .reset();
                    webview.app_handle().state::<SystemService>().release_main();
                    webview
                        .app_handle()
                        .state::<release_updates::Service>()
                        .cancel();
                }
                draft_maintenance::participant_lost(webview.app_handle(), webview.label());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) =
                event
            {
                file_drop::dropped(
                    window.app_handle(),
                    window.label(),
                    paths.clone(),
                    *position,
                );
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                screenshot_capture::destroyed(window.app_handle(), window.label());
                if window.label() == quick_capture::LABEL {
                    window_release::cancel(window.app_handle(), window.label());
                    window
                        .app_handle()
                        .state::<events::Service>()
                        .destroyed(window.label());
                    quick_capture::destroyed(window.app_handle());
                }
                prototype_events::reset(window.app_handle(), window.label());
                draft_maintenance::participant_lost(window.app_handle(), window.label());
                widgets::destroyed(window.app_handle(), window.label());
                if window.label() == "workspace-main" {
                    window.app_handle().state::<lan_host::Service>().navigated();
                    window
                        .app_handle()
                        .state::<toolbox::transfer_assets::Service>()
                        .reset();
                    screenshot_capture::reset_main(window.app_handle());
                    window.app_handle().state::<file_drop::Service>().reset();
                    window
                        .app_handle()
                        .state::<screenshot::Service>()
                        .reset_main();
                    window
                        .app_handle()
                        .state::<toolbox::image_store::Service>()
                        .reset();
                    window
                        .app_handle()
                        .state::<release_updates::Service>()
                        .cancel();
                    window
                        .app_handle()
                        .state::<file_search::SearchService>()
                        .release_owner("workspace-main");
                    window.app_handle().state::<SystemService>().release_main();
                    window
                        .app_handle()
                        .state::<desktop::DesktopService>()
                        .release();
                    window
                        .app_handle()
                        .state::<path_menu::MenuService>()
                        .cancel();
                }
                window
                    .app_handle()
                    .state::<ResourceService>()
                    .cancel(window.label(), None);
                if window.label() == "workspace-main" {
                    main_window::destroying(window.app_handle(), false);
                }
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == quick_capture::LABEL {
                    api.prevent_close();
                    quick_capture::request_hide(window.app_handle());
                }
                if window
                    .app_handle()
                    .state::<widgets::Service>()
                    .key(window.label())
                    .is_some()
                {
                    api.prevent_close();
                    widgets::close_requested(window.app_handle(), window.label());
                }
                if window.label() == "workspace-main" {
                    api.prevent_close();
                    if let Some(target) = window.app_handle().get_webview_window(window.label()) {
                        main_window::request_hide(window.app_handle(), &target);
                    }
                }
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if matches!(
                event,
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
            ) {
                if window.label() == "workspace-main" {
                    if let Some(target) = window.app_handle().get_webview_window(window.label()) {
                        let _ = main_window::remember(window.app_handle(), &target);
                    }
                }
                widgets::geometry_event(window.app_handle(), window.label());
            }
        })
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    if !cfg!(debug_assertions) && std::env::args().any(|argument| argument == "--prototype") {
        return Err("正式构建不提供原型窗口".into());
    }
    application_builder()
        .plugin(tauri_plugin_single_instance::init(|app, args, _| {
            if args.iter().any(|argument| argument == "--workspace") {
                main_window::request_show(app);
            } else {
                let _ = open_main(app);
            }
        }))
        .setup(|app| {
            let testing = std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR");
            let root = match testing.as_ref() {
                Some(value) => {
                    let path = PathBuf::from(value);
                    if !path.is_absolute() {
                        return Err("测试用户目录必须为绝对路径".into());
                    }
                    path.join("tauri-preview")
                }
                None => {
                    platform::legacy_processes::require_stopped()?;
                    let roaming = app.path().config_dir()?;
                    let current = roaming.join("DustDesk.Next");
                    let candidates = [
                        current.clone(),
                        roaming.join("dustdesk-electron"),
                        roaming.join("DustDesk"),
                    ];
                    let mut existing = candidates
                        .into_iter()
                        .filter(|path| path.join("LanTransfers").is_dir());
                    let selected = existing.next().unwrap_or(current);
                    if existing.next().is_some() {
                        return Err("发现多个局域网身份目录，未自动选择或覆盖".into());
                    }
                    selected
                }
            };
            let workspace = if testing.is_some() {
                root.join("Workspace")
            } else {
                app_paths::workspace()?
            };
            let profiles = root.join("WebView2");
            let auto_initialize = testing.is_none()
                || !std::env::args()
                    .any(|arg| ["--workspace", "--prototype"].contains(&arg.as_str()));
            let storage = if auto_initialize {
                StorageState::application(workspace.clone())
            } else {
                StorageState::new(workspace.clone())
            };
            setup_services(app, &root, profiles, storage)?;
            if draft_startup::needs_recovery(&workspace) {
                if let Err(error) = draft_startup::start(app.handle()) {
                    eprintln!("启动恢复失败，后台服务保持停止：{error}");
                }
            } else {
                draft_startup::restore_services(app.handle());
            }
            setup_tray(app.handle())?;
            if !std::env::args().any(|argument| argument == "--hidden") {
                if std::env::args().any(|argument| argument == "--prototype") {
                    open_main(app.handle())?;
                } else {
                    let handle = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        let hidden = workspace::commands::operation(handle.clone(), |store| {
                            Ok(store.widget_load()?.state["Settings"]["StartHiddenToTray"] == true)
                        })
                        .await
                        .unwrap_or(false);
                        if !hidden {
                            main_window::request_show(&handle);
                        }
                    });
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())?
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if !app.state::<QuitState>().committing() {
                    api.prevent_exit();
                    if code.is_some() || !app.webview_windows().is_empty() {
                        lifecycle::request_from_native(app);
                    }
                }
            }
        });
    Ok(())
}

fn main() {
    #[cfg(all(windows, debug_assertions))]
    if std::env::args().any(|argument| argument == "--legacy-runtime-preview-v1") {
        let result = dustdesk_tauri::legacy_source::bridge::runtime_stdio().and_then(|launch| {
            launch
                .map(workspace::runtime_boot::run)
                .transpose()
                .map(|_| ())
        });
        if let Err(error) = result {
            eprintln!("隔离运行启动失败：{error}");
            std::process::exit(1);
        }
        return;
    }
    let result = if std::env::args().any(|argument| argument == "--legacy-source-lease-v1") {
        dustdesk_tauri::legacy_source::bridge::run_stdio()
    } else if std::env::args().any(|argument| argument == "--legacy-source-snapshot-v1") {
        dustdesk_tauri::legacy_source::bridge::run_snapshot_stdio()
    } else {
        run().map_err(|error| error.to_string())
    };
    if let Err(error) = result {
        eprintln!("DustDesk: {error}");
        #[cfg(windows)]
        if std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR").is_none()
            && !std::env::args().any(|arg| arg.starts_with("--legacy-"))
        {
            use windows::core::{w, HSTRING};
            use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};
            unsafe {
                MessageBoxW(
                    None,
                    &HSTRING::from(error),
                    w!("DustDesk 无法启动"),
                    MB_OK | MB_ICONERROR,
                );
            }
        }
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(value: serde_json::Value) -> WindowOptions {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn window_options_reject_invalid_partial_updates_before_mutation() {
        assert!(
            options(serde_json::json!({ "topmost": true, "opacity": 0 }))
                .validate()
                .is_err()
        );
        assert!(options(serde_json::json!({ "x": 10 })).validate().is_err());
        assert!(options(serde_json::json!({ "width": 360 }))
            .validate()
            .is_err());
        assert!(
            options(serde_json::json!({ "width": 100000, "height": 100 }))
                .validate()
                .is_err()
        );
        assert!(options(serde_json::json!({ "x": -1920, "y": -100, "opacity": 128, "width": 360, "height": 240 })).validate().is_ok());
    }
}
