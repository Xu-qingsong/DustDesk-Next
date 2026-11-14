use super::{Context, Decision as PreparationDecision, Outcome as PreparationOutcome, Prepared};
use crate::{
    lan::{files::Directory, ownership::Lease},
    managed_snapshot::{
        self,
        preparation::{active, hash, operation, publish, read_retained, uuid, MAX_OPERATIONS},
        target::File,
        Manifest,
    },
};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const FOLDER: &str = "Ownership";

pub mod profile;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub runtime_id: String,
    pub runtime_receipt_sha256: String,
    pub destination_identity: super::FileIdentity,
    pub production_ready: bool,
    pub migration_complete: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, tag = "state", rename_all = "camelCase")]
pub enum Outcome {
    Granted { receipt: Receipt },
    Aborted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub outcome: Outcome,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    id: String,
    runtime_id: String,
    runtime_receipt_sha256: String,
    destination_identity: super::FileIdentity,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Decision {
    format: String,
    version: u32,
    id: String,
    intent_sha256: String,
    outcome: Outcome,
}

struct Record {
    root: Arc<Directory>,
    intent: File,
    intent_sha256: String,
    outcome: Option<Outcome>,
    decision: Option<File>,
}

struct Journal {
    root: Arc<Directory>,
    runtime: super::Receipt,
    runtime_sha256: String,
}

struct Proof {
    root: Arc<Directory>,
    intent: File,
    decision: File,
    inventory: File,
    runtime: super::Receipt,
    destination: PathBuf,
    parent_identity: super::FileIdentity,
}

pub(crate) struct Active {
    _lease: Lease,
    root: Arc<Directory>,
    proof: Proof,
    _record: Arc<Directory>,
    intent: File,
    decision: File,
    receipt: Receipt,
}

impl Journal {
    fn open(
        root: &Arc<Directory>,
        runtime: &super::Receipt,
        create: bool,
    ) -> Result<Option<Self>, String> {
        let root = match root.child(FOLDER, create) {
            Ok(root) => root,
            Err(error) if !create && error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None)
            }
            Err(error) => return Err(operation(error, root.path())),
        };
        Ok(Some(Self {
            root,
            runtime: runtime.clone(),
            runtime_sha256: hash(&serde_json::to_vec(runtime).map_err(|error| error.to_string())?),
        }))
    }

    fn record(&self, id: &str) -> Result<Record, String> {
        if !uuid(id) {
            return Err("运行所有权 ID 无效".into());
        }
        let root = self
            .root
            .child(id, false)
            .map_err(|error| error.to_string())?;
        let (intent, intent_sha256, intent_file) =
            read_retained::<Intent>(&root, "intent.json")?
                .ok_or("运行所有权原生意图缺失，未猜测已取得所有权")?;
        if intent.format != "dustdesk-runtime-ownership-intent"
            || intent.version != 1
            || intent.id != id
            || intent.runtime_id != self.runtime.id
            || intent.runtime_receipt_sha256 != self.runtime_sha256
            || intent.destination_identity != self.runtime.destination_identity
        {
            return Err("运行所有权意图不属于原生运行准备".into());
        }
        let (outcome, decision_file) = match read_retained::<Decision>(&root, "decision.json")? {
            Some((decision, _, file)) => {
                if decision.format != "dustdesk-runtime-ownership-decision"
                    || decision.version != 1
                    || decision.id != id
                    || decision.intent_sha256 != intent_sha256
                {
                    return Err("运行所有权决定与原生意图不匹配".into());
                }
                if let Outcome::Granted { receipt } = &decision.outcome {
                    if receipt.format != "dustdesk-runtime-ownership-granted"
                        || receipt.version != 1
                        || receipt.id != id
                        || receipt.runtime_id != self.runtime.id
                        || receipt.runtime_receipt_sha256 != self.runtime_sha256
                        || receipt.destination_identity != self.runtime.destination_identity
                        || receipt.production_ready
                        || receipt.migration_complete
                    {
                        return Err("运行所有权回执无效或越过未完成的切换边界".into());
                    }
                }
                (Some(decision.outcome), Some(file))
            }
            None => (None, None),
        };
        Ok(Record {
            root,
            intent: intent_file,
            intent_sha256,
            outcome,
            decision: decision_file,
        })
    }

    fn recover(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Vec<Status>, String> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.root.path()).map_err(|error| error.to_string())? {
            active(cancel, current)?;
            if ids.len() == MAX_OPERATIONS {
                return Err("运行所有权记录数量超限".into());
            }
            let id = entry.map_err(|error| error.to_string())?.file_name();
            let id = id
                .to_str()
                .filter(|id| uuid(id))
                .ok_or("运行所有权目录包含未知内容")?;
            ids.push(id.to_owned());
        }
        ids.sort();
        let mut statuses = Vec::new();
        for id in ids {
            active(cancel, current)?;
            let record = self.record(&id)?;
            let outcome = match record.outcome {
                Some(outcome) => outcome,
                None => {
                    active(cancel, current)?;
                    publish(
                        &record.root,
                        "decision.json",
                        &Decision {
                            format: "dustdesk-runtime-ownership-decision".into(),
                            version: 1,
                            id: id.clone(),
                            intent_sha256: record.intent_sha256,
                            outcome: Outcome::Aborted,
                        },
                    )?;
                    Outcome::Aborted
                }
            };
            statuses.push(Status { id, outcome });
        }
        if statuses
            .iter()
            .filter(|status| matches!(status.outcome, Outcome::Granted { .. }))
            .count()
            > 1
        {
            return Err("同一运行准备存在多个所有权成功决定，未选择其一".into());
        }
        active(cancel, current)?;
        Ok(statuses)
    }
}

