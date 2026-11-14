use crate::lan::{
    files::{Directory, FileIdentity, OwnedFile, SourceStamp},
    protocol,
};
use chrono::{SecondsFormat, Utc};
use serde::{
    de::{SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

pub mod bundle;
pub mod drafts;
pub mod preparation;
pub(crate) mod runtime_data;
pub(crate) mod source;
pub(crate) mod target;

const MAX_ENTRIES: usize = 65_536;
const MAX_PATH_BYTES: usize = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES: usize = 64 * 1024 * 1024;
const MAX_WORKSPACE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 1024 * 1024 * 1024 * 1024;
const MANIFEST: &str = "snapshot.json";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub created_at: String,
    pub app_version: String,
    pub source_path: String,
    pub source_identity: FileIdentity,
    pub workspace_sha256: String,
    #[serde(deserialize_with = "deserialize_excluded")]
    pub excluded_runtime_files: Vec<String>,
    #[serde(deserialize_with = "deserialize_entries")]
    pub entries: Vec<Entry>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(
    deny_unknown_fields,
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum Entry {
    Directory {
        path: String,
        identity: FileIdentity,
    },
    File {
        path: String,
        stamp: SourceStamp,
        object: u32,
        sha256: String,
        read_only: bool,
    },
}
impl Entry {
    fn path(&self) -> &str {
        match self {
            Self::Directory { path, .. } | Self::File { path, .. } => path,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub manifest_sha256: String,
    pub destination_identity: FileIdentity,
    pub source_identity: FileIdentity,
    pub workspace_sha256: String,
    pub files: usize,
    pub directories: usize,
    pub total_bytes: u64,
}

struct FilePin {
    file: OwnedFile,
    stamp: SourceStamp,
    read_only: bool,
}
enum Pin {
    Directory(Arc<Directory>),
    File(FilePin),
}
struct Inventory {
    entries: BTreeMap<String, Pin>,
    excluded: Vec<String>,
    bytes: u64,
    path_bytes: usize,
}

pub(crate) fn bounded_list<'de, Data, Item, const LIMIT: usize>(
    data: Data,
) -> Result<Vec<Item>, Data::Error>
where
    Data: Deserializer<'de>,
    Item: Deserialize<'de>,
{
    struct List<Item, const LIMIT: usize>(std::marker::PhantomData<Item>);
    impl<'de, Item: Deserialize<'de>, const LIMIT: usize> Visitor<'de> for List<Item, LIMIT> {
        type Value = Vec<Item>;
        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            write!(formatter, "at most {LIMIT} snapshot list entries")
        }
        fn visit_seq<Sequence: SeqAccess<'de>>(
            self,
            mut sequence: Sequence,
        ) -> Result<Self::Value, Sequence::Error> {
            let mut result = Vec::new();
            while let Some(item) = sequence.next_element()? {
                if result.len() == LIMIT {
                    return Err(serde::de::Error::custom("快照列表条目超限，未继续分配"));
                }
                result.push(item);
            }
            Ok(result)
        }
    }
    data.deserialize_seq(List::<Item, LIMIT>(std::marker::PhantomData))
}
fn deserialize_entries<'de, Data: Deserializer<'de>>(
    data: Data,
) -> Result<Vec<Entry>, Data::Error> {
    bounded_list::<Data, Entry, MAX_ENTRIES>(data)
}
fn deserialize_excluded<'de, Data: Deserializer<'de>>(
    data: Data,
) -> Result<Vec<String>, Data::Error> {
    bounded_list::<Data, String, 1>(data)
}

fn failure(operation: &str, path: &Path, error: impl std::fmt::Display) -> String {
    format!("迁移快照{operation}失败（{}）：{error}", path.display())
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn active(
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("迁移快照已取消，未授权接管".into());
    }
    require_active()
}
fn relative_key(path: &str) -> Result<String, String> {
    if path.encode_utf16().count() > 32_767 || path.split('/').count() > 128 {
        return Err("快照相对路径过长".into());
    }
    path.split('/')
        .map(protocol::path_key)
        .collect::<Result<Vec<_>, _>>()
        .map(|parts| parts.join("/"))
}
fn object_name(index: u32) -> String {
    format!("{index:06}.bin")
}
fn digest_file(
    file: &mut OwnedFile,
    size: u64,
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    if file.size().map_err(|error| error.to_string())? != size {
        return Err("快照文件大小不匹配".into());
    }
    file.seek(0).map_err(|error| error.to_string())?;
    let mut digest = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        active(cancel, require_active)?;
        let count = file
            .read_chunk(&mut buffer, cancel)
            .map_err(|error| failure("核验文件", &file.path(), error))?;
        if count == 0 {
            break;
        }
        copied = copied
            .checked_add(count as u64)
            .filter(|total| *total <= size)
            .ok_or("快照文件大小已变化")?;
        digest.update(&buffer[..count]);
    }
    if copied != size {
        return Err("快照文件被截断".into());
    }
    file.require_single_link()
        .map_err(|error| error.to_string())?;
    Ok(format!("{:x}", digest.finalize()))
}
fn names(directory: &Arc<Directory>) -> Result<Vec<String>, String> {
    let mut result = fs::read_dir(directory.path())
        .map_err(|error| failure("枚举", directory.path(), error))?
        .take(MAX_ENTRIES + 2)
        .map(|entry| {
            entry
                .map_err(|error| failure("枚举", directory.path(), error))?
                .file_name()
                .into_string()
                .map_err(|_| "快照文件名不是有效 Unicode，未忽略该文件".to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    if result.len() > MAX_ENTRIES + 1 {
        return Err("快照目录条目过多，未截断".into());
    }
    result.sort();
    Ok(result)
}
fn is_directory(directory: &Arc<Directory>, name: &str) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;
    let path = directory.path().join(name);
    let metadata =
        fs::symlink_metadata(&path).map_err(|error| failure("检查文件", &path, error))?;
    if metadata.file_attributes() & 0x400 != 0 || (!metadata.is_dir() && !metadata.is_file()) {
        return Err(failure("检查文件", &path, "拒绝重解析点或特殊文件"));
    }
    Ok(metadata.is_dir())
}
fn collect(
    directory: &Arc<Directory>,
    prefix: &str,
    inventory: &mut Inventory,
    keys: &mut HashSet<String>,
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if prefix.split('/').count() > 128 {
        return Err("快照目录层级超过 128，未截断".into());
    }
    for name in names(directory)? {
        active(cancel, require_active)?;
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        let key = relative_key(&relative)?;
        if !keys.insert(key.clone()) {
            return Err("快照含大小写冲突路径，未覆盖或合并".into());
        }
        let directory_entry = is_directory(directory, &name)?;
        if key == "workspace.lock" {
            if directory_entry {
                return Err("工作区运行锁不是普通文件，未忽略该目录".into());
            }
            inventory.excluded.push(name);
            continue;
        }
        inventory.path_bytes = inventory
            .path_bytes
            .checked_add(relative.len())
            .ok_or("快照路径总量溢出")?;
        if inventory.entries.len() >= MAX_ENTRIES || inventory.path_bytes > MAX_PATH_BYTES {
            return Err("快照文件数量或路径总量超过上限，未截断".into());
        }
        if directory_entry {
            let child = directory
                .child(&name, false)
                .map_err(|error| failure("固定目录", &directory.path().join(&name), error))?;
            inventory
                .entries
                .insert(relative.clone(), Pin::Directory(child.clone()));
            collect(&child, &relative, inventory, keys, cancel, require_active)?;
        } else {
            let file = if relative == "workspace.json" {
                directory.read_shared(&name)
            } else {
                directory.read(&name)
            }
            .map_err(|error| failure("固定文件", &directory.path().join(&name), error))?;
            let stamp = file
                .source_stamp()
                .map_err(|error| failure("读取身份", &file.path(), error))?;
            inventory.bytes = inventory
                .bytes
                .checked_add(stamp.size)
                .filter(|total| *total <= MAX_TOTAL_BYTES)
                .ok_or("快照总量超过 1 TiB，未截断")?;
            let read_only = fs::metadata(file.path())
                .map_err(|error| failure("读取属性", &file.path(), error))?
                .permissions()
                .readonly();
            inventory.entries.insert(
                relative,
                Pin::File(FilePin {
                    file,
                    stamp,
                    read_only,
                }),
            );
        }
    }
    Ok(())
}
fn confirm_inventory(
    directory: &Arc<Directory>,
    prefix: &str,
    inventory: &Inventory,
    seen: &mut HashSet<String>,
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    for name in names(directory)? {
        active(cancel, require_active)?;
        let relative = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{prefix}/{name}")
        };
        if prefix.is_empty() && inventory.excluded.contains(&name) {
            if is_directory(directory, &name)? {
                return Err("工作区运行锁类型已变化".into());
            }
            continue;
        }
        let pin = inventory
            .entries
            .get(&relative)
            .ok_or("快照源目录内容已变化，未发布完成记录")?;
        seen.insert(relative.clone());
        match pin {
            Pin::Directory(original) => {
                let current = directory
                    .child(&name, false)
                    .map_err(|error| failure("复核目录", &directory.path().join(&name), error))?;
                if current.identity().map_err(|error| error.to_string())?
                    != original.identity().map_err(|error| error.to_string())?
                {
                    return Err("快照源目录身份已变化".into());
                }
                confirm_inventory(&current, &relative, inventory, seen, cancel, require_active)?;
            }
            Pin::File(original) => {
                original
                    .file
                    .require_single_link()
                    .map_err(|error| failure("复核文件", &original.file.path(), error))?;
                if original
                    .file
                    .source_stamp()
                    .map_err(|error| error.to_string())?
                    != original.stamp
                    || fs::metadata(original.file.path())
                        .map_err(|error| error.to_string())?
                        .permissions()
                        .readonly()
                        != original.read_only
                {
                    return Err("快照源文件在复制期间变化".into());
                }
            }
        }
    }
    Ok(())
}

pub fn prepare(
    source: &Path,
    destination: &Path,
    workspace_sha256: &str,
    cancel: &CancellationToken,
    require_active: impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    active(cancel, &require_active)?;
    if !valid_hash(workspace_sha256) {
        return Err("快照必须使用原生工作区 SHA-256 检查点".into());
    }
    let source = Directory::open(source).map_err(|error| failure("固定源目录", source, error))?;
    let source_identity = source.identity().map_err(|error| error.to_string())?;
    let parent_path = destination.parent().ok_or("快照目标必须有父目录")?;
    let parent = Directory::open(parent_path)
        .map_err(|error| failure("固定目标父目录", parent_path, error))?;
    if parent
        .contains_identity(&source_identity)
        .map_err(|error| error.to_string())?
    {
        return Err("不能把快照放在源数据目录内部".into());
    }
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("快照目标目录名无效")?;
    if protocol::path_key(name)?.contains('/') {
        return Err("快照目标必须是单个目录名".into());
    }
    let mut inventory = Inventory {
        entries: BTreeMap::new(),
        excluded: Vec::new(),
        bytes: 0,
        path_bytes: 0,
    };
    collect(
        &source,
        "",
        &mut inventory,
        &mut HashSet::new(),
        cancel,
        &require_active,
    )?;
    let Some(Pin::File(workspace)) = inventory.entries.get_mut("workspace.json") else {
        return Err("快照源缺少普通 workspace.json".into());
    };
    if workspace.stamp.size > MAX_WORKSPACE_BYTES
        || digest_file(
            &mut workspace.file,
            workspace.stamp.size,
            cancel,
            &require_active,
        )? != workspace_sha256
    {
        return Err("快照源与原生工作区检查点不一致".into());
    }
    active(cancel, &require_active)?;
    fs::create_dir(parent.path().join(name))
        .map_err(|error| failure("创建独占目标", destination, error))?;
    let output = parent
        .child(name, false)
        .map_err(|error| failure("固定目标", destination, error))?;
    let objects = output
        .child("objects", true)
        .map_err(|error| error.to_string())?;
    let mut entries = Vec::with_capacity(inventory.entries.len());
    let mut files = 0_u32;
    for (path, pin) in &mut inventory.entries {
        active(cancel, &require_active)?;
        match pin {
            Pin::Directory(directory) => entries.push(Entry::Directory {
                path: path.clone(),
                identity: directory.identity().map_err(|error| error.to_string())?,
            }),
            Pin::File(original) => {
                original.file.seek(0).map_err(|error| error.to_string())?;
                let mut target = objects
                    .create(&object_name(files))
                    .map_err(|error| failure("创建对象", objects.path(), error))?;
                let mut digest = Sha256::new();
                let mut copied = 0_u64;
                let mut buffer = [0_u8; 64 * 1024];
                loop {
                    active(cancel, &require_active)?;
                    let count = original
                        .file
                        .read_chunk(&mut buffer, cancel)
                        .map_err(|error| failure("复制源文件", &original.file.path(), error))?;
                    if count == 0 {
                        break;
                    }
                    copied = copied
                        .checked_add(count as u64)
                        .filter(|total| *total <= original.stamp.size)
                        .ok_or("快照源文件大小已变化")?;
                    target
                        .write_all(&buffer[..count])
                        .map_err(|error| failure("写入对象", &target.path(), error))?;
                    digest.update(&buffer[..count]);
                }
                if copied != original.stamp.size {
                    return Err("快照源文件被截断".into());
                }
                target
                    .sync()
                    .map_err(|error| failure("刷新对象", &target.path(), error))?;
                let sha256 = format!("{:x}", digest.finalize());
                if digest_file(&mut target, copied, cancel, &require_active)? != sha256 {
                    return Err("快照对象落盘摘要不匹配".into());
                }
                entries.push(Entry::File {
                    path: path.clone(),
                    stamp: original.stamp.clone(),
                    object: files,
                    sha256,
                    read_only: original.read_only,
                });
                files += 1;
            }
        }
    }
    let mut seen = HashSet::new();
    confirm_inventory(&source, "", &inventory, &mut seen, cancel, &require_active)?;
    if seen.len() != inventory.entries.len() {
        return Err("快照源文件列表已变化".into());
    }
    let manifest = Manifest {
        format: "dustdesk-managed-data-snapshot".into(),
        version: 1,
        id: Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        app_version: env!("CARGO_PKG_VERSION").into(),
        source_path: source
            .path()
            .to_str()
            .ok_or("源路径不是有效 Unicode")?
            .into(),
        source_identity: source_identity.clone(),
        workspace_sha256: workspace_sha256.into(),
        excluded_runtime_files: inventory.excluded,
        entries,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err("快照清单超过 64 MiB，未截断或发布".into());
    }
    active(cancel, &require_active)?;
    let mut publication = output
        .create(&format!("manifest-{}.part", manifest.id))
        .map_err(|error| error.to_string())?;
    publication
        .write_all(&bytes)
        .and_then(|_| publication.sync())
        .map_err(|error| failure("刷新清单", &publication.path(), error))?;
    active(cancel, &require_active)?;
    publication
        .publish(&output, MANIFEST)
        .map_err(|error| failure("发布清单", output.path(), error))?;
    drop(publication);
    let manifest_sha256 = hash(&bytes);
    verify_active(
        output.path(),
        &manifest_sha256,
        None,
        cancel,
        &require_active,
    )?;
    active(cancel, &require_active)?;
    Ok(Receipt {
        id: manifest.id,
        manifest_sha256,
        destination_identity: output.identity().map_err(|error| error.to_string())?,
        source_identity,
        workspace_sha256: workspace_sha256.into(),
        files: files as usize,
        directories: manifest.entries.len() - files as usize,
        total_bytes: inventory.bytes,
    })
}

pub fn verify(
    destination: &Path,
    manifest_sha256: &str,
    cancel: &CancellationToken,
) -> Result<Manifest, String> {
    verify_active(destination, manifest_sha256, None, cancel, &|| Ok(()))
}
pub fn verify_receipt(
    destination: &Path,
    receipt: &Receipt,
    cancel: &CancellationToken,
) -> Result<Manifest, String> {
    let manifest = verify_active(
        destination,
        &receipt.manifest_sha256,
        Some(&receipt.destination_identity),
        cancel,
        &|| Ok(()),
    )?;
    let mut files = 0;
    let mut total_bytes = 0;
    for entry in &manifest.entries {
        if let Entry::File { stamp, .. } = entry {
            files += 1;
            total_bytes += stamp.size;
        }
    }
    if manifest.id != receipt.id
        || manifest.source_identity != receipt.source_identity
        || manifest.workspace_sha256 != receipt.workspace_sha256
        || files != receipt.files
        || manifest.entries.len() - files != receipt.directories
        || total_bytes != receipt.total_bytes
    {
        return Err("快照内容与原生保存的回执不匹配".into());
    }
    Ok(manifest)
}
fn verify_active(
    destination: &Path,
    manifest_sha256: &str,
    expected_identity: Option<&FileIdentity>,
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<Manifest, String> {
    let root = Directory::open(destination)
        .map_err(|error| failure("固定快照目录", destination, error))?;
    target::Data::capture(
        root,
        manifest_sha256,
        expected_identity,
        cancel,
        require_active,
    )
    .map(|target| target.manifest)
}

fn validate(manifest: &Manifest) -> Result<(), String> {
    let uuid = Uuid::parse_str(&manifest.id).map_err(|_| "快照 ID 无效")?;
    let excluded_valid = manifest.excluded_runtime_files.is_empty()
        || (manifest.excluded_runtime_files.len() == 1
            && protocol::path_key(&manifest.excluded_runtime_files[0])
                .is_ok_and(|key| key == "workspace.lock"));
    let version_valid = manifest
        .app_version
        .as_bytes()
        .first()
        .is_some_and(u8::is_ascii_digit)
        && manifest.app_version.len() <= 100
        && manifest
            .app_version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte));
    if manifest.format != "dustdesk-managed-data-snapshot"
        || manifest.version != 1
        || uuid.get_version_num() != 4
        || uuid.get_variant() != uuid::Variant::RFC4122
        || uuid.to_string() != manifest.id
        || chrono::DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
        || !version_valid
        || !valid_hash(&manifest.workspace_sha256)
        || manifest.entries.len() > MAX_ENTRIES
        || !Path::new(&manifest.source_path).is_absolute()
        || !excluded_valid
    {
        return Err("快照头部无效或不受此版本支持".into());
    }
    let mut keys = HashSet::new();
    let mut directories = HashSet::new();
    let mut path_bytes = 0_usize;
    let mut total_bytes = 0_u64;
    let mut next_object = 0_u32;
    let mut previous: Option<&str> = None;
    let mut workspace = false;
    for entry in &manifest.entries {
        let path = entry.path();
        let key = relative_key(path)?;
        if key == "workspace.lock"
            || !keys.insert(key.clone())
            || previous.is_some_and(|previous| previous >= path)
        {
            return Err("快照路径重复、乱序或占用运行锁".into());
        }
        path_bytes = path_bytes
            .checked_add(path.len())
            .filter(|size| *size <= MAX_PATH_BYTES)
            .ok_or("快照路径总量超过上限")?;
        if let Some((parent, _)) = key.rsplit_once('/') {
            if !directories.contains(parent) {
                return Err("快照路径缺少父目录或父路径为文件".into());
            }
        }
        match entry {
            Entry::Directory { .. } => {
                directories.insert(key);
            }
            Entry::File {
                stamp,
                object,
                sha256,
                ..
            } => {
                if *object != next_object
                    || !valid_hash(sha256)
                    || stamp.modified.len() != 16
                    || !u64::from_str_radix(&stamp.modified, 16)
                        .is_ok_and(|value| format!("{value:016x}") == stamp.modified)
                {
                    return Err("快照对象编号、摘要或时间无效".into());
                }
                total_bytes = total_bytes
                    .checked_add(stamp.size)
                    .filter(|total| *total <= MAX_TOTAL_BYTES)
                    .ok_or("快照总量超过上限")?;
                next_object += 1;
                if path == "workspace.json" {
                    workspace =
                        stamp.size <= MAX_WORKSPACE_BYTES && sha256 == &manifest.workspace_sha256;
                }
            }
        }
        previous = Some(path);
    }
    if !workspace {
        return Err("快照工作区与检查点不匹配".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests;
