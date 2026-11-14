//! Isolated first handover and cold recovery. The original snapshot and the
//! current state retain distinct proofs; no handback decision is inferred.
use super::{active, proof, Checkpoint, Frozen};
use crate::{
    lan::{files::Directory, ownership::Lease, state_store::StateStore, storage::Identity},
    managed_snapshot::{
        preparation::{publish, read_retained, runtime::ownership::Active},
        target::File,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroizing;

pub(super) struct Recovered {
    pub(super) original: Checkpoint,
    pub(super) original_state: Option<Zeroizing<Vec<u8>>>,
    pub(super) custody: Arc<Custody>,
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    ownership_id: String,
    ownership_sha256: String,
    checkpoint: Checkpoint,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Decision {
    format: String,
    version: u32,
    intent_sha256: String,
    production_ready: bool,
    migration_complete: bool,
}

pub(super) struct Unadopted {
    record: Arc<Directory>,
    intent: File,
    aborted: File,
}
fn release_names(record: &Directory) -> Result<Vec<std::ffi::OsString>, String> {
    let mut names = std::fs::read_dir(record.path())
        .map_err(|e| e.to_string())?
        .take(4)
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|e| e.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    Ok(names)
}
impl Unadopted {
    pub(super) fn confirm(&self) -> Result<(), String> {
        if release_names(&self.record)?
            != vec![
                std::ffi::OsString::from("aborted.json"),
                "intent.json".into(),
            ]
        {
            return Err("未采用的原 LAN 交接出现额外记录".into());
        }
        self.intent.confirm()?;
        self.aborted.confirm()
    }
}

impl Frozen {
    pub(crate) fn confirm_unadopted(&self, owner: &Active) -> Result<Checkpoint, String> {
        if self.live.is_some() || self.recovered.is_some() || self.handback.is_some() {
            return Err("原 LAN 已采用，不能声明从未启动".into());
        }
        if let Some(unadopted) = &self.unadopted {
            unadopted.confirm()?;
        } else if owner.has_lan_record()? {
            return Err("原 LAN 已有交接记录，不能声明从未启动".into());
        }
        Ok(self.checkpoint.clone())
    }

    /// Explicit recovery may drain a real grant or abort an intent that never
    /// released the original state pin. Unknown publication remnants stay shut.
    pub(crate) fn recover_release(
        &mut self,
        owner: &Active,
        archive: super::OriginalLan,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<super::ReleaseKind, String> {
        require_preview(owner.path(), self.profile.path())?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        if !owner.has_lan_record()? {
            if self.checkpoint != archive.checkpoint {
                return Err("未启动交接的原 LAN 状态不再匹配原快照".into());
            }
            return Ok(super::ReleaseKind::NotStarted);
        }
        let record = owner.lan_record(false)?;
        let names = release_names(&record)?;
        if names.iter().any(|name| name == "decision.json") {
            let handback = names.iter().any(|name| name == "Handback");
            self.recover_grant(owner, archive, handback, cancel, current)?;
            return Ok(if handback {
                super::ReleaseKind::Handback
            } else {
                super::ReleaseKind::Drain
            });
        }
        if self.checkpoint != archive.checkpoint
            || names
                .iter()
                .any(|name| name != "intent.json" && name != "aborted.json")
        {
            return Err("未采用的原 LAN 意图包含变化或未知记录；未推断交还".into());
        }
        if names.iter().any(|name| name == "aborted.json")
            && !names.iter().any(|name| name == "intent.json")
        {
            return Err("原 LAN 中止记录缺少原意图".into());
        }
        let expected = Intent {
            format: "dustdesk-original-lan-handover-intent".into(),
            version: 1,
            ownership_id: owner.receipt().id.clone(),
            ownership_sha256: format!(
                "{:x}",
                Sha256::digest(serde_json::to_vec(owner.receipt()).map_err(|e| e.to_string())?)
            ),
            checkpoint: archive.checkpoint,
        };
        if names.is_empty() {
            publish(&record, "intent.json", &expected)?;
        }
        let (intent, intent_sha256, intent_file) =
            read_retained::<Intent>(&record, "intent.json")?.ok_or("原 LAN 意图缺失")?;
        if intent != expected {
            return Err("原 LAN 未采用意图不属于当前原生授予".into());
        }
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        if read_retained::<Decision>(&record, "aborted.json")?.is_none() {
            publish(
                &record,
                "aborted.json",
                &Decision {
                    format: "dustdesk-original-lan-handover-not-adopted".into(),
                    version: 1,
                    intent_sha256: intent_sha256.clone(),
                    production_ready: false,
                    migration_complete: false,
                },
            )?;
        }
        let (aborted, _, aborted_file) =
            read_retained::<Decision>(&record, "aborted.json")?.ok_or("原 LAN 中止记录缺失")?;
        if aborted.format != "dustdesk-original-lan-handover-not-adopted"
            || aborted.version != 1
            || aborted.intent_sha256 != intent_sha256
            || aborted.production_ready
            || aborted.migration_complete
        {
            return Err("原 LAN 未采用中止记录不匹配".into());
        }
        self.unadopted = Some(Unadopted {
            record,
            intent: intent_file,
            aborted: aborted_file,
        });
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        Ok(super::ReleaseKind::NotStarted)
    }
}

/// Both the original source and the actual service worker retain this guard.
/// Dropping either one cannot release the pipe or the original identity pin.
pub(crate) struct Custody {
    _lease: Arc<Lease>,
    profile: Arc<Directory>,
    pub(super) root: Arc<Directory>,
    pub(super) checkpoint: Checkpoint,
    identity: File,
    intent: File,
    decision: File,
    cancel: CancellationToken,
    pub(super) sealed: AtomicBool,
    pub(super) grant_sha256: String,
}

impl Custody {
    pub(crate) fn confirm_writable(&self) -> Result<(), String> {
        self.confirm()?;
        if self.sealed.load(Ordering::SeqCst) {
            return Err("原 LAN 已封存交还，禁止再次写入".into());
        }
        Ok(())
    }
    pub(crate) fn require_identity(&self, identity: &Identity) -> Result<(), String> {
        self.confirm()?;
        let expected = self
            .checkpoint
            .original_identity
            .as_ref()
            .ok_or("原设备身份缺失")?;
        if identity.id != expected.device_id || identity.fingerprint != expected.fingerprint {
            return Err("设备身份与移交的原 LAN 身份不一致".into());
        }
        Ok(())
    }
    pub(crate) fn confirm(&self) -> Result<(), String> {
        active(&self.cancel, &|| Ok(()))?;
        if self.profile.identity().map_err(|error| error.to_string())?
            != self.checkpoint.app_profile
            || Some(self.root.identity().map_err(|error| error.to_string())?)
                != self.checkpoint.lan_profile
        {
            return Err("移交中的原 LAN 物理目录已变化".into());
        }
        for file in [&self.identity, &self.intent, &self.decision] {
            file.confirm()?;
        }
        active(&self.cancel, &|| Ok(()))
    }
}

pub(crate) fn require_preview(data: &Path, profile: &Path) -> Result<(), String> {
    let parent = data.parent().ok_or("隔离运行目录缺少父目录")?;
    if !cfg!(debug_assertions)
        || profile.parent() != Some(parent)
        || parent.parent() != Some(std::env::temp_dir().as_path())
        || !parent.file_name().is_some_and(|name| {
            name.to_string_lossy()
                .starts_with("dustdesk-runtime-preview-")
        })
    {
        return Err("原 LAN 租约交接仅允许 Debug 专用 TEMP 隔离运行目录".into());
    }
    Ok(())
}

impl Frozen {
    fn pinned_identity(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(File, Arc<Identity>), String> {
        let expected = self
            .checkpoint
            .original_identity
            .as_ref()
            .ok_or("原设备身份缺失")?;
        let mut file = self
            .identity
            .as_ref()
            .ok_or("原设备身份句柄缺失")?
            .duplicate()
            .map_err(|error| error.to_string())?;
        let bytes = super::bytes(&mut file, 1024 * 1024, cancel, current)?;
        if proof(&file, &bytes)? != expected.file {
            return Err("原设备身份与固定检查点不一致".into());
        }
        let identity = Arc::new(Identity::parse(&bytes)?);
        Ok((File::capture(file, expected.file.sha256.clone())?, identity))
    }

    /// Restores only a retained grant, keeping current state pinned until the
    /// caller explicitly adopts the service store. No journal is rewritten.
    pub(crate) fn recover_handover(
        &mut self,
        owner: &Active,
        archive: super::OriginalLan,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.recover_grant(owner, archive, false, cancel, current)
    }

    pub(crate) fn recover_grant(
        &mut self,
        owner: &Active,
        archive: super::OriginalLan,
        handback: bool,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        let super::OriginalLan {
            checkpoint: original,
            state: original_state,
        } = archive;
        require_preview(owner.path(), self.profile.path())?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        original.validate()?;
        if self.live.is_some()
            || self.recovered.is_some()
            || original.app_profile != self.checkpoint.app_profile
            || original.lan_profile != self.checkpoint.lan_profile
            || original.original_identity.is_none()
            || original.original_identity != self.checkpoint.original_identity
        {
            return Err("原 LAN 恢复缺少原物理目录或原身份，未授权复制或替换".into());
        }
        match (&original.state, &original_state) {
            (Some(expected), Some(bytes))
                if bytes.len() as u64 == expected.stamp.size
                    && format!("{:x}", Sha256::digest(bytes)) == expected.sha256 => {}
            (None, None) => {}
            _ => return Err("原 LAN 恢复缺少已核验的原快照状态字节".into()),
        }
        let record = owner.lan_record(false)?;
        let mut names = std::fs::read_dir(record.path())
            .map_err(|error| error.to_string())?
            .take(4)
            .map(|entry| {
                entry
                    .map(|entry| entry.file_name())
                    .map_err(|error| error.to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        names.sort();
        let mut expected = vec![
            std::ffi::OsString::from("decision.json"),
            std::ffi::OsString::from("intent.json"),
        ];
        if handback {
            expected.push("Handback".into());
            expected.sort();
        }
        if names != expected {
            return Err("原 LAN 恢复记录缺失、未决或含未知内容；未猜测授予".into());
        }
        let (intent, intent_sha256, intent_file) =
            read_retained::<Intent>(&record, "intent.json")?.ok_or("原 LAN 恢复意图缺失")?;
        let (decision, grant_sha256, decision_file) =
            read_retained::<Decision>(&record, "decision.json")?
                .ok_or("原 LAN 恢复成功决定缺失")?;
        if intent.format != "dustdesk-original-lan-handover-intent"
            || intent.version != 1
            || intent.ownership_id != owner.receipt().id
            || intent.ownership_sha256
                != format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(owner.receipt()).map_err(|error| error.to_string())?
                    )
                )
            || intent.checkpoint != original
            || decision.format != "dustdesk-original-lan-handover-granted"
            || decision.version != 1
            || decision.intent_sha256 != intent_sha256
            || decision.production_ready
            || decision.migration_complete
        {
            return Err("原 LAN 恢复决定不属于当前原生授予和原快照检查点".into());
        }
        let (identity, _) = self.pinned_identity(cancel, &current)?;
        let custody = Arc::new(Custody {
            _lease: self._lease.as_ref().ok_or("原 LAN 恢复租约缺失")?.clone(),
            profile: self.profile.clone(),
            root: self.root.as_ref().ok_or("原 LAN 恢复根缺失")?.clone(),
            checkpoint: original.clone(),
            identity,
            intent: intent_file,
            decision: decision_file,
            cancel: cancel.clone(),
            sealed: AtomicBool::new(handback),
            grant_sha256,
        });
        custody.confirm()?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        self.recovered = Some(Recovered {
            original,
            original_state,
            custody,
        });
        Ok(())
    }

    pub(crate) fn resume_handover(
        &mut self,
        owner: &Active,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(StateStore, Arc<Identity>), String> {
        require_preview(owner.path(), self.profile.path())?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        if self.live.is_some() {
            return Err("原 LAN 恢复服务已采用，未创建第二个所有者".into());
        }
        let custody = self
            .recovered
            .as_ref()
            .ok_or("未核验原 LAN 恢复授予")?
            .custody
            .clone();
        custody.confirm_writable()?;
        let (_, identity) = self.pinned_identity(cancel, &current)?;
        let state = self
            .state_bytes
            .as_ref()
            .map(|bytes| crate::lan::storage::State::parse(bytes))
            .transpose()?
            .unwrap_or_default();
        let root = self.root.as_ref().ok_or("原 LAN 恢复根缺失")?.clone();
        let lease = self._lease.as_ref().ok_or("原 LAN 恢复租约缺失")?.clone();
        let lock = StateStore::lock(&root)?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        self.state.take();
        self.live = Some(custody.clone());
        Ok((
            StateStore::adopt(root, lease, lock, state, custody),
            identity,
        ))
    }

    pub(crate) fn handover(
        &mut self,
        owner: &Active,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(StateStore, Arc<Identity>), String> {
        require_preview(owner.path(), self.profile.path())?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        if self.live.is_some() || self.recovered.is_some() {
            return Err("同一原 LAN 已移交，未创建第二个状态所有者".into());
        }
        if self.checkpoint.original_identity.is_none() {
            return Err("原 LAN 尚无设备身份；未初始化或生成新身份".into());
        }
        let root = self.root.as_ref().ok_or("原 LAN 目录缺失")?.clone();
        let lease = self._lease.as_ref().ok_or("原 LAN 租约缺失")?.clone();
        let (identity_file, identity) = self.pinned_identity(cancel, &current)?;
        let state = self
            .state_bytes
            .as_ref()
            .map(|bytes| crate::lan::storage::State::parse(bytes))
            .transpose()?
            .unwrap_or_default();
        let record = owner.lan_record(true)?;
        // Never overwrite or infer permission from an old, pending or granted
        // record. Lost responses and interrupted grants require explicit recovery.
        if std::fs::read_dir(record.path())
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
        {
            return Err("原 LAN 交接记录已存在；未猜测恢复或反转持久决定".into());
        }
        let lock = StateStore::lock(&root)?;
        let intent_sha256 = publish(
            &record,
            "intent.json",
            &Intent {
                format: "dustdesk-original-lan-handover-intent".into(),
                version: 1,
                ownership_id: owner.receipt().id.clone(),
                ownership_sha256: format!(
                    "{:x}",
                    Sha256::digest(
                        serde_json::to_vec(owner.receipt()).map_err(|error| error.to_string())?
                    )
                ),
                checkpoint: self.checkpoint.clone(),
            },
        )?;
        let (_, observed, intent) =
            read_retained::<Intent>(&record, "intent.json")?.ok_or("原 LAN 交接意图未持久化")?;
        if observed != intent_sha256 {
            return Err("原 LAN 交接意图摘要不匹配".into());
        }
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        let decision_sha256 = publish(
            &record,
            "decision.json",
            &Decision {
                format: "dustdesk-original-lan-handover-granted".into(),
                version: 1,
                intent_sha256,
                production_ready: false,
                migration_complete: false,
            },
        )?;
        let (_, observed, decision) = read_retained::<Decision>(&record, "decision.json")?
            .ok_or("原 LAN 交接决定未持久化")?;
        if observed != decision_sha256 {
            return Err("原 LAN 交接决定摘要不匹配".into());
        }
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        let custody = Arc::new(Custody {
            _lease: lease.clone(),
            profile: self.profile.clone(),
            root: root.clone(),
            checkpoint: self.checkpoint.clone(),
            identity: identity_file,
            intent,
            decision,
            cancel: cancel.clone(),
            sealed: AtomicBool::new(false),
            grant_sha256: decision_sha256,
        });
        custody.confirm()?;
        // No fallible operation below: the exact existing lease remains alive
        // throughout this transition. Only mutable state loses its old pin.
        self.state.take();
        self.live = Some(custody.clone());
        Ok((
            StateStore::adopt(root, lease, lock, state, custody),
            identity,
        ))
    }
}
