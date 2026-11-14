//! Same physical-directory pipe protocol as the Electron preparation build.
//! StateStore retains Directory (including pinned ancestors) for this lease.
use super::files::Directory;
use std::os::windows::io::{FromRawHandle, OwnedHandle};
use windows::{
    core::PCWSTR,
    Win32::{
        Storage::FileSystem::{FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX},
        System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_WAIT,
        },
    },
};

pub(crate) struct Lease {
    _pipe: OwnedHandle,
}
impl Lease {
    pub(crate) fn acquire(root: &Directory) -> Result<Self, String> {
        let identity = root.identity().map_err(|e| e.to_string())?;
        let name = format!(
            r"\\.\pipe\dustdesk-workspace-v1-{:016x}-{:016x}",
            identity.volume, identity.index
        );
        let wide = name.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
        let pipe = unsafe {
            CreateNamedPipeW(
                PCWSTR(wide.as_ptr()),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1,
                0,
                0,
                0,
                None,
            )
        };
        if pipe.is_invalid() {
            return Err(format!(
                "局域网状态目录正由另一个进程使用或锁访问被拒绝，未打开：{}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(Self {
            _pipe: unsafe { OwnedHandle::from_raw_handle(pipe.0) },
        })
    }
}