fn prepared_receipt(record: &super::Record) -> Result<&super::Receipt, String> {
    match &record.decision {
        Some(PreparationDecision {
            outcome: PreparationOutcome::Prepared { receipt },
            ..
        }) => Ok(receipt),
        _ => Err("运行所有权缺少原生运行准备成功决定".into()),
    }
}

pub(super) fn require_prepared(
    record: &super::Record,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<(), String> {
    if let Some(journal) = Journal::open(&record.root, prepared_receipt(record)?, false)? {
        if journal
            .recover(cancel, current)?
            .iter()
            .any(|status| matches!(status.outcome, Outcome::Granted { .. }))
        {
            return Err("运行准备已移交可写所有权，须显式恢复所有权，未重放旧只读清单".into());
        }
    }
    Ok(())
}

fn stored(
    context: &Context,
    id: &str,
    source: &Manifest,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<Proof, String> {
    active(cancel, current)?;
    let record = context.record(id)?;
    let receipt = prepared_receipt(&record)?.clone();
    let (manifest, inventory) = super::read_inventory(&record.root, &receipt.inventory_sha256)?;
    let (files, directories, total_bytes) = super::summary(&manifest);
    if manifest.id != id
        || manifest.source_path != record.intent.destination
        || manifest.source_identity != receipt.destination_identity
        || manifest.workspace_sha256 != receipt.workspace_sha256
        || files != receipt.files
        || directories != receipt.directories
        || total_bytes != receipt.total_bytes
    {
        return Err("运行所有权的准备清单不属于原生意图和回执".into());
    }
    managed_snapshot::runtime_data::require_origin(&manifest, source)?;
    Ok(Proof {
        root: record.root,
        intent: record.intent_file,
        decision: record.decision_file.ok_or("运行准备决定未固定")?,
        inventory,
        runtime: receipt,
        destination: PathBuf::from(record.intent.destination),
        parent_identity: record.intent.destination_parent_identity,
    })
}

pub(in crate::managed_snapshot::preparation) fn statuses(
    context: &Context,
    id: &str,
    source: &Manifest,
    held: Option<&Prepared>,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<Vec<Status>, String> {
    if let Some(held) = held.filter(|held| held.receipt.id == id) {
        return match Journal::open(&held._record, &held.receipt, false)? {
            Some(journal) => journal.recover(cancel, current),
            None => Ok(Vec::new()),
        };
    }
    let proof = stored(context, id, source, cancel, current)?;
    match Journal::open(&proof.root, &proof.runtime, false)? {
        Some(journal) => journal.recover(cancel, current),
        None => Ok(Vec::new()),
    }
}

impl Active {
    pub(crate) fn claim(
        mut prepared: Prepared,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
        mut final_check: impl FnMut() -> Result<(), String>,
    ) -> Result<Self, String> {
        prepared.verify(cancel, current)?;
        let lease = Lease::acquire(prepared.data.root())?;
        let journal = Journal::open(&prepared._record, &prepared.receipt, true)?
            .ok_or("运行所有权目录缺失")?;
        if journal
            .recover(cancel, current)?
            .iter()
            .any(|status| matches!(status.outcome, Outcome::Granted { .. }))
        {
            return Err("已有成功运行所有权，须显式恢复原所有权 ID".into());
        }
        let id = Uuid::new_v4().to_string();
        fs::create_dir(journal.root.path().join(&id)).map_err(|error| error.to_string())?;
        let root = journal
            .root
            .child(&id, false)
            .map_err(|error| error.to_string())?;
        let intent_sha256 = publish(
            &root,
            "intent.json",
            &Intent {
                format: "dustdesk-runtime-ownership-intent".into(),
                version: 1,
                id: id.clone(),
                runtime_id: prepared.receipt.id.clone(),
                runtime_receipt_sha256: journal.runtime_sha256.clone(),
                destination_identity: prepared.receipt.destination_identity.clone(),
            },
        )?;
        prepared.verify(cancel, current)?;
        final_check()?;
        prepared.confirm(cancel, current)?;
        let receipt = Receipt {
            format: "dustdesk-runtime-ownership-granted".into(),
            version: 1,
            id: id.clone(),
            runtime_id: prepared.receipt.id.clone(),
            runtime_receipt_sha256: journal.runtime_sha256.clone(),
            destination_identity: prepared.receipt.destination_identity.clone(),
            production_ready: false,
            migration_complete: false,
        };
        active(cancel, current)?;
        publish(
            &root,
            "decision.json",
            &Decision {
                format: "dustdesk-runtime-ownership-decision".into(),
                version: 1,
                id: id.clone(),
                intent_sha256,
                outcome: Outcome::Granted {
                    receipt: receipt.clone(),
                },
            },
        )?;
        let record = journal.record(&id)?;
        if !matches!(&record.outcome, Some(Outcome::Granted {receipt: observed}) if observed == &receipt)
        {
            return Err("运行所有权发布后的决定不匹配".into());
        }
        let Prepared {
            _record,
            _parent,
            intent,
            decision,
            inventory,
            data,
            receipt: runtime,
        } = prepared;
        let destination = data.manifest().source_path.clone().into();
        let parent_identity = _parent.identity().map_err(|error| error.to_string())?;
        let root = data.into_root();
        let active = Self {
            _lease: lease,
            root,
            proof: Proof {
                root: _record,
                intent,
                decision,
                inventory,
                runtime,
                destination,
                parent_identity,
            },
            _record: record.root,
            intent: record.intent,
            decision: record.decision.ok_or("运行所有权成功决定未固定")?,
            receipt,
        };
        active.confirm(cancel, current)?;
        Ok(active)
    }

    pub(in crate::managed_snapshot::preparation) fn resume(
        context: &Context,
        runtime_id: &str,
        id: &str,
        source: &Manifest,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        let proof = stored(context, runtime_id, source, cancel, current)?;
        let journal =
            Journal::open(&proof.root, &proof.runtime, false)?.ok_or("运行所有权记录缺失")?;
        let _ = journal.recover(cancel, current)?;
        let record = journal.record(id)?;
        let Some(Outcome::Granted { receipt }) = record.outcome else {
            return Err("没有原生成功所有权决定，未允许可写恢复".into());
        };
        let parent = Directory::open(proof.destination.parent().ok_or("运行目录父目录缺失")?)
            .map_err(|error| error.to_string())?;
        if parent.identity().map_err(|error| error.to_string())? != proof.parent_identity {
            return Err("运行所有权父目录身份已变化".into());
        }
        let root = Directory::open(&proof.destination).map_err(|error| error.to_string())?;
        if root.identity().map_err(|error| error.to_string())? != receipt.destination_identity {
            return Err("运行所有权不属于当前物理输出目录".into());
        }
        let lease = Lease::acquire(&root)?;
        let active = Self {
            _lease: lease,
            root,
            proof,
            _record: record.root,
            intent: record.intent,
            decision: record.decision.ok_or("运行所有权成功决定未固定")?,
            receipt,
        };
        active.confirm(cancel, current)?;
        Ok(active)
    }

    pub(crate) fn path(&self) -> &std::path::Path {
        self.root.path()
    }
    pub(crate) fn data_root(&self) -> Arc<Directory> {
        self.root.clone()
    }
    pub(crate) fn runtime_handback_record(&self, create: bool) -> Result<Arc<Directory>, String> {
        if create {
            fs::create_dir(self._record.path().join("RuntimeHandback"))
                .map_err(|error| error.to_string())?;
        }
        self._record
            .child("RuntimeHandback", false)
            .map_err(|error| error.to_string())
    }
    pub(crate) fn runtime_application_record(
        &self,
        create: bool,
    ) -> Result<Arc<Directory>, String> {
        // An application can only follow this ownership's durable handback.
        self.runtime_handback_record(false)?;
        if create {
            fs::create_dir(self._record.path().join("RuntimeApplication"))
                .map_err(|error| error.to_string())?;
        }
        self._record
            .child("RuntimeApplication", false)
            .map_err(|error| error.to_string())
    }
    pub(crate) fn require_runtime_writable(&self) -> Result<(), String> {
        match self._record.child("RuntimeHandback", false) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error.to_string()),
            Ok(_) => Err("整体运行交还已开始，普通读取、写入或恢复均被阻断；须显式核验交还".into()),
        }
    }
    pub(crate) fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    pub(crate) fn lan_record(&self, create: bool) -> Result<Arc<Directory>, String> {
        self._record
            .child("OriginalLan", create)
            .map_err(|error| error.to_string())
    }
    pub(crate) fn has_lan_record(&self) -> Result<bool, String> {
        match self._record.child("OriginalLan", false) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.to_string()),
        }
    }
    pub(crate) fn runtime_receipt(&self) -> &super::Receipt {
        &self.proof.runtime
    }
    pub(crate) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        if self.root.identity().map_err(|error| error.to_string())?
            != self.receipt.destination_identity
        {
            return Err("运行所有权目录身份已变化".into());
        }
        for file in [
            &self.intent,
            &self.decision,
            &self.proof.intent,
            &self.proof.decision,
            &self.proof.inventory,
        ] {
            file.confirm()?;
        }
        active(cancel, current)
    }

    pub(crate) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, current)?;
        for file in [
            &mut self.intent,
            &mut self.decision,
            &mut self.proof.intent,
            &mut self.proof.decision,
            &mut self.proof.inventory,
        ] {
            file.verify(cancel, current)?;
        }
        self.confirm(cancel, current)
    }
}
