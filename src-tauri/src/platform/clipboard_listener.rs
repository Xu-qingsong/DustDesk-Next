use std::{
    ptr::{null, null_mut},
    sync::mpsc,
    thread,
    time::Duration,
};
use tokio::sync::watch;
use windows_sys::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::{
        DataExchange::{
            AddClipboardFormatListener, GetClipboardSequenceNumber, RemoveClipboardFormatListener,
        },
        LibraryLoader::GetModuleHandleW,
    },
    UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
        GetWindowLongPtrW, PostMessageW, PostQuitMessage, RegisterClassW, SetWindowLongPtrW,
        UnregisterClassW, CREATESTRUCTW, GWLP_USERDATA, HWND_MESSAGE, MSG, WM_CLIPBOARDUPDATE,
        WM_CLOSE, WM_DESTROY, WM_NCCREATE, WNDCLASSW,
    },
};

pub struct Listener {
    window: usize,
    thread: Option<thread::JoinHandle<()>>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        unsafe {
            PostMessageW(self.window as HWND, WM_CLOSE, 0, 0);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

unsafe extern "system" fn procedure(
    window: HWND,
    message: u32,
    word: WPARAM,
    parameter: LPARAM,
) -> LRESULT {
    if message == WM_NCCREATE {
        let create = &*(parameter as *const CREATESTRUCTW);
        SetWindowLongPtrW(window, GWLP_USERDATA, create.lpCreateParams as isize);
    }
    match message {
        WM_CLIPBOARDUPDATE => {
            let signal = GetWindowLongPtrW(window, GWLP_USERDATA) as *const watch::Sender<u64>;
            if let Some(signal) = signal.as_ref() {
                signal.send_modify(|generation| *generation = generation.wrapping_add(1));
            }
            0
        }
        WM_CLOSE => {
            DestroyWindow(window);
            0
        }
        WM_DESTROY => {
            RemoveClipboardFormatListener(window);
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(window, message, word, parameter),
    }
}

pub fn sequence() -> u32 {
    unsafe { GetClipboardSequenceNumber() }
}

pub fn listen(signal: watch::Sender<u64>) -> Result<Listener, String> {
    let (ready, receiver) = mpsc::sync_channel(1);
    let thread = thread::Builder::new()
        .name("dustdesk-clipboard-notifications".into())
        .spawn(move || {
            let class: Vec<u16> = format!("DustDeskClipboard-{}", uuid::Uuid::new_v4())
                .encode_utf16()
                .chain([0])
                .collect();
            unsafe {
                let instance = GetModuleHandleW(null());
                let specification = WNDCLASSW {
                    lpfnWndProc: Some(procedure),
                    hInstance: instance,
                    lpszClassName: class.as_ptr(),
                    ..Default::default()
                };
                if RegisterClassW(&specification) == 0 {
                    let _ = ready.send(Err("无法注册剪贴板通知窗口".into()));
                    return;
                }
                let signal = Box::new(signal);
                let window = CreateWindowExW(
                    0,
                    class.as_ptr(),
                    null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    null_mut(),
                    instance,
                    (&*signal as *const watch::Sender<u64>).cast(),
                );
                if window.is_null() {
                    UnregisterClassW(class.as_ptr(), instance);
                    let _ = ready.send(Err("无法创建剪贴板通知窗口".into()));
                    return;
                }
                if AddClipboardFormatListener(window) == 0 {
                    DestroyWindow(window);
                    UnregisterClassW(class.as_ptr(), instance);
                    let _ = ready.send(Err("无法订阅 Windows 剪贴板更新".into()));
                    return;
                }
                if ready.send(Ok(window as usize)).is_err() {
                    DestroyWindow(window);
                    UnregisterClassW(class.as_ptr(), instance);
                    return;
                }
                let mut message = MSG::default();
                loop {
                    let status = GetMessageW(&mut message, null_mut(), 0, 0);
                    if status <= 0 {
                        break;
                    }
                    DispatchMessageW(&message);
                }
                UnregisterClassW(class.as_ptr(), instance);
            }
        })
        .map_err(|error| error.to_string())?;
    match receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| "等待剪贴板通知服务超时".to_string())?
    {
        Ok(window) => Ok(Listener {
            window,
            thread: Some(thread),
        }),
        Err(error) => {
            let _ = thread.join();
            Err(error)
        }
    }
}
