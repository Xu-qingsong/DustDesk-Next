use crate::{lifecycle::QuitState, platform, workspace::api::require_workspace};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Mutex};
use tauri::{Manager, WebviewWindow};

#[cfg(windows)]
pub const ENTRY_NAME: &str = "DustDesk";
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

pub struct StartupService {
    key: String,
    command: Result<String, String>,
    gate: Mutex<()>,
}

fn registry_key(test_directory: Option<&str>) -> String {
    match test_directory {
        Some(directory) => format!(
            "Software\\DustDesk\\TauriMigrationTests\\{:x}\\Run",
            Sha256::digest(directory.as_bytes())
        ),
        None => RUN_KEY.into(),
    }
}

fn startup_command(executable: &Path) -> Result<String, String> {
    let executable = executable.to_str().ok_or("应用路径不是有效 Unicode")?;
    if !Path::new(executable).is_absolute()
        || executable
            .chars()
            .any(|character| character == '"' || character.is_control())
    {
        return Err("应用路径不能用于开机启动".into());
    }
    let command = format!("\"{executable}\" --workspace --hidden");
    if command.encode_utf16().count() >= 260 {
        return Err("应用路径过长，请移至较短路径后设置开机启动".into());
    }
    Ok(command)
}

#[cfg(any(windows, test))]
pub(crate) fn decode_command(bytes: &[u8]) -> Result<String, String> {
    if bytes.len() < 2 || bytes.len() > 4096 || !bytes.len().is_multiple_of(2) {
        return Err("开机启动注册表内容长度无效".into());
    }
    let mut text = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    if text.pop() != Some(0) || text.contains(&0) {
        return Err("开机启动注册表字符串无效".into());
    }
    String::from_utf16(&text).map_err(|_| "开机启动注册表字符串编码无效".into())
}

impl StartupService {
    pub fn new() -> Self {
        let test_directory = std::env::var_os("DUSTDESK_TEST_USER_DATA_DIR")
            .map(|value| value.to_string_lossy().into_owned());
        Self {
            key: registry_key(test_directory.as_deref()),
            command: std::env::current_exe()
                .map_err(|error| error.to_string())
                .and_then(|path| startup_command(&path)),
            gate: Mutex::new(()),
        }
    }

    fn access(&self, enabled: Option<bool>) -> Result<bool, String> {
        let _guard = self.gate.lock().map_err(|error| error.to_string())?;
        if let Some(enabled) = enabled {
            let command = if enabled {
                Some(self.command.as_ref().map_err(Clone::clone)?.as_str())
            } else {
                None
            };
            platform::set_startup(&self.key, command)?;
        }
        let actual = platform::get_startup(&self.key)?;
        let active = actual
            .as_deref()
            .zip(self.command.as_ref().ok().map(String::as_str))
            .is_some_and(|(actual, expected)| actual == expected);
        if enabled.is_some_and(|expected| active != expected) {
            return Err("开机启动设置未生效，请重试".into());
        }
        Ok(active)
    }
}

#[tauri::command]
pub async fn system_startup(
    app: tauri::AppHandle,
    window: WebviewWindow,
    enabled: Option<bool>,
) -> Result<bool, String> {
    require_workspace(&window)?;
    app.state::<QuitState>().require_interactive()?;
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<QuitState>().require_interactive()?;
        app.state::<StartupService>().access(enabled)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encoded(text: &str) -> Vec<u8> {
        text.encode_utf16()
            .chain([0])
            .flat_map(u16::to_le_bytes)
            .collect()
    }

    #[test]
    fn isolated_registry_target_cannot_be_injected_or_confused_with_real_autorun() {
        assert_eq!(registry_key(None), RUN_KEY);
        let first = registry_key(Some("D:\\tests\\中文"));
        assert!(first.starts_with("Software\\DustDesk\\TauriMigrationTests\\"));
        assert!(first.ends_with("\\Run"));
        assert_eq!(first, registry_key(Some("D:\\tests\\中文")));
        assert_ne!(first, registry_key(Some("D:\\tests\\other")));
        assert_ne!(first, RUN_KEY);
        let injected = registry_key(Some("..\\Microsoft\\Windows\\CurrentVersion\\Run\0"));
        let hash = injected.split('\\').nth(3).unwrap();
        assert_eq!(hash.len(), 64);
        assert!(hash.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }

    #[test]
    fn rejects_malformed_unterminated_embedded_null_and_unbounded_registry_strings() {
        assert_eq!(
            decode_command(&encoded("\"D:\\空 格\\DustDesk.exe\" --workspace --hidden")).unwrap(),
            "\"D:\\空 格\\DustDesk.exe\" --workspace --hidden"
        );
        assert!(decode_command(&[]).is_err());
        assert!(decode_command(&[0]).is_err());
        assert!(decode_command(&[65, 0]).is_err());
        assert!(decode_command(&encoded("bad\0tail")).is_err());
        assert!(decode_command(&[0, 216, 0, 0]).is_err());
        assert!(decode_command(&vec![0; 4098]).is_err());
    }

    #[test]
    fn command_uses_trusted_quoted_executable_and_fixed_hidden_workspace_arguments() {
        let directory = std::env::temp_dir().join("DustDesk 测试目录");
        let executable = directory.join("DustDesk.exe");
        assert_eq!(
            startup_command(&executable).unwrap(),
            format!("\"{}\" --workspace --hidden", executable.display())
        );
        for invalid in [
            Path::new("relative.exe").to_owned(),
            directory.join("bad\".exe"),
            directory.join("bad\n.exe"),
            directory.join("x".repeat(260)),
        ] {
            assert!(startup_command(&invalid).is_err());
        }
    }
}
