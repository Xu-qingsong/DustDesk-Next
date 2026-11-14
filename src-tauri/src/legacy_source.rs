use crate::lan::files::{Directory, FileIdentity, OwnedFile, SourceStamp};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;

const CATALOG: &str = include_str!("../trust/legacy-windows-x64.json");
const FILE_PATHS: [&str; 2] = ["DustDesk.exe", "resources/app.asar"];

pub mod binding;
pub mod bridge;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Catalog {
    format: String,
    version: u32,
    repository: String,
    releases: Vec<Release>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Release {
    version: String,
    platform: String,
    zip_name: String,
    zip_sha256: String,
    checksums_sha256: String,
    files: [TrustedFile; 2],
    package_name: String,
    main_entry: String,
    browser_entry: String,
    data_relative_to_app_data: String,
    lan_relative_to_user_data: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct TrustedFile {
    path: String,
    size: u64,
    sha256: String,
}

struct FilePin {
    file: OwnedFile,
    stamp: SourceStamp,
    sha256: String,
}

pub struct PinnedInstallation {
    root: Arc<Directory>,
    resources: Arc<Directory>,
    root_identity: FileIdentity,
    resources_identity: FileIdentity,
    files: [FilePin; 2],
    release: Release,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Inspection {
    purpose: String,
    installation: String,
    root_identity: FileIdentity,
    resources_identity: FileIdentity,
    release: Release,
    production_ready: bool,
    migration_complete: bool,
    legacy_executed: bool,
    production_data_read: bool,
}

fn active(
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("旧版安装来源校验已取消".into());
    }
    current()?;
    if cancel.is_cancelled() {
        return Err("旧版安装来源校验已取消".into());
    }
    Ok(())
}

fn failure(path: &Path, error: impl std::fmt::Display) -> String {
    format!("旧版安装来源校验失败（{}）：{error}", path.display())
}

fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn catalog() -> Result<Catalog, String> {
    let catalog: Catalog = serde_json::from_str(CATALOG).map_err(|error| error.to_string())?;
    if catalog.format != "dustdesk-trusted-legacy-releases"
        || catalog.version != 1
        || catalog.repository != "Xu-qingsong/DustDesk-Next"
        || catalog.releases.is_empty()
        || catalog.releases.len() > 8
        || catalog.releases.iter().any(|release| {
            release.platform != "windows-x64"
                || !valid_hash(&release.zip_sha256)
                || !valid_hash(&release.checksums_sha256)
                || release.files.iter().zip(FILE_PATHS).any(|(file, path)| {
                    file.path != path
                        || file.size == 0
                        || file.size > 512 * 1024 * 1024
                        || !valid_hash(&file.sha256)
                })
        })
    {
        return Err("内置旧版安装来源信任目录无效".into());
    }
    Ok(catalog)
}

fn digest(
    file: &mut OwnedFile,
    stamp: &SourceStamp,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    let path = file.path();
    let check = |file: &OwnedFile| {
        active(cancel, current)?;
        file.require_single_link()
            .map_err(|error| failure(&path, error))?;
        if file.source_stamp().map_err(|error| failure(&path, error))? != *stamp {
            return Err(failure(&path, "来源文件身份、大小或修改时间已变化"));
        }
        Ok(())
    };
    check(file)?;
    file.seek(0).map_err(|error| failure(&path, error))?;
    let mut digest = Sha256::new();
    let mut remaining = stamp.size;
    let mut buffer = [0_u8; 64 * 1024];
    while remaining > 0 {
        active(cancel, current)?;
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = file
            .read_chunk(&mut buffer[..limit], cancel)
            .map_err(|error| failure(&path, error))?;
        if count == 0 {
            return Err(failure(&path, "来源文件被截断"));
        }
        digest.update(&buffer[..count]);
        remaining -= count as u64;
    }
    check(file)?;
    Ok(format!("{:x}", digest.finalize()))
}

impl PinnedInstallation {
    pub fn open(
        path: &Path,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, &current)?;
        Self::open_trusted(path, &catalog()?.releases, cancel, &current)
    }

    fn open_trusted(
        path: &Path,
        releases: &[Release],
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, current)?;
        let root = Directory::open(path).map_err(|error| failure(path, error))?;
        let resources = root
            .child("resources", false)
            .map_err(|error| failure(&path.join("resources"), error))?;
        let root_identity = root.identity().map_err(|error| failure(path, error))?;
        let resources_identity = resources
            .identity()
            .map_err(|error| failure(resources.path(), error))?;
        let executable = root
            .read("DustDesk.exe")
            .map_err(|error| failure(&path.join(FILE_PATHS[0]), error))?;
        let archive = resources
            .read("app.asar")
            .map_err(|error| failure(&path.join(FILE_PATHS[1]), error))?;
        let pin = |file: OwnedFile| {
            file.source_stamp()
                .map(|stamp| FilePin {
                    file,
                    stamp,
                    sha256: String::new(),
                })
                .map_err(|error| failure(path, error))
        };
        let mut files = [pin(executable)?, pin(archive)?];
        let candidates: Vec<_> = releases
            .iter()
            .filter(|release| {
                release
                    .files
                    .iter()
                    .zip(&files)
                    .all(|(trusted, actual)| trusted.size == actual.stamp.size)
            })
            .collect();
        if candidates.is_empty() {
            return Err(failure(path, "文件大小不属于内置支持的正式发行版"));
        }
        for file in &mut files {
            file.sha256 = digest(&mut file.file, &file.stamp, cancel, current)?;
        }
        let release = candidates
            .into_iter()
            .find(|release| {
                release
                    .files
                    .iter()
                    .zip(&files)
                    .all(|(trusted, actual)| trusted.sha256 == actual.sha256)
            })
            .ok_or_else(|| failure(path, "EXE 与 app.asar 未同时匹配同一个受信任正式发行版"))?
            .clone();
        active(cancel, current)?;
        Ok(Self {
            root,
            resources,
            root_identity,
            resources_identity,
            files,
            release,
        })
    }

    fn assert_pinned(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        if self.root.identity().map_err(|error| error.to_string())? != self.root_identity
            || self
                .resources
                .identity()
                .map_err(|error| error.to_string())?
                != self.resources_identity
        {
            return Err("旧版安装物理目录身份已变化".into());
        }
        for file in &self.files {
            file.file
                .require_single_link()
                .map_err(|error| error.to_string())?;
            if file
                .file
                .source_stamp()
                .map_err(|error| error.to_string())?
                != file.stamp
            {
                return Err(failure(&file.file.path(), "来源文件身份或检查点已变化"));
            }
        }
        active(cancel, current)
    }

    pub fn confirm(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.assert_pinned(cancel, &current)?;
        for file in &mut self.files {
            if digest(&mut file.file, &file.stamp, cancel, &current)? != file.sha256 {
                return Err(failure(&file.file.path(), "来源文件内容已变化"));
            }
        }
        self.assert_pinned(cancel, &current)
    }

    pub fn inspection(&self) -> Inspection {
        Inspection {
            purpose: "installation-identification-only".into(),
            installation: self.root.path().to_string_lossy().into_owned(),
            root_identity: self.root_identity.clone(),
            resources_identity: self.resources_identity.clone(),
            release: self.release.clone(),
            production_ready: false,
            migration_complete: false,
            legacy_executed: false,
            production_data_read: false,
        }
    }
}

#[cfg(test)]
mod tests;
