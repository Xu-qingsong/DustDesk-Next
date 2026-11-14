use crate::{
    lifecycle::QuitState,
    workspace::{
        self,
        commands::{broadcast, operation},
        widgets::{self as model, Options, Rect},
        Snapshot,
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::{watch, Mutex as AsyncMutex};
use uuid::Uuid;

#[derive(Clone)]
struct Entry {
    label: String,
    placement: Value,
    expected: Rect,
    preview: bool,
    serial: u64,
    snap: bool,
}
pub struct Service {
    entries: Mutex<HashMap<String, Entry>>,
    pub gate: Arc<AsyncMutex<()>>,
    updates: watch::Sender<Option<Snapshot>>,
    started: AtomicBool,
    applied: AtomicU64,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            entries: Mutex::default(),
            gate: Arc::new(AsyncMutex::new(())),
            updates: watch::channel(None).0,
            started: AtomicBool::new(false),
            applied: AtomicU64::new(0),
        }
    }
}
impl Service {
    pub fn key(&self, label: &str) -> Option<String> {
        self.entries
            .lock()
            .ok()?
            .iter()
            .find(|(_, entry)| entry.label == label)
            .map(|(key, _)| key.clone())
    }
    pub fn labels(&self) -> Vec<String> {
        self.entries
            .lock()
            .map(|entries| entries.values().map(|entry| entry.label.clone()).collect())
            .unwrap_or_default()
    }
    fn entry(&self, key: &str) -> Result<Entry, String> {
        self.entries
            .lock()
            .map_err(|error| error.to_string())?
            .get(key)
            .cloned()
            .ok_or("小组件窗口不可用".into())
    }
}
pub fn reader(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<Option<String>, String> {
    if window.label() == "workspace-main" {
        return Ok(None);
    }
    app.state::<Service>()
        .key(window.label())
        .map(Some)
        .ok_or("此窗口无组件业务权限".into())
}

pub fn business(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    roles: &[&str],
) -> Result<Option<String>, String> {
    let role = reader(app, window)?;
    if role.as_ref().is_some_and(|key| {
        !roles
            .iter()
            .any(|allowed| key == allowed || (allowed.ends_with(':') && key.starts_with(allowed)))
    }) {
        return Err("此组件无此系统业务权限".into());
    }
    Ok(role)
}
fn controller(app: &tauri::AppHandle, window: &WebviewWindow, key: &str) -> Result<(), String> {
    if !model::valid_key(key) {
        return Err("小组件标识无效".into());
    }
    if reader(app, window)?.is_some_and(|own| own != key) {
        return Err("不能控制其他小组件".into());
    }
    Ok(())
}
fn areas(window: &WebviewWindow) -> Result<Vec<Rect>, String> {
    window
        .available_monitors()
        .map_err(|error| error.to_string())
        .map(|monitors| {
            monitors
                .iter()
                .map(|monitor| {
                    let area = monitor.work_area();
                    let scale = monitor.scale_factor();
                    Rect {
                        x: f64::from(area.position.x) / scale,
                        y: f64::from(area.position.y) / scale,
                        width: f64::from(area.size.width) / scale,
                        height: f64::from(area.size.height) / scale,
                    }
                })
                .collect()
        })
}
fn bounds(window: &WebviewWindow) -> Result<Rect, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    Ok(Rect {
        x: model::round_coordinate(position.x),
        y: model::round_coordinate(position.y),
        width: size.width.round(),
        height: size.height.round(),
    })
}
fn visible(app: &tauri::AppHandle, key: &str) -> bool {
    app.state::<Service>()
        .entry(key)
        .ok()
        .and_then(|entry| app.get_webview_window(&entry.label))
        .is_some_and(|window| window.is_visible().unwrap_or(false))
}
fn snap_enabled(key: &str, state: &Value) -> bool {
    state["Settings"]["WidgetPlacements"][key]["SnapToEdges"]
        .as_bool()
        .unwrap_or(key == "launcher" && state["Settings"]["LauncherWidgetSnapToEdges"] == true)
}

