//! Handle-pinned local storage for the receiver. Call only on blocking jobs.
//! Opening a directory is an authorization decision made by the native host;
//! network fields must never select an absolute root.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    os::windows::{ffi::OsStrExt, fs::OpenOptionsExt, io::AsRawHandle},
    path::{Component, Path, PathBuf, Prefix},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
use windows::Win32::{
    Foundation::{FILETIME, HANDLE},
    Storage::FileSystem::{
        FileDispositionInfo, FileRenameInfo, GetDriveTypeW, GetFileInformationByHandle,
        SetFileInformationByHandle, SetFileTime, BY_HANDLE_FILE_INFORMATION, FILE_DISPOSITION_INFO,
        FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO,
    },
};

const OPEN_REPARSE_POINT: u32 = 0x0020_0000;
const BACKUP_SEMANTICS: u32 = 0x0200_0000;
const DELETE: u32 = 0x0001_0000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileIdentity {
    pub volume: u32,
    #[serde(with = "identity_index")]
    pub index: u64,
}

mod identity_index {
    use serde::{Deserialize, Deserializer, Serializer};
    pub fn serialize<S: Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&format!("{value:016x}"))
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
        let value = String::deserialize(deserializer)?;
        let index = u64::from_str_radix(&value, 16).map_err(serde::de::Error::custom)?;
        if index == 0 || value != format!("{index:016x}") {
            return Err(serde::de::Error::custom("文件身份无效"));
        }
        Ok(index)
    }
}

struct Information {
    identity: FileIdentity,
    size: u64,
    links: u32,
    attributes: u32,
    modified: u64,
}
fn information(file: &File) -> io::Result<Information> {
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    unsafe { GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info) }
        .map_err(win_error)?;
    let index = (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow);
    if index == 0 || info.dwFileAttributes & 0x400 != 0 {
        return Err(io::Error::other("文件身份不可核验或路径为重解析点"));
    }
    Ok(Information {
        identity: FileIdentity {
            volume: info.dwVolumeSerialNumber,
            index,
        },
        size: (u64::from(info.nFileSizeHigh) << 32) | u64::from(info.nFileSizeLow),
        links: info.nNumberOfLinks,
        attributes: info.dwFileAttributes,
        modified: (u64::from(info.ftLastWriteTime.dwHighDateTime) << 32)
            | u64::from(info.ftLastWriteTime.dwLowDateTime),
    })
}

fn relative_parts(relative: &str) -> io::Result<Vec<&str>> {
    // Reuse protocol path rules, including Windows devices and alternate streams.
    super::protocol::path_key(relative).map_err(io::Error::other)?;
    Ok(relative.split('/').collect())
}

