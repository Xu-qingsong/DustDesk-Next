use serde::Serialize;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Manager, WebviewWindow};

#[derive(Clone, Copy, Serialize)]
pub struct Position {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Serialize)]
pub struct Packet {
    token: String,
    paths: Vec<String>,
    position: Position,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}
#[derive(Clone)]
struct Connection {
    token: String,
    channel: Channel<Packet>,
}
#[derive(Default)]
pub struct Service {
    connection: Mutex<Option<Connection>>,
    generation: AtomicU64,
}
impl Service {
    fn attach(&self, channel: Channel<Packet>) -> Result<String, String> {
        let token = uuid::Uuid::new_v4().to_string();
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        self.cancel_pending();
        *connection = Some(Connection {
            token: token.clone(),
            channel,
        });
        Ok(token)
    }
    fn detach(&self, token: &str) -> bool {
        self.connection.lock().is_ok_and(|mut connection| {
            if connection
                .as_ref()
                .is_some_and(|value| value.token == token)
            {
                self.cancel_pending();
                *connection = None;
                true
            } else {
                false
            }
        })
    }
    pub fn cancel_pending(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
    }
    pub fn reset(&self) {
        self.cancel_pending();
        if let Ok(mut connection) = self.connection.lock() {
            *connection = None;
        }
    }
    fn snapshot(&self) -> Option<(Connection, u64)> {
        let connection = self.connection.lock().ok()?.clone()?;
        Some((connection, self.generation.load(Ordering::SeqCst)))
    }
    fn deliver(
        &self,
        token: &str,
        generation: u64,
        publish: impl FnOnce(&Channel<Packet>, &mut bool) -> Result<(), String>,
    ) -> Result<(), String> {
        let mut connection = self.connection.lock().map_err(|error| error.to_string())?;
        let current = connection
            .as_ref()
            .filter(|value| {
                value.token == token && self.generation.load(Ordering::SeqCst) == generation
            })
            .ok_or("文件拖入会话已失效")?;
        let mut disconnected = false;
        let result = publish(&current.channel, &mut disconnected);
        if disconnected {
            self.cancel_pending();
            *connection = None;
        }
        result
    }
}
fn validate(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, String> {
    if paths.is_empty() || paths.len() > 10000 {
        return Err("一次只能拖入 1 至 10000 个文件或目录".into());
    }
    let mut seen = HashSet::new();
    let mut output = Vec::new();
    for path in paths {
        let key = crate::system::path_key(path.to_str().ok_or("拖入路径不是有效文本")?)?;
        crate::workspace::checked_path(&path)?;
        let metadata = std::fs::symlink_metadata(&path)
            .map_err(|error| format!("检查拖入路径失败（{}）：{error}", path.display()))?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err("不支持拖入符号链接或特殊文件".into());
        }
        if seen.insert(key) {
            output.push(path);
        }
    }
    Ok(output)
}
fn position(position: tauri::PhysicalPosition<f64>, scale: f64) -> Result<Position, String> {
    if !scale.is_finite()
        || scale <= 0.0
        || !position.x.is_finite()
        || !position.y.is_finite()
        || position.x < 0.0
        || position.y < 0.0
    {
        return Err("文件拖入位置无效".into());
    }
    Ok(Position {
        x: position.x / scale,
        y: position.y / scale,
    })
}
#[tauri::command]
pub fn file_drop_attach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    channel: Channel<Packet>,
) -> Result<String, String> {
    crate::toolbox::require_active(&app, &window)?;
    app.state::<Service>().attach(channel)
}
#[tauri::command]
pub fn file_drop_detach(
    app: tauri::AppHandle,
    window: WebviewWindow,
    token: String,
) -> Result<bool, String> {
    crate::workspace::api::require_workspace(&window)?;
    if !crate::main_window::current(&app, &window) {
        return Err("主窗口已失效".into());
    }
    Ok(app.state::<Service>().detach(&token))
}
pub fn dropped(
    app: &tauri::AppHandle,
    label: &str,
    paths: Vec<PathBuf>,
    physical: tauri::PhysicalPosition<f64>,
) {
    let Some(window) = app.get_webview_window(label).filter(|window| {
        label == "workspace-main"
            && window.is_visible().unwrap_or(false)
            && crate::toolbox::require_active(app, window).is_ok()
    }) else {
        return;
    };
    let Some((connection, generation)) = app.state::<Service>().snapshot() else {
        return;
    };
    let Ok(position) = window
        .scale_factor()
        .map_err(|error| error.to_string())
        .and_then(|scale| position(physical, scale))
    else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            tauri::async_runtime::spawn_blocking(move || validate(paths)),
        )
        .await
        .map_err(|_| "检查拖入路径超时，未授权读取".to_string())
        .and_then(|result| result.map_err(|error| error.to_string()))
        .and_then(|result| result);
        let _ = app.state::<Service>().deliver(
            &connection.token,
            generation,
            |channel, disconnected| {
                crate::toolbox::require_active(&app, &window)?;
                if !window.is_visible().map_err(|error| error.to_string())? {
                    return Err("主窗口已隐藏，未接收拖入文件".into());
                }
                let mut send = |packet| {
                    channel.send(packet).map_err(|error| {
                        *disconnected = true;
                        error.to_string()
                    })
                };
                match result {
                    Ok(paths) => {
                        app.state::<crate::system::SystemService>()
                            .grant_drop(&paths, || {
                                if app.state::<Service>().generation.load(Ordering::SeqCst)
                                    != generation
                                {
                                    return Err("文件拖入会话已失效".into());
                                }
                                crate::toolbox::require_active(&app, &window)?;
                                send(Packet {
                                    token: connection.token.clone(),
                                    paths: paths
                                        .iter()
                                        .map(|path| path.display().to_string())
                                        .collect(),
                                    position,
                                    error: None,
                                })
                            })
                    }
                    Err(error) => send(Packet {
                        token: connection.token.clone(),
                        paths: Vec::new(),
                        position,
                        error: Some(error),
                    }),
                }
            },
        );
    });
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[test]
    fn validates_complete_batches_and_deduplicates_exact_windows_paths_without_authorizing_parents()
    {
        let root =
            std::env::temp_dir().join(format!("dustdesk-rust-drop-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("中文.txt");
        std::fs::write(&path, b"source").unwrap();
        assert_eq!(
            validate(vec![path.clone(), path.clone(), root.clone()]).unwrap(),
            vec![path.clone(), root.clone()]
        );
        assert!(validate(vec![path.clone(), root.join("missing")]).is_err());
        for paths in [
            vec![],
            vec![PathBuf::from("relative")],
            vec![PathBuf::from("C:/file:stream")],
            vec![path; 10001],
        ] {
            assert!(validate(paths).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn coordinates_are_webview_logical_pixels_and_reject_invalid_scale_or_nonfinite_values() {
        let converted = position(tauri::PhysicalPosition::new(300.0, 450.0), 1.5).unwrap();
        assert_eq!((converted.x, converted.y), (200.0, 300.0));
        for scale in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(position(tauri::PhysicalPosition::new(1.0, 1.0), scale).is_err());
        }
        assert!(position(tauri::PhysicalPosition::new(f64::NAN, 1.0), 1.0).is_err());
        assert!(position(tauri::PhysicalPosition::new(-1.0, 1.0), 1.0).is_err());
    }
    #[test]
    fn reconnect_cancel_and_reset_reject_old_deliveries_and_stale_detach_cannot_close_new_channel()
    {
        let service = Service::default();
        let first = service.attach(Channel::new(|_| Ok(()))).unwrap();
        let (_, old_generation) = service.snapshot().unwrap();
        let next = service.attach(Channel::new(|_| Ok(()))).unwrap();
        assert_ne!(first, next);
        assert!(!service.detach(&first));
        assert!(service
            .deliver(&first, old_generation, |_, _| Ok(()))
            .is_err());
        let (_, generation) = service.snapshot().unwrap();
        assert!(service.deliver(&next, generation, |_, _| Ok(())).is_ok());
        service.cancel_pending();
        assert!(service.deliver(&next, generation, |_, _| Ok(())).is_err());
        assert!(service.snapshot().is_some());
        service.reset();
        assert!(service.snapshot().is_none());
    }
    #[test]
    fn a_closed_channel_revokes_the_connection_instead_of_queuing_unbounded_events() {
        let service = Service::default();
        let token = service.attach(Channel::new(|_| Ok(()))).unwrap();
        let (_, generation) = service.snapshot().unwrap();
        assert!(service
            .deliver(&token, generation, |_, closed| {
                *closed = true;
                Err("closed".into())
            })
            .is_err());
        assert!(service.snapshot().is_none());
    }
    #[test]
    fn a_cancelled_operation_does_not_detach_the_live_channel_needed_after_resume() {
        let service = Service::default();
        let token = service.attach(Channel::new(|_| Ok(()))).unwrap();
        let (_, generation) = service.snapshot().unwrap();
        assert!(service
            .deliver(&token, generation, |_, _| Err("maintenance".into()))
            .is_err());
        assert!(service.snapshot().is_some());
        service.cancel_pending();
        let (_, generation) = service.snapshot().unwrap();
        assert!(service.deliver(&token, generation, |_, _| Ok(())).is_ok());
    }
}
