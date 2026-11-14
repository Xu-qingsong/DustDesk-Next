use super::{
    active, collect, confirm_inventory, digest_file, failure, validate, Directory, Entry, FilePin,
    Inventory, Manifest, Pin,
};
use chrono::{SecondsFormat, Utc};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

pub(crate) struct PreparedData {
    root: Arc<Directory>,
    manifest: Manifest,
    inventory: Inventory,
}

impl PreparedData {
    pub(super) fn root(&self) -> &Arc<Directory> {
        &self.root
    }

    pub(super) fn into_root(self) -> Arc<Directory> {
        self.root
    }

    pub(super) fn create(
        source: &Manifest,
        files: &mut [super::target::File],
        destination: &Path,
        id: &str,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, current)?;
        validate(source)?;
        if !uuid::Uuid::parse_str(id)
            .is_ok_and(|parsed| parsed.get_version_num() == 4 && parsed.to_string() == id)
        {
            return Err("运行目录准备 ID 无效".into());
        }
        let parent = Directory::open(destination.parent().ok_or("运行目录必须有父目录")?)
            .map_err(|error| failure("固定运行目录父目录", destination, error))?;
        let name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("运行目录名无效")?;
        if crate::lan::protocol::path_key(name)?.contains('/') {
            return Err("运行目录名必须为单个目录名".into());
        }
        active(cancel, current)?;
        fs::create_dir(parent.path().join(name))
            .map_err(|error| failure("独占创建运行目录", destination, error))?;
        let root = parent
            .child(name, false)
            .map_err(|error| error.to_string())?;
        let mut inventory = Inventory {
            entries: BTreeMap::new(),
            excluded: Vec::new(),
            bytes: 0,
            path_bytes: 0,
        };
        let mut entries = Vec::with_capacity(source.entries.len());
        let mut objects = files.iter_mut();
        for entry in &source.entries {
            active(cancel, current)?;
            let path = entry.path();
            let (parent, name) = root
                .parent_for(path, false)
                .map_err(|error| failure("固定运行子目录", root.path(), error))?;
            inventory.path_bytes += path.len();
            match entry {
                Entry::Directory { .. } => {
                    fs::create_dir(parent.path().join(&name)).map_err(|error| {
                        failure("独占创建运行子目录", &parent.path().join(&name), error)
                    })?;
                    let directory = parent
                        .child(&name, false)
                        .map_err(|error| error.to_string())?;
                    entries.push(Entry::Directory {
                        path: path.to_owned(),
                        identity: directory.identity().map_err(|error| error.to_string())?,
                    });
                    inventory
                        .entries
                        .insert(path.to_owned(), Pin::Directory(directory));
                }
                Entry::File {
                    stamp,
                    object,
                    sha256,
                    read_only,
                    ..
                } => {
                    let original = objects.next().ok_or("已固定快照对象数量不匹配")?;
                    let mut file = parent.create(&name).map_err(|error| {
                        failure("独占创建运行文件", &parent.path().join(&name), error)
                    })?;
                    original.copy_to(&mut file, cancel, current)?;
                    file.set_source_metadata(&stamp.modified, *read_only)
                        .and_then(|_| file.sync())
                        .map_err(|error| failure("恢复运行文件元数据", &file.path(), error))?;
                    let observed = file.source_stamp().map_err(|error| error.to_string())?;
                    if observed.size != stamp.size || observed.modified != stamp.modified {
                        return Err("运行目录原始大小或写入时间恢复不一致".into());
                    }
                    entries.push(Entry::File {
                        path: path.to_owned(),
                        stamp: observed.clone(),
                        object: *object,
                        sha256: sha256.clone(),
                        read_only: *read_only,
                    });
                    inventory.bytes += observed.size;
                    inventory.entries.insert(
                        path.to_owned(),
                        Pin::File(FilePin {
                            file,
                            stamp: observed,
                            read_only: *read_only,
                        }),
                    );
                }
            }
        }
        if objects.next().is_some() {
            return Err("已固定快照对象数量不匹配".into());
        }
        let manifest = Manifest {
            format: source.format.clone(),
            version: source.version,
            id: id.to_owned(),
            created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            app_version: source.app_version.clone(),
            source_path: root
                .path()
                .to_str()
                .ok_or("运行目录路径不是有效 Unicode")?
                .to_owned(),
            source_identity: root.identity().map_err(|error| error.to_string())?,
            workspace_sha256: source.workspace_sha256.clone(),
            excluded_runtime_files: Vec::new(),
            entries,
        };
        require_origin(&manifest, source)?;
        let mut prepared = Self {
            root,
            manifest,
            inventory,
        };
        prepared.verify(cancel, current)?;
        Ok(prepared)
    }

    pub(crate) fn capture(
        manifest: Manifest,
        source: &Manifest,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, current)?;
        require_origin(&manifest, source)?;
        let root =
            Directory::open(Path::new(&manifest.source_path)).map_err(|error| error.to_string())?;
        let mut inventory = Inventory {
            entries: BTreeMap::new(),
            excluded: Vec::new(),
            bytes: 0,
            path_bytes: 0,
        };
        collect(
            &root,
            "",
            &mut inventory,
            &mut HashSet::new(),
            cancel,
            current,
        )?;
        if !inventory.excluded.is_empty() {
            return Err("运行准备目录不能包含运行锁".into());
        }
        let mut prepared = Self {
            root,
            manifest,
            inventory,
        };
        prepared.verify(cancel, current)?;
        Ok(prepared)
    }

    pub(crate) fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub(crate) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        if self.root.identity().map_err(|error| error.to_string())? != self.manifest.source_identity
        {
            return Err("运行准备目录物理身份已变化".into());
        }
        let mut seen = HashSet::new();
        confirm_inventory(&self.root, "", &self.inventory, &mut seen, cancel, current)?;
        if seen.len() != self.inventory.entries.len() {
            return Err("运行准备目录存在缺失条目".into());
        }
        active(cancel, current)
    }

    pub(crate) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, current)?;
        if self.inventory.entries.len() != self.manifest.entries.len() {
            return Err("运行准备目录条目集合不匹配".into());
        }
        for entry in &self.manifest.entries {
            active(cancel, current)?;
            match (entry, self.inventory.entries.get_mut(entry.path())) {
                (Entry::Directory { identity, .. }, Some(Pin::Directory(directory))) => {
                    if directory.identity().map_err(|error| error.to_string())? != *identity {
                        return Err("运行准备子目录物理身份不匹配".into());
                    }
                }
                (
                    Entry::File {
                        stamp,
                        sha256,
                        read_only,
                        ..
                    },
                    Some(Pin::File(file)),
                ) => {
                    if &file.stamp != stamp || file.read_only != *read_only {
                        return Err("运行准备文件身份、大小、时间或只读属性不匹配".into());
                    }
                    if digest_file(&mut file.file, stamp.size, cancel, current)? != *sha256 {
                        return Err("运行准备文件完整摘要不匹配".into());
                    }
                }
                _ => return Err("运行准备文件类型或路径不匹配".into()),
            }
        }
        self.confirm(cancel, current)
    }
}

