use crate::screenshot_windows::{Target, MAX_WINDOWS};
use std::{ffi::c_void, time::Instant};
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError, HWND, LPARAM, RECT},
    Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
    UI::WindowsAndMessaging::*,
};

fn target(handle: HWND) -> Option<Target> {
    unsafe {
        if handle.is_null()
            || IsWindow(handle) == 0
            || IsWindowVisible(handle) == 0
            || IsIconic(handle) != 0
        {
            return None;
        }
        if GetWindowLongPtrW(handle, GWL_EXSTYLE) & WS_EX_TOOLWINDOW as isize != 0 {
            return None;
        }
        let mut process_id = 0;
        let thread_id = GetWindowThreadProcessId(handle, &mut process_id);
        if thread_id == 0 || process_id == 0 {
            return None;
        }
        let mut cloaked = 0u32;
        if DwmGetWindowAttribute(
            handle,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut _ as *mut c_void,
            size_of::<u32>() as u32,
        ) >= 0
            && cloaked != 0
        {
            return None;
        }
        let mut affinity = 0;
        if GetWindowDisplayAffinity(handle, &mut affinity) != 0 && affinity != WDA_NONE {
            return None;
        }
        let mut bounds = RECT::default();
        if GetWindowRect(handle, &mut bounds) == 0
            || bounds.right <= bounds.left
            || bounds.bottom <= bounds.top
        {
            return None;
        }
        let length = GetWindowTextLengthW(handle);
        if length <= 0 || length > 2048 {
            return None;
        }
        let mut title = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(handle, title.as_mut_ptr(), title.len() as i32);
        if copied <= 0 {
            return None;
        }
        Some(Target {
            handle: handle as isize,
            process_id,
            thread_id,
            name: String::from_utf16_lossy(&title[..copied as usize]),
        })
    }
}
unsafe extern "system" fn collect(handle: HWND, state: LPARAM) -> i32 {
    let targets = &mut *(state as *mut Vec<Target>);
    if let Some(candidate) = target(handle) {
        targets.push(candidate);
    }
    (targets.len() < MAX_WINDOWS) as i32
}
pub fn capture_targets() -> Result<Vec<Target>, String> {
    let mut targets = Vec::new();
    unsafe {
        SetLastError(0);
        let success = EnumWindows(Some(collect), &mut targets as *mut Vec<Target> as LPARAM);
        let error = GetLastError();
        if success == 0 && targets.len() < MAX_WINDOWS && error != 0 {
            return Err(format!(
                "无法枚举截图窗口：{}",
                std::io::Error::from_raw_os_error(error as i32)
            ));
        }
    }
    Ok(targets)
}
fn validate(candidate: &Target) -> Result<(), String> {
    if target(candidate.handle as HWND).as_ref() != Some(candidate) {
        return Err("capture-window-unavailable".into());
    }
    Ok(())
}
pub fn capture_thumbnail(
    candidate: &Target,
    deadline: Instant,
    cancelled: impl Fn() -> bool,
) -> Result<String, String> {
    use base64::Engine;
    validate(candidate)?;
    let png = super::window_capture::capture_preview(candidate.handle, deadline, &cancelled)?;
    validate(candidate)?;
    if cancelled() {
        return Err("截图操作已取消".into());
    }
    Ok(format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD.encode(png)
    ))
}
pub fn capture_target(candidate: &Target, cancelled: impl Fn() -> bool) -> Result<Vec<u8>, String> {
    validate(candidate)?;
    let png = super::window_capture::capture_checked(candidate.handle, &cancelled)?;
    validate(candidate)?;
    if cancelled() {
        return Err("截图操作已取消".into());
    }
    Ok(png)
}
