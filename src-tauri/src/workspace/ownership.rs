#[cfg(windows)]
pub struct Ownership {
    guard: Guard,
}

#[cfg(windows)]
enum Guard {
    Standard {
        _pipe: std::os::windows::io::OwnedHandle,
        directory: std::fs::File,
    },
    Runtime(Box<std::sync::Mutex<dustdesk_tauri::legacy_source::binding::snapshot::RuntimeOwner>>),
}

#[cfg(windows)]
impl Ownership {
    #[cfg(debug_assertions)]
    pub(super) fn seal_runtime(
        &self,
        drafts: &[u8],
        workspace: &str,
        browser: &str,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<dustdesk_tauri::legacy_source::binding::snapshot::handback::Receipt, String> {
        match &self.guard {
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|e| e.to_string())?
                .seal_runtime_preview(drafts, workspace, browser, current),
            _ => Err("未持有实际运行所有权".into()),
        }
    }

    #[cfg(debug_assertions)]
    pub(super) fn confirm_runtime_handback(&self) -> Result<(), String> {
        match &self.guard {
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|e| e.to_string())?
                .resume_runtime_handback_preview(|| Ok(()))
                .map(|_| ()),
            _ => Err("未持有整体交还所有权".into()),
        }
    }

    #[cfg(debug_assertions)]
    pub(super) fn original_lan_enabled(&self) -> Result<bool, String> {
        match &self.guard {
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|error| error.to_string())?
                .original_lan_enabled_preview(),
            _ => Err("未持有实际运行所有权".into()),
        }
    }
    #[cfg(debug_assertions)]
    pub(super) fn prepare_original_lan(
        &self,
    ) -> Result<
        (
            dustdesk_tauri::lan::state_store::StateStore,
            std::sync::Arc<dustdesk_tauri::lan::storage::Identity>,
        ),
        String,
    > {
        match &self.guard {
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|error| error.to_string())?
                .prepare_original_lan_preview(|| Ok(())),
            _ => Err("未持有实际运行所有权".into()),
        }
    }
    #[cfg(debug_assertions)]
    pub(super) fn finish_original_lan(
        &self,
        drained: &dustdesk_tauri::lan::migration::service::Drained,
    ) -> Result<dustdesk_tauri::lan::migration::handback::Receipt, String> {
        match &self.guard {
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|error| error.to_string())?
                .finish_original_lan_preview(drained, || Ok(())),
            _ => Err("未持有实际运行所有权".into()),
        }
    }
    #[cfg(debug_assertions)]
    pub(super) fn original_lan_not_started(
        &self,
    ) -> Result<dustdesk_tauri::lan::migration::Checkpoint, String> {
        match &self.guard {
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|error| error.to_string())?
                .confirm_original_lan_not_started_preview(),
            _ => Err("未持有实际运行所有权".into()),
        }
    }

    pub(super) fn from_runtime(
        mut owner: dustdesk_tauri::legacy_source::binding::snapshot::RuntimeOwner,
    ) -> Result<Self, String> {
        owner.confirm()?;
        Ok(Self {
            guard: Guard::Runtime(Box::new(std::sync::Mutex::new(owner))),
        })
    }

    pub(super) fn confirm_runtime(&self) -> Result<(), String> {
        match &self.guard {
            Guard::Standard { .. } => Ok(()),
            Guard::Runtime(owner) => owner.lock().map_err(|error| error.to_string())?.confirm(),
        }
    }

    pub(super) fn runtime_drafts(
        &self,
    ) -> Result<Option<dustdesk_tauri::legacy_source::binding::snapshot::RuntimeDraftArchive>, String>
    {
        match &self.guard {
            Guard::Standard { .. } => Ok(None),
            Guard::Runtime(owner) => owner
                .lock()
                .map_err(|error| error.to_string())?
                .browser_archive()
                .map(Some),
        }
    }

    pub fn identity(&self, root: &std::path::Path) -> Result<NativeIdentity, String> {
        let directory = match &self.guard {
            Guard::Standard { directory, .. } => directory,
            Guard::Runtime(owner) => {
                let mut owner = owner.lock().map_err(|error| error.to_string())?;
                owner.confirm()?;
                if root != owner.path() {
                    return Err("运行所有权不能用于另一工作区路径".into());
                }
                let identity = &owner.receipt().destination_identity;
                return Ok(NativeIdentity {
                    volume: format!("{:016x}", identity.volume),
                    file: format!("{:016x}", identity.index),
                });
            }
        };
        use std::os::windows::fs::OpenOptionsExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_FLAG_BACKUP_SEMANTICS, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        super::checked_path(root)?;
        let current = std::fs::OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(root)
            .map_err(|error| error.to_string())?;
        let identity = inspect_file(directory)?;
        let observed = inspect_file(&current)?;
        if identity.reparse || observed.reparse || identity.identity != observed.identity {
            return Err("工作区原生目录身份已变化".into());
        }
        Ok(identity.identity)
    }

    pub fn acquire(root: &std::path::Path) -> Result<Self, String> {
        use std::fs::OpenOptions;
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle, io::FromRawHandle};
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_SHARE_READ, FILE_SHARE_WRITE, PIPE_ACCESS_DUPLEX,
        };
        use windows::Win32::System::Pipes::{
            CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS, PIPE_TYPE_BYTE,
            PIPE_WAIT,
        };

        let directory = OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS.0)
            .open(root)
            .map_err(|error| error.to_string())?;
        let mut identity = BY_HANDLE_FILE_INFORMATION::default();
        unsafe {
            GetFileInformationByHandle(HANDLE(directory.as_raw_handle()), &mut identity)
                .map_err(|error| error.to_string())?;
        }
        let index = (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow);
        if index == 0 {
            return Err("无法确认工作区目录身份".into());
        }
        let name = format!(
            r"\\.\pipe\dustdesk-workspace-v1-{:016x}-{:016x}",
            identity.dwVolumeSerialNumber, index
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
                "工作区正由另一个进程使用或锁访问被拒绝，未打开：{}",
                std::io::Error::last_os_error()
            ));
        }
        let pipe = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(pipe.0) };
        super::checked_path(root)?;
        Ok(Self {
            guard: Guard::Standard {
                _pipe: pipe,
                directory,
            },
        })
    }
}

