use crate::{
    screenshot::Document,
    screenshot_output::{Action, Output, Packet},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{
    ipc::{Channel, InvokeBody, Request, Response},
    menu::{CheckMenuItem, Menu, MenuItem, Submenu},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const MAX_PINS: usize = 32;
const MAX_PIN_BYTES: usize = 256 * 1024 * 1024;
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Options {
    opacity: f64,
    topmost: bool,
    locked: bool,
    mouse_through: bool,
}
impl Options {
    fn from_settings(settings: &Value) -> Self {
        Self {
            opacity: settings["PinnedImageOpacityPercent"]
                .as_f64()
                .unwrap_or(100.0)
                .clamp(20.0, 100.0),
            topmost: settings["PinnedImageTopmost"] != false,
            locked: false,
            mouse_through: settings["PinnedImageMouseThrough"] == true,
        }
    }
}
#[derive(Clone)]
struct Pin {
    id: String,
    label: String,
    document: Document,
    png: Arc<[u8]>,
    version: u64,
    options: Options,
}
struct LastOutput {
    png: Arc<[u8]>,
    width: u32,
    height: u32,
}
#[derive(Clone, Serialize)]
pub struct Event {
    token: String,
    event: String,
    payload: Value,
}
pub struct Service {
    events: Mutex<HashMap<String, (String, Channel<Event>)>>,
    pins: Mutex<HashMap<String, Pin>>,
    edits: Mutex<HashMap<String, (String, u64)>>,
    gate: tokio::sync::Mutex<()>,
    last_output: Mutex<Option<LastOutput>>,
    reads: Arc<tokio::sync::Semaphore>,
    operations: Arc<tokio::sync::Semaphore>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            events: Mutex::default(),
            pins: Mutex::default(),
            edits: Mutex::default(),
            gate: tokio::sync::Mutex::default(),
            last_output: Mutex::default(),
            reads: Arc::new(tokio::sync::Semaphore::new(2)),
            operations: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}
impl Service {
    fn send(&self, label: &str, event: &str, payload: Value) -> Result<(), String> {
        let mut events = self.events.lock().map_err(|error| error.to_string())?;
        if let Some((token, channel)) = events.get(label) {
            if let Err(error) = channel.send(Event {
                token: token.clone(),
                event: event.into(),
                payload,
            }) {
                events.remove(label);
                return Err(error.to_string());
            }
        }
        Ok(())
    }
    pub fn busy(&self) -> bool {
        self.operations.available_permits() < 4 || self.gate.try_lock().is_err()
    }
    fn get(&self, id: &str) -> Result<Pin, String> {
        self.pins
            .lock()
            .map_err(|error| error.to_string())?
            .get(id)
            .cloned()
            .ok_or("贴图已关闭".into())
    }
    fn budget(&self, id: Option<&str>, length: usize) -> Result<(), String> {
        let pins = self.pins.lock().map_err(|error| error.to_string())?;
        if id.is_none() && pins.len() >= MAX_PINS
            || pins
                .values()
                .filter(|pin| Some(pin.id.as_str()) != id)
                .map(|pin| pin.png.len())
                .sum::<usize>()
                .saturating_add(length)
                > MAX_PIN_BYTES
        {
            return Err("贴图占用较多内存，请关闭部分贴图后重试".into());
        }
        Ok(())
    }
}
pub fn require(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    if !crate::main_window::current(app, window) {
        return Err("贴图窗口已失效".into());
    }
    let id = window
        .label()
        .strip_prefix("screenshot-pin-")
        .ok_or("不是贴图窗口")?;
    let pin = app.state::<Service>().get(id)?;
    if pin.label != window.label() {
        return Err("此窗口无贴图权限".into());
    }
    Ok(())
}
fn owned(app: &tauri::AppHandle, window: &WebviewWindow, id: &str) -> Result<Pin, String> {
    require(app, window)?;
    let pin = app.state::<Service>().get(id)?;
    if pin.label != window.label() {
        return Err("此窗口无贴图权限".into());
    }
    Ok(pin)
}
pub fn destroyed(app: &tauri::AppHandle, label: &str) {
    if let Ok(mut events) = app.state::<Service>().events.lock() {
        events.remove(label);
    }
    if let Ok(mut edits) = app.state::<Service>().edits.lock() {
        edits.remove(label);
    }
    let pin = app
        .state::<Service>()
        .pins
        .lock()
        .ok()
        .and_then(|mut pins| {
            let id = pins
                .values()
                .find(|pin| pin.label == label)
                .map(|pin| pin.id.clone())?;
            pins.remove(&id)
        });
    if let Some(pin) = pin {
        let _ = app
            .state::<crate::screenshot::Service>()
            .remove_owned(&pin.document.id, Some(label));
        app.state::<crate::system::SystemService>()
            .cancel_picker_for(label);
        let _ = crate::refresh_tray(app);
    }
}
pub fn emit(
    app: &tauri::AppHandle,
    label: &str,
    event: &str,
    payload: Value,
) -> Result<(), String> {
    if !matches!(event, "pin:changed" | "pin:save" | "pin:error") {
        return Err("贴图事件未授权".into());
    }
    app.state::<Service>().send(label, event, payload)
}
#[tauri::command]
pub fn screenshot_pin_attach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    channel: Channel<Event>,
) -> Result<String, String> {
    require(&app, &window)?;
    let token = uuid::Uuid::new_v4().to_string();
    app.state::<Service>()
        .events
        .lock()
        .map_err(|error| error.to_string())?
        .insert(window.label().into(), (token.clone(), channel));
    Ok(token)
}
#[tauri::command]
pub fn screenshot_pin_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<(), String> {
    require(&app, &window)?;
    let service = app.state::<Service>();
    let mut events = service.events.lock().map_err(|error| error.to_string())?;
    if events
        .get(window.label())
        .is_some_and(|(current, _)| current == &token)
    {
        events.remove(window.label());
    }
    Ok(())
}
fn native_options(window: &WebviewWindow, options: &Options) -> Result<(), String> {
    window
        .set_always_on_top(options.topmost)
        .map_err(|error| error.to_string())?;
    window
        .set_resizable(!options.locked)
        .map_err(|error| error.to_string())?;
    window
        .set_ignore_cursor_events(options.mouse_through)
        .map_err(|error| error.to_string())?;
    crate::platform::set_opacity(window, (options.opacity * 255.0 / 100.0).round() as u8)
}
fn open_pin_window(app: &tauri::AppHandle, pin: &Pin) -> Result<(), String> {
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let monitor = app
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|monitor| {
            let origin = monitor.position();
            let size = monitor.size();
            cursor.x >= f64::from(origin.x)
                && cursor.y >= f64::from(origin.y)
                && cursor.x < f64::from(origin.x) + f64::from(size.width)
                && cursor.y < f64::from(origin.y) + f64::from(size.height)
        })
        .or(app.primary_monitor().map_err(|error| error.to_string())?)
        .ok_or("未找到显示器")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let fit = (1.0 / scale)
        .min(f64::from(area.size.width) / scale * 0.7 / pin.document.crop.width)
        .min(f64::from(area.size.height) / scale * 0.7 / pin.document.crop.height);
    let target = WebviewWindowBuilder::new(
        app,
        &pin.label,
        WebviewUrl::App(format!("pin.html?pin={}", pin.id).into()),
    )
    .title("DustDesk 贴图")
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .always_on_top(pin.options.topmost)
    .skip_taskbar(true)
    .resizable(!pin.options.locked)
    .visible(false)
    .inner_size(
        (pin.document.crop.width * fit).round().max(64.0),
        (pin.document.crop.height * fit).round().max(48.0),
    )
    .min_inner_size(32.0, 32.0)
    .data_directory(app.state::<crate::ProbeState>().profiles.clone())
    .build()
    .map_err(|error| error.to_string())?;
    target
        .set_position(tauri::PhysicalPosition::new(
            area.position
                .x
                .saturating_add((40.0 * scale).round() as i32),
            area.position
                .y
                .saturating_add((40.0 * scale).round() as i32),
        ))
        .map_err(|error| error.to_string())?;
    target
        .set_size(tauri::LogicalSize::new(
            (pin.document.crop.width * fit).round().max(64.0),
            (pin.document.crop.height * fit).round().max(48.0),
        ))
        .map_err(|error| error.to_string())?;
    native_options(&target, &pin.options)?;
    Ok(())
}

