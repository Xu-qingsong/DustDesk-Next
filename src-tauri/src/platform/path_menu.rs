use std::{
    ptr::null_mut,
    sync::atomic::{AtomicBool, AtomicIsize, Ordering},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{GlobalFree, POINT},
    System::{DataExchange::*, Memory::*},
    UI::WindowsAndMessaging::*,
};

struct Popup(HMENU);
impl Drop for Popup {
    fn drop(&mut self) {
        unsafe {
            DestroyMenu(self.0);
        }
    }
}
pub fn cancel(owner: isize) {
    if owner != 0 {
        unsafe {
            PostMessageW(owner as *mut _, WM_CANCELMODE, 0, 0);
        }
    }
}
pub fn show(owner: isize, handle: &AtomicIsize, cancelled: &AtomicBool) -> Result<u32, String> {
    if cancelled.load(Ordering::SeqCst) {
        return Ok(0);
    }
    unsafe {
        let _apartment = super::shell::apartment()?;
        struct Owner<'handle> {
            window: windows_sys::Win32::Foundation::HWND,
            handle: &'handle AtomicIsize,
        }
        impl Drop for Owner<'_> {
            fn drop(&mut self) {
                self.handle.store(0, Ordering::SeqCst);
                unsafe {
                    DestroyWindow(self.window);
                }
            }
        }
        let class: Vec<u16> = "STATIC".encode_utf16().chain(Some(0)).collect();
        let title: Vec<u16> = "DustDesk native path menu"
            .encode_utf16()
            .chain(Some(0))
            .collect();
        let window = CreateWindowExW(
            WS_EX_TOOLWINDOW,
            class.as_ptr(),
            title.as_ptr(),
            WS_POPUP,
            0,
            0,
            0,
            0,
            owner as *mut _,
            null_mut(),
            null_mut(),
            std::ptr::null(),
        );
        if window.is_null() {
            return Err("无法创建菜单会话窗口".into());
        }
        let popup_owner = Owner { window, handle };
        handle.store(window as isize, Ordering::SeqCst);
        let menu = Popup(CreatePopupMenu());
        if menu.0.is_null() {
            return Err("无法创建文件菜单".into());
        }
        for (index, label) in [(1, "打开"), (2, "在资源管理器中显示"), (3, "复制路径")]
        {
            let text: Vec<u16> = label.encode_utf16().chain(Some(0)).collect();
            if AppendMenuW(menu.0, MF_STRING, index, text.as_ptr()) == 0 {
                return Err("无法添加文件菜单项".into());
            }
        }
        let mut point = POINT::default();
        if GetCursorPos(&mut point) == 0 {
            return Err("无法读取菜单位置".into());
        }
        if cancelled.load(Ordering::SeqCst) {
            return Ok(0);
        }
        SetForegroundWindow(owner as *mut _);
        let selected = TrackPopupMenu(
            menu.0,
            TPM_LEFTALIGN | TPM_RETURNCMD | TPM_NONOTIFY,
            point.x,
            point.y,
            0,
            popup_owner.window,
            std::ptr::null(),
        );
        PostMessageW(popup_owner.window, WM_NULL, 0, 0);
        Ok(if cancelled.load(Ordering::SeqCst) {
            0
        } else {
            selected as u32
        })
    }
}
struct Clipboard;
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}
struct Memory(*mut core::ffi::c_void);
impl Drop for Memory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                GlobalFree(self.0);
            }
        }
    }
}
pub fn copy(owner: isize, text: &str, cancelled: &AtomicBool) -> Result<(), String> {
    crate::system::path_key(text)?;
    let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    unsafe {
        let mut memory = Memory(GlobalAlloc(GMEM_MOVEABLE, units.len() * 2));
        if memory.0.is_null() {
            return Err("无法分配剪贴板文本".into());
        }
        let pointer = GlobalLock(memory.0);
        if pointer.is_null() {
            return Err("无法准备剪贴板文本".into());
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), pointer.cast::<u16>(), units.len());
        GlobalUnlock(memory.0);
        let mut opened = false;
        for _attempt in 0..6 {
            if cancelled.load(Ordering::SeqCst) {
                return Err("文件菜单已取消".into());
            }
            if OpenClipboard(owner as *mut _) != 0 {
                opened = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        if !opened {
            return Err("剪贴板被占用，请稍后重试".into());
        }
        let _clipboard = Clipboard;
        if cancelled.load(Ordering::SeqCst) {
            return Err("文件菜单已取消".into());
        }
        if EmptyClipboard() == 0 {
            return Err("无法更新剪贴板".into());
        }
        if SetClipboardData(13, memory.0).is_null() {
            return Err("无法复制路径".into());
        }
        memory.0 = null_mut();
        Ok(())
    }
}