pub struct Directory {
    path: PathBuf,
    _handle: File,
    // Every ancestor denies delete sharing, preventing path redirection while
    // an authorized descendant is open. No path-only check/open gap.
    _parent: Option<Arc<Directory>>,
}
impl Directory {
    /// Existing local drive directory only. Does not follow junctions/symlinks.
    pub fn open(path: &Path) -> io::Result<Arc<Self>> {
        let mut components = path.components();
        let Some(Component::Prefix(prefix)) = components.next() else {
            return Err(io::Error::other("接收目录必须为本地盘绝对路径"));
        };
        if !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
            || components.next() != Some(Component::RootDir)
        {
            return Err(io::Error::other("接收目录必须为本地盘绝对路径"));
        }
        let mut root = PathBuf::from(prefix.as_os_str());
        root.push(Path::new("\\"));
        let drive: Vec<u16> = root.as_os_str().encode_wide().chain(Some(0)).collect();
        // A drive letter may be a mapped SMB share. Only fixed/removable local
        // drives are supported by this first native storage implementation.
        if !matches!(
            unsafe { GetDriveTypeW(windows_core::PCWSTR(drive.as_ptr())) },
            2 | 3
        ) {
            return Err(io::Error::other("接收目录暂不支持网络映射盘或非磁盘设备"));
        }
        let mut current = Self::pin(root, None)?;
        for component in components {
            let Component::Normal(name) = component else {
                return Err(io::Error::other("接收目录不能含父级路径"));
            };
            let name = name
                .to_str()
                .ok_or_else(|| io::Error::other("目录名无效"))?;
            let parts = relative_parts(name)?;
            if parts.len() != 1 {
                return Err(io::Error::other("目录名无效"));
            }
            current = Self::pin(current.path.join(name), Some(current))?;
        }
        Ok(current)
    }
    fn pin(path: PathBuf, parent: Option<Arc<Self>>) -> io::Result<Arc<Self>> {
        Self::pin_access(path, parent, false)
    }
    fn pin_access(
        path: PathBuf,
        parent: Option<Arc<Self>>,
        deletable: bool,
    ) -> io::Result<Arc<Self>> {
        let handle = OpenOptions::new()
            .access_mode(
                FILE_READ_ATTRIBUTES.0 | FILE_LIST_DIRECTORY.0 | if deletable { DELETE } else { 0 },
            )
            .share_mode(1 | 2)
            .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)
            .open(&path)?;
        let info = information(&handle)?;
        if info.attributes & 0x10 == 0 {
            return Err(io::Error::other("接收路径不是目录"));
        }
        Ok(Arc::new(Self {
            path,
            _handle: handle,
            _parent: parent,
        }))
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub(crate) fn identity(&self) -> io::Result<FileIdentity> {
        Ok(information(&self._handle)?.identity)
    }
    pub(crate) fn contains_identity(&self, identity: &FileIdentity) -> io::Result<bool> {
        let mut current = Some(self);
        while let Some(directory) = current {
            if directory.identity()? == *identity {
                return Ok(true);
            }
            current = directory._parent.as_deref();
        }
        Ok(false)
    }
    pub(super) fn staging(self: &Arc<Self>, name: &str, create: bool) -> io::Result<Arc<Self>> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("暂存目录名无效"));
        }
        let path = self.path.join(name);
        if create {
            match std::fs::create_dir(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error),
            }
        }
        Self::pin_access(path, Some(self.clone()), true)
    }
    pub(super) fn create_child(self: &Arc<Self>, name: &str) -> io::Result<Arc<Self>> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("接收目录名无效"));
        }
        let path = self.path.join(name);
        std::fs::create_dir(&path)?;
        Self::pin(path, Some(self.clone()))
    }
    pub(super) fn remove_empty(&self) -> io::Result<()> {
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(self._handle.as_raw_handle()),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        }
        .map_err(win_error)
    }
    pub fn child(self: &Arc<Self>, relative: &str, create: bool) -> io::Result<Arc<Self>> {
        let mut current = self.clone();
        for name in relative_parts(relative)? {
            let path = current.path.join(name);
            if create {
                match std::fs::create_dir(&path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                    Err(error) => return Err(error),
                }
            }
            current = Self::pin(path, Some(current))?;
        }
        Ok(current)
    }
    pub fn parent_for(
        self: &Arc<Self>,
        relative: &str,
        create: bool,
    ) -> io::Result<(Arc<Self>, String)> {
        relative_parts(relative)?;
        match relative.rsplit_once('/') {
            Some((parent, name)) => Ok((self.child(parent, create)?, name.to_owned())),
            None => Ok((self.clone(), relative.to_owned())),
        }
    }
    fn open_file(
        self: &Arc<Self>,
        name: &str,
        writable: bool,
        create: bool,
    ) -> io::Result<OwnedFile> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("文件名无效"));
        }
        let mut options = OpenOptions::new();
        options
            .read(true)
            .write(writable)
            .share_mode(0)
            .custom_flags(OPEN_REPARSE_POINT);
        if writable {
            options.access_mode(0x8000_0000 | 0x4000_0000 | DELETE);
        }
        if create {
            options.create_new(true);
        }
        let file = options.open(self.path.join(name))?;
        let info = information(&file)?;
        if info.attributes & 0x10 != 0 || info.links != 1 {
            return Err(io::Error::other("接收文件必须是单链接普通文件"));
        }
        Ok(OwnedFile {
            file,
            parent: self.clone(),
            name: name.to_owned(),
            identity: info.identity,
        })
    }
    pub fn create(self: &Arc<Self>, name: &str) -> io::Result<OwnedFile> {
        self.open_file(name, true, true)
    }
    pub fn part(self: &Arc<Self>, name: &str) -> io::Result<OwnedFile> {
        self.open_file(name, true, false)
    }
    pub fn read(self: &Arc<Self>, name: &str) -> io::Result<OwnedFile> {
        self.open_file(name, false, false)
    }
    pub(crate) fn read_shared(self: &Arc<Self>, name: &str) -> io::Result<OwnedFile> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("固定读取文件名无效"));
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(self.path.join(name))?;
        let info = information(&file)?;
        if info.attributes & 0x10 != 0 || info.links != 1 {
            return Err(io::Error::other("固定读取来源必须是单链接普通文件"));
        }
        Ok(OwnedFile {
            file,
            parent: self.clone(),
            name: name.to_owned(),
            identity: info.identity,
        })
    }
    /// Only publication recovery may inspect the legacy link-before-save gap.
    /// Deny writes and pin the staging name. The target name needs its own
    /// metadata handle: delete sharing is specific to each hard-link name.
    /// Ordinary receive/source opens stay strict.
    pub(super) fn legacy_part(self: &Arc<Self>, name: &str) -> io::Result<Option<OwnedFile>> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("暂存文件名无效"));
        }
        let file = OpenOptions::new()
            .access_mode(0x8000_0000 | DELETE)
            .share_mode(1)
            .custom_flags(OPEN_REPARSE_POINT)
            .open(self.path.join(name))?;
        let info = information(&file)?;
        if info.attributes & 0x10 != 0 || !matches!(info.links, 1 | 2) {
            return Err(io::Error::other("旧版暂存文件不是单链接或双链接普通文件"));
        }
        if info.links == 1 {
            return Ok(None);
        }
        Ok(Some(OwnedFile {
            file,
            parent: self.clone(),
            name: name.to_owned(),
            identity: info.identity,
        }))
    }
    /// Read access pins this distinct hard-link name. Keep this pin
    /// through unlink and mapping commit. Delete sharing is per link name.
    pub(super) fn legacy_target(self: &Arc<Self>, name: &str) -> io::Result<OwnedFile> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("发布文件名无效"));
        }
        let file = OpenOptions::new()
            .read(true)
            .share_mode(1)
            .custom_flags(OPEN_REPARSE_POINT | BACKUP_SEMANTICS)
            .open(self.path.join(name))?;
        let info = information(&file)?;
        Ok(OwnedFile {
            file,
            parent: self.clone(),
            name: name.to_owned(),
            identity: info.identity,
        })
    }
}