// Match Electron's lastScreenshotDataUrl: the last successful editor output,
// including annotations. Cancelled captures and direct clipboard imports do
// not replace it. Retain at most one bounded rendered PNG.
pub fn remember_output(app: &tauri::AppHandle, packet: &Packet) -> Result<(), String> {
    *app.state::<Service>()
        .last_output
        .lock()
        .map_err(|error| error.to_string())? = Some(LastOutput {
        png: Arc::from(packet.png()),
        width: packet.metadata.document.crop.width as u32,
        height: packet.metadata.document.crop.height as u32,
    });
    Ok(())
}
fn native_ready(app: &tauri::AppHandle) -> Result<(), String> {
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()
}
async fn from_clipboard(app: &tauri::AppHandle) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let guard = gate.lock().await;
    native_ready(app)?;
    let operation = app
        .state::<Service>()
        .operations
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理贴图，请稍后重试")?;
    let clipboard = app
        .state::<crate::clipboard::ClipboardService>()
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "剪贴板正忙，请稍后重试")?;
    // A timed out Win32 clipboard read may still be running. Its worker retains
    // both permits until it exits; a late result can never create a window.
    let worker = tauri::async_runtime::spawn_blocking(move || {
        let _clipboard = clipboard;
        let result = crate::platform::clipboard::read_image();
        (operation, result)
    });
    drop(guard);
    let (_operation, decoded) = tokio::time::timeout(std::time::Duration::from_secs(10), worker)
        .await
        .map_err(|_| "读取剪贴板超时，请稍后重试")?
        .map_err(|error| error.to_string())?;
    let decoded = match decoded? {
        Some(decoded) => decoded,
        None => {
            let service = app.state::<Service>();
            let last = service
                .last_output
                .lock()
                .map_err(|error| error.to_string())?;
            let last = last
                .as_ref()
                .ok_or("剪贴板中没有图片，请先截图或复制一张图片")?;
            crate::screenshot::Decoded {
                png: last.png.to_vec(),
                width: last.width,
                height: last.height,
            }
        }
    };
    let _guard = gate.lock().await;
    native_ready(app)?;
    let settings =
        crate::workspace::commands::operation(app.clone(), |store| store.screenshot_settings())
            .await?;
    native_ready(app)?;
    let service = app.state::<Service>();
    let _pins = service
        .gate
        .try_lock()
        .map_err(|_| "正在更新贴图，请稍后重试")?;
    service.budget(None, decoded.png.len())?;
    let id = uuid::Uuid::new_v4().to_string();
    let label = format!("screenshot-pin-{id}");
    let sessions = app.state::<crate::screenshot::Service>();
    let document = sessions.create_owned(sessions.generation()?, decoded, &label, || {
        native_ready(app)
    })?;
    let publication = (|| {
        let (_, png) = sessions.read_owned(&document.id, &label)?;
        let pin = Pin {
            id: id.clone(),
            label: label.clone(),
            document: document.clone(),
            png,
            version: 0,
            options: Options::from_settings(&settings),
        };
        open_pin_window(app, &pin)?;
        native_ready(app)?;
        service
            .pins
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id.clone(), pin);
        app.get_webview_window(&label)
            .ok_or("贴图窗口已关闭")?
            .show()
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if publication.is_err() {
        if let Ok(mut pins) = service.pins.lock() {
            pins.remove(&id);
        }
        let _ = sessions.remove_owned(&document.id, Some(&label));
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
    let _ = crate::refresh_tray(app);
    publication
}
pub fn request_clipboard(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = from_clipboard(&app).await {
            eprintln!("剪贴板贴图失败：{error}");
            let _ =
                crate::events::emit(&app, "workspace-main", "system:action-error", error.clone());
            if let Some(tray) = app.tray_by_id("dustdesk-preview") {
                let _ = tray.set_tooltip(Some(format!(
                    "DustDesk · {}",
                    error.chars().take(300).collect::<String>()
                )));
            }
        }
    });
}

