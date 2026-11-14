use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    str::FromStr,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

const FIELDS: [(&str, &str, Action); 5] = [
    ("mainWindow", "MainWindowHotKey", Action::Main),
    ("widgets", "DesktopWidgetsHotKey", Action::Widgets),
    ("screenshot", "ScreenshotHotKey", Action::Screenshot),
    ("pin", "PinScreenshotHotKey", Action::Pin),
    ("quickCapture", "QuickCaptureHotKey", Action::Quick),
];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Action {
    Main,
    Widgets,
    Screenshot,
    Pin,
    Quick,
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Binding {
    shortcut: Shortcut,
    action: Action,
}
type Bindings = BTreeMap<u32, Binding>;

fn configuration(settings: &Value) -> Result<Bindings, String> {
    let mut bindings = Bindings::new();
    for (_, field, action) in FIELDS {
        let text = settings[field].as_str().ok_or("快捷键格式无效")?;
        if text.encode_utf16().count() > 80 {
            return Err("快捷键格式无效".into());
        }
        if text.trim().is_empty() {
            continue;
        }
        let shortcut =
            Shortcut::from_str(text.trim()).map_err(|_| format!("快捷键无效：{text}"))?;
        if bindings
            .insert(shortcut.id(), Binding { shortcut, action })
            .is_some()
        {
            return Err("快捷键不能重复（包括不同写法的同一组合）".into());
        }
    }
    Ok(bindings)
}
fn patch(settings: &mut Value, keys: Value) -> Result<(), String> {
    let keys = keys.as_object().ok_or("快捷键格式无效")?;
    for (name, value) in keys {
        let field = FIELDS
            .iter()
            .find(|(key, _, _)| name == key)
            .map(|(_, field, _)| *field)
            .ok_or("未知快捷键设置")?;
        let value = value
            .as_str()
            .filter(|text| text.encode_utf16().count() <= 80)
            .ok_or("快捷键格式无效")?;
        settings[field] = json!(value);
    }
    Ok(())
}

trait Registrar {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String>;
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String>;
}
#[derive(Default)]
struct State {
    active: Bindings,
    installed: BTreeMap<u32, Shortcut>,
    error: Option<String>,
}
impl State {
    fn reconcile(
        &mut self,
        registrar: &mut impl Registrar,
        target: &BTreeMap<u32, Shortcut>,
        preparing: bool,
    ) -> Result<(), String> {
        let mut errors = Vec::new();
        for (id, shortcut) in target {
            if !self.installed.contains_key(id) {
                match registrar.register(*shortcut) {
                    Ok(()) => {
                        self.installed.insert(*id, *shortcut);
                    }
                    Err(error) => errors.push(error),
                }
            }
        }
        if preparing && !errors.is_empty() {
            return Err(errors.join("；"));
        }
        for (id, shortcut) in self.installed.clone() {
            if !target.contains_key(&id) {
                match registrar.unregister(shortcut) {
                    Ok(()) => {
                        self.installed.remove(&id);
                    }
                    Err(error) => errors.push(error),
                }
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("；"))
        }
    }
    fn transition<T>(
        &mut self,
        registrar: &mut impl Registrar,
        next: Bindings,
        persist: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let previous = self.installed.clone();
        let wanted = next
            .iter()
            .map(|(id, binding)| (*id, binding.shortcut))
            .collect();
        let outcome = self
            .reconcile(registrar, &wanted, true)
            .and_then(|()| persist());
        match outcome {
            Ok(result) => {
                self.active = next;
                self.error = None;
                Ok(result)
            }
            Err(error) => {
                let rollback = self.reconcile(registrar, &previous, false);
                let error = match rollback {
                    Ok(()) => error,
                    Err(rollback) => format!("{error}；恢复旧快捷键失败：{rollback}"),
                };
                self.error = Some(error.clone());
                Err(error)
            }
        }
    }
}
pub struct Service {
    state: Mutex<State>,
    started: AtomicBool,
    updates: tokio::sync::watch::Sender<()>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            started: AtomicBool::new(false),
            updates: tokio::sync::watch::channel(()).0,
        }
    }
}
struct NativeRegistrar<'a>(&'a tauri::AppHandle);
impl Registrar for NativeRegistrar<'_> {
    fn register(&mut self, shortcut: Shortcut) -> Result<(), String> {
        if disabled() {
            return Ok(());
        }
        self.0
            .global_shortcut()
            .on_shortcut(shortcut, |app, shortcut, event| {
                if event.state == ShortcutState::Pressed {
                    dispatch(app, shortcut.id());
                }
            })
            .map_err(|error| format!("快捷键无效或已被其他程序占用（{shortcut}）：{error}"))
    }
    fn unregister(&mut self, shortcut: Shortcut) -> Result<(), String> {
        if disabled() {
            return Ok(());
        }
        self.0
            .global_shortcut()
            .unregister(shortcut)
            .map_err(|error| format!("无法释放快捷键（{shortcut}）：{error}"))
    }
}
fn disabled() -> bool {
    std::env::var_os("DUSTDESK_TAURI_DISABLE_HOTKEYS").is_some()
}
fn commit<T>(
    app: &tauri::AppHandle,
    settings: &Value,
    persist: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let next = configuration(settings)?;
    let service = app.state::<Service>();
    let mut state = service.state.lock().map_err(|error| error.to_string())?;
    let changed = state.active != next || state.error.is_some();
    let count = next.len();
    let result = state.transition(&mut NativeRegistrar(app), next, persist);
    if result.is_ok() && changed {
        eprintln!("全局快捷键已应用（{count} 项）");
    }
    result
}
pub fn error(app: &tauri::AppHandle) -> Option<String> {
    app.state::<Service>()
        .state
        .try_lock()
        .ok()
        .and_then(|state| state.error.clone())
}
fn failure(app: &tauri::AppHandle, error: &str) {
    eprintln!("快捷键未应用：{error}");
    if let Ok(mut state) = app.state::<Service>().state.lock() {
        state.error = Some(error.into());
    }
    let _ = crate::events::emit(
        app,
        "workspace-main",
        "system:action-error",
        error.to_string(),
    );
    if let Some(tray) = app.tray_by_id("dustdesk-preview") {
        let _ = tray.set_tooltip(Some(format!(
            "DustDesk · 快捷键未应用：{}",
            error.chars().take(300).collect::<String>()
        )));
    }
}
fn dispatch(app: &tauri::AppHandle, id: u32) {
    let app = app.clone();
    // Registration can wait for the UI thread. Wait for its state on a worker
    // so a key pressed during a settings update uses the committed binding.
    tauri::async_runtime::spawn_blocking(move || dispatch_committed(&app, id));
}
fn dispatch_committed(app: &tauri::AppHandle, id: u32) {
    let service = app.state::<Service>();
    let action = service.state.lock().ok().and_then(|state| {
        state
            .installed
            .contains_key(&id)
            .then(|| state.active.get(&id).map(|binding| binding.action))
            .flatten()
    });
    if app
        .state::<crate::draft_startup::Service>()
        .require_ready()
        .is_err()
        || app
            .state::<crate::lifecycle::QuitState>()
            .require_interactive()
            .is_err()
    {
        return;
    }
    match action {
        Some(Action::Main) => crate::main_window::request_show(app),
        Some(Action::Quick) => crate::quick_capture::request_show(app),
        Some(Action::Screenshot) => {
            crate::screenshot_capture::request_native(app, "screenshot:region")
        }
        Some(Action::Widgets) => crate::widgets::request_toggle_configured(app),
        Some(Action::Pin) => crate::screenshot_pins::request_clipboard(app),
        None => {}
    }
}

