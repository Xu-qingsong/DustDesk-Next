use super::{
    active, collect, confirm_inventory, digest_file, validate, Directory, Entry, HashSet,
    Inventory, Manifest, Pin,
};
use std::{collections::BTreeMap, sync::Arc};
use tokio_util::sync::CancellationToken;

pub(crate) struct SourceInventory {
    root: Arc<Directory>,
    inventory: Inventory,
    manifest: Manifest,
}

#[cfg(test)]
mod tests;

impl SourceInventory {
    /// Copy from the actual retained handles. Reopening a path would conflict
    /// with exclusive asset pins and would introduce another source identity.
    pub(crate) fn materialize(
        &mut self,
        destination: &std::path::Path,
        id: &str,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<super::runtime_data::PreparedData, String> {
        self.verify(cancel, current)?;
        let mut files = Vec::new();
        for entry in &self.manifest.entries {
            if let Entry::File { path, sha256, .. } = entry {
                let Some(Pin::File(pin)) = self.inventory.entries.get(path) else {
                    return Err("应用副本缺少已固定的源文件".into());
                };
                files.push(super::target::File::capture(
                    pin.file.duplicate().map_err(|error| error.to_string())?,
                    sha256.clone(),
                )?);
            }
        }
        let data = super::runtime_data::PreparedData::create(
            &self.manifest,
            &mut files,
            destination,
            id,
            cancel,
            current,
        )?;
        self.verify(cancel, current)?;
        Ok(data)
    }

    /// Seal the latest owned Data, including new assets and empty directories.
    /// The old migration manifest is deliberately not the expected inventory.
    pub(crate) fn capture_current(
        root: Arc<Directory>,
        workspace_sha256: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, &current)?;
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
            &current,
        )?;
        let mut entries = Vec::with_capacity(inventory.entries.len());
        let mut object = 0;
        for (path, pin) in &mut inventory.entries {
            active(cancel, &current)?;
            entries.push(match pin {
                Pin::Directory(directory) => Entry::Directory {
                    path: path.clone(),
                    identity: directory.identity().map_err(|error| error.to_string())?,
                },
                Pin::File(file) => {
                    let entry = Entry::File {
                        path: path.clone(),
                        stamp: file.stamp.clone(),
                        object,
                        sha256: digest_file(&mut file.file, file.stamp.size, cancel, &current)?,
                        read_only: file.read_only,
                    };
                    object += 1;
                    entry
                }
            });
        }
        let manifest = Manifest {
            format: "dustdesk-managed-data-snapshot".into(),
            version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            created_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
            app_version: env!("CARGO_PKG_VERSION").into(),
            source_path: root
                .path()
                .to_str()
                .ok_or("运行 Data 路径不是 Unicode")?
                .into(),
            source_identity: root.identity().map_err(|error| error.to_string())?,
            workspace_sha256: workspace_sha256.into(),
            excluded_runtime_files: inventory.excluded.clone(),
            entries,
        };
        validate(&manifest)?;
        let pinned = Self {
            root,
            inventory,
            manifest,
        };
        pinned.confirm(cancel, current)?;
        Ok(pinned)
    }

    pub(crate) fn manifest(&self) -> &Manifest {
        &self.manifest
    }

    pub(crate) fn capture(
        root: Arc<Directory>,
        manifest: Manifest,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, &current)?;
        validate(&manifest)?;
        if root.identity().map_err(|error| error.to_string())? != manifest.source_identity {
            return Err("活源资产清单不属于当前物理工作区".into());
        }
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
            &current,
        )?;
        let mut pinned = Self {
            root,
            inventory,
            manifest,
        };
        pinned.verify(cancel, current)?;
        Ok(pinned)
    }

    pub(crate) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, &current)?;
        if self.inventory.entries.len() != self.manifest.entries.len() {
            return Err("活源资产文件或目录集合与已准备快照不一致".into());
        }
        for entry in &self.manifest.entries {
            active(cancel, &current)?;
            let pin = self
                .inventory
                .entries
                .get_mut(entry.path())
                .ok_or("活源资产路径与已准备快照不一致")?;
            match (entry, pin) {
                (Entry::Directory { identity, .. }, Pin::Directory(directory)) => {
                    if directory.identity().map_err(|error| error.to_string())? != *identity {
                        return Err("活源资产目录身份与已准备快照不一致".into());
                    }
                }
                (
                    Entry::File {
                        stamp,
                        sha256,
                        read_only,
                        ..
                    },
                    Pin::File(original),
                ) => {
                    if &original.stamp != stamp || original.read_only != *read_only {
                        return Err(
                            "活源资产文件身份、大小、时间或只读属性与已准备快照不一致".into()
                        );
                    }
                    if digest_file(&mut original.file, stamp.size, cancel, &current)? != *sha256 {
                        return Err("活源资产完整摘要与已准备快照不一致".into());
                    }
                }
                _ => return Err("活源资产文件与目录类型和已准备快照不一致".into()),
            }
        }
        self.confirm(cancel, current)
    }

    pub(crate) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, &current)?;
        if self.root.identity().map_err(|error| error.to_string())? != self.manifest.source_identity
        {
            return Err("活源资产根目录物理身份已变化".into());
        }
        let mut seen = HashSet::new();
        confirm_inventory(&self.root, "", &self.inventory, &mut seen, cancel, &current)?;
        if seen.len() != self.inventory.entries.len() {
            return Err("活源资产在固定后出现缺失文件或目录".into());
        }
        active(cancel, &current)
    }
}
