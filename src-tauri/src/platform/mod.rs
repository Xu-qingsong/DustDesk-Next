use serde::{Deserialize, Serialize};
pub mod legacy_processes;

#[derive(Clone)]
pub enum ExportKind {
    Projects,
    Text,
    Drafts,
    Images {
        name: String,
        extension: String,
    },
    Screenshots {
        path: std::path::PathBuf,
        extension: String,
    },
}

#[cfg(windows)]
pub mod update_dialog;
#[cfg(not(windows))]
pub mod update_dialog {
    pub fn show(
        _owner: isize,
        _title: &str,
        _content: &str,
        _confirm: bool,
        _cancelled: tokio::sync::watch::Receiver<bool>,
    ) -> Result<bool, String> {
        Err("当前平台尚不支持更新确认对话框".into())
    }
}

#[cfg(windows)]
pub mod clipboard;
#[cfg(windows)]
pub mod clipboard_listener;
#[cfg(not(windows))]
pub mod clipboard_listener {
    pub struct Listener;
    pub fn sequence() -> u32 {
        0
    }
    pub fn listen(_signal: tokio::sync::watch::Sender<u64>) -> Result<Listener, String> {
        Err("当前平台暂不支持剪贴板更新通知".into())
    }
}
#[cfg(windows)]
pub mod icons;
#[cfg(not(windows))]
pub mod clipboard {
    pub fn read_image() -> Result<Option<crate::screenshot::Decoded>, String> {
        Err("当前平台暂不支持原生剪贴板".into())
    }
    pub fn read_monitored() -> Result<crate::clipboard::ClipboardContent, String> {
        read()
    }
    pub fn read() -> Result<crate::clipboard::ClipboardContent, String> {
        Err("当前平台暂不支持原生剪贴板".into())
    }
    pub fn write(_content: &crate::clipboard::PreparedContent) -> Result<(), String> {
        Err("当前平台暂不支持原生剪贴板".into())
    }
}
#[cfg(windows)]
mod metrics;
#[cfg(windows)]
pub use metrics::sample_system_metrics;
#[cfg(not(windows))]
pub fn sample_system_metrics() -> Result<crate::metrics::SystemMetrics, String> {
    Err("当前平台暂不支持原生系统监控".into())
}
#[cfg(windows)]
pub mod path_menu;
#[cfg(windows)]
mod startup;
#[cfg(windows)]
pub use startup::{get_startup, set_startup};
#[cfg(not(windows))]
pub fn get_startup(_path: &str) -> Result<Option<String>, String> {
    Err("当前平台暂不支持开机启动".into())
}
#[cfg(not(windows))]
pub fn set_startup(_path: &str, _command: Option<&str>) -> Result<(), String> {
    Err("当前平台暂不支持开机启动".into())
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl CaptureRect {
    pub fn validate(self) -> Result<(), String> {
        if self.width == 0
            || self.height == 0
            || u64::from(self.width) * u64::from(self.height) > 40_000_000
        {
            return Err("选区尺寸无效".into());
        }
        if self.x.unsigned_abs() > 65536 || self.y.unsigned_abs() > 65536 {
            return Err("选区坐标无效".into());
        }
        self.x
            .checked_add_unsigned(self.width)
            .ok_or("选区横坐标溢出")?;
        self.y
            .checked_add_unsigned(self.height)
            .ok_or("选区纵坐标溢出")?;
        Ok(())
    }
}

#[cfg(windows)]
mod capture_sources;
#[cfg(windows)]
pub mod shell;
#[cfg(windows)]
mod window_capture;
#[cfg(windows)]
pub use capture_sources::{capture_target, capture_targets, capture_thumbnail};
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use window_capture::capture_window;
#[cfg(windows)]
pub use windows::{capture_region, set_opacity, window_flags};

#[cfg(not(windows))]
pub fn capture_region(_rect: CaptureRect) -> Result<Vec<u8>, String> {
    Err("当前平台暂不支持原生截图".into())
}

#[cfg(not(windows))]
pub fn capture_window(_handle: isize) -> Result<Vec<u8>, String> {
    Err("当前平台暂不支持窗口截图".into())
}

#[cfg(not(windows))]
pub fn capture_targets() -> Result<Vec<crate::screenshot_windows::Target>, String> {
    Err("当前平台暂不支持截图窗口枚举".into())
}
#[cfg(not(windows))]
pub fn capture_thumbnail(
    _target: &crate::screenshot_windows::Target,
    _deadline: std::time::Instant,
    _cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    Err("当前平台暂不支持窗口截图".into())
}
#[cfg(not(windows))]
pub fn capture_target(
    _target: &crate::screenshot_windows::Target,
    _cancelled: impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    Err("当前平台暂不支持窗口截图".into())
}

#[cfg(not(windows))]
pub fn set_opacity(_window: &tauri::WebviewWindow, _opacity: u8) -> Result<(), String> {
    Err("当前平台暂不支持窗口透明度".into())
}

#[cfg(not(windows))]
pub fn window_flags(_window: &tauri::WebviewWindow) -> Result<(bool, u8), String> {
    Err("当前平台暂不支持原生窗口状态验证".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_negative_coordinates_and_pixel_budget() {
        assert!(CaptureRect {
            x: -1920,
            y: -100,
            width: 1920,
            height: 1080
        }
        .validate()
        .is_ok());
        assert!(CaptureRect {
            x: 0,
            y: 0,
            width: 0,
            height: 1080
        }
        .validate()
        .is_err());
        assert!(CaptureRect {
            x: 0,
            y: 0,
            width: 10000,
            height: 10000
        }
        .validate()
        .is_err());
        assert!(CaptureRect {
            x: i32::MIN,
            y: 0,
            width: 1,
            height: 1
        }
        .validate()
        .is_err());
        assert!(CaptureRect {
            x: 0,
            y: 0,
            width: u32::MAX,
            height: 1
        }
        .validate()
        .is_err());
    }
}
