use crate::{
    lifecycle::QuitState,
    workspace::{
        api::require_workspace,
        commands::{operation, StorageState},
        productivity, resources,
    },
};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicIsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Manager, WebviewWindow};

#[derive(Default)]
struct Picker {
    owner: String,
    handle: Arc<AtomicIsize>,
    cancelled: Arc<AtomicBool>,
    native_cancel: Option<tokio_util::sync::CancellationToken>,
}
pub struct SystemService {
    picker: Mutex<Option<Arc<Picker>>>,
    grants: Mutex<HashSet<String>>,
    opens: Arc<tokio::sync::Semaphore>,
}
impl Default for SystemService {
    fn default() -> Self {
        Self {
            picker: Mutex::new(None),
            grants: Mutex::new(HashSet::new()),
            opens: Arc::new(tokio::sync::Semaphore::new(4)),
        }
    }
}

#[tauri::command]
pub fn system_cancel_picker(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    app.state::<crate::lan_host::Service>().cancel_renderer();
    app.state::<SystemService>().cancel_picker();
    app.state::<crate::path_menu::MenuService>().cancel();
    Ok(())
}
impl SystemService {
    pub(crate) fn grant_drop(
        &self,
        paths: &[std::path::PathBuf],
        publish: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let keys: Vec<String> = paths
            .iter()
            .map(|path| path_key(path.to_str().ok_or("拖入路径无效")?))
            .collect::<Result<_, String>>()?;
        let mut grants = self.grants.lock().map_err(|error| error.to_string())?;
        let added: Vec<String> = keys
            .into_iter()
            .filter(|key| grants.insert(key.clone()))
            .collect();
        if let Err(error) = publish() {
            for key in added {
                grants.remove(&key);
            }
            return Err(error);
        }
        Ok(())
    }
    pub(crate) fn grant(&self, path: &Path) -> Result<(), String> {
        let key = path_key(path.to_str().ok_or("文件路径无效")?)?;
        self.grants
            .lock()
            .map_err(|error| error.to_string())?
            .insert(key);
        Ok(())
    }
    pub(crate) fn selected(&self, path: &Path) -> Result<bool, String> {
        let key = path_key(path.to_str().ok_or("文件路径无效")?)?;
        Ok(self
            .grants
            .lock()
            .map_err(|error| error.to_string())?
            .contains(&key))
    }
    pub fn busy(&self) -> bool {
        self.picker.lock().map_or(true, |picker| picker.is_some())
            || self.opens.available_permits() < 4
    }
    pub fn cancel_picker(&self) {
        self.cancel_matching(None);
    }
    pub(crate) fn cancel_picker_for(&self, owner: &str) {
        self.cancel_matching(Some(owner));
    }
    fn cancel_matching(&self, owner: Option<&str>) {
        if let Ok(slot) = self.picker.lock() {
            if let Some(picker) = slot
                .as_ref()
                .filter(|picker| owner.is_none_or(|owner| picker.owner == owner))
            {
                picker.cancelled.store(true, Ordering::SeqCst);
                if let Some(cancel) = &picker.native_cancel {
                    cancel.cancel();
                }
                #[cfg(windows)]
                crate::platform::shell::cancel(picker.handle.load(Ordering::SeqCst));
            }
        }
    }
    pub fn release(&self) {
        self.cancel_picker();
        if let Ok(mut grants) = self.grants.lock() {
            grants.clear();
        }
    }
    pub(crate) fn release_main(&self) {
        self.cancel_picker_for("workspace-main");
        if let Ok(mut grants) = self.grants.lock() {
            grants.clear();
        }
    }
}
/// Shared exclusion and cancellation for native background LAN modals.
/// The lease stays on the blocking UI thread until the real dialog returns.
pub(crate) fn native_modal(
    app: &tauri::AppHandle,
    cancel: &tokio_util::sync::CancellationToken,
) -> Result<NativeModal, String> {
    app.state::<QuitState>().require_interactive()?;
    let picker = Arc::new(Picker {
        owner: "$lan".into(),
        native_cancel: Some(cancel.clone()),
        ..Picker::default()
    });
    {
        let service = app.state::<SystemService>();
        let mut slot = service.picker.lock().map_err(|error| error.to_string())?;
        if slot.is_some() {
            return Err("已有系统确认窗口，请先完成或取消".into());
        }
        *slot = Some(picker.clone());
    }
    let lease = NativeModal(PickerGuard {
        app: app.clone(),
        picker,
    });
    app.state::<QuitState>().require_interactive()?;
    if cancel.is_cancelled() {
        return Err("局域网确认已取消".into());
    }
    Ok(lease)
}
pub(crate) struct NativeModal(#[allow(dead_code)] PickerGuard);
struct PickerGuard {
    app: tauri::AppHandle,
    picker: Arc<Picker>,
}
impl Drop for PickerGuard {
    fn drop(&mut self) {
        if let Ok(mut slot) = self.app.state::<SystemService>().picker.lock() {
            if slot
                .as_ref()
                .is_some_and(|value| Arc::ptr_eq(value, &self.picker))
            {
                *slot = None;
            }
        };
    }
}
fn title(value: Option<String>, folder: bool) -> Result<String, String> {
    let fallback = if folder {
        "选择文件夹"
    } else {
        "选择文件或文件夹"
    };
    let text = value
        .filter(|value| !productivity::trim(value).is_empty())
        .unwrap_or_else(|| fallback.into());
    if text.contains('\0') {
        return Err("对话框标题无效".into());
    }
    let mut length = 0;
    Ok(text
        .chars()
        .take_while(|character| {
            length += character.len_utf16();
            length <= 120
        })
        .collect())
}
pub(crate) fn path_key(value: &str) -> Result<String, String> {
    if value.is_empty()
        || value.encode_utf16().count() > 4096
        || value.contains('\0')
        || !Path::new(value).is_absolute()
    {
        return Err("路径无效，请使用完整文件或文件夹路径".into());
    }
    #[cfg(windows)]
    if value.starts_with(r"\\.\")
        || value.starts_with(r"\\?\")
        || value.get(2..).is_some_and(|rest| rest.contains(':'))
    {
        return Err("路径无效，不支持设备路径或文件流".into());
    }
    let mut normalized = std::path::PathBuf::new();
    for component in Path::new(value).components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            component => normalized.push(component.as_os_str()),
        }
    }
    Ok(normalized.to_string_lossy().to_lowercase())
}
pub(crate) async fn sta<ResultType: Send + 'static>(
    callback: impl FnOnce() -> Result<ResultType, String> + Send + 'static,
) -> Result<ResultType, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    std::thread::Builder::new()
        .name("dustdesk-shell-sta".into())
        .spawn(move || {
            let _ = sender.send(callback());
        })
        .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}