pub(super) fn require_origin(manifest: &Manifest, source: &Manifest) -> Result<(), String> {
    validate(manifest)?;
    if manifest.app_version != source.app_version
        || manifest.workspace_sha256 != source.workspace_sha256
        || manifest.source_identity == source.source_identity
        || !manifest.excluded_runtime_files.is_empty()
        || manifest.entries.len() != source.entries.len()
    {
        return Err("运行准备清单不属于已固定的完整快照".into());
    }
    for (entry, original) in manifest.entries.iter().zip(&source.entries) {
        let matched = match (entry, original) {
            (Entry::Directory { path, .. }, Entry::Directory { path: original, .. }) => {
                path == original
            }
            (
                Entry::File {
                    path,
                    stamp,
                    object,
                    sha256,
                    read_only,
                },
                Entry::File {
                    path: original,
                    stamp: original_stamp,
                    object: original_object,
                    sha256: original_sha256,
                    read_only: original_read_only,
                },
            ) => {
                path == original
                    && stamp.size == original_stamp.size
                    && stamp.modified == original_stamp.modified
                    && object == original_object
                    && sha256 == original_sha256
                    && read_only == original_read_only
            }
            _ => false,
        };
        if !matched {
            return Err("运行准备清单改变了快照的路径、类型、原字节或元数据".into());
        }
    }
    Ok(())
}
