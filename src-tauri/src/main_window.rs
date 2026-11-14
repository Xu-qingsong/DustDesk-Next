use std::{sync::Mutex, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::watch;

#[derive(Clone)]
struct Placement {
    #[cfg(windows)]
    native: windows::Win32::UI::WindowsAndMessaging::WINDOWPLACEMENT,
    #[cfg(not(windows))]
    x: f64,
    #[cfg(not(windows))]
    y: f64,
    #[cfg(not(windows))]
    width: f64,
    #[cfg(not(windows))]
    height: f64,
    maximized: bool,
}
pub struct Service {
    placement: Mutex<Option<Placement>>,
    destroying: watch::Sender<bool>,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            placement: Mutex::default(),
            destroying: watch::channel(false).0,
        }
    }
}
pub fn destroying(app: &tauri::AppHandle, value: bool) {
    app.state::<Service>().destroying.send_replace(value);
}
pub async fn wait_destroyed(app: &tauri::AppHandle) -> Result<(), String> {
    let mut state = app.state::<Service>().destroying.subscribe();
    tokio::time::timeout(Duration::from_secs(3), async {
        while *state.borrow_and_update() {
            state.changed().await.map_err(|error| error.to_string())?;
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "主窗口仍在销毁，请稍后重试".to_string())?
}

pub fn current(app: &tauri::AppHandle, window: &WebviewWindow) -> bool {
    let own = std::ptr::from_ref(&*window.resources_table());
    app.get_webview_window(window.label())
        .is_some_and(|registered| {
            std::ptr::eq(own, std::ptr::from_ref(&*registered.resources_table()))
        })
}

pub fn remember(app: &tauri::AppHandle, window: &WebviewWindow) -> Result<(), String> {
    if window.is_minimized().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let maximized = window.is_maximized().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    let placement = {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{GetWindowPlacement, WINDOWPLACEMENT},
        };
        let mut native = WINDOWPLACEMENT {
            length: std::mem::size_of::<WINDOWPLACEMENT>() as u32,
            ..Default::default()
        };
        let handle = window.hwnd().map_err(|error| error.to_string())?;
        unsafe { GetWindowPlacement(HWND(handle.0), &mut native) }
            .map_err(|error| error.to_string())?;
        Placement { native, maximized }
    };
    #[cfg(not(windows))]
    let placement = {
        let scale = window.scale_factor().map_err(|error| error.to_string())?;
        let position = window
            .outer_position()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(scale);
        let size = window
            .inner_size()
            .map_err(|error| error.to_string())?
            .to_logical::<f64>(scale);
        Placement {
            x: position.x,
            y: position.y,
            width: size.width,
            height: size.height,
            maximized,
        }
    };
    *app.state::<Service>()
        .placement
        .lock()
        .map_err(|error| error.to_string())? = Some(placement);
    Ok(())
}

fn show_locked(app: &tauri::AppHandle) -> Result<(), String> {
    if *app.state::<Service>().destroying.borrow() {
        return Err("主窗口仍在销毁，请稍后重试".into());
    }
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    crate::window_release::cancel(app, "workspace-main");
    if let Some(window) = app.get_webview_window("workspace-main") {
        if window.is_minimized().map_err(|error| error.to_string())? {
            window.unminimize().map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        return window.set_focus().map_err(|error| error.to_string());
    }
    let placement = app
        .state::<Service>()
        .placement
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    let profiles = app.state::<crate::ProbeState>().profiles.clone();
    let builder =
        WebviewWindowBuilder::new(app, "workspace-main", WebviewUrl::App("tauri.html".into()))
            .title("DustDesk")
            .inner_size(1280.0, 850.0)
            .min_inner_size(960.0, 640.0)
            .visible(false)
            .data_directory(profiles);
    #[cfg(not(windows))]
    let builder = if let Some(placement) = &placement {
        builder
            .position(placement.x, placement.y)
            .inner_size(placement.width.max(960.0), placement.height.max(640.0))
    } else {
        builder
    };
    let window = builder.build().map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if let Some(placement) = &placement {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{SetWindowPlacement, SW_HIDE},
        };
        let handle = window.hwnd().map_err(|error| error.to_string())?;
        let mut native = placement.native;
        native.showCmd = SW_HIDE.0 as u32;
        unsafe { SetWindowPlacement(HWND(handle.0), &native) }
            .map_err(|error| error.to_string())?;
    }
    remember(app, &window)?;
    if placement.is_some_and(|placement| placement.maximized) {
        window.maximize().map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

pub async fn show(app: &tauri::AppHandle) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    wait_destroyed(app).await?;
    show_locked(app)
}

pub async fn visibility(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
    visible: bool,
) -> Result<(), String> {
    let gate = app.state::<crate::widgets::Service>().gate.clone();
    let _guard = gate.lock().await;
    wait_destroyed(app).await?;
    crate::workspace::api::require_workspace(window)?;
    if !current(app, window) {
        return Err("主窗口已失效".into());
    }
    app.state::<crate::lifecycle::QuitState>()
        .require_interactive()?;
    if visible {
        show_locked(app)
    } else {
        window.hide().map_err(|error| error.to_string())?;
        crate::window_release::schedule(app, window.label());
        Ok(())
    }
}

pub fn request_show(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = show(&app).await {
            eprintln!("打开主窗口失败：{error}");
        }
    });
}

pub fn request_hide(app: &tauri::AppHandle, window: &WebviewWindow) {
    let app = app.clone();
    let window = window.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = visibility(&app, &window, false).await {
            eprintln!("隐藏主窗口失败：{error}");
        }
    });
}

pub fn request_restore(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let gate = app.state::<crate::widgets::Service>().gate.clone();
        let _guard = gate.lock().await;
        if let Err(error) = wait_destroyed(&app).await {
            eprintln!("恢复主窗口失败：{error}");
            return;
        }
        let result = (|| {
            show_locked(&app)?;
            let window = app
                .get_webview_window("workspace-main")
                .ok_or("主窗口不可用")?;
            window
                .set_ignore_cursor_events(false)
                .map_err(|error| error.to_string())?;
            crate::platform::set_opacity(&window, 255)
        })();
        if let Err(error) = result {
            eprintln!("恢复主窗口失败：{error}");
        }
    });
}