fn owner(window: &WebviewWindow) -> Result<isize, String> {
    #[cfg(windows)]
    {
        Ok(window.hwnd().map_err(|error| error.to_string())?.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Err("当前平台尚未接通原生资源操作".into())
    }
}

#[tauri::command]
pub async fn system_pick(
    app: tauri::AppHandle,
    window: WebviewWindow,
    folder: bool,
    title: Option<String>,
) -> Result<Value, String> {
    select(app, window, folder, title, false, false).await
}

pub(crate) async fn pick_image(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    select(
        app,
        window,
        false,
        Some("选择便签背景图片".into()),
        true,
        false,
    )
    .await
}

pub(crate) async fn pick_drafts(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    select(
        app,
        window,
        false,
        Some("选择草稿迁移包".into()),
        false,
        true,
    )
    .await
}

async fn select(
    app: tauri::AppHandle,
    window: WebviewWindow,
    folder: bool,
    title: Option<String>,
    images: bool,
    drafts: bool,
) -> Result<Value, String> {
    require_workspace(&window)?;
    app.state::<QuitState>().require_interactive()?;
    let title = match self::title(title, folder) {
        Ok(value) => value,
        Err(error) => return Ok(json!({"ok":false,"error":error})),
    };
    let service = app.state::<SystemService>();
    let picker = Arc::new(Picker {
        owner: window.label().into(),
        ..Picker::default()
    });
    {
        let mut slot = service.picker.lock().map_err(|error| error.to_string())?;
        if slot.is_some() {
            return Ok(json!({"ok":false,"error":"已有文件选择窗口，请先完成或取消"}));
        }
        *slot = Some(picker.clone());
    }
    let _guard = PickerGuard {
        app: app.clone(),
        picker: picker.clone(),
    };
    if app.state::<QuitState>().require_interactive().is_err() {
        picker.cancelled.store(true, Ordering::SeqCst);
        return Ok(json!({"ok":false,"canceled":true}));
    }
    let handle = owner(&window)?;
    #[cfg(windows)]
    let selected = {
        let picker = picker.clone();
        sta(move || {
            crate::platform::shell::pick(
                handle,
                title,
                folder,
                images,
                drafts,
                picker.handle.clone(),
                picker.cancelled.clone(),
            )
        })
        .await
    };
    #[cfg(not(windows))]
    let selected: Result<Option<std::path::PathBuf>, String> = {
        let _ = (handle, title, folder);
        Err("当前平台尚未接通原生路径选择".into())
    };
    if picker.cancelled.load(Ordering::SeqCst) {
        return Ok(json!({"ok":false,"canceled":true}));
    }
    match selected {
        Ok(Some(path)) => {
            let path = path.display().to_string();
            let key = match path_key(&path) {
                Ok(key) => key,
                Err(error) => return Ok(json!({"ok":false,"error":error})),
            };
            service
                .grants
                .lock()
                .map_err(|error| error.to_string())?
                .insert(key);
            Ok(json!({"ok":true,"path":path}))
        }
        Ok(None) => Ok(json!({"ok":false,"canceled":true})),
        Err(error) => Ok(json!({"ok":false,"error":error})),
    }
}

pub(crate) struct SaveSelection {
    pub path: std::path::PathBuf,
    guard: PickerGuard,
}
pub(crate) struct ImageSelection {
    pub paths: Vec<std::path::PathBuf>,
    guard: PickerGuard,
}
impl ImageSelection {
    pub fn require_active(&self) -> Result<(), String> {
        if self.guard.picker.cancelled.load(Ordering::SeqCst) {
            Err("图片导入已取消".into())
        } else {
            Ok(())
        }
    }
}
pub(crate) async fn select_tool_images(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<ImageSelection>, String> {
    select_tool_paths(app, window, false, true).await
}
pub(crate) async fn select_tool_paths(
    app: tauri::AppHandle,
    window: WebviewWindow,
    folder: bool,
    images: bool,
) -> Result<Option<ImageSelection>, String> {
    crate::toolbox::require_active(&app, &window)?;
    let picker = Arc::new(Picker {
        owner: window.label().into(),
        ..Picker::default()
    });
    {
        let service = app.state::<SystemService>();
        let mut slot = service.picker.lock().map_err(|error| error.to_string())?;
        if slot.is_some() {
            return Err("已有文件选择窗口，请先完成或取消".into());
        }
        *slot = Some(picker.clone());
    }
    let guard = PickerGuard {
        app: app.clone(),
        picker: picker.clone(),
    };
    crate::toolbox::require_active(&app, &window)?;
    let handle = owner(&window)?;
    #[cfg(windows)]
    let selected = {
        let picker = picker.clone();
        sta(move || {
            crate::platform::shell::pick_tool_paths(
                handle,
                folder,
                images,
                picker.handle.clone(),
                picker.cancelled.clone(),
            )
        })
        .await?
    };
    #[cfg(not(windows))]
    let selected: Option<Vec<std::path::PathBuf>> = {
        let _ = handle;
        return Err("当前平台尚未接通图片选择".into());
    };
    if picker.cancelled.load(Ordering::SeqCst) {
        return Ok(None);
    }
    crate::toolbox::require_active(&app, &window)?;
    selected
        .map(|paths| Ok(ImageSelection { paths, guard }))
        .transpose()
}
impl SaveSelection {
    pub(crate) fn finish_selection(self) -> Result<std::path::PathBuf, String> {
        self.require_active()?;
        // The native dialog has closed. Release its picker registration before
        // maintenance cancels pending pickers; the path stays native-only.
        Ok(self.path.clone())
    }
    pub fn require_active(&self) -> Result<(), String> {
        if self.guard.picker.cancelled.load(Ordering::SeqCst) {
            Err("导出已取消，未写入目标文件".into())
        } else {
            Ok(())
        }
    }
}

pub(crate) async fn select_project_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<SaveSelection>, String> {
    select_export(app, window, crate::platform::ExportKind::Projects).await
}

pub(crate) async fn select_text_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<SaveSelection>, String> {
    select_export(app, window, crate::platform::ExportKind::Text).await
}
pub(crate) async fn select_draft_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<SaveSelection>, String> {
    select_export(app, window, crate::platform::ExportKind::Drafts).await
}
pub(crate) async fn select_image_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
    name: String,
    extension: String,
) -> Result<Option<SaveSelection>, String> {
    select_export(
        app,
        window,
        crate::platform::ExportKind::Images { name, extension },
    )
    .await
}
pub(crate) async fn select_screenshot_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
    path: std::path::PathBuf,
    extension: String,
) -> Result<Option<SaveSelection>, String> {
    select_export(
        app,
        window,
        crate::platform::ExportKind::Screenshots { path, extension },
    )
    .await
}