fn apply(app: &tauri::AppHandle, snapshot: &Snapshot) -> Result<(), String> {
    let service = app.state::<Service>();
    if snapshot.revision < service.applied.load(Ordering::SeqCst) {
        return Ok(());
    }
    let mut keys: Vec<String> = snapshot.state["Settings"]["WidgetPlacements"]
        .as_object()
        .unwrap()
        .keys()
        .cloned()
        .collect();
    keys.extend(
        service
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .keys()
            .cloned(),
    );
    keys.sort();
    keys.dedup();
    for key in keys {
        if !model::valid_key(&key) {
            continue;
        }
        let placement = &snapshot.state["Settings"]["WidgetPlacements"][&key];
        let desired = placement["Visible"] == true && model::exists(&key, &snapshot.state);
        let previous = service.entry(&key).ok();
        if previous.is_none() && !desired {
            continue;
        }
        let entry = previous.clone().unwrap_or_else(|| Entry {
            label: format!("workspace-widget-{}", Uuid::new_v4().simple()),
            placement: Value::Null,
            expected: Rect::defaults(&key),
            preview: false,
            serial: 0,
            snap: false,
        });
        let window = match app.get_webview_window(&entry.label) {
            Some(window) => window,
            None => {
                service
                    .entries
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(key.clone(), entry.clone());
                let result = WebviewWindowBuilder::new(
                    app,
                    &entry.label,
                    WebviewUrl::App(format!("widget.html?widget={key}").into()),
                )
                .title(format!("DustDesk · {key}"))
                .inner_size(entry.expected.width, entry.expected.height)
                .position(entry.expected.x, entry.expected.y)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .skip_taskbar(true)
                .visible(false)
                .data_directory(app.state::<crate::ProbeState>().profiles.clone())
                .build();
                match result {
                    Ok(window) => window,
                    Err(error) => {
                        service
                            .entries
                            .lock()
                            .map_err(|error| error.to_string())?
                            .remove(&key);
                        return Err(format!("创建小组件失败：{error}"));
                    }
                }
            }
        };
        let mut restored = Rect::restore(&key, placement, Rect::defaults(&key), &areas(&window)?);
        if placement["IsCollapsed"] == true {
            restored.height = 34.0;
        }
        let geometry_changed = ["X", "Y", "Width", "Height", "IsCollapsed"]
            .iter()
            .any(|name| entry.placement[name] != placement[name]);
        let preview = entry.preview && !geometry_changed && placement["Locked"] != true;
        let target = if preview { entry.expected } else { restored };
        service
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                key.clone(),
                Entry {
                    label: entry.label.clone(),
                    placement: placement.clone(),
                    expected: target,
                    preview,
                    serial: entry.serial.wrapping_add(1),
                    snap: snap_enabled(&key, &snapshot.state),
                },
            );
        window
            .set_min_size(Some(tauri::LogicalSize::new(
                if key == "search" { 52.0 } else { 300.0 },
                if placement["IsCollapsed"] == true {
                    34.0
                } else if key == "search" {
                    52.0
                } else {
                    120.0
                },
            )))
            .map_err(|error| error.to_string())?;
        if !preview && (previous.is_none() || geometry_changed || entry.expected != target) {
            window
                .set_size(tauri::LogicalSize::new(target.width, target.height))
                .map_err(|error| error.to_string())?;
            window
                .set_position(tauri::LogicalPosition::new(target.x, target.y))
                .map_err(|error| error.to_string())?;
        }
        window
            .set_resizable(key != "search" && placement["Locked"] != true)
            .map_err(|error| error.to_string())?;
        window
            .set_always_on_top(placement["TopMost"] == true)
            .map_err(|error| error.to_string())?;
        let opacity = (snapshot.state["Settings"]["WidgetOpacityPercent"]
            .as_f64()
            .unwrap_or(86.0)
            / 100.0)
            .clamp(0.2, 1.0);
        crate::platform::set_opacity(&window, (opacity * 255.0).round() as u8)?;
        if desired {
            crate::window_release::cancel(app, &entry.label);
            window.show().map_err(|error| error.to_string())?;
        } else {
            window.hide().map_err(|error| error.to_string())?;
            crate::window_release::schedule(app, &entry.label);
        }
        if !preview && bounds(&window)? != target {
            geometry_event(app, &entry.label);
        }
        let _ = crate::events::emit(
            app,
            &entry.label,
            "workspace:snapshot",
            model::project(snapshot.clone(), &key),
        );
        let _ = crate::events::emit(
            app,
            &entry.label,
            "runtime:onWidgetAppearance",
            [
                json!({"color":snapshot.state["Settings"]["WidgetBackgroundColorArgb"],"alpha":if placement["TransparentBackground"]==true{72.0/255.0}else{245.0/255.0}}),
            ],
        );
        for label in service
            .labels()
            .into_iter()
            .chain(std::iter::once("workspace-main".into()))
        {
            let _ = crate::events::emit(
                app,
                &label,
                "runtime:onWidgetVisibilityChanged",
                json!([key, desired]),
            );
        }
    }
    service.applied.store(snapshot.revision, Ordering::SeqCst);
    Ok(())
}

