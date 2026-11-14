//! Durable handback of the current compatible LAN state. This is a terminal
//! decision for the original native grant; it never restores snapshot bytes.
use super::{active, bytes, handover::Custody, proof, service::Drained, Checkpoint, Frozen};
use crate::{
    lan::{
        files::{Directory, OwnedFile},
        protocol::{valid_fingerprint, MAX_JSON_BYTES},
        state_store::StateStore,
        storage::{State, Status},
    },
    managed_snapshot::{
        preparation::{publish, read_retained, runtime::ownership::Active},
        target::File,
    },
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{atomic::Ordering, Arc},
};
use tokio_util::sync::CancellationToken;

const COMPATIBLE_RUNTIME: &str = "dustdesk-electron-lan-protocol-1";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    ownership_id: String,
    grant_sha256: String,
    checkpoint: Checkpoint,
    compatible_runtime: String,
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

/// Metadata only. Releasing the actual native owner, not deserializing this
/// receipt, is what permits the next runtime to acquire the original pipe.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub ownership_id: String,
    pub checkpoint: Checkpoint,
    pub intent_sha256: String,
    pub compatible_runtime: String,
    pub production_ready: bool,
    pub migration_complete: bool,
}

pub(super) struct Retained {
    custody: Arc<Custody>,
    _lock: OwnedFile,
    state: Option<File>,
    checkpoint: Checkpoint,
    record: Option<Arc<Directory>>,
    state_bytes: Option<zeroize::Zeroizing<Vec<u8>>>,
    intent_sha256: Option<String>,
    intent: Option<File>,
    decision: Option<File>,
}

impl Retained {
    pub(super) fn confirm(&self) -> Result<(), String> {
        self.custody.confirm()?;
        if let Some(record) = &self.record {
            record_names(record)?;
        }
        if let Some(state) = &self.state {
            state.confirm()?;
        } else {
            match self.custody.root.read("state.json") {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
                Ok(_) => return Err("原 LAN 交还封存后出现新状态".into()),
            }
        }
        for file in [&self.intent, &self.decision].into_iter().flatten() {
            file.confirm()?;
        }
        Ok(())
    }
}

fn record_names(record: &Directory) -> Result<Vec<std::ffi::OsString>, String> {
    let mut names = std::fs::read_dir(record.path())
        .map_err(|error| error.to_string())?
        .take(3)
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    if names
        .iter()
        .any(|name| name != "intent.json" && name != "decision.json")
        || (names.iter().any(|name| name == "decision.json")
            && !names.iter().any(|name| name == "intent.json"))
    {
        return Err("原 LAN 交还包含未知或孤立决定；未覆盖记录".into());
    }
    Ok(names)
}

fn compatible(bytes: &[u8]) -> Result<(), String> {
    let state: State = serde_json::from_slice(bytes).map_err(|_| "原 LAN 当前状态损坏，未交还")?;
    let mut trusted = HashSet::new();
    if state
        .trusted
        .iter()
        .any(|pin| !valid_fingerprint(pin) || !trusted.insert(pin))
    {
        return Err("原 LAN 交还信任列表无效或重复".into());
    }
    let mut ids = HashSet::new();
    for task in &state.tasks {
        task.validate()?;
        if !ids.insert(&task.view.id)
            || task.manifest.text.is_some()
            || task.view.text.is_some()
            || !matches!(
                task.view.status,
                Status::Paused | Status::Completed | Status::Canceled
            )
            || task.view.speed != 0.0
            || ["token", "running", "controller", "rustPublicationV1"]
                .iter()
                .any(|key| task.extra.contains_key(*key))
        {
            return Err("原 LAN 尚含活动任务、临时授权或未完成原生发布，未交还".into());
        }
    }
    Ok(())
}