async fn select_export(
    app: tauri::AppHandle,
    window: WebviewWindow,
    kind: crate::platform::ExportKind,
) -> Result<Option<SaveSelection>, String> {
    if matches!(&kind, crate::platform::ExportKind::Screenshots { .. }) {
        crate::screenshot_capture::require(&app, &window)?;
    } else {
        require_workspace(&window)?;
    }
    app.state::<QuitState>().require_interactive()?;
    app.state::<crate::draft_startup::Service>()
        .require_ready()?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    let picker = Arc::new(Picker {
        owner: window.label().into(),
        ..Picker::default()
    });
    {
        let service = app.state::<SystemService>();
        let mut slot = service.picker.lock().map_err(|error| error.to_string())?;
        if slot.is_some() {
            return Err("已有文件选择窗口，请先完成或取消".into());
        }
        *slot = Some(picker.clone());
    }
    let guard = PickerGuard {
        app: app.clone(),
        picker: picker.clone(),
    };
    app.state::<QuitState>().require_interactive()?;
    let handle = owner(&window)?;
    let default_path = match &kind {
        crate::platform::ExportKind::Screenshots { path, .. } => path.clone(),
        _ => app
            .path()
            .document_dir()
            .map_err(|error| error.to_string())?
            .join(match &kind {
                crate::platform::ExportKind::Projects => format!(
                    "项目管理_{}.xlsx",
                    chrono::Utc::now().format("%Y-%m-%d-%H-%M")
                ),
                crate::platform::ExportKind::Text => "DustDesk-文本.txt".into(),
                crate::platform::ExportKind::Drafts => format!(
                    "DustDesk-草稿-{}.json",
                    chrono::Utc::now().format("%Y-%m-%d-%H-%M")
                ),
                crate::platform::ExportKind::Images { name, .. } => name.clone(),
                crate::platform::ExportKind::Screenshots { .. } => unreachable!(),
            }),
    };
    #[cfg(windows)]
    let selected = {
        let picker = picker.clone();
        sta(move || {
            crate::platform::shell::save_export(
                handle,
                default_path,
                kind,
                picker.handle.clone(),
                picker.cancelled.clone(),
            )
        })
        .await?
    };
    #[cfg(not(windows))]
    let selected: Option<std::path::PathBuf> = {
        let _ = (handle, default_path);
        return Err("当前平台尚未接通原生保存".into());
    };
    if picker.cancelled.load(Ordering::SeqCst) {
        return Ok(None);
    }
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效，未交付导出目标".into());
    }
    app.state::<QuitState>().require_interactive()?;
    selected
        .map(|path| {
            path_key(path.to_str().ok_or("导出路径无效")?)?;
            Ok(SaveSelection { path, guard })
        })
        .transpose()
}