#[cfg(not(windows))]
pub struct Ownership;

#[cfg(not(windows))]
impl Ownership {
    pub(super) fn confirm_runtime(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn identity(&self, _root: &std::path::Path) -> Result<NativeIdentity, String> {
        Err("当前平台暂不支持原生草稿回执核验".into())
    }

    pub fn acquire(_root: &std::path::Path) -> Result<Self, String> {
        Ok(Self)
    }
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct NativeIdentity {
    pub volume: String,
    pub file: String,
}

pub(super) struct NativeFileInfo {
    pub identity: NativeIdentity,
    pub links: u32,
    pub reparse: bool,
}

#[cfg(windows)]
pub(super) fn inspect_file(file: &std::fs::File) -> Result<NativeFileInfo, String> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };
    let mut identity = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut identity)
            .map_err(|error| error.to_string())?;
    }
    let index = (u64::from(identity.nFileIndexHigh) << 32) | u64::from(identity.nFileIndexLow);
    if index == 0 {
        return Err("无法确认原生文件身份".into());
    }
    Ok(NativeFileInfo {
        identity: NativeIdentity {
            volume: format!("{:016x}", identity.dwVolumeSerialNumber),
            file: format!("{index:016x}"),
        },
        links: identity.nNumberOfLinks,
        reparse: identity.dwFileAttributes & 0x400 != 0,
    })
}

#[cfg(not(windows))]
pub(super) fn inspect_file(_file: &std::fs::File) -> Result<NativeFileInfo, String> {
    Err("当前平台暂不支持原生草稿回执核验".into())
}
