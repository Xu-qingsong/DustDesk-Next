//! Blocking native LAN confirmations. The trusted host must validate its real
//! owner window/role and supervise/join the call. No IPC, trust or path grant.
use super::{protocol::Device, receiver::ReceivePrompt};
use std::path::Path;
use tokio_util::sync::CancellationToken;
use windows::{
    core::{HRESULT, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        System::Threading::GetCurrentProcessId,
        UI::{
            Controls::{
                TaskDialogIndirect, TASKDIALOGCONFIG, TASKDIALOG_BUTTON, TASKDIALOG_NOTIFICATIONS,
                TDF_ALLOW_DIALOG_CANCELLATION, TDF_CALLBACK_TIMER, TDM_CLICK_BUTTON, TDN_CREATED,
                TDN_TIMER,
            },
            WindowsAndMessaging::{
                GetWindowThreadProcessId, IsWindow, IsWindowVisible, SendMessageW,
                SetForegroundWindow, ShowWindow, IDCANCEL, SW_SHOWNORMAL,
            },
        },
    },
};

const ACCEPT: i32 = 100;
const CHOOSE: i32 = 101;
const CANCELED: &str = "局域网确认已取消";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReceiveChoice {
    Decline,
    Accept,
    /// This is a request to open a native picker, never a directory approval.
    ChooseDirectory,
}

struct Presentation {
    title: &'static str,
    heading: String,
    content: String,
    accept: &'static str,
    choose: bool,
}

// Names must remain a single literal line. Peer-controlled newlines, NUL and
// bidi overrides must not impersonate the trusted pairing code/path labels.
fn literal(value: &str) -> String {
    let mut output = String::new();
    for character in value.chars() {
        if character.is_control()
            || matches!(character, '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        {
            output.push_str(&format!("\\u{:04x}", character as u32));
        } else {
            output.push(character);
        }
    }
    output
}

fn pairing(peer: &Device, code: &str) -> Result<Presentation, String> {
    peer.validate()?;
    if code.len() != 6 || !code.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("配对码无效".into());
    }
    Ok(Presentation {
        title: "局域网设备配对",
        heading: format!("与 {} 配对", literal(&peer.name)),
        content: format!("请核对两台电脑显示的配对码一致：\n\n{code}\n\n设备地址：{}:{}\n确认身份后，每次接收仍需单独同意。", peer.address, peer.port),
        accept: "配对码一致，继续",
        choose: false,
    })
}

fn receiving(prompt: &ReceivePrompt, downloads: &Path) -> Result<Presentation, String> {
    prompt.peer.validate()?;
    prompt.manifest.validate()?;
    let resume = prompt.existing_directory.is_some();
    let (content, accept, choose) = if let Some(text) = &prompt.manifest.text {
        if resume {
            return Err("文本不能恢复磁盘接收任务".into());
        }
        let mut units = 0;
        let preview: String = text
            .chars()
            .take_while(|character| {
                units += character.len_utf16();
                units <= 2000
            })
            .collect();
        let shortened = preview.len() < text.len();
        (
            format!(
                "文本预览：\n{}{}\n\n接收后可自行复制或保存。",
                literal(&preview),
                if shortened { "\n…" } else { "" }
            ),
            "接收",
            false,
        )
    } else {
        let root = prompt.existing_directory.as_deref().unwrap_or(downloads);
        if !root.is_absolute() || root.as_os_str().to_string_lossy().contains('\0') {
            return Err("原生接收目录无效".into());
        }
        let total: u64 = prompt.manifest.entries.iter().map(|entry| entry.size).sum();
        let location = if resume {
            "继续上次传输，沿用原接收目录："
        } else {
            "默认目录："
        };
        (
            format!(
                "{} 个文件 · {:.2} MiB\n{location}\n{}",
                prompt.manifest.entries.len(),
                total as f64 / 1024.0 / 1024.0,
                literal(&root.display().to_string())
            ),
            if resume {
                "接收"
            } else {
                "接收到默认目录"
            },
            !resume,
        )
    };
    Ok(Presentation {
        title: "接收局域网内容",
        heading: format!(
            "{} 请求{}发送：{}",
            literal(&prompt.peer.name),
            if resume { "继续" } else { "" },
            literal(&prompt.manifest.name)
        ),
        content,
        accept,
        choose,
    })
}

unsafe extern "system" fn callback(
    window: HWND,
    notification: TASKDIALOG_NOTIFICATIONS,
    _parameter: WPARAM,
    _data: LPARAM,
    reference: isize,
) -> HRESULT {
    let cancel = &*(reference as *const CancellationToken);
    if (notification == TDN_CREATED || notification == TDN_TIMER) && cancel.is_cancelled() {
        // Synchronous message on the dialog's own callback thread. Never
        // retain an HWND or later send cancellation to a recycled window.
        SendMessageW(
            window,
            TDM_CLICK_BUTTON.0 as u32,
            Some(WPARAM(IDCANCEL.0 as usize)),
            Some(LPARAM(0)),
        );
    } else if notification == TDN_TIMER && !IsWindowVisible(window).as_bool() {
        // A tray/background host may inherit STARTUPINFO's hidden-show flag.
        // Its first modal must still be visible for an explicit decision.
        let _ = ShowWindow(window, SW_SHOWNORMAL);
        let _ = SetForegroundWindow(window);
    }
    HRESULT(0)
}

