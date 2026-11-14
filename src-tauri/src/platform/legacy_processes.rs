#[derive(Debug, PartialEq, Eq)]
struct Process {
    pid: u32,
    executable: String,
}

fn require_stopped_from(
    snapshot: Result<Vec<Process>, String>,
    own_pid: u32,
) -> Result<(), String> {
    let mut candidates = snapshot
        .map_err(|error| format!("无法确认旧版 DustDesk 已退出，迁移维护已拒绝：{error}"))?
        .into_iter()
        .filter(|process| {
            process.pid != own_pid
                && ["DustDesk.exe", "DustDesk.Next.exe", "dustdesk-tauri.exe"]
                    .iter()
                    .any(|name| process.executable.eq_ignore_ascii_case(name))
        })
        .collect::<Vec<_>>();
    candidates.sort_by_key(|process| process.pid);
    candidates.dedup_by_key(|process| process.pid);
    if candidates.is_empty() {
        return Ok(());
    }
    let display = candidates
        .iter()
        .take(8)
        .map(|process| format!("{}（PID {}）", process.executable, process.pid))
        .collect::<Vec<_>>()
        .join("、");
    Err(format!(
        "检测到其他 DustDesk 进程（共 {} 个）：{display}。请先从旧版托盘完整退出，再重试迁移维护；本程序不会强制结束进程。",
        candidates.len()
    ))
}

#[cfg(windows)]
fn snapshot() -> Result<Vec<Process>, String> {
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows::Win32::Foundation::{ERROR_NO_MORE_FILES, HANDLE};
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };

    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) }
        .map_err(|error| error.to_string())?;
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
    let mut entry = PROCESSENTRY32W {
        dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    let native = HANDLE(handle.as_raw_handle());
    if let Err(error) = unsafe { Process32FirstW(native, &mut entry) } {
        return if error.code() == ERROR_NO_MORE_FILES.to_hresult() {
            Ok(Vec::new())
        } else {
            Err(error.to_string())
        };
    }
    let mut result = Vec::new();
    loop {
        if result.len() >= 65536 {
            return Err("进程清单超过安全上限，不能确认旧版已退出".into());
        }
        let length = entry
            .szExeFile
            .iter()
            .position(|value| *value == 0)
            .ok_or("进程名称无终止符，不能确认旧版已退出")?;
        result.push(Process {
            pid: entry.th32ProcessID,
            executable: String::from_utf16_lossy(&entry.szExeFile[..length]),
        });
        if let Err(error) = unsafe { Process32NextW(native, &mut entry) } {
            return if error.code() == ERROR_NO_MORE_FILES.to_hresult() {
                Ok(result)
            } else {
                Err(error.to_string())
            };
        }
    }
}

pub fn require_stopped() -> Result<(), String> {
    #[cfg(windows)]
    {
        require_stopped_from(snapshot(), std::process::id())
    }
    #[cfg(not(windows))]
    {
        Err("当前平台尚不能确认旧版 DustDesk 进程状态，迁移维护已拒绝".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, name: &str) -> Process {
        Process {
            pid,
            executable: name.into(),
        }
    }

    #[test]
    fn known_product_names_are_case_insensitive_but_not_substring_matches() {
        for name in [
            "DustDesk.exe",
            "dustdesk.EXE",
            "DustDesk.Next.exe",
            "dustdesk-tauri.exe",
        ] {
            let error = require_stopped_from(Ok(vec![process(42, name)]), 7).unwrap_err();
            assert!(error.contains("PID 42"));
            assert!(error.contains("完整退出"));
        }
        for name in [
            "electron.exe",
            "msedgewebview2.exe",
            "DustDesk-other.exe",
            "NotDustDesk.exe",
            "DustDesk.exe.backup",
            "",
        ] {
            assert!(require_stopped_from(Ok(vec![process(42, name)]), 7).is_ok());
        }
    }

    #[test]
    fn only_current_native_pid_is_exempt_and_snapshot_errors_fail_closed() {
        assert!(require_stopped_from(Ok(vec![process(7, "DustDesk.exe")]), 7).is_ok());
        assert!(require_stopped_from(
            Ok(vec![process(7, "DustDesk.exe"), process(8, "DustDesk.exe")]),
            7
        )
        .is_err());
        assert!(require_stopped_from(Err("access denied".into()), 7)
            .unwrap_err()
            .contains("无法确认"));
    }

    #[test]
    fn diagnostics_are_stable_bounded_and_do_not_discard_additional_blockers() {
        let mut processes = (10..30)
            .rev()
            .map(|pid| process(pid, "DustDesk.exe"))
            .collect::<Vec<_>>();
        processes.push(process(10, "DustDesk.exe"));
        let error = require_stopped_from(Ok(processes), 7).unwrap_err();
        assert!(error.contains("共 20 个"));
        assert!(error.contains("PID 10"));
        assert!(!error.contains("PID 18"));
        assert_eq!(error.matches("PID ").count(), 8);
    }
}