fn referenced(state: &Value, key: &str) -> bool {
    resources::collect(state)
        .iter()
        .filter(|item| item.kind != "link")
        .any(|item| path_key(&item.target).is_ok_and(|value| value == key))
        || state["Notes"].as_array().into_iter().flatten().any(|note| {
            note["BackgroundImagePath"]
                .as_str()
                .is_some_and(|path| path_key(path).is_ok_and(|value| value == key))
        })
}
pub(crate) async fn authorize_path(app: tauri::AppHandle, target: &str) -> Result<String, String> {
    let key = path_key(target)?;
    let granted = app
        .state::<SystemService>()
        .grants
        .lock()
        .map_err(|error| error.to_string())?
        .contains(&key);
    let root = app.state::<StorageState>().root.display().to_string();
    let desktop_granted = app.state::<crate::desktop::DesktopService>().granted(&key);
    let search_granted = app
        .state::<crate::file_search::SearchService>()
        .owner("workspace-main")?
        .granted(&key);
    if !granted && !desktop_granted && !search_granted && path_key(&root)? != key {
        let reference = key.clone();
        if !operation(app, move |store| {
            Ok(referenced(&store.resource_snapshot()?, &reference))
        })
        .await?
        {
            return Err("路径未授权，请先选择文件或关联到工作区".into());
        }
    }
    Ok(key)
}

