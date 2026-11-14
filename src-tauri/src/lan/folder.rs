//! LAN-only folder chooser. Cancellation runs on the same STA message loop
//! as IFileDialog; no cross-thread COM pointer or recycled HWND is retained.
use std::{cell::RefCell, path::PathBuf};
use tokio_util::sync::CancellationToken;
use windows::{
    core::{implement, Interface, Ref, HRESULT, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            Ole::IOleWindow,
        },
        UI::{
            Shell::{
                FileOpenDialog, IFileDialog, IFileDialogEvents, IFileDialogEvents_Impl,
                IFileOpenDialog, IShellItem, FDEOR_DEFAULT, FDESVR_DEFAULT, FDE_OVERWRITE_RESPONSE,
                FDE_SHAREVIOLATION_RESPONSE, FOS_DONTADDTORECENT, FOS_FORCEFILESYSTEM,
                FOS_NOCHANGEDIR, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, SIGDN_FILESYSPATH,
            },
            WindowsAndMessaging::{
                GetDlgItem, IsWindowVisible, KillTimer, PostMessageW, SendMessageW,
                SetForegroundWindow, SetTimer, ShowWindow, BM_CLICK, SW_SHOWNORMAL, WM_CLOSE,
            },
        },
    },
};
const CANCELLED: HRESULT = HRESULT(0x800704c7u32 as i32);
static TIMER_KEY: u8 = 0;
struct Session {
    cancel: CancellationToken,
    timer: Option<(isize, usize)>,
}
thread_local! { static PICKER: RefCell<Option<Session>> = const { RefCell::new(None) }; }

unsafe extern "system" fn tick(window: HWND, _: u32, id: usize, _: u32) {
    let state = PICKER.with(|picker| {
        picker
            .borrow()
            .as_ref()
            .filter(|state| state.timer == Some((window.0 as isize, id)))
            .map(|state| state.cancel.clone())
    });
    if let Some(cancel) = state {
        if cancel.is_cancelled() {
            let _ = KillTimer(Some(window), id);
            PICKER.with(|picker| {
                if let Some(state) = picker.borrow_mut().as_mut() {
                    state.timer = None;
                }
            });
            // Ask the modal's own message loop to close its current window.
            // Never post cancellation from a different thread holding an old HWND.
            if let Ok(button) = GetDlgItem(Some(window), 2) {
                SendMessageW(button, BM_CLICK, Some(WPARAM(0)), Some(LPARAM(0)));
            } else {
                let _ = PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        } else if !IsWindowVisible(window).as_bool() {
            let _ = ShowWindow(window, SW_SHOWNORMAL);
            let _ = SetForegroundWindow(window);
        }
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}
#[implement(IFileDialogEvents)]
struct Events;
impl IFileDialogEvents_Impl for Events_Impl {
    fn OnFileOk(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChanging(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnFolderChange(&self, dialog: Ref<IFileDialog>) -> windows::core::Result<()> {
        unsafe {
            let dialog = dialog.ok()?;
            let window = dialog.cast::<IOleWindow>()?.GetWindow()?;
            let canceled = PICKER.with(|picker| {
                let mut picker = picker.borrow_mut();
                let Some(state) = picker.as_mut() else {
                    return true;
                };
                if state.timer.is_none() {
                    // A COM file dialog filters thread-only timer messages.
                    // Attach to its actual HWND on the owning STA instead.
                    let id = std::ptr::addr_of!(TIMER_KEY) as usize;
                    // With an HWND, SetTimer returns success, not a timer ID.
                    // Keep the requested ID for callbacks and KillTimer.
                    if SetTimer(Some(window), id, 100, Some(tick)) == 0 {
                        return true;
                    }
                    state.timer = Some((window.0 as isize, id));
                }
                state.cancel.is_cancelled()
            });
            if canceled {
                let _ = PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
        Ok(())
    }
    fn OnSelectionChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnShareViolation(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<FDE_SHAREVIOLATION_RESPONSE> {
        Ok(FDESVR_DEFAULT)
    }
    fn OnTypeChange(&self, _: Ref<IFileDialog>) -> windows::core::Result<()> {
        Ok(())
    }
    fn OnOverwrite(
        &self,
        _: Ref<IFileDialog>,
        _: Ref<IShellItem>,
    ) -> windows::core::Result<FDE_OVERWRITE_RESPONSE> {
        Ok(FDEOR_DEFAULT)
    }
}
struct Timer;
impl Drop for Timer {
    fn drop(&mut self) {
        let state = PICKER.with(|picker| picker.borrow_mut().take());
        if let Some((window, id)) = state.and_then(|state| state.timer) {
            unsafe {
                let _ = KillTimer(Some(HWND(window as *mut _)), id);
            }
        }
    }
}

/// Trusted native owner only, after the host checks role/lifecycle. Does not
/// create a directory, grant file access, or persist a default on cancellation.
pub fn choose(owner: isize, cancel: &CancellationToken) -> Result<Option<PathBuf>, String> {
    super::dialog::validate_owner(owner)?;
    if cancel.is_cancelled() {
        return Err("局域网目录选择已取消".into());
    }
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok() }
        .map_err(|error| error.to_string())?;
    let _apartment = Apartment;
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        dialog
            .SetOptions(
                dialog.GetOptions().map_err(|error| error.to_string())?
                    | FOS_PICKFOLDERS
                    | FOS_FORCEFILESYSTEM
                    | FOS_PATHMUSTEXIST
                    | FOS_NOCHANGEDIR
                    | FOS_DONTADDTORECENT,
            )
            .map_err(|error| error.to_string())?;
        let title: Vec<u16> = "选择局域网接收目录".encode_utf16().chain(Some(0)).collect();
        dialog
            .SetTitle(PCWSTR(title.as_ptr()))
            .map_err(|error| error.to_string())?;
        PICKER.with(|picker| {
            let mut picker = picker.borrow_mut();
            if picker.is_some() {
                return Err("已有局域网目录选择窗口".to_owned());
            }
            *picker = Some(Session {
                cancel: cancel.clone(),
                timer: None,
            });
            Ok(())
        })?;
        let _timer = Timer;
        let events: IFileDialogEvents = Events.into();
        let cookie = dialog.Advise(&events).map_err(|error| error.to_string())?;
        let result = dialog.Show(Some(HWND(owner as *mut _)));
        let _ = dialog.Unadvise(cookie);
        if cancel.is_cancelled() {
            return Err("局域网目录选择已取消".into());
        }
        match result {
            Err(error) if error.code() == CANCELLED => Ok(None),
            Err(error) => Err(format!("无法选择局域网接收目录：{error}")),
            Ok(()) => {
                let item = dialog.GetResult().map_err(|error| error.to_string())?;
                let value = item
                    .GetDisplayName(SIGDN_FILESYSPATH)
                    .map_err(|error| error.to_string())?;
                let path = value.to_string();
                CoTaskMemFree(Some(value.0.cast()));
                Ok(Some(PathBuf::from(
                    path.map_err(|error| error.to_string())?,
                )))
            }
        }
    }
}
