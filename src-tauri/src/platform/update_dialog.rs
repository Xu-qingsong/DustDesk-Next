use tokio::sync::watch;
use windows::{
    core::{HRESULT, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        UI::{
            Controls::{
                TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS,
                TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDM_CLICK_BUTTON, TDN_CREATED,
                TDN_TIMER,
            },
            WindowsAndMessaging::{
                IsWindowVisible, PostMessageW, SetForegroundWindow, ShowWindow, IDCANCEL,
                SW_SHOWNORMAL,
            },
        },
    },
};

unsafe extern "system" fn callback(
    window: HWND,
    notification: TASKDIALOG_NOTIFICATIONS,
    _parameter: WPARAM,
    _data: LPARAM,
    reference: isize,
) -> HRESULT {
    if notification == TDN_CREATED || notification == TDN_TIMER {
        let cancelled = &*(reference as *const watch::Receiver<bool>);
        if *cancelled.borrow() {
            let _ = PostMessageW(
                Some(window),
                TDM_CLICK_BUTTON.0 as u32,
                WPARAM(IDCANCEL.0 as usize),
                LPARAM(0),
            );
        } else if notification == TDN_TIMER && !IsWindowVisible(window).as_bool() {
            let _ = ShowWindow(window, SW_SHOWNORMAL);
            let _ = SetForegroundWindow(window);
        }
    }
    HRESULT(0)
}
pub fn show(
    owner: isize,
    title: &str,
    content: &str,
    confirm: bool,
    cancelled: watch::Receiver<bool>,
) -> Result<bool, String> {
    if *cancelled.borrow() {
        return Err("更新检查已取消".into());
    }
    let _apartment = super::shell::apartment()?;
    let wide = |value: &str| {
        value
            .replace('\0', "")
            .encode_utf16()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let title = wide(title);
    let content = wide(content);
    let decline = wide(if confirm { "暂不更新" } else { "确定" });
    let accept = wide("前往更新");
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: IDCANCEL.0,
            pszButtonText: PCWSTR(decline.as_ptr()),
        },
        TASKDIALOG_BUTTON {
            nButtonID: 100,
            pszButtonText: PCWSTR(accept.as_ptr()),
        },
    ];
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: HWND(owner as *mut _),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        cButtons: if confirm { 2 } else { 1 },
        pButtons: buttons.as_ptr(),
        nDefaultButton: IDCANCEL.0,
        pfCallback: Some(callback),
        lpCallbackData: &cancelled as *const _ as isize,
        cxWidth: 380,
        ..Default::default()
    };
    let mut selected = IDCANCEL.0;
    unsafe { TaskDialogIndirect(&config, Some(&mut selected), None, None) }
        .map_err(|error| format!("无法显示更新对话框：{error}"))?;
    if *cancelled.borrow() {
        return Err("更新检查已取消".into());
    }
    Ok(confirm && selected == 100)
}