pub(crate) async fn authorize_path_for(
    app: tauri::AppHandle,
    label: &str,
    target: &str,
) -> Result<String, String> {
    if label == "workspace-main" {
        return authorize_path(app, target).await;
    }
    let role = app
        .state::<crate::widgets::Service>()
        .key(label)
        .ok_or("组件窗口已失效")?;
    let key = path_key(target)?;
    if role == "search" {
        if app
            .state::<crate::file_search::SearchService>()
            .owner(label)?
            .granted(&key)
        {
            return Ok(key);
        }
    } else {
        let target = target.to_owned();
        if operation(app.clone(), move |store| {
            Ok(crate::workspace::widgets::permits_resource(
                &store.resource_snapshot()?,
                &role,
                &target,
                false,
            ))
        })
        .await?
        {
            return Ok(key);
        }
    }
    Err("路径不属于此组件的当前业务授权".into())
}
async fn authorize_url_for(app: tauri::AppHandle, label: &str, target: &str) -> Result<(), String> {
    if label == "workspace-main" {
        return Ok(());
    }
    let role = app
        .state::<crate::widgets::Service>()
        .key(label)
        .ok_or("组件窗口已失效")?;
    let target = target.to_owned();
    if operation(app, move |store| {
        Ok(crate::workspace::widgets::permits_resource(
            &store.resource_snapshot()?,
            &role,
            &target,
            true,
        ))
    })
    .await?
    {
        Ok(())
    } else {
        Err("链接不属于此组件的当前业务授权".into())
    }
}
#[tauri::command]
pub async fn system_open(
    app: tauri::AppHandle,
    window: WebviewWindow,
    target: String,
    url: bool,
) -> Result<Value, String> {
    crate::widgets::business(
        &app,
        &window,
        &[
            "launcher",
            "links",
            "organizer",
            "organizer-group:",
            "search",
        ],
    )?;
    app.state::<QuitState>().require_interactive()?;
    let result = async {
        let target = if url {
            let value = productivity::trim(&target);
            if value.contains('\0')
                || value.encode_utf16().count() > 32768
                || resources::http_url(value).is_none()
            {
                return Err("只允许打开 HTTP/HTTPS 链接".into());
            }
            authorize_url_for(app.clone(), window.label(), value).await?;
            value.to_owned()
        } else {
            authorize_path_for(app.clone(), window.label(), &target).await?;
            crate::workspace::resource_api::require_safe_path(app.clone(), target.clone()).await?;
            target
        };
        let handle = owner(&window)?;
        #[cfg(windows)]
        {
            let permit = app
                .state::<SystemService>()
                .opens
                .clone()
                .acquire_owned()
                .await
                .map_err(|error| error.to_string())?;
            let app = app.clone();
            if url {
                authorize_url_for(app.clone(), window.label(), &target).await?;
            } else {
                authorize_path_for(app.clone(), window.label(), &target).await?;
            }
            sta(move || {
                let _permit = permit;
                app.state::<QuitState>().require_interactive()?;
                crate::platform::shell::open(handle, target)
            })
            .await
        }
        #[cfg(not(windows))]
        {
            let _ = (handle, target);
            Err("当前平台尚未接通原生资源打开".into())
        }
    }
    .await;
    Ok(match result {
        Ok(()) => json!({"ok":true}),
        Err(error) => json!({"ok":false,"error":error}),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picker_titles_use_defaults_and_utf16_limits_without_truncating_surrogate_pairs() {
        assert_eq!(title(None, true).unwrap(), "选择文件夹");
        assert_eq!(
            title(Some("\u{feff}  ".into()), false).unwrap(),
            "选择文件或文件夹"
        );
        assert_eq!(
            title(Some("😀".repeat(80)), false).unwrap(),
            "😀".repeat(60)
        );
        assert_eq!(
            title(Some("a".repeat(119) + "😀"), true).unwrap(),
            "a".repeat(119)
        );
        assert!(title(Some("bad\0title".into()), false).is_err());
    }

    #[test]
    fn native_paths_reject_relative_protocol_device_stream_and_nul_inputs() {
        for value in [
            "",
            "relative.txt",
            "http://localhost/",
            "C:relative.txt",
            r"\\.\C:",
            r"\\?\C:\file",
            "C:/file:stream",
            "C:/file\0ignored",
        ] {
            assert!(path_key(value).is_err(), "{value:?}");
        }
        assert_eq!(
            path_key("C:/folder/child/../文件.exe").unwrap(),
            path_key(r"c:\folder\文件.exe").unwrap()
        );
        assert!(path_key(r"\\server\share\file.txt").is_ok());
    }

    #[test]
    fn workspace_authorization_does_not_grant_siblings_or_ancestors() {
        let mut state = crate::workspace::normalize::default_state();
        state["Launchers"] =
            json!([{"Id":"launch","Name":"Launch","Path":"C:/folder/allowed.exe"}]);
        state["Projects"] = json!([]);
        state["DesktopCategories"] = json!([]);
        state["Notes"] = json!([]);
        assert!(referenced(
            &state,
            &path_key("c:/folder/ALLOWED.exe").unwrap()
        ));
        assert!(!referenced(
            &state,
            &path_key("C:/folder/sibling.exe").unwrap()
        ));
        assert!(!referenced(&state, &path_key("C:/folder").unwrap()));
        state["Launchers"] = json!([]);
        assert!(!referenced(
            &state,
            &path_key("C:/folder/allowed.exe").unwrap()
        ));
    }

    #[test]
    fn cancellation_and_release_mark_the_actual_picker_and_clear_all_grants() {
        let service = SystemService::default();
        let picker = Arc::new(Picker::default());
        *service.picker.lock().unwrap() = Some(picker.clone());
        service.grants.lock().unwrap().insert("c:/allowed".into());
        service.release();
        assert!(picker.cancelled.load(Ordering::SeqCst));
        assert!(service.grants.lock().unwrap().is_empty());
    }
    #[test]
    fn screenshot_cancellation_cannot_cancel_another_windows_picker() {
        let service = SystemService::default();
        let picker = Arc::new(Picker {
            owner: "workspace-main".into(),
            ..Picker::default()
        });
        *service.picker.lock().unwrap() = Some(picker.clone());
        service.cancel_picker_for("screenshot-overlay-exact");
        assert!(!picker.cancelled.load(Ordering::SeqCst));
        service.cancel_picker_for("workspace-main");
        assert!(picker.cancelled.load(Ordering::SeqCst));
    }
    #[test]
    fn failed_drop_delivery_rolls_back_only_new_grants_and_preserves_existing_selection() {
        let service = SystemService::default();
        let existing = std::path::PathBuf::from(r"C:\drop\existing.png");
        let fresh = std::path::PathBuf::from(r"C:\drop\new.png");
        service.grant(&existing).unwrap();
        assert!(service
            .grant_drop(&[existing.clone(), fresh.clone()], || Err(
                "channel closed".into()
            ))
            .is_err());
        assert!(service.selected(&existing).unwrap());
        assert!(!service.selected(&fresh).unwrap());
        service
            .grant_drop(std::slice::from_ref(&fresh), || Ok(()))
            .unwrap();
        assert!(service.selected(&fresh).unwrap());
        assert!(!service.selected(std::path::Path::new(r"C:\drop")).unwrap());
    }
    #[test]
    fn malformed_drop_paths_reject_the_whole_batch_before_publishing_or_authorizing() {
        let service = SystemService::default();
        let called = std::cell::Cell::new(false);
        assert!(service
            .grant_drop(
                &[
                    std::path::PathBuf::from(r"C:\drop\image.png"),
                    std::path::PathBuf::from("relative")
                ],
                || {
                    called.set(true);
                    Ok(())
                }
            )
            .is_err());
        assert!(!called.get());
        assert!(service.grants.lock().unwrap().is_empty());
    }
}
