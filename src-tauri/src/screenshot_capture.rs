use crate::{screenshot::Document, screenshot_output::Output};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{
    ipc::{Channel, Request, Response},
    Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use tokio::sync::Semaphore;

#[derive(Clone)]
struct Entry {
    epoch: u64,
    main_bound: bool,
    document: Option<Document>,
    retained: Vec<String>,
    region: Option<Region>,
    settings: Value,
}
#[derive(Clone, Debug, PartialEq)]
struct Region {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
}
impl Region {
    fn from_monitor(monitor: &tauri::Monitor) -> Result<Self, String> {
        let region = Self {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
            scale: monitor.scale_factor(),
        };
        region.validate()?;
        Ok(region)
    }
    fn validate(&self) -> Result<(), String> {
        crate::platform::CaptureRect {
            x: self.x,
            y: self.y,
            width: self.width,
            height: self.height,
        }
        .validate()?;
        if !self.scale.is_finite() || self.scale <= 0.0 || self.scale > 8.0 {
            return Err("显示器缩放无效".into());
        }
        Ok(())
    }
    fn selection(
        &self,
        rect: &crate::screenshot::Rect,
    ) -> Result<(crate::platform::CaptureRect, crate::screenshot::Rect), String> {
        self.validate()?;
        if ![rect.x, rect.y, rect.width, rect.height]
            .iter()
            .all(|value| value.is_finite())
            || rect.x < 0.0
            || rect.y < 0.0
            || rect.width < 2.0
            || rect.height < 2.0
            || rect.x + rect.width > f64::from(self.width) / self.scale
            || rect.y + rect.height > f64::from(self.height) / self.scale
        {
            return Err("请选择当前显示器内的有效区域".into());
        }
        let left = (rect.x * self.scale).round() as u32;
        let top = (rect.y * self.scale).round() as u32;
        let right = ((rect.x + rect.width) * self.scale)
            .round()
            .min(f64::from(self.width)) as u32;
        let bottom = ((rect.y + rect.height) * self.scale)
            .round()
            .min(f64::from(self.height)) as u32;
        let physical = crate::platform::CaptureRect {
            x: self.x.checked_add_unsigned(left).ok_or("选区横坐标溢出")?,
            y: self.y.checked_add_unsigned(top).ok_or("选区纵坐标溢出")?,
            width: right - left,
            height: bottom - top,
        };
        physical.validate()?;
        let source = crate::screenshot::Rect {
            x: f64::from(left),
            y: f64::from(top),
            width: f64::from(physical.width),
            height: f64::from(physical.height),
        };
        Ok((physical, source))
    }
}
pub struct Service {
    entries: Mutex<HashMap<String, Entry>>,
    gate: Arc<Semaphore>,
    epoch: AtomicU64,
    checkpoints: Mutex<HashMap<String, Checkpoint>>,
    operations: Arc<AtomicUsize>,
}
struct OverlayOperation(Arc<AtomicUsize>);
impl Drop for OverlayOperation {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}
#[derive(Clone)]
struct Checkpoint {
    request: String,
    maintenance: bool,
    epoch: u64,
    token: String,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            gate: Arc::new(Semaphore::new(1)),
            epoch: AtomicU64::new(0),
            checkpoints: Mutex::default(),
            operations: Arc::default(),
        }
    }
}
// Idle overlays retain their live React editor, worker and source ownership for
// the whole handshake. They are ephemeral and are not workspace/browser drafts.
pub(crate) fn checkpoint_participants(app: &tauri::AppHandle) -> Result<Vec<String>, String> {
    checkpoint_idle(app)?;
    Ok(app
        .state::<Service>()
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .keys()
        .cloned()
        .collect())
}
fn checkpoint_idle(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<Service>().gate.available_permits() == 0
        || app.state::<Service>().operations.load(Ordering::SeqCst) != 0
        || app.state::<crate::screenshot_pins::Service>().busy()
    {
        return Err("截图正在进行：正在捕获或输出，请完成后重试".into());
    }
    Ok(())
}
fn checkpoint_owner(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<u64, String> {
    if !window.label().starts_with("screenshot-overlay-")
        || !crate::main_window::current(app, window)
    {
        return Err("此窗口无截图检查点权限".into());
    }
    Ok(app.state::<Service>().entry(window.label())?.epoch)
}
pub(crate) fn verify_checkpoints(
    app: &tauri::AppHandle,
    labels: &std::collections::HashSet<String>,
    request: &str,
    maintenance: bool,
) -> Result<(), String> {
    checkpoint_idle(app)?;
    let service = app.state::<Service>();
    let checkpoints = service
        .checkpoints
        .lock()
        .map_err(|error| error.to_string())?;
    for label in labels
        .iter()
        .filter(|label| label.starts_with("screenshot-overlay-"))
    {
        let window = app
            .get_webview_window(label)
            .ok_or("截图检查点窗口已关闭")?;
        let epoch = checkpoint_owner(app, &window)?;
        let checkpoint = checkpoints
            .get(label)
            .ok_or("截图编辑器尚未冻结或已重新加载")?;
        if checkpoint.request != request
            || checkpoint.maintenance != maintenance
            || checkpoint.epoch != epoch
            || !app
                .state::<crate::events::Service>()
                .connected(label, &checkpoint.token)
        {
            return Err("截图检查点已失效，请重试".into());
        }
    }
    Ok(())
}
pub(crate) fn release_checkpoints(app: &tauri::AppHandle, request: &str) {
    if let Ok(mut checkpoints) = app.state::<Service>().checkpoints.lock() {
        checkpoints.retain(|_, checkpoint| checkpoint.request != request);
    }
}
pub(crate) fn preserve_on_draft_refresh(app: &tauri::AppHandle, request: &str) {
    let service = app.state::<Service>();
    if let (Ok(checkpoints), Ok(mut entries)) = (service.checkpoints.lock(), service.entries.lock())
    {
        for (label, checkpoint) in checkpoints
            .iter()
            .filter(|(_, checkpoint)| checkpoint.request == request && checkpoint.maintenance)
        {
            if let Some(entry) = entries
                .get_mut(label)
                .filter(|entry| entry.epoch == checkpoint.epoch)
            {
                // A successful browser-draft import intentionally reloads main.
                // Screenshots are outside that import and keep their live owner.
                entry.main_bound = false;
            }
        }
    };
}
#[tauri::command]
pub async fn screenshot_overlay_events_attach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    channel: Channel<crate::events::Packet>,
) -> Result<String, String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    checkpoint_owner(&app, &window)?;
    require(&app, &window)?;
    app.state::<crate::events::Service>().attach(
        window.label(),
        "screenshot-overlay".into(),
        channel,
    )
}
#[tauri::command]
pub fn screenshot_overlay_events_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<bool, String> {
    checkpoint_owner(&app, &window)?;
    let detached = app
        .state::<crate::events::Service>()
        .detach(window.label(), &token);
    if detached {
        crate::draft_maintenance::participant_lost(&app, window.label());
    }
    Ok(detached)
}
#[tauri::command]
pub async fn screenshot_overlay_checkpoint(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    maintenance: bool,
    token: String,
    error: Option<String>,
) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    let epoch = checkpoint_owner(&app, &window)?;
    if !app
        .state::<crate::events::Service>()
        .connected(window.label(), &token)
    {
        return Err("截图检查点事件连接已失效".into());
    }
    let service = app.state::<Service>();
    let mut checkpoints = service
        .checkpoints
        .lock()
        .map_err(|error| error.to_string())?;
    let previous = checkpoints.insert(
        window.label().into(),
        Checkpoint {
            request: request_id.clone(),
            maintenance,
            epoch,
            token,
        },
    );
    let outcome = app
        .state::<crate::lifecycle::QuitState>()
        .acknowledge_capture(window.label(), &request_id, error, maintenance);
    if outcome.is_err() {
        checkpoints.remove(window.label());
        if let Some(previous) = previous {
            checkpoints.insert(window.label().into(), previous);
        }
    }
    outcome
}
impl Service {
    fn operation(&self) -> OverlayOperation {
        self.operations.fetch_add(1, Ordering::SeqCst);
        OverlayOperation(self.operations.clone())
    }
    pub fn busy(&self) -> bool {
        self.gate.available_permits() == 0
            || self
                .entries
                .lock()
                .map_or(true, |entries| !entries.is_empty())
    }
    fn entry(&self, label: &str) -> Result<Entry, String> {
        self.entries
            .lock()
            .map_err(|error| error.to_string())?
            .get(label)
            .cloned()
            .ok_or_else(|| "截图覆盖层会话已结束".into())
    }
}
pub fn require(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "workspace-main" {
        return crate::toolbox::require_active(app, window);
    }
    if window.label().starts_with("screenshot-pin-") {
        return crate::screenshot_pins::require(app, window);
    }
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    if !crate::main_window::current(app, window) {
        return Err("截图窗口已失效".into());
    }
    app.state::<Service>().entry(window.label())?;
    Ok(())
}
pub fn protected(app: &tauri::AppHandle) -> Result<(), String> {
    if app.state::<Service>().busy() || app.state::<crate::screenshot_pins::Service>().busy() {
        return Err("截图正在进行，请完成或取消截图后重试".into());
    }
    Ok(())
}
pub fn require_document(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    id: &str,
) -> Result<u64, String> {
    require(app, window)?;
    let entry = app.state::<Service>().entry(window.label())?;
    if window.label() == "workspace-main"
        || entry
            .document
            .as_ref()
            .is_none_or(|document| document.id != id)
    {
        return Err("当前覆盖层无此截图文档权限".into());
    }
    Ok(entry.epoch)
}
pub fn navigated(app: &tauri::AppHandle, label: &str) {
    if label.starts_with("screenshot-overlay-") {
        app.state::<crate::events::Service>().destroyed(label);
        if let Ok(mut checkpoints) = app.state::<Service>().checkpoints.lock() {
            checkpoints.remove(label);
        }
    }
    if let Ok(mut entries) = app.state::<Service>().entries.lock() {
        if let Some(entry) = entries.get_mut(label) {
            entry.epoch = entry.epoch.wrapping_add(1);
        }
    }
}
pub fn destroyed(app: &tauri::AppHandle, label: &str) {
    if label.starts_with("screenshot-overlay-") {
        app.state::<crate::events::Service>().destroyed(label);
        if let Ok(mut checkpoints) = app.state::<Service>().checkpoints.lock() {
            checkpoints.remove(label);
        }
    }
    crate::screenshot_pins::destroyed(app, label);
    crate::screenshot_editor::cancel_window(app, label);
    let entry = app
        .state::<Service>()
        .entries
        .lock()
        .ok()
        .and_then(|mut entries| entries.remove(label));
    if let Some(entry) = entry {
        app.state::<crate::system::SystemService>()
            .cancel_picker_for(label);
        if let Some(document) = entry.document {
            let _ = app
                .state::<crate::screenshot::Service>()
                .remove(&document.id);
        }
        for id in entry.retained {
            let _ = app.state::<crate::screenshot::Service>().remove(&id);
        }
        if entry.region.is_some() {
            reset(app);
        }
    }
}
pub fn reset(app: &tauri::AppHandle) {
    app.state::<Service>().epoch.fetch_add(1, Ordering::SeqCst);
    crate::screenshot_editor::reset(app);
    reset_entries(app, false);
}
pub fn reset_main(app: &tauri::AppHandle) {
    reset_entries(app, true);
}
fn reset_entries(app: &tauri::AppHandle, main_only: bool) {
    let labels = app
        .state::<Service>()
        .entries
        .lock()
        .map(|mut entries| {
            let labels = entries
                .iter()
                .filter(|(_, entry)| !main_only || entry.main_bound)
                .map(|(label, _)| label.clone())
                .collect::<Vec<_>>();
            labels
                .into_iter()
                .filter_map(|label| entries.remove(&label).map(|entry| (label, entry)))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    for (label, entry) in labels {
        if let Some(document) = entry.document {
            let _ = app
                .state::<crate::screenshot::Service>()
                .remove(&document.id);
        }
        for id in entry.retained {
            let _ = app.state::<crate::screenshot::Service>().remove(&id);
        }
        app.state::<crate::system::SystemService>()
            .cancel_picker_for(&label);
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.destroy();
        }
    }
}
#[tauri::command]
pub fn screenshot_overlay_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    require(&app, &window)?;
    if window.label() == "workspace-main" {
        return Err("主窗口不是截图覆盖层".into());
    }
    app.state::<crate::system::SystemService>()
        .cancel_picker_for(window.label());
    window.destroy().map_err(|error| error.to_string())
}
#[tauri::command]
pub fn screenshot_overlay_document(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    require(&app, &window)?;
    let entry = app.state::<Service>().entry(window.label())?;
    let mut metadata = if let Some(region) = &entry.region {
        let document = if let Some(document) = &entry.document {
            app.state::<crate::screenshot::Service>()
                .read_owned(&document.id, window.label())?
                .0
        } else {
            Document {
                id: format!("live-{}", window.label()),
                source_asset_id: String::new(),
                width: region.width,
                height: region.height,
                crop: crate::screenshot::Rect {
                    x: 0.0,
                    y: 0.0,
                    width: f64::from(region.width),
                    height: f64::from(region.height),
                },
                annotations: Vec::new(),
                revision: 0.0,
                next_number: 1.0,
                source_rect: None,
                target_pin_id: None,
            }
        };
        json!({"document":document,"liveRegion":true,"placement":{"x":0,"y":0,"width":f64::from(region.width)/region.scale,"height":f64::from(region.height)/region.scale}})
    } else {
        let document = entry.document.as_ref().ok_or("截图源图尚未创建")?;
        let (document, _) = app
            .state::<crate::screenshot::Service>()
            .read_owned(&document.id, window.label())?;
        json!({"document":document,"liveRegion":false})
    };
    let action = entry.settings["ScreenshotAfterAction"]
        .as_str()
        .filter(|action| matches!(*action, "copy" | "pin"));
    metadata["settings"] = json!({"ScreenshotFormat":entry.settings["ScreenshotFormat"],"ScreenshotAfterAction":entry.settings["ScreenshotAfterAction"]});
    if let Some(action) = action.filter(|_| entry.region.is_none()) {
        metadata["initialAction"] = json!(action);
    }
    Ok(metadata)
}
#[tauri::command]
pub async fn screenshot_overlay_source(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<Response, String> {
    require(&app, &window)?;
    let _operation = app.state::<Service>().operation();
    crate::screenshot_api::screenshot_source(app, window, id).await
}
#[tauri::command]
pub async fn screenshot_overlay_finish(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: Request<'_>,
) -> Result<Output, String> {
    require(&app, &window)?;
    let _operation = app.state::<Service>().operation();
    app.state::<Service>().entry(window.label())?;
    let output = crate::screenshot_api::finish(app.clone(), window.clone(), request).await?;
    if output.ok && output.warning.is_none() {
        let target = window.clone();
        let handle = app.clone();
        let region = app
            .state::<Service>()
            .entry(window.label())?
            .region
            .is_some();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if region && require(&handle, &target).is_ok() {
                reset(&handle);
            } else if !region {
                let _ = target.destroy();
            }
        });
    }
    Ok(output)
}
#[derive(Serialize)]
pub struct Started {
    pub ok: bool,
    pub message: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::Rect;
    #[test]
    fn selection_maps_fractional_dip_to_exact_negative_origin_physical_pixels() {
        let region = Region {
            x: -2560,
            y: -300,
            width: 2560,
            height: 1440,
            scale: 1.5,
        };
        let (physical, source) = region
            .selection(&Rect {
                x: 10.25,
                y: 20.5,
                width: 100.5,
                height: 80.25,
            })
            .unwrap();
        assert_eq!(
            (physical.x, physical.y, physical.width, physical.height),
            (-2545, -269, 151, 120)
        );
        assert_eq!(
            source,
            Rect {
                x: 15.0,
                y: 31.0,
                width: 151.0,
                height: 120.0
            }
        );
        let (physical, _) = region
            .selection(&Rect {
                x: 0.0,
                y: 0.0,
                width: 2560.0 / 1.5,
                height: 960.0,
            })
            .unwrap();
        assert_eq!(
            (physical.x, physical.y, physical.width, physical.height),
            (-2560, -300, 2560, 1440)
        );
    }
    #[test]
    fn selection_rejects_invalid_geometry_scaling_and_outside_monitor_coordinates() {
        let region = Region {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
            scale: 1.0,
        };
        for rect in [
            Rect {
                x: f64::NAN,
                y: 0.0,
                width: 2.0,
                height: 2.0,
            },
            Rect {
                x: -1.0,
                y: 0.0,
                width: 2.0,
                height: 2.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1.0,
                height: 2.0,
            },
            Rect {
                x: 1919.0,
                y: 0.0,
                width: 2.0,
                height: 2.0,
            },
            Rect {
                x: 0.0,
                y: 1079.0,
                width: 2.0,
                height: 2.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: f64::INFINITY,
                height: 2.0,
            },
        ] {
            assert!(region.selection(&rect).is_err());
        }
        for scale in [0.0, -1.0, 9.0, f64::NAN, f64::INFINITY] {
            assert!(Region {
                scale,
                ..region.clone()
            }
            .selection(&Rect {
                x: 0.0,
                y: 0.0,
                width: 2.0,
                height: 2.0
            })
            .is_err());
        }
        assert!(Region {
            width: 10000,
            height: 10000,
            ..region
        }
        .validate()
        .is_err());
    }
}
fn open_overlay(app: &tauri::AppHandle, label: &str, region: &Region) -> Result<(), String> {
    let profiles = app.state::<crate::ProbeState>().profiles.clone();
    let overlay = WebviewWindowBuilder::new(app, label, WebviewUrl::App("capture.html".into()))
        .title("DustDesk 实时区域截图")
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .content_protected(true)
        .resizable(false)
        .visible(false)
        .inner_size(
            f64::from(region.width) / region.scale,
            f64::from(region.height) / region.scale,
        )
        .data_directory(profiles)
        .build()
        .map_err(|error| error.to_string())?;
    overlay
        .set_position(tauri::PhysicalPosition::new(region.x, region.y))
        .map_err(|error| error.to_string())?;
    overlay
        .set_size(tauri::PhysicalSize::new(region.width, region.height))
        .map_err(|error| error.to_string())?;
    overlay.show().map_err(|error| error.to_string())?;
    let cursor = overlay
        .cursor_position()
        .map_err(|error| error.to_string())?;
    if cursor.x >= f64::from(region.x)
        && cursor.y >= f64::from(region.y)
        && cursor.x < f64::from(region.x) + f64::from(region.width)
        && cursor.y < f64::from(region.y) + f64::from(region.height)
    {
        overlay.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}
fn region_active(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    region: &Region,
    generation: u64,
) -> Result<(), String> {
    require(app, window)?;
    if app.state::<crate::screenshot::Service>().generation()? != generation {
        return Err("框选会话已取消".into());
    }
    if app
        .state::<Service>()
        .entry(window.label())?
        .region
        .as_ref()
        != Some(region)
    {
        return Err("框选会话已改变".into());
    }
    let monitors = window
        .available_monitors()
        .map_err(|error| error.to_string())?;
    if !monitors
        .iter()
        .any(|monitor| Region::from_monitor(monitor).ok().as_ref() == Some(region))
    {
        return Err("显示器位置或缩放已改变，请取消后重新框选".into());
    }
    if window.outer_position().map_err(|error| error.to_string())?
        != tauri::PhysicalPosition::new(region.x, region.y)
        || window.inner_size().map_err(|error| error.to_string())?
            != tauri::PhysicalSize::new(region.width, region.height)
    {
        return Err("框选窗口与显示器边界不一致".into());
    }
    Ok(())
}
struct HiddenOverlays(Vec<WebviewWindow>);
impl Drop for HiddenOverlays {
    fn drop(&mut self) {
        for window in &self.0 {
            if require(window.app_handle(), window).is_ok() {
                let _ = window.show();
            }
        }
    }
}
#[tauri::command]
pub async fn screenshot_overlay_region(
    app: tauri::AppHandle,
    window: WebviewWindow,
    rect: crate::screenshot::Rect,
) -> Result<Value, String> {
    require(&app, &window)?;
    let _operation = app.state::<Service>().operation();
    let region = app
        .state::<Service>()
        .entry(window.label())?
        .region
        .ok_or("当前不是实时框选会话")?;
    let (physical, source) = region.selection(&rect)?;
    let service = app.state::<crate::screenshot::Service>();
    let generation = service.generation()?;
    let permit = service
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    region_active(&app, &window, &region, generation)?;
    let mut hidden = HiddenOverlays(Vec::new());
    let labels = app
        .state::<Service>()
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for label in labels {
        if let Some(target) = app.get_webview_window(&label) {
            if target.is_visible().map_err(|error| error.to_string())? {
                hidden.0.push(target.clone());
                target.hide().map_err(|error| error.to_string())?;
            }
        }
    }
    tokio::time::sleep(Duration::from_millis(40)).await;
    region_active(&app, &window, &region, generation)?;
    let handle = app.clone();
    let caller = window.clone();
    let selected = region.clone();
    let document = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        region_active(&handle, &caller, &selected, generation)?;
        let bytes = crate::platform::capture_region(physical)?;
        region_active(&handle, &caller, &selected, generation)?;
        let decoded = crate::screenshot::decode(&bytes)?;
        handle
            .state::<crate::screenshot::Service>()
            .create_positioned(
                generation,
                decoded,
                caller.label(),
                Some((selected.width, selected.height, source)),
                || require(&handle, &caller),
            )
    })
    .await
    .map_err(|error| error.to_string())??;
    let publication = (|| {
        region_active(&app, &window, &region, generation)?;
        let service = app.state::<Service>();
        let mut entries = service.entries.lock().map_err(|error| error.to_string())?;
        let entry = entries.get_mut(window.label()).ok_or("框选会话已结束")?;
        if let Some(previous) = entry.document.replace(document.clone()) {
            entry.retained.push(previous.id);
        }
        Ok(())
    })();
    if let Err(error) = publication {
        let _ = app
            .state::<crate::screenshot::Service>()
            .remove(&document.id);
        return Err(error);
    }
    drop(hidden);
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(
        json!({"document":document,"placement":{"x":0,"y":0,"width":f64::from(region.width)/region.scale,"height":f64::from(region.height)/region.scale}}),
    )
}
#[tauri::command]
pub fn screenshot_overlay_adopt(
    app: tauri::AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    require(&app, &window)?;
    let retired = {
        let service = app.state::<Service>();
        let mut entries = service.entries.lock().map_err(|error| error.to_string())?;
        let entry = entries.get_mut(window.label()).ok_or("截图会话已结束")?;
        if entry
            .document
            .as_ref()
            .is_none_or(|document| document.id != id)
        {
            return Err("截图来源已改变，不能确认交付".into());
        }
        std::mem::take(&mut entry.retained)
    };
    for id in retired {
        app.state::<crate::screenshot::Service>()
            .remove_owned(&id, Some(window.label()))?;
    }
    Ok(())
}
#[derive(Clone)]
enum CaptureOrigin {
    Main {
        window: Arc<WebviewWindow>,
        generation: u64,
    },
    Native {
        epoch: u64,
    },
}
impl CaptureOrigin {
    fn require_origin(&self, app: &tauri::AppHandle) -> Result<(), String> {
        app.state::<crate::draft_startup::Service>()
            .require_ready()?;
        app.state::<crate::lifecycle::QuitState>()
            .require_interactive()?;
        match self {
            Self::Main { window, .. } => {
                crate::toolbox::require_active(app, window)?;
            }
            Self::Native { epoch } => {
                if app.state::<Service>().epoch.load(Ordering::SeqCst) != *epoch {
                    return Err("原生截图操作已取消".into());
                }
            }
        }
        Ok(())
    }
    fn active(&self, app: &tauri::AppHandle) -> Result<(), String> {
        self.require_origin(app)?;
        if let Self::Main { generation, .. } = self {
            if app.state::<crate::screenshot::Service>().generation()? != *generation {
                return Err("截图操作已取消".into());
            }
        }
        Ok(())
    }
    fn main_bound(&self) -> bool {
        matches!(self, Self::Main { .. })
    }
    fn generation(&self, app: &tauri::AppHandle) -> Result<u64, String> {
        self.active(app)?;
        match self {
            Self::Main { generation, .. } => Ok(*generation),
            Self::Native { .. } => app.state::<crate::screenshot::Service>().generation(),
        }
    }
}
#[tauri::command]
pub async fn screenshot_start(
    app: tauri::AppHandle,
    window: WebviewWindow,
    mode: String,
    source_id: Option<String>,
) -> Result<Started, String> {
    crate::toolbox::require_active(&app, &window)?;
    let origin = CaptureOrigin::Main {
        window: Arc::new(window),
        generation: app.state::<crate::screenshot::Service>().generation()?,
    };
    start(app, origin, mode, source_id).await
}
async fn start(
    app: tauri::AppHandle,
    origin: CaptureOrigin,
    mode: String,
    source_id: Option<String>,
) -> Result<Started, String> {
    let widgets = app.state::<crate::widgets::Service>();
    let starting = tokio::time::timeout(Duration::from_secs(1), widgets.gate.lock())
        .await
        .map_err(|_| "正在更新窗口或准备维护，请稍后重试")?;
    origin.active(&app)?;
    if !matches!(mode.as_str(), "Region" | "Window" | "FullScreen") {
        return Err("截图模式无效".into());
    }
    let service = app.state::<Service>();
    let _gate = service
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| "screenshot-in-progress")?;
    if !service
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .is_empty()
    {
        return Err("screenshot-in-progress".into());
    }
    drop(starting);
    origin.active(&app)?;
    let target = if mode == "Window" {
        Some(
            app.state::<crate::screenshot::Service>()
                .windows
                .resolve(source_id.as_deref().ok_or("select-capture-window")?)?,
        )
    } else {
        None
    };
    let settings =
        crate::workspace::commands::operation(app.clone(), |store| store.screenshot_settings())
            .await?;
    let delay = settings["ScreenshotDelaySeconds"]
        .as_f64()
        .unwrap_or(0.0)
        .clamp(0.0, 10.0);
    let deadline = std::time::Instant::now() + Duration::from_secs_f64(delay);
    while std::time::Instant::now() < deadline {
        origin.active(&app)?;
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    origin.active(&app)?;
    if mode == "Region" {
        let monitors = app
            .available_monitors()
            .map_err(|error| error.to_string())?;
        if monitors.is_empty() || monitors.len() > 32 {
            return Err("没有可用的截图显示器".into());
        }
        let regions = monitors
            .iter()
            .map(Region::from_monitor)
            .collect::<Result<Vec<_>, _>>()?;
        let result = (|| {
            for region in regions {
                origin.active(&app)?;
                let label = format!("screenshot-overlay-{}", uuid::Uuid::new_v4());
                app.state::<Service>()
                    .entries
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(
                        label.clone(),
                        Entry {
                            epoch: 0,
                            main_bound: origin.main_bound(),
                            document: None,
                            retained: Vec::new(),
                            region: Some(region.clone()),
                            settings: settings.clone(),
                        },
                    );
                open_overlay(&app, &label, &region)?;
            }
            Ok(Started {
                ok: true,
                message: "已开始实时框选".into(),
            })
        })();
        if result.is_err() {
            reset_entries(&app, origin.main_bound());
        }
        return result;
    }
    let cursor = app.cursor_position().map_err(|error| error.to_string())?;
    let monitor = app
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            cursor.x >= f64::from(position.x)
                && cursor.y >= f64::from(position.y)
                && cursor.x < f64::from(position.x) + f64::from(size.width)
                && cursor.y < f64::from(position.y) + f64::from(size.height)
        })
        .ok_or("no-capture-source")?;
    let scale = monitor.scale_factor();
    let permit = app
        .state::<crate::screenshot::Service>()
        .slot
        .clone()
        .try_acquire_owned()
        .map_err(|_| "正在处理上一项截图操作")?;
    let label = format!("screenshot-overlay-{}", uuid::Uuid::new_v4());
    let handle = app.clone();
    let caller = origin.clone();
    let owner = label.clone();
    let position = *monitor.position();
    let size = *monitor.size();
    let document = tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        caller.active(&handle)?;
        if let Some(target) = &target {
            if handle
                .state::<crate::screenshot::Service>()
                .windows
                .resolve(source_id.as_deref().ok_or("select-capture-window")?)?
                != *target
            {
                return Err("capture-window-unavailable".into());
            }
        }
        let bytes = if let Some(target) = &target {
            crate::platform::capture_target(target, || caller.active(&handle).is_err())?
        } else {
            crate::platform::capture_region(crate::platform::CaptureRect {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            })?
        };
        let decoded = crate::screenshot::decode(&bytes)?;
        handle.state::<crate::screenshot::Service>().create_owned(
            caller.generation(&handle)?,
            decoded,
            &owner,
            || {
                // create_owned already validates generation while holding the
                // screenshot state lock. Only recheck independent origin and
                // lifecycle state here; active would acquire that lock again.
                caller.require_origin(&handle)?;
                if let Some(target) = &target {
                    if handle
                        .state::<crate::screenshot::Service>()
                        .windows
                        .resolve(source_id.as_deref().ok_or("select-capture-window")?)?
                        != *target
                    {
                        return Err("capture-window-unavailable".into());
                    }
                }
                Ok(())
            },
        )
    })
    .await
    .map_err(|error| error.to_string())??;
    let profiles = app.state::<crate::ProbeState>().profiles.clone();
    let width = f64::from(size.width) / scale;
    let height = f64::from(size.height) / scale;
    let result = (|| {
        origin.active(&app)?;
        app.state::<Service>()
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                label.clone(),
                Entry {
                    epoch: 0,
                    main_bound: origin.main_bound(),
                    document: Some(document.clone()),
                    retained: Vec::new(),
                    region: None,
                    settings,
                },
            );
        let overlay =
            WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("capture.html".into()))
                .title("DustDesk 截图编辑")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .content_protected(true)
                .resizable(false)
                .visible(false)
                .inner_size(width, height)
                .data_directory(profiles)
                .build()
                .map_err(|error| error.to_string())?;
        overlay
            .set_position(position)
            .map_err(|error| error.to_string())?;
        overlay.set_size(size).map_err(|error| error.to_string())?;
        origin.active(&app)?;
        overlay.show().map_err(|error| error.to_string())?;
        overlay.set_focus().map_err(|error| error.to_string())?;
        Ok(Started {
            ok: true,
            message: "截图已打开".into(),
        })
    })();
    if result.is_err() {
        if let Some(overlay) = app.get_webview_window(&label) {
            let _ = overlay.destroy();
        }
        destroyed(&app, &label);
        let _ = app
            .state::<crate::screenshot::Service>()
            .remove(&document.id);
    }
    result
}
pub fn tray(app: &tauri::AppHandle) -> Result<tauri::menu::Submenu<tauri::Wry>, String> {
    use tauri::menu::{MenuItem, Submenu};
    let menu = Submenu::new(app, "截图", true).map_err(|error| error.to_string())?;
    for (command, text) in [("region", "区域截图"), ("fullscreen", "全屏截图")] {
        menu.append(
            &MenuItem::with_id(
                app,
                format!("screenshot:{command}"),
                text,
                true,
                None::<&str>,
            )
            .map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(menu)
}
pub fn request_native(app: &tauri::AppHandle, command: &str) {
    let mode = match command {
        "screenshot:region" => "Region",
        "screenshot:fullscreen" => "FullScreen",
        _ => return,
    };
    let handle = app.clone();
    let origin = CaptureOrigin::Native {
        epoch: app.state::<Service>().epoch.load(Ordering::SeqCst),
    };
    tauri::async_runtime::spawn(async move {
        let result = start(handle.clone(), origin, mode.into(), None).await;
        let message = match result {
            Ok(_) => "DustDesk".to_string(),
            Err(error) => {
                eprintln!("截图未启动：{error}");
                format!(
                    "DustDesk · 截图未启动：{}",
                    error.chars().take(300).collect::<String>()
                )
            }
        };
        if let Some(tray) = handle.tray_by_id("dustdesk-preview") {
            let _ = tray.set_tooltip(Some(message));
        }
    });
}
pub async fn edit_pin(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    id: &str,
    document_id: &str,
    version: u64,
) -> Result<(), String> {
    crate::screenshot_pins::require(app, window)?;
    let service = app.state::<Service>();
    let _guard = service
        .gate
        .clone()
        .try_acquire_owned()
        .map_err(|_| "请先完成或取消当前截图")?;
    if !service
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .is_empty()
    {
        return Err("请先完成或取消当前截图".into());
    }
    let generation = app.state::<crate::screenshot::Service>().generation()?;
    let handle = app.clone();
    let caller = window.clone();
    let mut settings = crate::workspace::commands::operation(app.clone(), move |store| {
        crate::screenshot_pins::require(&handle, &caller)?;
        store.screenshot_settings()
    })
    .await?;
    settings["ScreenshotAfterAction"] = json!("edit");
    let label = format!("screenshot-overlay-{}", uuid::Uuid::new_v4());
    let document = app.state::<crate::screenshot::Service>().edit_pin(
        document_id,
        window.label(),
        &label,
        id,
    )?;
    let result = (|| {
        crate::screenshot_pins::require(app, window)?;
        if app.state::<crate::screenshot::Service>().generation()? != generation {
            return Err("再编辑已取消".into());
        }
        crate::screenshot_pins::register_edit(app, &label, id, version)?;
        service
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                label.clone(),
                Entry {
                    epoch: 0,
                    main_bound: false,
                    document: Some(document.clone()),
                    retained: Vec::new(),
                    region: None,
                    settings,
                },
            );
        let monitor = window
            .current_monitor()
            .map_err(|error| error.to_string())?
            .ok_or("未找到显示器")?;
        open_overlay(app, &label, &Region::from_monitor(&monitor)?)
    })();
    if result.is_err() {
        if let Some(target) = app.get_webview_window(&label) {
            let _ = target.destroy();
        }
        destroyed(app, &label);
        let _ = app
            .state::<crate::screenshot::Service>()
            .remove(&document.id);
    }
    result
}
