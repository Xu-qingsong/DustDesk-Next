use super::checked_path;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Node {
    directory: bool,
    length: u64,
    modified: String,
    identity: String,
    hash: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tree(pub BTreeMap<String, Node>);
fn open(path: &Path) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x02000000);
    }
    options.open(path).map_err(|error| error.to_string())
}
fn node(file: &File) -> Result<Node, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_dir() && !metadata.is_file() {
        return Err("不支持特殊文件".into());
    }
    #[cfg(windows)]
    let identity = {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::HANDLE,
            Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION},
        };
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        unsafe {
            GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut info)
                .map_err(|error| error.to_string())?;
        }
        format!(
            "{}:{}:{}:{}:{}",
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
            info.ftCreationTime.dwHighDateTime,
            info.ftCreationTime.dwLowDateTime
        )
    };
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    };
    #[cfg(not(any(windows, unix)))]
    let identity = return Err("当前平台不支持文件身份验证".into());
    let modified = match metadata
        .modified()
        .map_err(|error| error.to_string())?
        .duration_since(UNIX_EPOCH)
    {
        Ok(duration) => format!("+{}", duration.as_nanos()),
        Err(error) => format!("-{}", error.duration().as_nanos()),
    };
    Ok(Node {
        directory: metadata.is_dir(),
        length: if metadata.is_dir() { 0 } else { metadata.len() },
        modified,
        identity,
        hash: String::new(),
    })
}
fn visit(
    root: &Path,
    path: &Path,
    entries: &mut BTreeMap<String, Node>,
    depth: usize,
) -> Result<(), String> {
    if depth > 128 {
        return Err("目录嵌套超过安全限制".into());
    }
    checked_path(path)?;
    let mut file = open(path)?;
    let mut before = node(&file)?;
    if before.directory {
        for item in fs::read_dir(path).map_err(|error| error.to_string())? {
            visit(
                root,
                &item.map_err(|error| error.to_string())?.path(),
                entries,
                depth + 1,
            )?;
        }
    } else {
        let mut hash = Sha256::new();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        before.hash = format!("{:x}", hash.finalize());
    }
    let after = node(&file)?;
    if before.identity != after.identity
        || before.length != after.length
        || before.modified != after.modified
    {
        return Err("源项目读取期间已发生变化".into());
    }
    checked_path(path)?;
    let relative = path
        .strip_prefix(root)
        .map_err(|error| error.to_string())?
        .to_str()
        .ok_or("文件名无法表示")?
        .to_owned();
    entries.insert(relative, before);
    Ok(())
}
impl Tree {
    pub(super) fn root_only(&self) -> Result<Self, String> {
        Ok(Self(BTreeMap::from([(
            String::new(),
            self.0.get("").ok_or("缺少根项目身份")?.clone(),
        )])))
    }
    pub(super) fn same_root_identity(&self, other: &Tree) -> bool {
        self.0
            .get("")
            .zip(other.0.get(""))
            .is_some_and(|(left, right)| {
                left.identity == right.identity && left.directory == right.directory
            })
    }
    pub(super) fn legacy_identity(&self) -> Result<(f64, f64), String> {
        let root = self.0.get("").ok_or("缺少根项目身份")?;
        #[cfg(windows)]
        {
            let fields: Vec<u64> = root
                .identity
                .split(':')
                .map(str::parse)
                .collect::<Result<_, _>>()
                .map_err(|_| "文件身份格式无效")?;
            if fields.len() != 5 {
                return Err("文件身份格式无效".into());
            }
            let inode = (fields[1] << 32) | fields[2];
            let birth = (fields[3] << 32) | fields[4];
            let ticks = birth as i128 - 116444736000000000i128;
            Ok((
                inode as f64,
                ticks.div_euclid(10000000) as f64 * 1000.0
                    + ticks.rem_euclid(10000000) as f64 / 10000.0,
            ))
        }
        #[cfg(not(windows))]
        {
            let _ = root;
            Err("当前平台尚未实现旧版文件身份兼容".into())
        }
    }
    pub fn validate(&self) -> Result<(), String> {
        let root = self.0.get("").ok_or("日志缺少根项目身份")?;
        for (relative, node) in &self.0 {
            if !relative.is_empty()
                && Path::new(relative)
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
            {
                return Err("恢复日志包含越界路径".into());
            }
            if relative.contains(':')
                || relative.chars().any(|character| character as u32 == 0)
                || node.identity.is_empty()
            {
                return Err("恢复日志文件信息无效".into());
            }
            if !relative.is_empty() && !root.directory {
                return Err("普通文件日志不能包含后代".into());
            }
            if !relative.is_empty() {
                let parent = Path::new(relative)
                    .parent()
                    .and_then(Path::to_str)
                    .ok_or("日志父目录无效")?;
                if !self.0.get(parent).is_some_and(|node| node.directory) {
                    return Err("日志缺少父目录".into());
                }
            }
            if !node.directory
                && (node.hash.len() != 64
                    || !node.hash.bytes().all(|byte| byte.is_ascii_hexdigit()))
            {
                return Err("日志缺少内容摘要".into());
            }
        }
        Ok(())
    }
    pub fn read(root: &Path) -> Result<Self, String> {
        let mut entries = BTreeMap::new();
        visit(root, root, &mut entries, 0)?;
        Ok(Self(entries))
    }
    pub fn matches(&self, path: &Path) -> bool {
        Self::read(path).is_ok_and(|current| current == *self)
    }
    pub(super) fn same_content(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self.0.iter().all(|(path, node)| {
                other.0.get(path).is_some_and(|target| {
                    node.directory == target.directory
                        && node.length == target.length
                        && node.hash == target.hash
                })
            })
    }
    pub fn remove_exact(&self, root: &Path) -> Result<(), String> {
        if !self.matches(root) {
            return Err("文件内容或身份已变化，拒绝删除".into());
        }
        let mut paths: Vec<_> = self.0.iter().collect();
        paths.sort_by_key(|(path, _)| std::cmp::Reverse(Path::new(path).components().count()));
        for (relative, expected) in paths {
            let path = if relative.is_empty() {
                root.to_owned()
            } else {
                root.join(relative)
            };
            checked_path(&path)?;
            let current = node(&open(&path)?)?;
            if current.identity != expected.identity
                || (!expected.directory
                    && (current.length != expected.length || current.modified != expected.modified))
            {
                return Err("清理期间文件已变化，完整副本已保留".into());
            }
            if expected.directory {
                fs::remove_dir(&path)
            } else {
                fs::remove_file(&path)
            }
            .map_err(|error| format!("源清理失败，完整副本已保留：{error}"))?;
        }
        Ok(())
    }
}
pub fn exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}
pub fn rename(source: &Path, target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::{
            core::PCWSTR,
            Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH},
        };
        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let target: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
        unsafe {
            MoveFileExW(
                PCWSTR(source.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
            .map_err(|error| {
                std::io::Error::from_raw_os_error((error.code().0 as u32 & 0xffff) as i32)
            })
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (source, target);
        Err(std::io::Error::new(
            std::io::ErrorKind::Unsupported,
            "当前平台不支持原子不覆盖移动",
        ))
    }
}
pub fn different_volume(error: &std::io::Error) -> bool {
    error.raw_os_error() == Some(17)
}
pub fn copy(source: &Path, target: &Path, expected: &Tree) -> Result<Tree, String> {
    for (relative, entry) in &expected.0 {
        let source = if relative.is_empty() {
            source.to_owned()
        } else {
            source.join(relative)
        };
        let target = if relative.is_empty() {
            target.to_owned()
        } else {
            target.join(relative)
        };
        checked_path(&source)?;
        checked_path(&target)?;
        if entry.directory {
            fs::create_dir(&target).map_err(|error| error.to_string())?;
        } else {
            let mut input = open(&source)?;
            let mut output = OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&target)
                .map_err(|error| error.to_string())?;
            let count =
                std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
            if count != entry.length {
                return Err("复制期间源文件大小发生变化".into());
            }
            output
                .flush()
                .and_then(|_| output.sync_all())
                .map_err(|error| error.to_string())?;
        }
    }
    let actual = Tree::read(target)?;
    if !expected.same_content(&actual) || !expected.matches(source) {
        return Err("跨卷复制校验失败，源项目已保留".into());
    }
    Ok(actual)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Paths {
    pub desktop: PathBuf,
    pub organizer: PathBuf,
}
impl Paths {
    pub fn validate(&self, path: &Path) -> Result<(), String> {
        let key = crate::system::path_key(path.to_str().ok_or("路径无效")?)?;
        let parent = Path::new(&key).parent().ok_or("不能移动根目录")?;
        let desktop = crate::system::path_key(self.desktop.to_str().ok_or("桌面路径无效")?)?;
        let organizer = crate::system::path_key(self.organizer.to_str().ok_or("收纳路径无效")?)?;
        let under_organizer = Path::new(&key)
            .strip_prefix(Path::new(&organizer))
            .is_ok_and(|relative| relative.components().count() >= 2);
        if parent != Path::new(&desktop) && !under_organizer {
            return Err("只能移动桌面直属项目或受管分类项目".into());
        }
        if [desktop.as_str(), organizer.as_str()]
            .iter()
            .any(|root| Path::new(root).strip_prefix(Path::new(&key)).is_ok())
        {
            return Err("不允许移动根目录或包含受管根目录的项目".into());
        }
        checked_path(&self.desktop)?;
        checked_path(&self.organizer)?;
        checked_path(path)?;
        Ok(())
    }
}
