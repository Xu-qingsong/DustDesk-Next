use crate::startup::{decode_command, ENTRY_NAME};
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS},
        System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
            RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
            REG_OPTION_NON_VOLATILE, REG_SZ, REG_VALUE_TYPE,
        },
    },
};

struct RegistryKey(HKEY);

impl Drop for RegistryKey {
    fn drop(&mut self) {
        let _ = unsafe { RegCloseKey(self.0) };
    }
}

fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain([0]).collect()
}

pub fn get_startup(path: &str) -> Result<Option<String>, String> {
    let path = wide(path);
    let name = wide(ENTRY_NAME);
    let mut handle = HKEY::default();
    let result = unsafe {
        RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(path.as_ptr()),
            None,
            KEY_QUERY_VALUE,
            &mut handle,
        )
    };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    result
        .ok()
        .map_err(|error| format!("读取开机启动失败：{error}"))?;
    let key = RegistryKey(handle);
    let mut kind = REG_VALUE_TYPE::default();
    let mut length = 0;
    let result = unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut length),
        )
    };
    if result == ERROR_FILE_NOT_FOUND {
        return Ok(None);
    }
    result
        .ok()
        .map_err(|error| format!("读取开机启动值失败：{error}"))?;
    if kind != REG_SZ {
        return Err("开机启动注册表值类型无效".into());
    }
    if !(2..=4096).contains(&length) {
        return Err("开机启动注册表内容长度无效".into());
    }
    let mut bytes = vec![0; length as usize];
    unsafe {
        RegQueryValueExW(
            key.0,
            PCWSTR(name.as_ptr()),
            None,
            Some(&mut kind),
            Some(bytes.as_mut_ptr()),
            Some(&mut length),
        )
    }
    .ok()
    .map_err(|error| format!("读取开机启动内容失败：{error}"))?;
    if kind != REG_SZ {
        return Err("开机启动注册表值类型已变化".into());
    }
    bytes.truncate(length as usize);
    decode_command(&bytes).map(Some)
}

pub fn set_startup(path: &str, command: Option<&str>) -> Result<(), String> {
    let path = wide(path);
    let name = wide(ENTRY_NAME);
    let mut handle = HKEY::default();
    let result = if command.is_some() {
        unsafe {
            RegCreateKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                None,
                PCWSTR::null(),
                REG_OPTION_NON_VOLATILE,
                KEY_SET_VALUE | KEY_QUERY_VALUE,
                None,
                &mut handle,
                None,
            )
        }
    } else {
        unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                PCWSTR(path.as_ptr()),
                None,
                KEY_SET_VALUE,
                &mut handle,
            )
        }
    };
    if command.is_none() && result == ERROR_FILE_NOT_FOUND {
        return Ok(());
    }
    result
        .ok()
        .map_err(|error| format!("打开开机启动设置失败：{error}"))?;
    let key = RegistryKey(handle);
    let result = match command {
        Some(command) => {
            let bytes = wide(command)
                .into_iter()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            unsafe { RegSetValueExW(key.0, PCWSTR(name.as_ptr()), None, REG_SZ, Some(&bytes)) }
        }
        None => unsafe { RegDeleteValueW(key.0, PCWSTR(name.as_ptr())) },
    };
    if result == ERROR_SUCCESS || (command.is_none() && result == ERROR_FILE_NOT_FOUND) {
        Ok(())
    } else {
        Err(format!("修改开机启动失败：{result:?}"))
    }
}