pub(super) fn validate_owner(owner: isize) -> Result<(), String> {
    if owner != 0 {
        let window = HWND(owner as *mut _);
        let mut process = 0;
        unsafe {
            GetWindowThreadProcessId(window, Some(&mut process));
        }
        if !unsafe { IsWindow(Some(window)) }.as_bool()
            || process != unsafe { GetCurrentProcessId() }
        {
            return Err("局域网确认所属窗口无效".into());
        }
    }
    Ok(())
}

fn show(
    owner: isize,
    presentation: Presentation,
    cancel: &CancellationToken,
) -> Result<i32, String> {
    if cancel.is_cancelled() {
        return Err(CANCELED.into());
    }
    validate_owner(owner)?;
    let wide = |value: &str| value.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    let title = wide(presentation.title);
    let heading = wide(&presentation.heading);
    let content = wide(&presentation.content);
    let decline = wide("取消");
    let accept = wide(presentation.accept);
    let choose = wide("选择接收目录");
    let buttons = [
        TASKDIALOG_BUTTON {
            nButtonID: IDCANCEL.0,
            pszButtonText: PCWSTR(decline.as_ptr()),
        },
        TASKDIALOG_BUTTON {
            nButtonID: ACCEPT,
            pszButtonText: PCWSTR(accept.as_ptr()),
        },
        TASKDIALOG_BUTTON {
            nButtonID: CHOOSE,
            pszButtonText: PCWSTR(choose.as_ptr()),
        },
    ];
    let config = TASKDIALOGCONFIG {
        cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
        hwndParent: HWND(owner as *mut _),
        dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_CALLBACK_TIMER,
        pszWindowTitle: PCWSTR(title.as_ptr()),
        pszMainInstruction: PCWSTR(heading.as_ptr()),
        pszContent: PCWSTR(content.as_ptr()),
        cButtons: if presentation.choose { 3 } else { 2 },
        pButtons: buttons.as_ptr(),
        nDefaultButton: IDCANCEL.0,
        pfCallback: Some(callback),
        lpCallbackData: cancel as *const _ as isize,
        cxWidth: 400,
        ..Default::default()
    };
    let mut selected = IDCANCEL.0;
    unsafe { TaskDialogIndirect(&config, Some(&mut selected), None, None) }
        .map_err(|error| format!("无法显示局域网确认：{error}"))?;
    if cancel.is_cancelled() {
        return Err(CANCELED.into());
    }
    Ok(selected)
}

/// Must run on a host-owned blocking UI job, joined before shutdown. An owner
/// of zero is reserved for a trusted native background host, never renderer IPC.
pub fn pair(
    owner: isize,
    peer: &Device,
    code: &str,
    cancel: &CancellationToken,
) -> Result<bool, String> {
    Ok(show(owner, pairing(peer, code)?, cancel)? == ACCEPT)
}

pub fn receive(
    owner: isize,
    prompt: &ReceivePrompt,
    downloads: &Path,
    cancel: &CancellationToken,
) -> Result<ReceiveChoice, String> {
    let presentation = receiving(prompt, downloads)?;
    let choose = presentation.choose;
    Ok(match show(owner, presentation, cancel)? {
        ACCEPT => ReceiveChoice::Accept,
        CHOOSE if choose => ReceiveChoice::ChooseDirectory,
        _ => ReceiveChoice::Decline,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lan::protocol::Manifest;
    use std::path::PathBuf;

    fn prompt() -> ReceivePrompt {
        ReceivePrompt {
            peer: Device {
                id: "peer".into(),
                name: "设备\n123456\u{202e}".into(),
                address: "127.0.0.1".into(),
                port: 12345,
                fingerprint: "a".repeat(64),
                last_seen: 0.0,
                extra: Default::default(),
            },
            manifest: Manifest {
                id: "task".into(),
                name: "文件\0名".into(),
                entries: vec![],
                directories: vec![],
                text: None,
                extra: Default::default(),
            },
            existing_directory: None,
        }
    }
    #[test]
    fn pair_code_and_peer_are_validated_and_names_cannot_add_trusted_lines() {
        let prompt = prompt();
        let p = pairing(&prompt.peer, "123456").unwrap();
        assert!(!p.heading.contains('\n'));
        assert!(p.heading.contains("\\u000a123456\\u202e"));
        assert!(p.content.contains("\n\n123456\n\n"));
        for code in ["", "12345", "1234567", "１２３４５６", "123\n56"] {
            assert!(pairing(&prompt.peer, code).is_err());
        }
    }
    #[test]
    fn resume_shows_original_directory_and_never_offers_another_directory() {
        let mut prompt = prompt();
        let downloads = Path::new("C:\\default");
        assert!(receiving(&prompt, downloads).unwrap().choose);
        prompt.existing_directory = Some(PathBuf::from("D:\\original"));
        let p = receiving(&prompt, downloads).unwrap();
        assert!(!p.choose);
        assert!(p.content.contains("D:\\original"));
        assert!(!p.content.contains("C:\\default"));
        prompt.manifest.text = Some("text".into());
        assert!(receiving(&prompt, downloads).is_err());
    }
    #[test]
    fn text_preview_is_bounded_on_utf16_boundaries_and_never_offers_directory() {
        let mut prompt = prompt();
        prompt.manifest.text = Some(format!("{}😀private suffix", "字".repeat(1999)));
        let p = receiving(&prompt, Path::new("relative-unused-for-text")).unwrap();
        assert!(!p.choose);
        assert!(!p.content.contains("private suffix"));
        assert!(!p.content.contains('😀'));
        assert!(p.content.contains("\n…"));
        assert!(receiving(&self::prompt(), Path::new("relative")).is_err());
    }
}
