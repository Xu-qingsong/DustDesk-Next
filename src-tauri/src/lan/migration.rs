use super::{
    files::{Directory, OwnedFile, SourceStamp},
    ownership::Lease,
    protocol::MAX_JSON_BYTES,
    storage::{Identity, State},
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, io, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub mod handback;
pub(crate) mod handover;
pub mod service;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReleaseKind {
    NotStarted,
    Drain,
    Handback,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct FileProof {
    pub stamp: SourceStamp,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OriginalIdentity {
    pub device_id: String,
    pub fingerprint: String,
    pub file: FileProof,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Checkpoint {
    pub format: String,
    pub version: u32,
    pub app_profile: super::files::FileIdentity,
    pub lan_profile: Option<super::files::FileIdentity>,
    pub state: Option<FileProof>,
    pub original_identity: Option<OriginalIdentity>,
}

pub(crate) struct OriginalLan {
    pub(crate) checkpoint: Checkpoint,
    pub(crate) state: Option<Zeroizing<Vec<u8>>>,
}

pub struct Frozen {
    profile: Arc<Directory>,
    root: Option<Arc<Directory>>,
    _lease: Option<Arc<Lease>>,
    state: Option<OwnedFile>,
    identity: Option<OwnedFile>,
    state_bytes: Option<Zeroizing<Vec<u8>>>,
    checkpoint: Checkpoint,
    live: Option<Arc<handover::Custody>>,
    recovered: Option<handover::Recovered>,
    handback: Option<handback::Retained>,
    unadopted: Option<handover::Unadopted>,
}

impl Checkpoint {
    pub fn validate(&self) -> Result<(), String> {
        let file = |proof: &FileProof, limit: u64| {
            proof.stamp.identity.index != 0
                && proof.stamp.size <= limit
                && proof.stamp.modified.len() == 16
                && u64::from_str_radix(&proof.stamp.modified, 16)
                    .is_ok_and(|value| format!("{value:016x}") == proof.stamp.modified)
                && proof.sha256.len() == 64
                && proof
                    .sha256
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        };
        if self.format != "dustdesk-lan-original-checkpoint"
            || self.version != 1
            || self.app_profile.index == 0
            || self
                .lan_profile
                .as_ref()
                .is_some_and(|identity| identity.index == 0)
            || (self.lan_profile.is_none()
                && (self.state.is_some() || self.original_identity.is_some()))
            || (self.state.is_some() && self.original_identity.is_none())
            || self
                .state
                .as_ref()
                .is_some_and(|proof| !file(proof, MAX_JSON_BYTES as u64))
            || self.original_identity.as_ref().is_some_and(|identity| {
                identity.device_id.is_empty()
                    || identity.device_id.encode_utf16().count() > 80
                    || !super::protocol::valid_fingerprint(&identity.fingerprint)
                    || !file(&identity.file, 1024 * 1024)
            })
        {
            return Err("LAN 原身份检查点头部或文件证明无效".into());
        }
        Ok(())
    }
}

fn active(
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if cancel.is_cancelled() {
        return Err("LAN 一致检查点已取消".into());
    }
    require_active()
}

fn optional(root: &Arc<Directory>, name: &str) -> Result<Option<OwnedFile>, String> {
    match root.read(name) {
        Ok(file) => Ok(Some(file)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!(
            "固定 LAN 检查点文件失败（{}）：{error}",
            root.path().join(name).display()
        )),
    }
}

fn bytes(
    file: &mut OwnedFile,
    limit: usize,
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let size = file.size().map_err(|error| error.to_string())?;
    if size > limit as u64 {
        return Err("LAN 检查点文件超过上限，未截断".into());
    }
    file.seek(0).map_err(|error| error.to_string())?;
    let mut result = Zeroizing::new(Vec::with_capacity(size as usize));
    let mut chunk = Zeroizing::new([0_u8; 64 * 1024]);
    loop {
        active(cancel, require_active)?;
        let count = file
            .read_chunk(&mut chunk[..], cancel)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        if result
            .len()
            .checked_add(count)
            .is_none_or(|length| length > size as usize)
        {
            return Err("LAN 检查点文件在读取时超过上限".into());
        }
        result.extend_from_slice(&chunk[..count]);
    }
    if result.len() != size as usize {
        return Err("LAN 检查点文件大小已变化".into());
    }
    file.require_single_link()
        .map_err(|error| error.to_string())?;
    Ok(result)
}

fn proof(file: &OwnedFile, bytes: &[u8]) -> Result<FileProof, String> {
    Ok(FileProof {
        stamp: file.source_stamp().map_err(|error| error.to_string())?,
        sha256: format!("{:x}", Sha256::digest(bytes)),
    })
}

impl Frozen {
    pub fn capture(
        profile: &Path,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, &require_active)?;
        let profile = Directory::open(profile).map_err(|error| error.to_string())?;
        let root = match profile.child("LanTransfers", false) {
            Ok(root) => Some(root),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(format!("固定原 LAN 目录失败：{error}")),
        };
        let lease = root
            .as_ref()
            .map(|root| Lease::acquire(root).map(Arc::new))
            .transpose()?;
        let mut checkpoint = Checkpoint {
            format: "dustdesk-lan-original-checkpoint".into(),
            version: 1,
            app_profile: profile.identity().map_err(|error| error.to_string())?,
            lan_profile: root
                .as_ref()
                .map(|root| root.identity())
                .transpose()
                .map_err(|error| error.to_string())?,
            state: None,
            original_identity: None,
        };
        let mut state = root
            .as_ref()
            .map(|root| optional(root, "state.json"))
            .transpose()?
            .flatten();
        let mut identity = root
            .as_ref()
            .map(|root| optional(root, "identity.json"))
            .transpose()?
            .flatten();
        if state.is_some() && identity.is_none() {
            return Err("LAN 状态存在但原设备身份缺失；未生成身份或准备交接".into());
        }
        let state_bytes = if let Some(file) = &mut state {
            let bytes = bytes(file, MAX_JSON_BYTES, cancel, &require_active)?;
            let parsed: State =
                serde_json::from_slice(&bytes).map_err(|_| "持久 LAN 状态格式无效")?;
            let mut ids = HashSet::new();
            for task in &parsed.tasks {
                task.validate()?;
                if !ids.insert(&task.view.id) {
                    return Err("持久 LAN 状态含重复任务，未准备交接".into());
                }
                if task.manifest.text.is_some()
                    || task.view.text.is_some()
                    || ["token", "controller", "running"]
                        .iter()
                        .any(|name| task.extra.contains_key(*name))
                {
                    return Err(
                        "持久 LAN 状态包含临时文本或会话凭据，未把临时内容写入迁移快照".into(),
                    );
                }
            }
            checkpoint.state = Some(proof(file, &bytes)?);
            Some(bytes)
        } else {
            None
        };
        if let Some(file) = &mut identity {
            let bytes = bytes(file, 1024 * 1024, cancel, &require_active)?;
            let parsed = Identity::parse(&bytes)?;
            checkpoint.original_identity = Some(OriginalIdentity {
                device_id: parsed.id.clone(),
                fingerprint: parsed.fingerprint.clone(),
                file: proof(file, &bytes)?,
            });
        }
        active(cancel, &require_active)?;
        let mut frozen = Self {
            profile,
            root,
            _lease: lease,
            state,
            identity,
            state_bytes,
            checkpoint,
            live: None,
            recovered: None,
            handback: None,
            unadopted: None,
        };
        frozen.confirm(cancel, &require_active)?;
        Ok(frozen)
    }

    pub fn checkpoint(&self) -> &Checkpoint {
        self.recovered
            .as_ref()
            .map_or(&self.checkpoint, |grant| &grant.original)
    }

    pub fn state_bytes(&self) -> Option<&[u8]> {
        match &self.recovered {
            Some(grant) => grant
                .original_state
                .as_deref()
                .map(|bytes| bytes.as_slice()),
            None => self.state_bytes.as_deref().map(|bytes| bytes.as_slice()),
        }
    }

    pub fn confirm(
        &mut self,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, &require_active)?;
        if let Some(unadopted) = &self.unadopted {
            unadopted.confirm()?;
        }
        if let Some(handback) = &self.handback {
            handback.confirm()?;
            return active(cancel, &require_active);
        }
        if let Some(live) = &self.live {
            live.confirm()?;
            return active(cancel, &require_active);
        }
        if let Some(grant) = &self.recovered {
            grant.custody.confirm()?;
        }
        if self.profile.identity().map_err(|error| error.to_string())?
            != self.checkpoint.app_profile
        {
            return Err("原 LAN profile 身份已变化".into());
        }
        let Some(root) = &self.root else {
            match self.profile.child("LanTransfers", false) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                _ => return Err("原来未初始化的 LAN 目录已出现或无法确认".into()),
            }
        };
        if Some(root.identity().map_err(|error| error.to_string())?) != self.checkpoint.lan_profile
        {
            return Err("原 LAN 目录身份已变化".into());
        }
        for (file, expected, name, limit) in [
            (
                &mut self.state,
                self.checkpoint.state.as_ref(),
                "state.json",
                MAX_JSON_BYTES,
            ),
            (
                &mut self.identity,
                self.checkpoint
                    .original_identity
                    .as_ref()
                    .map(|identity| &identity.file),
                "identity.json",
                1024 * 1024,
            ),
        ] {
            match (file, expected) {
                (Some(file), Some(expected)) => {
                    let observed = bytes(file, limit, cancel, &require_active)?;
                    if &proof(file, &observed)? != expected {
                        return Err("原 LAN 文件与封存检查点不匹配".into());
                    }
                }
                (None, None) if optional(root, name)?.is_none() => {}
                _ => return Err("原 LAN 文件集合在准备期间变化".into()),
            }
        }
        active(cancel, &require_active)
    }

    pub fn reopen_original(
        profile: &Path,
        expected: &Checkpoint,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        let actual = Self::capture(profile, cancel, &require_active)?;
        if actual.checkpoint != *expected {
            return Err(
                "LAN 检查点不属于当前原始物理目录、原身份及状态，未授权复制 profile 或新身份"
                    .into(),
            );
        }
        Ok(actual)
    }
}

#[cfg(test)]
mod tests;