pub fn changed(app: &tauri::AppHandle, snapshot: &Snapshot) {
    let service = app.state::<Service>();
    service.updates.send_replace(Some(snapshot.clone()));
    for (key, entry) in service
        .entries
        .lock()
        .map(|entries| entries.clone())
        .unwrap_or_default()
    {
        if app.get_webview_window(&entry.label).is_some() {
            let _ = crate::events::emit(
                app,
                &entry.label,
                "workspace:snapshot",
                model::project(snapshot.clone(), &key),
            );
        }
    }
    if service.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut updates = service.updates.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let next = updates.borrow_and_update().clone();
            if let Some(snapshot) = next {
                let gate = app.state::<Service>().gate.clone();
                let _guard = gate.lock().await;
                if app.state::<QuitState>().require_interactive().is_ok() {
                    if let Err(error) = apply(&app, &snapshot) {
                        eprintln!("同步小组件失败：{error}");
                        let _ = app.emit_to("workspace-main", "system:action-error", error);
                    }
                }
            }
            if updates.changed().await.is_err() {
                break;
            }
        }
    });
}
pub fn resume(app: &tauri::AppHandle) {
    crate::hotkeys::changed(app);
    let service = app.state::<Service>();
    service.updates.send_modify(|_| {});
}

pub async fn flush_layout(app: &tauri::AppHandle) -> Result<(), String> {
    let gate = app.state::<Service>().gate.clone();
    let _guard = gate.lock().await;
    let entries = app
        .state::<Service>()
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    for (key, entry) in entries {
        flush_entry(app, &key, &entry).await?;
    }
    Ok(())
}
pub async fn flush_window(app: &tauri::AppHandle, label: &str) -> Result<(), String> {
    let service = app.state::<Service>();
    if let Some(key) = service.key(label) {
        let entry = service.entry(&key)?;
        flush_entry(app, &key, &entry).await?;
    }
    Ok(())
}
async fn flush_entry(app: &tauri::AppHandle, key: &str, entry: &Entry) -> Result<(), String> {
    if entry.placement["Locked"] == true {
        return Ok(());
    }
    let Some(window) = app.get_webview_window(&entry.label) else {
        return Ok(());
    };
    let actual = bounds(&window)?;
    if !entry.preview && actual == entry.expected {
        return Ok(());
    }
    let (next, edge) = actual.snap(&areas(&window)?, entry.snap);
    let owned = key.to_owned();
    let snapshot = operation(app.clone(), move |store| {
        store.widget_native_geometry(&owned, next, edge)
    })
    .await
    .map_err(|error| format!("保存组件位置失败，已取消退出：{error}"))?;
    if let Some(current) = app
        .state::<Service>()
        .entries
        .lock()
        .map_err(|error| error.to_string())?
        .get_mut(key)
    {
        current.preview = false;
        current.expected = next;
    }
    broadcast(app, &snapshot);
    Ok(())
}
pub fn destroyed(app: &tauri::AppHandle, label: &str) {
    app.state::<crate::events::Service>().destroyed(label);
    crate::window_release::cancel(app, label);
    app.state::<crate::file_search::SearchService>()
        .release_owner(label);
    if let Ok(mut entries) = app.state::<Service>().entries.lock() {
        entries.retain(|_, entry| entry.label != label);
    }
}