impl Frozen {
    pub(crate) fn finish_handback(
        &mut self,
        owner: &Active,
        drained: Option<&Drained>,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        super::handover::require_preview(owner.path(), self.profile.path())?;
        self.confirm(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        if self.handback.is_none() {
            let custody = match (&self.live, &self.recovered, drained) {
                (Some(live), _, Some(drained))
                    if std::sync::Weak::ptr_eq(&Arc::downgrade(live), &drained.custody) =>
                {
                    live.clone()
                }
                (None, Some(recovered), None)
                    if recovered.custody.sealed.load(Ordering::SeqCst) =>
                {
                    recovered.custody.clone()
                }
                _ => return Err("原 LAN 交还缺少同一授予的真实服务排空凭证或明确冷恢复".into()),
            };
            custody.confirm()?;
            // This exclusive state lock must have been released by the actual
            // worker. The original cross-runtime pipe remains continuously held.
            let lock = StateStore::lock(&custody.root)?;
            custody.sealed.store(true, Ordering::SeqCst);
            let mut state = match self.state.take() {
                Some(state) => Some(state),
                None => super::optional(&custody.root, "state.json")?,
            };
            let mut checkpoint = custody.checkpoint.clone();
            let mut state_bytes = None;
            let state = if let Some(mut state) = state.take() {
                let value = match bytes(&mut state, MAX_JSON_BYTES, cancel, &current) {
                    Ok(value) => value,
                    Err(error) => {
                        self.state = Some(state);
                        return Err(error);
                    }
                };
                let observed = proof(&state, &value)?;
                checkpoint.state = Some(observed.clone());
                state_bytes = Some(value);
                Some(File::capture(state, observed.sha256)?)
            } else {
                checkpoint.state = None;
                None
            };
            checkpoint.validate()?;
            self.handback = Some(Retained {
                custody,
                _lock: lock,
                state,
                checkpoint,
                record: None,
                state_bytes,
                intent_sha256: None,
                intent: None,
                decision: None,
            });
        }
        let retained = self.handback.as_mut().ok_or("原 LAN 交还封存缺失")?;
        retained.confirm()?;
        active(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        if let Some(value) = &retained.state_bytes {
            compatible(value)?;
        }
        if retained.record.is_none() {
            retained.record = Some(
                owner
                    .lan_record(false)?
                    .child("Handback", true)
                    .map_err(|error| error.to_string())?,
            );
        }
        let record = retained.record.as_ref().ok_or("原 LAN 交还目录缺失")?;
        let expected = Intent {
            format: "dustdesk-original-lan-handback-intent".into(),
            version: 1,
            ownership_id: owner.receipt().id.clone(),
            grant_sha256: retained.custody.grant_sha256.clone(),
            checkpoint: retained.checkpoint.clone(),
            compatible_runtime: COMPATIBLE_RUNTIME.into(),
        };
        let names = record_names(record)?;
        if retained.intent.is_none() {
            if names.is_empty() {
                publish(record, "intent.json", &expected)?;
            }
            let (observed, intent_sha256, file) =
                read_retained::<Intent>(record, "intent.json")?.ok_or("原 LAN 交还意图缺失")?;
            if observed != expected {
                return Err("原 LAN 交还意图不属于当前授予和最新兼容状态".into());
            }
            retained.intent = Some(file);
            retained.intent_sha256 = Some(intent_sha256);
        }
        retained.confirm()?;
        active(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        let intent_sha256 = retained
            .intent_sha256
            .as_ref()
            .ok_or("原 LAN 交还意图摘要缺失")?
            .clone();
        if retained.decision.is_none() {
            let decision = match read_retained::<Decision>(record, "decision.json")? {
                Some(decision) => decision,
                None => {
                    publish(
                        record,
                        "decision.json",
                        &Decision {
                            format: "dustdesk-original-lan-handback-granted".into(),
                            version: 1,
                            intent_sha256: intent_sha256.clone(),
                            production_ready: false,
                            migration_complete: false,
                        },
                    )?;
                    read_retained::<Decision>(record, "decision.json")?
                        .ok_or("原 LAN 交还成功决定缺失")?
                }
            };
            let (decision, _, file) = decision;
            if decision.format != "dustdesk-original-lan-handback-granted"
                || decision.version != 1
                || decision.intent_sha256 != intent_sha256
                || decision.production_ready
                || decision.migration_complete
            {
                return Err("原 LAN 交还成功决定不匹配，未推断交还".into());
            }
            retained.decision = Some(file);
        }
        retained.confirm()?;
        active(cancel, &current)?;
        owner.confirm(cancel, &current)?;
        Ok(Receipt {
            ownership_id: expected.ownership_id,
            checkpoint: expected.checkpoint,
            intent_sha256,
            compatible_runtime: expected.compatible_runtime,
            production_ready: false,
            migration_complete: false,
        })
    }
}