pub fn changed(app: &tauri::AppHandle) {
    let service = app.state::<Service>();
    service.updates.send_replace(());
    if service.started.swap(true, Ordering::SeqCst) {
        return;
    }
    let mut updates = service.updates.subscribe();
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            updates.borrow_and_update();
            let gate = app.state::<crate::widgets::Service>().gate.clone();
            {
                let _guard = gate.lock().await;
                if app
                    .state::<crate::draft_startup::Service>()
                    .require_ready()
                    .is_ok()
                    && app
                        .state::<crate::lifecycle::QuitState>()
                        .require_interactive()
                        .is_ok()
                {
                    let owner = app.clone();
                    let result = crate::workspace::commands::operation(app.clone(), move |store| {
                        let settings = store.widget_load()?.state["Settings"].clone();
                        commit(&owner, &settings, || Ok(()))
                    })
                    .await;
                    if let Err(error) = result {
                        failure(&app, &error);
                    }
                }
            }
            if updates.changed().await.is_err() {
                break;
            }
        }
    });
}

#[tauri::command]
pub async fn hotkeys_set(
    app: tauri::AppHandle,
    window: WebviewWindow,
    keys: Value,
) -> Result<Value, String> {
    crate::workspace::api::require_workspace(&window)?;
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    let owner = app.clone();
    let result = crate::workspace::commands::operation(app.clone(), move |store| {
        let baseline = store.widget_load()?.state;
        let mut state = baseline.clone();
        patch(&mut state["Settings"], keys)?;
        let settings = state["Settings"].clone();
        commit(&owner, &settings, || {
            store.save(state, Some(baseline), "hotkeys")
        })
    })
    .await;
    match result {
        Ok(snapshot) => {
            crate::workspace::commands::broadcast(&app, &snapshot);
            Ok(json!({"ok":true}))
        }
        Err(error) => {
            failure(&app, &error);
            Ok(json!({"ok":false,"error":error}))
        }
    }
}
#[tauri::command]
pub fn hotkeys_status(app: tauri::AppHandle, window: WebviewWindow) -> Result<Value, String> {
    crate::workspace::api::require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    Ok(json!({"disabled":disabled(),"error":error(&app)}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    #[derive(Default)]
    struct Fake {
        keys: HashSet<u32>,
        register_failure: Option<u32>,
        unregister_failure: Option<u32>,
        calls: Vec<(bool, u32)>,
    }
    impl Registrar for Fake {
        fn register(&mut self, key: Shortcut) -> Result<(), String> {
            self.calls.push((true, key.id()));
            if self.register_failure == Some(key.id()) {
                return Err("conflict".into());
            }
            assert!(self.keys.insert(key.id()));
            Ok(())
        }
        fn unregister(&mut self, key: Shortcut) -> Result<(), String> {
            self.calls.push((false, key.id()));
            if self.unregister_failure == Some(key.id()) {
                return Err("unregister".into());
            }
            assert!(self.keys.remove(&key.id()));
            Ok(())
        }
    }
    fn settings(main: &str, quick: &str) -> Value {
        json!({"MainWindowHotKey":main,"DesktopWidgetsHotKey":"","ScreenshotHotKey":"","PinScreenshotHotKey":"","QuickCaptureHotKey":quick})
    }
    #[test]
    fn aliases_are_duplicates_and_empty_accelerators_disable_individual_actions() {
        assert!(configuration(&settings("Ctrl+Shift+K", "Shift+Control+KeyK")).is_err());
        assert!(configuration(&settings("Ctrl+Shift+K", "bad+key+syntax")).is_err());
        assert!(configuration(&settings("", " ")).unwrap().is_empty());
        let mut value = settings("Ctrl+F18", "");
        for patch_value in [
            json!(null),
            json!([]),
            json!({"pin":null}),
            json!({"pin":false}),
            json!({"unknown":"F3"}),
            json!({"pin":"x".repeat(81)}),
        ] {
            assert!(patch(&mut value, patch_value).is_err());
        }
    }
    #[test]
    fn config_and_actual_registrations_roll_back_on_conflict_or_disk_failure() {
        let old = configuration(&settings("Ctrl+F18", "Ctrl+F19")).unwrap();
        let next = configuration(&settings("Ctrl+F20", "Ctrl+F21")).unwrap();
        for disk_failure in [false, true] {
            let mut state = State::default();
            let mut fake = Fake::default();
            state.transition(&mut fake, old.clone(), || Ok(())).unwrap();
            if !disk_failure {
                fake.register_failure = Some(next.keys().next().copied().unwrap());
            }
            let mut persisted = false;
            fake.calls.clear();
            assert!(state
                .transition(&mut fake, next.clone(), || {
                    persisted = true;
                    Err::<(), _>("disk".into())
                })
                .is_err());
            assert_eq!(persisted, disk_failure);
            if !disk_failure {
                assert!(
                    fake.calls
                        .iter()
                        .all(|(register, id)| *register || !old.contains_key(id)),
                    "failed preparation must not release an old binding"
                );
            }
            assert_eq!(state.active, old);
            assert_eq!(fake.keys, old.keys().copied().collect());
            assert_eq!(
                state.installed.keys().copied().collect::<HashSet<_>>(),
                fake.keys
            );
            fake.register_failure = None;
            state
                .transition(&mut fake, next.clone(), || Ok(()))
                .unwrap();
            assert_eq!(state.active, next);
            assert!(state.error.is_none());
        }
    }
    #[test]
    fn swapping_action_owners_reuses_registration_and_unregister_failure_never_persists() {
        let mut state = State::default();
        let mut fake = Fake::default();
        let old = configuration(&settings("Ctrl+F18", "Ctrl+F19")).unwrap();
        state.transition(&mut fake, old.clone(), || Ok(())).unwrap();
        fake.calls.clear();
        let swapped = configuration(&settings("Ctrl+F19", "Ctrl+F18")).unwrap();
        state
            .transition(&mut fake, swapped.clone(), || Ok(()))
            .unwrap();
        assert!(fake.calls.is_empty());
        assert_eq!(state.active, swapped);
        fake.unregister_failure = old.keys().next().copied();
        assert!(state
            .transition(&mut fake, Bindings::new(), || -> Result<(), String> {
                panic!("unregister failure must not persist")
            })
            .is_err());
        assert_eq!(state.active, swapped);
        assert_eq!(fake.keys, old.keys().copied().collect());
    }
}