#[tauri::command]
pub async fn widgets_visibility(
    app: tauri::AppHandle,
    window: WebviewWindow,
    keys: Vec<String>,
) -> Result<Value, String> {
    let mut result = serde_json::Map::new();
    for key in keys {
        controller(&app, &window, &key)?;
        result.insert(key.clone(), json!(visible(&app, &key)));
    }
    Ok(Value::Object(result))
}
#[tauri::command]
pub async fn widgets_set(
    app: tauri::AppHandle,
    window: WebviewWindow,
    key: Option<String>,
    visible: Option<bool>,
) -> Result<Value, String> {
    let key = key.unwrap_or_else(|| "todo".into());
    controller(&app, &window, &key)?;
    set(&app, &key, visible).await
}
async fn set(app: &tauri::AppHandle, key: &str, desired: Option<bool>) -> Result<Value, String> {
    let gate = app.state::<Service>().gate.clone();
    let _guard = gate.lock().await;
    app.state::<QuitState>().require_interactive()?;
    let desired = desired.unwrap_or_else(|| !visible(app, key));
    let owned = key.to_string();
    let snapshot = operation(app.clone(), move |store| {
        store.widget_visible(&owned, desired)
    })
    .await?;
    broadcast(app, &snapshot);
    apply(app, &snapshot)?;
    Ok(json!({"ok":true,"visible":visible(app,key)}))
}
pub fn close_requested(app: &tauri::AppHandle, label: &str) {
    if let Some(key) = app.state::<Service>().key(label) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(error) = set(&app, &key, Some(false)).await {
                eprintln!("隐藏小组件失败：{error}");
            }
        });
    }
}

pub fn request_toggle_configured(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let gate = app.state::<Service>().gate.clone();
        let _guard = gate.lock().await;
        let result = async {
            app.state::<crate::draft_startup::Service>()
                .require_ready()?;
            app.state::<QuitState>().require_interactive()?;
            let snapshot = operation(app.clone(), |store| store.widget_load()).await?;
            let mut keys: Vec<String> = snapshot.state["Settings"]["DesktopHotKeyWidgetKeys"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|key| model::valid_key(key))
                .map(str::to_owned)
                .collect();
            keys.sort();
            keys.dedup();
            if keys.is_empty() {
                keys.push("todo".into());
            }
            let show = !keys.iter().any(|key| visible(&app, key));
            let mut state = snapshot.state.clone();
            for key in keys {
                if show && !model::exists(&key, &state) {
                    continue;
                }
                if !state["Settings"]["WidgetPlacements"][&key].is_object() {
                    state["Settings"]["WidgetPlacements"][&key] = json!({});
                }
                state["Settings"]["WidgetPlacements"][&key]["Visible"] = json!(show);
            }
            let saved = operation(app.clone(), move |store| {
                store.save(state, Some(snapshot.state), "native-widget-toggle")
            })
            .await?;
            broadcast(&app, &saved);
            apply(&app, &saved)
        }
        .await;
        if let Err(error) = result {
            eprintln!("切换桌面组件失败：{error}");
            let _ = crate::events::emit(&app, "workspace-main", "system:action-error", error);
        }
    });
}

