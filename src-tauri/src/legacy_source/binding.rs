use super::{active, digest, valid_hash, Inspection, PinnedInstallation};
use crate::lan::files::{Directory, FileIdentity, OwnedFile, SourceStamp};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io, path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

pub mod snapshot;

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Locations {
    pub installation: PathBuf,
    pub data: PathBuf,
    pub user_data: PathBuf,
    pub browser_profile: PathBuf,
    pub workspace_sha256: String,
}

pub struct BoundSource {
    installation: PinnedInstallation,
    data: Arc<Directory>,
    user_data: Arc<Directory>,
    browser_profile: Arc<Directory>,
    lan: Option<Arc<Directory>>,
    workspace: OwnedFile,
    binding: Binding,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Binding {
    format: String,
    version: u32,
    scope: String,
    installation: Inspection,
    data_identity: FileIdentity,
    user_data_identity: FileIdentity,
    browser_profile_identity: FileIdentity,
    lan_storage_identity: Option<FileIdentity>,
    workspace: SourceStamp,
    workspace_sha256: String,
    browser_entry: String,
    browser_binding: String,
    production_ready: bool,
    migration_complete: bool,
}

fn separate(first: &Arc<Directory>, second: &Arc<Directory>) -> Result<(), String> {
    let first_identity = first.identity().map_err(|error| error.to_string())?;
    let second_identity = second.identity().map_err(|error| error.to_string())?;
    if first
        .contains_identity(&second_identity)
        .map_err(|error| error.to_string())?
        || second
            .contains_identity(&first_identity)
            .map_err(|error| error.to_string())?
    {
        return Err("旧安装、实际 Data 和实际 userData 必须是分离的物理目录".into());
    }
    Ok(())
}

impl BoundSource {
    pub fn open(
        locations: Locations,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        if !valid_hash(&locations.workspace_sha256) {
            return Err("原生工作区检查点摘要无效".into());
        }
        active(cancel, &current)?;
        let installation = PinnedInstallation::open(&locations.installation, cancel, &current)?;
        Self::bind(installation, locations, cancel, &current)
    }

    fn bind(
        installation: PinnedInstallation,
        locations: Locations,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, current)?;
        let data = Directory::open(&locations.data).map_err(|error| error.to_string())?;
        let user_data = Directory::open(&locations.user_data).map_err(|error| error.to_string())?;
        let browser_profile =
            Directory::open(&locations.browser_profile).map_err(|error| error.to_string())?;
        separate(&installation.root, &data)?;
        separate(&installation.root, &user_data)?;
        separate(&data, &user_data)?;
        let user_data_identity = user_data.identity().map_err(|error| error.to_string())?;
        if !browser_profile
            .contains_identity(&user_data_identity)
            .map_err(|error| error.to_string())?
        {
            return Err("实际浏览器配置不属于当前 userData，未绑定旧草稿来源".into());
        }
        let lan = match user_data.child("LanTransfers", false) {
            Ok(directory) => Some(directory),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("固定实际 LAN 目录失败：{error}")),
        };
        if let Some(lan) = &lan {
            if browser_profile
                .contains_identity(&lan.identity().map_err(|error| error.to_string())?)
                .map_err(|error| error.to_string())?
            {
                return Err("浏览器配置不能位于 LAN 存储内".into());
            }
        }
        let mut workspace = data
            .read_shared("workspace.json")
            .map_err(|error| error.to_string())?;
        let stamp = workspace
            .source_stamp()
            .map_err(|error| error.to_string())?;
        if stamp.size == 0 || stamp.size > 64 * 1024 * 1024 {
            return Err("绑定工作区检查点超过当前 64 MiB 上限或为空".into());
        }
        let actual_sha256 = digest(&mut workspace, &stamp, cancel, current)?;
        if actual_sha256 != locations.workspace_sha256 {
            return Err("实际 Data 不匹配原生维护工作区检查点".into());
        }
        crate::lan::protocol::path_key(&installation.release.browser_entry)?;
        let browser_entry = tauri::Url::from_file_path(
            installation
                .root
                .path()
                .join("resources")
                .join("app.asar")
                .join(&installation.release.browser_entry),
        )
        .map_err(|_| "无法形成固定旧安装的本地浏览器入口")?
        .to_string();
        let browser_profile_identity = browser_profile
            .identity()
            .map_err(|error| error.to_string())?;
        let browser_binding = format!("{:x}", Sha256::digest(format!(
            "{{\"version\":1,\"runtime\":\"electron\",\"entry\":{},\"profile\":{{\"volume\":\"{:016x}\",\"file\":\"{:016x}\"}}}}",
            serde_json::to_string(&browser_entry).map_err(|error| error.to_string())?,
            browser_profile_identity.volume, browser_profile_identity.index
        ).as_bytes()));
        let binding = Binding {
            format: "dustdesk-live-legacy-source-binding".into(),
            version: 1,
            scope: "prepared-electron-runtime".into(),
            installation: installation.inspection(),
            data_identity: data.identity().map_err(|error| error.to_string())?,
            user_data_identity,
            browser_profile_identity,
            lan_storage_identity: lan
                .as_ref()
                .map(|directory| directory.identity())
                .transpose()
                .map_err(|error| error.to_string())?,
            workspace: stamp,
            workspace_sha256: actual_sha256,
            browser_entry,
            browser_binding,
            production_ready: false,
            migration_complete: false,
        };
        active(cancel, current)?;
        Ok(Self {
            installation,
            data,
            user_data,
            browser_profile,
            lan,
            workspace,
            binding,
        })
    }

    pub fn binding(&self) -> &Binding {
        &self.binding
    }

    fn assert_pinned(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        self.installation.assert_pinned(cancel, current)?;
        for (directory, expected) in [
            (&self.data, &self.binding.data_identity),
            (&self.user_data, &self.binding.user_data_identity),
            (
                &self.browser_profile,
                &self.binding.browser_profile_identity,
            ),
        ] {
            if directory.identity().map_err(|error| error.to_string())? != *expected {
                return Err("旧安装关联的实际运行时目录身份已变化".into());
            }
        }
        let lan_identity = match self.user_data.child("LanTransfers", false) {
            Ok(directory) => Some(directory.identity().map_err(|error| error.to_string())?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error.to_string()),
        };
        if lan_identity != self.binding.lan_storage_identity
            || self
                .lan
                .as_ref()
                .map(|directory| directory.identity())
                .transpose()
                .map_err(|error| error.to_string())?
                != lan_identity
        {
            return Err("实际 LAN 存储目录出现、消失或物理身份已变化".into());
        }
        self.workspace
            .require_single_link()
            .map_err(|error| error.to_string())?;
        if self
            .workspace
            .source_stamp()
            .map_err(|error| error.to_string())?
            != self.binding.workspace
        {
            return Err("已绑定工作区文件检查点已变化".into());
        }
        active(cancel, current)
    }

    pub fn confirm(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.assert_pinned(cancel, &current)?;
        if digest(
            &mut self.workspace,
            &self.binding.workspace,
            cancel,
            &current,
        )? != self.binding.workspace_sha256
        {
            return Err("已绑定工作区内容发生变化".into());
        }
        self.installation.confirm(cancel, &current)?;
        self.assert_pinned(cancel, &current)
    }
}

#[cfg(test)]
mod tests;
