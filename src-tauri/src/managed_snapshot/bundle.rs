use super::{active, hash, valid_hash};
use crate::lan::{
    files::{Directory, FileIdentity, OwnedFile},
    migration::{Checkpoint as LanCheckpoint, Frozen},
};
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;
use std::{fs, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MANIFEST: &str = "handoff.json";
const MAX_MANIFEST: usize = 128 * 1024;
const MAX_DRAFTS: usize = 64 * 1024 * 1024;

pub struct Inputs<'a> {
    pub request_id: &'a str,
    pub workspace_sha256: &'a str,
    pub drafts: &'a [u8],
    pub browser_binding: &'a str,
    pub lan: &'a mut Frozen,
    pub source: Option<&'a crate::legacy_source::binding::BoundSource>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DraftProof {
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub payload_sha256: String,
    pub archive_id: String,
    pub entries: usize,
    pub browser_binding: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Components {
    pub drafts: DraftProof,
    pub lan: LanCheckpoint,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<crate::legacy_source::binding::Binding>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub created_at: String,
    pub identity_mode: String,
    pub external_transfer_files: String,
    pub data: super::Receipt,
    pub components: Components,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub manifest_sha256: String,
    pub destination_identity: FileIdentity,
    pub data: super::Receipt,
    pub components_sha256: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Archive {
    format: String,
    version: u32,
    payload: String,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct DraftSource {
    runtime: String,
    app_version: String,
    workspace_fingerprint: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Payload {
    id: String,
    created_at: String,
    source: DraftSource,
    #[serde(deserialize_with = "entries")]
    entries: Vec<Box<RawValue>>,
}
fn entries<'de, Data: Deserializer<'de>>(data: Data) -> Result<Vec<Box<RawValue>>, Data::Error> {
    super::bounded_list::<Data, Box<RawValue>, 5000>(data)
}

pub(crate) fn draft_proof(
    bytes: &[u8],
    workspace_sha256: &str,
    browser_binding: &str,
    legacy_source: bool,
) -> Result<DraftProof, String> {
    if bytes.len() > MAX_DRAFTS || !valid_hash(workspace_sha256) || !valid_hash(browser_binding) {
        return Err("组合快照草稿或原生检查点无效／超限".into());
    }
    let archive: Archive = serde_json::from_slice(bytes).map_err(|_| "组合快照草稿包格式无效")?;
    if archive.format != "dustdesk-browser-drafts"
        || archive.version != 1
        || archive.sha256 != hash(archive.payload.as_bytes())
    {
        return Err("组合快照草稿包格式或摘要不匹配".into());
    }
    let payload: Payload =
        serde_json::from_str(&archive.payload).map_err(|_| "组合快照草稿载荷无效")?;
    if !Uuid::parse_str(&payload.id)
        .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == payload.id)
        || payload.source.workspace_fingerprint != workspace_sha256
        || !matches!(payload.source.runtime.as_str(), "tauri" | "electron")
        || (legacy_source && payload.source.runtime != "electron")
        || payload.source.app_version.is_empty()
        || payload.source.app_version.len() > 128
        || payload.created_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&payload.created_at).is_err()
    {
        return Err("组合快照草稿来源与当前原生检查点不匹配".into());
    }
    Ok(DraftProof {
        archive_sha256: hash(bytes),
        archive_bytes: bytes.len() as u64,
        payload_sha256: archive.sha256,
        archive_id: payload.id,
        entries: payload.entries.len(),
        browser_binding: browser_binding.into(),
    })
}

pub(crate) fn components(inputs: &Inputs<'_>) -> Result<Components, String> {
    inputs.lan.checkpoint().validate()?;
    Ok(Components {
        drafts: draft_proof(
            inputs.drafts,
            inputs.workspace_sha256,
            inputs.browser_binding,
            inputs.source.is_some(),
        )?,
        lan: inputs.lan.checkpoint().clone(),
        source: inputs.source.map(|source| source.binding().clone()),
    })
}
pub(crate) fn components_hash(components: &Components) -> Result<String, String> {
    Ok(hash(
        &serde_json::to_vec(components).map_err(|error| error.to_string())?,
    ))
}

fn write(
    root: &Arc<Directory>,
    name: &str,
    bytes: &[u8],
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    let mut file = root.create(name).map_err(|error| error.to_string())?;
    for chunk in bytes.chunks(64 * 1024) {
        active(cancel, require_active)?;
        file.write_all(chunk).map_err(|error| error.to_string())?;
    }
    file.sync().map_err(|error| error.to_string())?;
    if super::digest_file(&mut file, bytes.len() as u64, cancel, require_active)? != hash(bytes) {
        return Err("组合快照附件落盘摘要不匹配".into());
    }
    Ok(())
}

pub(crate) fn prepare(
    source: &Path,
    destination: &Path,
    inputs: &mut Inputs<'_>,
    cancel: &CancellationToken,
    require_active: &impl Fn() -> Result<(), String>,
) -> Result<Receipt, String> {
    active(cancel, require_active)?;
    let components = components(inputs)?;
    inputs.lan.confirm(cancel, require_active)?;
    let source = Directory::open(source).map_err(|error| error.to_string())?;
    let parent = Directory::open(destination.parent().ok_or("组合快照目标缺少父目录")?)
        .map_err(|error| error.to_string())?;
    if parent
        .contains_identity(&source.identity().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        return Err("组合快照不能写入源 Data".into());
    }
    let name = destination
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or("组合快照目标名称无效")?;
    if crate::lan::protocol::path_key(name)?.contains('/') {
        return Err("组合快照目标名称无效".into());
    }
    fs::create_dir(parent.path().join(name)).map_err(|error| error.to_string())?;
    let root = parent
        .child(name, false)
        .map_err(|error| error.to_string())?;
    let data = super::prepare(
        source.path(),
        &root.path().join("Data"),
        inputs.workspace_sha256,
        cancel,
        require_active,
    )?;
    if let Some(binding) = &components.source {
        let manifest = super::verify(&root.path().join("Data"), &data.manifest_sha256, cancel)?;
        binding.validate_snapshot(&manifest, &components.drafts, &components.lan)?;
    }
    write(
        &root,
        "browser-drafts.json",
        inputs.drafts,
        cancel,
        require_active,
    )?;
    if let Some(bytes) = inputs.lan.state_bytes() {
        write(&root, "lan-state.json", bytes, cancel, require_active)?;
    }
    inputs.lan.confirm(cancel, require_active)?;
    let manifest = Manifest {
        format: "dustdesk-handoff-snapshot".into(),
        version: 1,
        id: Uuid::new_v4().to_string(),
        created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        identity_mode: "original-profile-only".into(),
        external_transfer_files: "original-locations-required".into(),
        data,
        components,
    };
    let bytes = serde_json::to_vec(&manifest).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MANIFEST {
        return Err("组合快照清单超过上限，未截断或发布".into());
    }
    let mut publication = root
        .create(&format!("handoff-{}.part", manifest.id))
        .map_err(|error| error.to_string())?;
    publication
        .write_all(&bytes)
        .and_then(|_| publication.sync())
        .map_err(|error| error.to_string())?;
    active(cancel, require_active)?;
    publication
        .publish(&root, MANIFEST)
        .map_err(|error| error.to_string())?;
    drop(publication);
    let receipt = Receipt {
        id: manifest.id,
        manifest_sha256: hash(&bytes),
        destination_identity: root.identity().map_err(|error| error.to_string())?,
        data: manifest.data,
        components_sha256: components_hash(&manifest.components)?,
    };
    verify_receipt(root.path(), &receipt, cancel)?;
    inputs.lan.confirm(cancel, require_active)?;
    active(cancel, require_active)?;
    Ok(receipt)
}

fn read(root: &Arc<Directory>, name: &str, limit: usize) -> Result<(OwnedFile, Vec<u8>), String> {
    let mut file = root.read(name).map_err(|error| error.to_string())?;
    let bytes = file
        .read_bounded(limit)
        .map_err(|error| error.to_string())?;
    Ok((file, bytes))
}

pub fn verify(
    destination: &Path,
    manifest_sha256: &str,
    cancel: &CancellationToken,
) -> Result<Manifest, String> {
    verify_with_data(destination, manifest_sha256, cancel).map(|(manifest, _)| manifest)
}

fn verify_with_data(
    destination: &Path,
    manifest_sha256: &str,
    cancel: &CancellationToken,
) -> Result<(Manifest, super::Manifest), String> {
    let root = Directory::open(destination).map_err(|error| error.to_string())?;
    retain(root, manifest_sha256, cancel, &|| Ok(()))
        .map(|target| (target.manifest, target.data.manifest))
}

pub(crate) struct VerifiedTarget {
    root: Arc<Directory>,
    manifest: Manifest,
    data: super::target::Data,
    publication: super::target::File,
    drafts: super::target::File,
    state: Option<super::target::File>,
    expected: Vec<String>,
}

fn retain(
    root: Arc<Directory>,
    manifest_sha256: &str,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<VerifiedTarget, String> {
    if !valid_hash(manifest_sha256) {
        return Err("组合快照清单摘要无效".into());
    }
    active(cancel, current)?;
    let (publication, bytes) = read(&root, MANIFEST, MAX_MANIFEST)?;
    if hash(&bytes) != manifest_sha256 {
        return Err("组合快照清单摘要不匹配".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|_| "组合快照清单格式无效")?;
    if manifest.format != "dustdesk-handoff-snapshot"
        || manifest.version != 1
        || !Uuid::parse_str(&manifest.id)
            .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == manifest.id)
        || manifest.created_at.len() > 64
        || chrono::DateTime::parse_from_rfc3339(&manifest.created_at).is_err()
        || manifest.identity_mode != "original-profile-only"
        || manifest.external_transfer_files != "original-locations-required"
    {
        return Err("组合快照头部无效或不受支持".into());
    }
    let (draft_file, draft_bytes) = read(&root, "browser-drafts.json", MAX_DRAFTS)?;
    if draft_proof(
        &draft_bytes,
        &manifest.data.workspace_sha256,
        &manifest.components.drafts.browser_binding,
        manifest.components.source.is_some(),
    )? != manifest.components.drafts
    {
        return Err("组合快照草稿与原生来源摘要不匹配".into());
    }
    let mut expected = vec![
        "Data".to_string(),
        "browser-drafts.json".into(),
        MANIFEST.into(),
    ];
    manifest.components.lan.validate()?;
    let state_file = if let Some(proof) = &manifest.components.lan.state {
        let (file, bytes) = read(
            &root,
            "lan-state.json",
            crate::lan::protocol::MAX_JSON_BYTES,
        )?;
        if bytes.len() as u64 != proof.stamp.size || hash(&bytes) != proof.sha256 {
            return Err("组合快照 LAN 状态与原始封存摘要不匹配".into());
        }
        if manifest.components.lan.original_identity.is_none() {
            return Err("组合快照缺少原 LAN 身份绑定".into());
        }
        expected.push("lan-state.json".into());
        Some(file)
    } else {
        None
    };
    if manifest.components.lan.format != "dustdesk-lan-original-checkpoint"
        || manifest.components.lan.version != 1
        || (manifest.components.lan.lan_profile.is_none()
            && (manifest.components.lan.state.is_some()
                || manifest.components.lan.original_identity.is_some()))
    {
        return Err("组合快照 LAN 原目录检查点无效".into());
    }
    expected.sort();
    if super::names(&root)? != expected {
        return Err("组合快照文件集合不匹配或包含额外内容".into());
    }
    let data = super::target::Data::capture(
        root.child("Data", false)
            .map_err(|error| error.to_string())?,
        &manifest.data.manifest_sha256,
        None,
        cancel,
        current,
    )?;
    if let Some(binding) = &manifest.components.source {
        binding.validate_snapshot(
            &data.manifest,
            &manifest.components.drafts,
            &manifest.components.lan,
        )?;
    }
    let files = data
        .manifest
        .entries
        .iter()
        .filter(|entry| matches!(entry, super::Entry::File { .. }))
        .count();
    let total = data
        .manifest
        .entries
        .iter()
        .map(|entry| match entry {
            super::Entry::File { stamp, .. } => stamp.size,
            _ => 0,
        })
        .sum::<u64>();
    if data.manifest.id != manifest.data.id
        || data.manifest.source_identity != manifest.data.source_identity
        || data.manifest.workspace_sha256 != manifest.data.workspace_sha256
        || files != manifest.data.files
        || data.manifest.entries.len() - files != manifest.data.directories
        || total != manifest.data.total_bytes
    {
        return Err("组合快照 Data 汇总与内容不匹配".into());
    }
    if super::names(&root)? != expected {
        return Err("组合快照核验期间文件集合已变化".into());
    }
    let publication = super::target::File::capture(publication, manifest_sha256.to_owned())?;
    let drafts = super::target::File::capture(
        draft_file,
        manifest.components.drafts.archive_sha256.clone(),
    )?;
    let state = match (state_file, &manifest.components.lan.state) {
        (Some(file), Some(proof)) => {
            Some(super::target::File::capture(file, proof.sha256.clone())?)
        }
        _ => None,
    };
    let target = VerifiedTarget {
        root,
        manifest,
        data,
        publication,
        drafts,
        state,
        expected,
    };
    target.confirm(cancel, current)?;
    Ok(target)
}

impl VerifiedTarget {
    pub(crate) fn materialize(
        &mut self,
        destination: &Path,
        id: &str,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<super::runtime_data::PreparedData, String> {
        self.confirm(cancel, current)?;
        super::preparation::require_external_destination(destination, self.root.path())?;
        let data = self.data.materialize(destination, id, cancel, current)?;
        self.confirm(cancel, current)?;
        Ok(data)
    }

    pub(crate) fn capture(
        destination: &Path,
        receipt: &Receipt,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        active(cancel, current)?;
        let root = Directory::open(destination).map_err(|error| error.to_string())?;
        if root.identity().map_err(|error| error.to_string())? != receipt.destination_identity {
            return Err("组合快照物理目录与原生回执不匹配".into());
        }
        let target = retain(root, &receipt.manifest_sha256, cancel, current)?;
        if target
            .data
            .root
            .identity()
            .map_err(|error| error.to_string())?
            != receipt.data.destination_identity
        {
            return Err("组合快照 Data 物理目录与原生回执不匹配".into());
        }
        if target.manifest.id != receipt.id
            || target.manifest.data != receipt.data
            || components_hash(&target.manifest.components)? != receipt.components_sha256
        {
            return Err("组合快照内容与原生持久回执不匹配".into());
        }
        Ok(target)
    }

    pub(crate) fn data(&self) -> &super::Manifest {
        &self.data.manifest
    }

    pub(crate) fn original_lan(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<crate::lan::migration::OriginalLan, String> {
        self.confirm(cancel, current)?;
        let bytes = self
            .state
            .as_mut()
            .map(|file| file.read_verified(crate::lan::protocol::MAX_JSON_BYTES, cancel, current))
            .transpose()?;
        self.confirm(cancel, current)?;
        Ok(crate::lan::migration::OriginalLan {
            checkpoint: self.manifest.components.lan.clone(),
            state: bytes,
        })
    }

    pub(crate) fn require_binding(
        &self,
        source: &crate::legacy_source::binding::Binding,
    ) -> Result<(), String> {
        if self.manifest.components.source.as_ref() != Some(source) {
            return Err("持久快照不属于当前仍存活的来源与原物理绑定".into());
        }
        Ok(())
    }

    pub(crate) fn browser_archive(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(zeroize::Zeroizing<Vec<u8>>, DraftProof), String> {
        self.confirm(cancel, current)?;
        let bytes = self.drafts.read_verified(MAX_DRAFTS, cancel, current)?;
        let proof = draft_proof(
            &bytes,
            &self.data.manifest.workspace_sha256,
            &self.manifest.components.drafts.browser_binding,
            self.manifest.components.source.is_some(),
        )?;
        if proof != self.manifest.components.drafts {
            return Err("已固定浏览器归档与原组合快照证明不匹配".into());
        }
        self.confirm(cancel, current)?;
        Ok((bytes, proof))
    }

    pub(crate) fn require_source(
        &self,
        source: &crate::legacy_source::binding::Binding,
        lan: &LanCheckpoint,
    ) -> Result<(), String> {
        if self.manifest.components.source.as_ref() != Some(source)
            || &self.manifest.components.lan != lan
        {
            return Err("持久快照不属于当前仍存活的来源与冻结 LAN 检查点".into());
        }
        Ok(())
    }

    pub(crate) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        if super::names(&self.root)? != self.expected {
            return Err("组合快照核验期间文件集合已变化".into());
        }
        self.publication.confirm()?;
        self.drafts.confirm()?;
        if let Some(state) = &self.state {
            state.confirm()?;
        }
        self.data.confirm(cancel, current)?;
        active(cancel, current)
    }

    pub(crate) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, current)?;
        self.publication.verify(cancel, current)?;
        self.drafts.verify(cancel, current)?;
        if let Some(state) = &mut self.state {
            state.verify(cancel, current)?;
        }
        self.data.verify(cancel, current)?;
        self.confirm(cancel, current)
    }
}

pub fn verify_receipt(
    destination: &Path,
    receipt: &Receipt,
    cancel: &CancellationToken,
) -> Result<Manifest, String> {
    verify_receipt_with_data(destination, receipt, cancel).map(|(manifest, _)| manifest)
}

pub(crate) fn verify_receipt_with_data(
    destination: &Path,
    receipt: &Receipt,
    cancel: &CancellationToken,
) -> Result<(Manifest, super::Manifest), String> {
    VerifiedTarget::capture(destination, receipt, cancel, &|| Ok(()))
        .map(|target| (target.manifest, target.data.manifest))
}

#[cfg(test)]
mod tests;