#[tauri::command]
pub async fn widgets_options(
    app: tauri::AppHandle,
    window: WebviewWindow,
    key: String,
    options: Options,
) -> Result<Value, String> {
    controller(&app, &window, &key)?;
    let gate = app.state::<Service>().gate.clone();
    let _guard = gate.lock().await;
    app.state::<QuitState>().require_interactive()?;
    let entry = app.state::<Service>().entry(&key).ok();
    let snapped = if options.snap_to_edges == Some(true) {
        if let Some(entry) = entry {
            if let Some(target) = app.get_webview_window(&entry.label) {
                Some(bounds(&target)?.snap(&areas(&target)?, true))
            } else {
                None
            }
        } else {
            None
        }
    } else {
        None
    };
    let snapshot = operation(app.clone(), move |store| {
        store.widget_options(&key, options, snapped)
    })
    .await?;
    broadcast(&app, &snapshot);
    apply(&app, &snapshot)?;
    Ok(json!({"ok":true}))
}
#[tauri::command]
pub async fn widgets_geometry(
    app: tauri::AppHandle,
    window: WebviewWindow,
    key: String,
    first: f64,
    second: f64,
    resize: bool,
    commit: bool,
) -> Result<Value, String> {
    controller(&app, &window, &key)?;
    if !first.is_finite()
        || !second.is_finite()
        || first.abs() > 10000000.0
        || second.abs() > 10000000.0
    {
        return Err("小组件位置或尺寸无效".into());
    }
    let gate = app.state::<Service>().gate.clone();
    let _guard = gate.lock().await;
    app.state::<QuitState>().require_interactive()?;
    let entry = app.state::<Service>().entry(&key)?;
    if entry.placement["Locked"] == true {
        return Err("小组件已锁定".into());
    }
    let target = app
        .get_webview_window(&entry.label)
        .ok_or("小组件窗口不可用")?;
    let mut next = bounds(&target)?;
    if resize {
        next.width = first
            .round()
            .clamp(if key == "search" { 52.0 } else { 300.0 }, 1200.0);
        next.height = second
            .round()
            .clamp(if key == "search" { 52.0 } else { 120.0 }, 900.0);
    } else {
        next.x = model::round_coordinate(first);
        next.y = model::round_coordinate(second);
    }
    let enabled = entry.snap;
    let (next, edge) = if resize {
        (next, "None")
    } else {
        next.snap(&areas(&target)?, enabled)
    };
    if commit {
        let owned = key.clone();
        let snapshot = operation(app.clone(), move |store| {
            store.widget_geometry(&owned, next, edge, resize)
        })
        .await?;
        if let Some(entry) = app
            .state::<Service>()
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .get_mut(&key)
        {
            entry.preview = false;
        }
        broadcast(&app, &snapshot);
        apply(&app, &snapshot)?;
    } else {
        if let Some(entry) = app
            .state::<Service>()
            .entries
            .lock()
            .map_err(|error| error.to_string())?
            .get_mut(&key)
        {
            entry.expected = next;
            entry.preview = true;
            entry.serial = entry.serial.wrapping_add(1);
        }
        if resize {
            target
                .set_size(tauri::LogicalSize::new(next.width, next.height))
                .map_err(|error| error.to_string())?;
        } else {
            target
                .set_position(tauri::LogicalPosition::new(next.x, next.y))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(json!({"ok":true}))
}
#[tauri::command]
pub async fn widgets_presets(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    name: Option<String>,
) -> Result<Value, String> {
    workspace::api::require_workspace(&window)?;
    let gate = app.state::<Service>().gate.clone();
    let _guard = gate.lock().await;
    app.state::<QuitState>().require_interactive()?;
    if action == "list" {
        let snapshot = operation(app, |store| store.load("widget-presets")).await?;
        let mut names: Vec<String> = snapshot.state["Settings"]["WidgetLayoutPresets"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        let locale: icu_locale_core::Locale = "zh-CN"
            .parse()
            .map_err(|error| format!("排序区域无效：{error}"))?;
        let collator = icu_collator::Collator::try_new(
            locale.into(),
            icu_collator::options::CollatorOptions::default(),
        )
        .map_err(|error| error.to_string())?;
        names.sort_by(|left, right| collator.compare(left, right));
        return Ok(json!(names));
    }
    let name = name.ok_or("布局名称无效")?;
    let snapshot = operation(app.clone(), move |store| {
        store.widget_preset(&action, &name)
    })
    .await?;
    broadcast(&app, &snapshot);
    apply(&app, &snapshot)?;
    Ok(json!({"ok":true}))
}

pub fn geometry_event(app: &tauri::AppHandle, label: &str) {
    let service = app.state::<Service>();
    let Some(key) = service.key(label) else {
        return;
    };
    let serial = if let Ok(mut entries) = service.entries.lock() {
        if let Some(entry) = entries.get_mut(&key) {
            entry.serial = entry.serial.wrapping_add(1);
            entry.serial
        } else {
            return;
        }
    } else {
        return;
    };
    let label = label.to_owned();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(150)).await;
        let gate = app.state::<Service>().gate.clone();
        let _guard = gate.lock().await;
        let result = async {
            if app.state::<QuitState>().require_interactive().is_err() {
                return Ok(());
            }
            let Ok(entry) = app.state::<Service>().entry(&key) else {
                return Ok(());
            };
            if entry.label != label
                || entry.serial != serial
                || entry.preview
                || entry.placement["Locked"] == true
            {
                return Ok(());
            }
            let Some(window) = app.get_webview_window(&entry.label) else {
                return Ok(());
            };
            let actual = bounds(&window)?;
            if actual == entry.expected {
                return Ok(());
            }
            let (next, edge) = actual.snap(&areas(&window)?, entry.snap);
            let snapshot = operation(app.clone(), move |store| {
                store.widget_native_geometry(&key, next, edge)
            })
            .await?;
            broadcast(&app, &snapshot);
            apply(&app, &snapshot)?;
            Ok::<(), String>(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("保存原生组件位置失败：{error}");
        }
    });
}