pub async fn publish(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    generation: u64,
    packet: Arc<Packet>,
    settings: &Value,
) -> Result<Output, String> {
    let service = app.state::<Service>();
    let _guard = service
        .gate
        .try_lock()
        .map_err(|_| "正在更新贴图，请稍后重试")?;
    crate::screenshot_capture::require(app, window)?;
    let previous = if packet.metadata.action == Action::UpdatePin {
        let (id, version) = service
            .edits
            .lock()
            .map_err(|error| error.to_string())?
            .get(window.label())
            .cloned()
            .ok_or("此编辑窗口没有可更新的原贴图")?;
        let pin = service.get(&id)?;
        if pin.version != version || packet.metadata.document.target_pin_id.as_deref() != Some(&id)
        {
            return Err("原贴图已更新，请重新编辑后再更新，或创建新贴图".into());
        }
        Some(pin)
    } else {
        None
    };
    service.budget(
        previous.as_ref().map(|pin| pin.id.as_str()),
        packet.png().len(),
    )?;
    let id = previous
        .as_ref()
        .map(|pin| pin.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let label = format!("screenshot-pin-{id}");
    let document = app.state::<crate::screenshot::Service>().snapshot_owned(
        generation,
        &packet,
        window.label(),
        &label,
        || crate::screenshot_capture::require(app, window),
    )?;
    let pin = Pin {
        id: id.clone(),
        label: label.clone(),
        document: document.clone(),
        png: Arc::from(packet.png()),
        version: previous.as_ref().map(|pin| pin.version + 1).unwrap_or(0),
        options: previous
            .as_ref()
            .map(|pin| pin.options.clone())
            .unwrap_or_else(|| Options::from_settings(settings)),
    };
    let publication = (|| {
        if previous.is_none() {
            open_pin_window(app, &pin)?;
        }
        let target = app.get_webview_window(&label).ok_or("贴图窗口已关闭")?;
        let result = app.state::<crate::screenshot::Service>().transact_owned(
            generation,
            &packet,
            window.label(),
            || crate::screenshot_capture::require(app, window),
            || {
                let mut pins = service.pins.lock().map_err(|error| error.to_string())?;
                if let Some(previous) = &previous {
                    if pins
                        .get(&id)
                        .is_none_or(|current| current.version != previous.version)
                    {
                        return Err("原贴图已关闭或更新".into());
                    }
                }
                pins.insert(id.clone(), pin.clone());
                if let Err(error) = target.show() {
                    if let Some(previous) = &previous {
                        pins.insert(id.clone(), previous.clone());
                    } else {
                        pins.remove(&id);
                    }
                    return Err(error.to_string());
                }
                Ok(Output {
                    ok: true,
                    pin_id: Some(id.clone()),
                    ..Output::default()
                })
            },
        )?;
        Ok(result)
    })();
    match publication {
        Ok(output) => {
            if let Some(previous) = previous {
                let _ = app
                    .state::<crate::screenshot::Service>()
                    .remove_owned(&previous.document.id, Some(&label));
            }
            let _ = crate::events::emit(app, &label, "pin:changed", ());
            let _ = crate::refresh_tray(app);
            Ok(output)
        }
        Err(error) => {
            let _ = app
                .state::<crate::screenshot::Service>()
                .remove_owned(&document.id, Some(&label));
            if previous.is_none() {
                if let Some(target) = app.get_webview_window(&label) {
                    let _ = target.destroy();
                }
            }
            Err(error)
        }
    }
}
#[tauri::command]
pub fn screenshot_pin_info(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<Value, String> {
    let pin = owned(&app, &window, &id)?;
    let mut value = serde_json::to_value(&pin.options).map_err(|error| error.to_string())?;
    value["ok"] = json!(true);
    value["version"] = json!(pin.version);
    value["width"] = json!(pin.document.crop.width);
    value["height"] = json!(pin.document.crop.height);
    Ok(value)
}
#[tauri::command]
pub async fn screenshot_pin_source(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
    version: u64,
) -> Result<Response, String> {
    let permit = app
        .state::<Service>()
        .reads
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在读取贴图，请稍后重试")?;
    let pin = owned(&app, &window, &id)?;
    if pin.version != version {
        return Err("贴图已更新，请重试读取".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        if owned(&app, &window, &id)?.version != version {
            return Err("贴图已更新，请重试读取".into());
        }
        Ok(Response::new(pin.png.to_vec()))
    })
    .await
    .map_err(|error| error.to_string())?
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    opacity: Option<f64>,
    topmost: Option<bool>,
    locked: Option<bool>,
    mouse_through: Option<bool>,
    x: Option<f64>,
    y: Option<f64>,
    width: Option<f64>,
    height: Option<f64>,
}
fn changed_options(options: &Options, change: &Change) -> Result<Options, String> {
    if change.opacity.is_some_and(|opacity| !opacity.is_finite()) {
        return Err("贴图透明度无效".into());
    }
    Ok(Options {
        opacity: change.opacity.unwrap_or(options.opacity).clamp(20.0, 100.0),
        topmost: change.topmost.unwrap_or(options.topmost),
        locked: change.locked.unwrap_or(options.locked),
        mouse_through: change.mouse_through.unwrap_or(options.mouse_through),
    })
}
async fn output(
    app: tauri::AppHandle,
    window: WebviewWindow,
    pin: Pin,
    action: Action,
    jpeg: Vec<u8>,
) -> Result<Output, String> {
    let _guard = app
        .state::<Service>()
        .operations
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理贴图输出，请稍后重试")?;
    let packet = Packet::prepared(pin.document, action, &pin.png, &jpeg)?;
    crate::screenshot_api::finish_bytes(app, window, packet.into_bytes(), false).await
}
async fn control(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
    action: String,
    value: Change,
) -> Result<(), String> {
    let pin = owned(&app, &window, &id)?;
    match action.as_str() {
        "close" => {
            app.state::<crate::system::SystemService>()
                .cancel_picker_for(window.label());
            window.destroy().map_err(|error| error.to_string())?;
        }
        "copy" => {
            output(app, window, pin, Action::Copy, Vec::new()).await?;
        }
        "save" => {
            crate::events::emit(&app, window.label(), "pin:save", ())?;
        }
        "edit" => {
            crate::screenshot_capture::edit_pin(
                &app,
                &window,
                &pin.id,
                &pin.document.id,
                pin.version,
            )
            .await?;
        }
        "options" => {
            let service = app.state::<Service>();
            let _guard = service
                .gate
                .try_lock()
                .map_err(|_| "正在更新贴图，请稍后重试")?;
            let pin = owned(&app, &window, &id)?;
            let next = changed_options(&pin.options, &value)?;
            if let Err(error) = native_options(&window, &next) {
                let _ = native_options(&window, &pin.options);
                return Err(error);
            }
            let service = app.state::<Service>();
            let mut pins = service.pins.lock().map_err(|error| error.to_string())?;
            pins.get_mut(&id).ok_or("贴图已关闭")?.options = next;
            drop(pins);
            crate::events::emit(&app, window.label(), "pin:changed", ())?;
            crate::refresh_tray(&app)?;
        }
        "move" if !pin.options.locked => {
            let (Some(horizontal), Some(vertical)) = (value.x, value.y) else {
                return Err("贴图位置无效".into());
            };
            if !horizontal.is_finite() || !vertical.is_finite() {
                return Err("贴图位置无效".into());
            }
            window
                .set_position(tauri::LogicalPosition::new(
                    horizontal.clamp(-32768.0, 32768.0).round(),
                    vertical.clamp(-32768.0, 32768.0).round(),
                ))
                .map_err(|error| error.to_string())?;
        }
        "resize" | "original" if !pin.options.locked => {
            let monitor = window
                .current_monitor()
                .map_err(|error| error.to_string())?
                .ok_or("未找到显示器")?;
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let ratio = pin.document.crop.width / pin.document.crop.height;
            let width = if action == "original" {
                pin.document.crop.width / scale
            } else {
                value.width.ok_or("贴图尺寸无效")?
            };
            if !width.is_finite() || value.height.is_some_and(|height| !height.is_finite()) {
                return Err("贴图尺寸无效".into());
            }
            let width = width
                .min(f64::from(area.size.width) / scale * 2.0)
                .min(f64::from(area.size.height) / scale * 2.0 * ratio)
                .max(32.0);
            window
                .set_size(tauri::LogicalSize::new(
                    width.round(),
                    (width / ratio).round().max(32.0),
                ))
                .map_err(|error| error.to_string())?;
        }
        "move" | "resize" | "original" => {}
        "menu" => {
            let menu = pin_menu(&app, &pin)?;
            window
                .popup_menu(&menu)
                .map_err(|error| error.to_string())?;
        }
        _ => return Err("贴图操作无效".into()),
    }
    Ok(())
}
#[tauri::command]
pub async fn screenshot_pin_control(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
    action: String,
    value: Option<Change>,
) -> Result<(), String> {
    control(app, window, id, action, value.unwrap_or_default()).await
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Save {
    id: String,
    version: u64,
}
#[tauri::command]
pub async fn screenshot_pin_save(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<Output, String> {
    require(&app, &window)?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("贴图保存必须以二进制传输".into());
    };
    if bytes.len() < 4 || bytes.len() > 4 + 1024 + crate::screenshot::MAX_BYTES {
        return Err("贴图保存数据无效或过大".into());
    }
    let length = u32::from_le_bytes(bytes[..4].try_into().unwrap()) as usize;
    if length == 0 || length > 1024 || 4 + length >= bytes.len() {
        return Err("贴图保存元数据无效".into());
    }
    let metadata: Save =
        serde_json::from_slice(&bytes[4..4 + length]).map_err(|error| error.to_string())?;
    let pin = owned(&app, &window, &metadata.id)?;
    if pin.version != metadata.version {
        return Err("贴图已更新，请重新保存".into());
    }
    output(
        app,
        window,
        pin,
        Action::SaveAs,
        bytes[4 + length..].to_vec(),
    )
    .await
}
pub fn register_edit(
    app: &tauri::AppHandle,
    label: &str,
    id: &str,
    version: u64,
) -> Result<(), String> {
    if app.state::<Service>().get(id)?.version != version {
        return Err("原贴图已更新".into());
    }
    app.state::<Service>()
        .edits
        .lock()
        .map_err(|error| error.to_string())?
        .insert(label.into(), (id.into(), version));
    Ok(())
}
pub fn restore_all(app: &tauri::AppHandle) -> Result<(), String> {
    batch(app, "restore")
}
fn batch(app: &tauri::AppHandle, action: &str) -> Result<(), String> {
    let widgets = app.state::<crate::widgets::Service>();
    let _starting = widgets
        .gate
        .try_lock()
        .map_err(|_| "正在更新窗口或准备维护，请稍后重试")?;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    let service = app.state::<Service>();
    let _guard = service
        .gate
        .try_lock()
        .map_err(|_| "正在更新贴图，请稍后重试")?;
    let pins = app
        .state::<Service>()
        .pins
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut windows = Vec::new();
    for pin in &pins {
        if let Some(window) = app.get_webview_window(&pin.label) {
            windows.push((pin, window));
        }
    }
    let hide = action == "toggle"
        && windows.iter().try_fold(false, |visible, (_, window)| {
            window
                .is_visible()
                .map(|current| visible || current)
                .map_err(|error| error.to_string())
        })?;
    let mut errors = Vec::new();
    for (pin, window) in windows {
        let result = (|| {
            match action {
                "toggle" => {
                    if hide { window.hide() } else { window.show() }
                        .map_err(|error| error.to_string())?;
                }
                "close" => {
                    app.state::<crate::system::SystemService>()
                        .cancel_picker_for(&pin.label);
                    window.destroy().map_err(|error| error.to_string())?;
                }
                "restore" => {
                    let options = Options {
                        opacity: 100.0,
                        locked: false,
                        mouse_through: false,
                        ..pin.options.clone()
                    };
                    if let Err(error) = native_options(&window, &options) {
                        let _ = native_options(&window, &pin.options);
                        return Err(error);
                    }
                    if let Some(current) = service
                        .pins
                        .lock()
                        .map_err(|error| error.to_string())?
                        .get_mut(&pin.id)
                    {
                        current.options = options;
                    }
                    crate::events::emit(app, &pin.label, "pin:changed", ())?;
                    window.show().map_err(|error| error.to_string())?;
                }
                _ => return Err("未知贴图批量操作".to_string()),
            }
            Ok(())
        })();
        if let Err(error) = result {
            errors.push(format!("贴图 {}：{error}", &pin.id[..8]));
        }
    }
    if let Err(error) = crate::refresh_tray(app) {
        errors.push(error);
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}
fn pin_menu(app: &tauri::AppHandle, pin: &Pin) -> Result<Menu<tauri::Wry>, String> {
    let menu = Menu::new(app).map_err(|error| error.to_string())?;
    for (action, text) in [
        ("original", "恢复原始比例"),
        ("copy", "复制"),
        ("save", "保存…"),
        ("edit", "重新编辑"),
        ("close", "关闭贴图"),
    ] {
        menu.append(
            &MenuItem::with_id(
                app,
                format!("pin:{action}:{}", pin.id),
                text,
                true,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }
    for (action, text, checked) in [
        ("topmost", "置顶", pin.options.topmost),
        ("locked", "锁定位置", pin.options.locked),
        ("through", "鼠标穿透", pin.options.mouse_through),
    ] {
        menu.append(
            &CheckMenuItem::with_id(
                app,
                format!("pin:{action}:{}", pin.id),
                text,
                true,
                checked,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(menu)
}
pub fn tray(app: &tauri::AppHandle) -> Result<Submenu<tauri::Wry>, String> {
    let submenu = Submenu::new(app, "截图贴图", true).map_err(|error| error.to_string())?;
    submenu
        .append(
            &MenuItem::with_id(app, "pin:clipboard", "剪贴板贴图", true, None::<&str>)
                .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    let mut pins = app
        .state::<Service>()
        .pins
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    pins.sort_by(|left, right| left.id.cmp(&right.id));
    let populated = !pins.is_empty();
    for pin in pins {
        let nested = Submenu::new(app, format!("贴图 {}", &pin.id[..8]), true)
            .map_err(|error| error.to_string())?;
        for item in pin_menu(app, &pin)?
            .items()
            .map_err(|error| error.to_string())?
        {
            nested.append(&item).map_err(|error| error.to_string())?;
        }
        submenu.append(&nested).map_err(|error| error.to_string())?;
    }
    for (action, text) in [
        ("toggle", "显示/隐藏所有贴图"),
        ("restore", "恢复所有贴图鼠标操作"),
        ("close", "关闭所有桌面贴图"),
    ] {
        submenu
            .append(
                &MenuItem::with_id(
                    app,
                    format!("pin:{action}:all"),
                    text,
                    populated,
                    None::<&str>,
                )
                .map_err(|error| error.to_string())?,
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(submenu)
}
pub fn request_native(app: &tauri::AppHandle, command: &str) {
    if command == "pin:clipboard" {
        request_clipboard(app);
        return;
    }
    let parts = command.split(':').collect::<Vec<_>>();
    if parts.len() != 3 || parts[0] != "pin" {
        return;
    }
    if parts[2] == "all" {
        if !matches!(parts[1], "toggle" | "restore" | "close") {
            return;
        }
        if let Err(error) = batch(app, parts[1]) {
            eprintln!("贴图操作失败：{error}");
            if let Ok(pins) = app.state::<Service>().pins.lock() {
                for pin in pins.values() {
                    let _ = crate::events::emit(app, &pin.label, "pin:error", error.clone());
                }
            }
        }
        return;
    }
    let id = parts[2].to_string();
    let action = parts[1].to_string();
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let pin = handle.state::<Service>().get(&id)?;
            let window = handle.get_webview_window(&pin.label).ok_or("贴图已关闭")?;
            let change = match action.as_str() {
                "topmost" => Change {
                    topmost: Some(!pin.options.topmost),
                    ..Change::default()
                },
                "locked" => Change {
                    locked: Some(!pin.options.locked),
                    ..Change::default()
                },
                "through" => Change {
                    mouse_through: Some(!pin.options.mouse_through),
                    ..Change::default()
                },
                _ => Change::default(),
            };
            let action = if matches!(action.as_str(), "topmost" | "locked" | "through") {
                "options".to_string()
            } else {
                action
            };
            control(handle.clone(), window, id.clone(), action, change).await
        }
        .await;
        if let Err(error) = result {
            if let Ok(pin) = handle.state::<Service>().get(&id) {
                let _ = crate::events::emit(&handle, &pin.label, "pin:error", error);
            }
        }
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pin_budget_refuses_growth_without_evicting_sources_and_replacement_excludes_only_its_own_png(
    ) {
        let service = Service::default();
        let image = image::DynamicImage::ImageRgba8(image::RgbaImage::new(2, 2));
        let mut bytes = std::io::Cursor::new(Vec::new());
        image.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        let sessions = crate::screenshot::Service::default();
        let document = sessions
            .create(
                0,
                crate::screenshot::decode(&bytes.into_inner()).unwrap(),
                || Ok(()),
            )
            .unwrap();
        for index in 0..MAX_PINS {
            let id = index.to_string();
            service.pins.lock().unwrap().insert(
                id.clone(),
                Pin {
                    id: id.clone(),
                    label: format!("screenshot-pin-{id}"),
                    document: document.clone(),
                    png: Arc::from(vec![0u8; 1]),
                    version: 0,
                    options: Options::from_settings(&json!({})),
                },
            );
        }
        assert!(service.budget(None, 1).is_err());
        assert!(service.budget(Some("0"), 1).is_ok());
        assert!(service.budget(Some("0"), MAX_PIN_BYTES).is_err());
        assert_eq!(service.pins.lock().unwrap().len(), MAX_PINS);
        service.pins.lock().unwrap().retain(|id, _| id == "0");
        assert!(service.budget(Some("0"), MAX_PIN_BYTES).is_ok());
        assert!(service.budget(Some("0"), MAX_PIN_BYTES + 1).is_err());
    }
    #[test]
    fn native_options_keep_explicit_false_clamp_opacity_and_reject_nonfinite_changes() {
        let options = Options::from_settings(
            &json!({"PinnedImageOpacityPercent":-10,"PinnedImageTopmost":false,"PinnedImageMouseThrough":true}),
        );
        assert_eq!(options.opacity, 20.0);
        assert!(!options.topmost);
        assert!(options.mouse_through);
        let next = changed_options(
            &options,
            &Change {
                opacity: Some(900.0),
                mouse_through: Some(false),
                locked: Some(true),
                ..Change::default()
            },
        )
        .unwrap();
        assert_eq!(next.opacity, 100.0);
        assert!(!next.mouse_through);
        assert!(next.locked);
        for opacity in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(changed_options(
                &options,
                &Change {
                    opacity: Some(opacity),
                    ..Change::default()
                }
            )
            .is_err());
        }
    }
}