pub struct OwnedFile {
    file: File,
    parent: Arc<Directory>,
    name: String,
    identity: FileIdentity,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SourceStamp {
    pub identity: FileIdentity,
    pub size: u64,
    pub modified: String,
}
impl SourceStamp {
    pub fn mtime_ms(&self) -> Result<f64, String> {
        let ticks = u64::from_str_radix(&self.modified, 16).map_err(|_| "发送源时间无效")?;
        if self.modified != format!("{ticks:016x}") {
            return Err("发送源时间无效".into());
        }
        let ticks = i128::from(ticks) - 116_444_736_000_000_000_i128;
        Ok((ticks.div_euclid(10_000_000) * 1000) as f64
            + ticks.rem_euclid(10_000_000) as f64 / 10_000.0)
    }
}
impl OwnedFile {
    /// Duplicates the already authorized OS handle, preserving its access and
    /// sharing restrictions. The duplicate shares the file cursor: callers
    /// must serialize reads and must not create concurrent writers.
    pub(crate) fn duplicate(&self) -> io::Result<Self> {
        self.require_single_link()?;
        Ok(Self {
            file: self.file.try_clone()?,
            parent: self.parent.clone(),
            name: self.name.clone(),
            identity: self.identity.clone(),
        })
    }
    pub(crate) fn require_single_link(&self) -> io::Result<()> {
        let info = information(&self.file)?;
        if info.identity != self.identity || info.links != 1 || info.attributes & 0x10 != 0 {
            return Err(io::Error::other("恢复后的发布文件不是同一单链接普通文件"));
        }
        Ok(())
    }
    pub fn identity(&self) -> &FileIdentity {
        &self.identity
    }
    pub fn size(&self) -> io::Result<u64> {
        Ok(information(&self.file)?.size)
    }
    pub fn source_stamp(&self) -> io::Result<SourceStamp> {
        let info = information(&self.file)?;
        Ok(SourceStamp {
            identity: info.identity,
            size: info.size,
            modified: format!("{:016x}", info.modified),
        })
    }
    pub(crate) fn seek(&mut self, offset: u64) -> io::Result<()> {
        self.file.seek(SeekFrom::Start(offset)).map(|_| ())
    }
    pub(crate) fn read_chunk(
        &mut self,
        bytes: &mut [u8],
        cancel: &CancellationToken,
    ) -> io::Result<usize> {
        check_cancel(cancel)?;
        if bytes.len() > 64 * 1024 {
            return Err(io::Error::other("发送读取帧过大"));
        }
        self.file.read(bytes)
    }
    pub fn hash_prefix(&mut self, size: u64, cancel: &CancellationToken) -> io::Result<String> {
        if self.size()? < size {
            return Err(io::Error::other("发送源短于续传偏移"));
        }
        self.seek(0)?;
        let mut hash = Sha256::new();
        let mut left = size;
        let mut buffer = [0_u8; 64 * 1024];
        while left > 0 {
            let amount = left.min(buffer.len() as u64) as usize;
            let count = self.read_chunk(&mut buffer[..amount], cancel)?;
            if count == 0 {
                return Err(io::Error::other("发送源短于续传偏移"));
            }
            hash.update(&buffer[..count]);
            left -= count as u64;
        }
        check_cancel(cancel)?;
        Ok(format!("{:x}", hash.finalize()))
    }
    pub fn path(&self) -> PathBuf {
        self.parent.path.join(&self.name)
    }
    pub fn sync(&self) -> io::Result<()> {
        self.file.sync_all()
    }
    pub fn hash(&mut self, size: u64, cancel: &CancellationToken) -> io::Result<String> {
        if self.size()? != size {
            return Err(io::Error::other("接收文件大小不符"));
        }
        self.file.seek(SeekFrom::Start(0))?;
        let mut hash = Sha256::new();
        let mut left = size;
        let mut buffer = [0_u8; 64 * 1024];
        while left > 0 {
            check_cancel(cancel)?;
            let length = (left.min(buffer.len() as u64)) as usize;
            let count = self.file.read(&mut buffer[..length])?;
            if count == 0 {
                return Err(io::Error::other("接收文件被截断"));
            }
            hash.update(&buffer[..count]);
            left -= count as u64;
        }
        check_cancel(cancel)?;
        Ok(format!("{:x}", hash.finalize()))
    }
    /// Append one bounded frame only after checking the exact actual offset.
    /// Request/task cancellation must be checked by the blocking job itself.
    pub fn append(
        &mut self,
        offset: u64,
        bytes: &[u8],
        limit: u64,
        cancel: &CancellationToken,
    ) -> io::Result<()> {
        check_cancel(cancel)?;
        if bytes.len() > 64 * 1024
            || self.size()? != offset
            || offset
                .checked_add(bytes.len() as u64)
                .is_none_or(|end| end > limit)
        {
            return Err(io::Error::other("续传偏移或声明大小无效"));
        }
        self.file.seek(SeekFrom::Start(offset))?;
        self.file.write_all(bytes)?;
        check_cancel(cancel)
    }
    /// Rename the exact open source. Destination collisions are never deleted.
    pub fn publish(&mut self, parent: &Arc<Directory>, name: &str) -> io::Result<()> {
        self.rename(parent, name, false)
    }
    pub(super) fn replace(&mut self, parent: &Arc<Directory>, name: &str) -> io::Result<()> {
        self.rename(parent, name, true)
    }
    fn rename(&mut self, parent: &Arc<Directory>, name: &str, replace: bool) -> io::Result<()> {
        if relative_parts(name)?.len() != 1 {
            return Err(io::Error::other("发布文件名无效"));
        }
        let info = information(&self.file)?;
        if info.identity != self.identity || info.links != 1 {
            return Err(io::Error::other("待发布文件身份已变化"));
        }
        // Use the documented NULL-root/full-path form. All target ancestors
        // remain pinned; the source is still renamed by its exact open handle.
        let path = parent.path.join(name);
        let native = match path.components().next() {
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_)) => {
                let mut extended = std::ffi::OsString::from(r"\\?\");
                extended.push(path.as_os_str());
                PathBuf::from(extended)
            }
            Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::VerbatimDisk(_)) => {
                path
            }
            _ => return Err(io::Error::other("发布目标不是已固定的本地盘绝对路径")),
        };
        let wide: Vec<u16> = native.as_os_str().encode_wide().collect();
        let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
        let length = (offset + (wide.len() + 1) * 2).max(std::mem::size_of::<FILE_RENAME_INFO>());
        // FILE_RENAME_INFO contains an aligned flexible UTF-16 array.
        let mut buffer = vec![0_u64; length.div_ceil(8)];
        let pointer = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
        unsafe {
            (*pointer).Anonymous.ReplaceIfExists = replace;
            (*pointer).RootDirectory = HANDLE::default();
            (*pointer).FileNameLength = (wide.len() * 2) as u32;
            std::ptr::copy_nonoverlapping(
                wide.as_ptr(),
                (*pointer).FileName.as_mut_ptr(),
                wide.len(),
            );
            SetFileInformationByHandle(
                HANDLE(self.file.as_raw_handle()),
                FileRenameInfo,
                pointer.cast(),
                length as u32,
            )
            .map_err(win_error)?;
        }
        self.parent = parent.clone();
        self.name = name.to_owned();
        Ok(())
    }
    /// Deletes only this verified open file, including on failure cleanup.
    pub fn remove(self) -> io::Result<()> {
        if information(&self.file)?.identity != self.identity {
            return Err(io::Error::other("清理文件身份已变化"));
        }
        let info = FILE_DISPOSITION_INFO { DeleteFile: true };
        unsafe {
            SetFileInformationByHandle(
                HANDLE(self.file.as_raw_handle()),
                FileDispositionInfo,
                (&info as *const FILE_DISPOSITION_INFO).cast(),
                std::mem::size_of_val(&info) as u32,
            )
        }
        .map_err(win_error)?;
        Ok(())
    }
    pub(crate) fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        self.file.write_all(bytes)
    }
    pub(crate) fn set_source_metadata(&self, modified: &str, read_only: bool) -> io::Result<()> {
        let modified =
            u64::from_str_radix(modified, 16).map_err(|_| io::Error::other("原始文件时间无效"))?;
        let modified = FILETIME {
            dwLowDateTime: modified as u32,
            dwHighDateTime: (modified >> 32) as u32,
        };
        unsafe {
            SetFileTime(
                HANDLE(self.file.as_raw_handle()),
                None,
                None,
                Some(&modified),
            )
        }
        .map_err(win_error)?;
        let mut permissions = self.file.metadata()?.permissions();
        permissions.set_readonly(read_only);
        self.file.set_permissions(permissions)
    }
    pub(crate) fn read_bounded(&mut self, limit: usize) -> io::Result<Vec<u8>> {
        if self.size()? > limit as u64 {
            return Err(io::Error::other("局域网状态文件过大"));
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut self.file)
            .take(limit as u64 + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() > limit {
            return Err(io::Error::other("局域网状态文件过大"));
        }
        Ok(bytes)
    }
}
pub(super) fn check_cancel(cancel: &CancellationToken) -> io::Result<()> {
    if cancel.is_cancelled() {
        Err(io::Error::new(io::ErrorKind::Interrupted, "接收任务已取消"))
    } else {
        Ok(())
    }
}

fn win_error(error: windows_core::Error) -> io::Error {
    let code = error.code().0;
    if (code as u32) & 0xffff_0000 == 0x8007_0000 {
        io::Error::from_raw_os_error(code & 0xffff)
    } else {
        io::Error::other(error.to_string())
    }
}

#[cfg(test)]
#[path = "files_tests.rs"]
pub(crate) mod tests;
