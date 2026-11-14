use super::{active, hash, operation, publish, read_retained, uuid, Directory, FileIdentity};
use crate::managed_snapshot::{
    self, bundle::VerifiedTarget, runtime_data::PreparedData, target::File, Manifest,
};
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const FOLDER: &str = "RuntimePreparation";

pub mod ownership;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub format: String,
    pub version: u32,
    pub id: String,
    pub preparation_id: String,
    pub snapshot_receipt_sha256: String,
    pub inventory_sha256: String,
    pub destination_identity: FileIdentity,
    pub workspace_sha256: String,
    pub files: usize,
    pub directories: usize,
    pub total_bytes: u64,
    pub production_ready: bool,
    pub migration_complete: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    id: String,
    preparation_id: String,
    snapshot_receipt_sha256: String,
    destination: String,
    destination_parent_identity: FileIdentity,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, tag = "state", rename_all = "camelCase")]
pub enum Outcome {
    Prepared { receipt: Receipt },
    Aborted,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub id: String,
    pub outcome: Outcome,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Page {
    statuses: Vec<Status>,
    next_cursor: Option<String>,
}

pub(crate) fn page(statuses: &[Status], after: Option<&str>) -> Result<Page, String> {
    if after.is_some_and(|id| !uuid(id)) {
        return Err("运行准备分页游标无效".into());
    }
    let mut statuses = statuses
        .iter()
        .filter(|status| after.is_none_or(|id| status.id.as_str() > id))
        .take(33)
        .cloned()
        .collect::<Vec<_>>();
    let next_cursor = if statuses.len() > 32 {
        statuses.pop();
        statuses.last().map(|status| status.id.clone())
    } else {
        None
    };
    Ok(Page {
        statuses,
        next_cursor,
    })
}

pub(super) struct Context {
    root: Arc<Directory>,
    preparation_id: String,
    snapshot_receipt_sha256: String,
    source: managed_snapshot::Receipt,
}

struct Record {
    root: Arc<Directory>,
    intent: Intent,
    intent_sha256: String,
    intent_file: File,
    decision: Option<Decision>,
    decision_file: Option<File>,
}

pub(crate) struct Prepared {
    _record: Arc<Directory>,
    _parent: Arc<Directory>,
    intent: File,
    decision: File,
    inventory: File,
    data: PreparedData,
    receipt: Receipt,
}

impl Prepared {
    pub(super) fn receipt(&self) -> &Receipt {
        &self.receipt
    }
    pub(super) fn data(&self) -> &Manifest {
        self.data.manifest()
    }
    pub(super) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, current)?;
        for file in [&self.intent, &self.decision, &self.inventory] {
            file.confirm()?;
        }
        self.data.confirm(cancel, current)
    }
    pub(super) fn verify(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, current)?;
        for file in [&mut self.intent, &mut self.decision, &mut self.inventory] {
            file.verify(cancel, current)?;
        }
        self.data.verify(cancel, current)?;
        self.confirm(cancel, current)
    }
}

impl Context {
    pub(super) fn statuses(
        record: &Arc<Directory>,
        preparation_id: &str,
        receipt: &managed_snapshot::bundle::Receipt,
        held: Option<&Receipt>,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Vec<Status>, String> {
        active(cancel, current)?;
        let root = match record.child(FOLDER, false) {
            Ok(root) => root,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(operation(error, record.path())),
        };
        let context = Self {
            root,
            source: receipt.data.clone(),
            preparation_id: preparation_id.to_owned(),
            snapshot_receipt_sha256: hash(
                &serde_json::to_vec(receipt).map_err(|error| error.to_string())?,
            ),
        };
        context.recover(cancel, current, held)
    }

    pub(super) fn open(
        record: &Arc<Directory>,
        preparation_id: &str,
        receipt: &managed_snapshot::bundle::Receipt,
        create: bool,
    ) -> Result<Self, String> {
        if !uuid(preparation_id) {
            return Err("运行准备来源 ID 无效".into());
        }
        let root = record
            .child(FOLDER, create)
            .map_err(|error| operation(error, record.path()))?;
        Ok(Self {
            root,
            source: receipt.data.clone(),
            preparation_id: preparation_id.to_owned(),
            snapshot_receipt_sha256: hash(
                &serde_json::to_vec(receipt).map_err(|error| error.to_string())?,
            ),
        })
    }

    fn record(&self, id: &str) -> Result<Record, String> {
        if !uuid(id) {
            return Err("运行准备 ID 无效".into());
        }
        let root = self
            .root
            .child(id, false)
            .map_err(|error| operation(error, self.root.path()))?;
        let (intent, intent_sha256, intent_file) = read_retained::<Intent>(&root, "intent.json")?
            .ok_or("运行准备原生意图缺失，未猜测成功")?;
        if intent.format != "dustdesk-runtime-data-intent"
            || intent.version != 1
            || intent.id != id
            || intent.preparation_id != self.preparation_id
            || intent.snapshot_receipt_sha256 != self.snapshot_receipt_sha256
            || !Path::new(&intent.destination).is_absolute()
        {
            return Err("运行准备意图不属于当前原生快照决定".into());
        }
        let (decision, decision_file) = match read_retained::<Decision>(&root, "decision.json")? {
            Some((decision, _, file)) => (Some(decision), Some(file)),
            None => (None, None),
        };
        if let Some(decision) = &decision {
            if decision.format != "dustdesk-runtime-data-decision"
                || decision.version != 1
                || decision.id != id
                || decision.intent_sha256 != intent_sha256
            {
                return Err("运行准备原生决定与意图不匹配".into());
            }
            if let Outcome::Prepared { receipt } = &decision.outcome {
                if receipt.format != "dustdesk-runtime-data-prepared"
                    || receipt.version != 1
                    || receipt.id != id
                    || receipt.preparation_id != self.preparation_id
                    || receipt.snapshot_receipt_sha256 != self.snapshot_receipt_sha256
                    || !managed_snapshot::valid_hash(&receipt.inventory_sha256)
                    || !managed_snapshot::valid_hash(&receipt.workspace_sha256)
                    || receipt.files == 0
                    || receipt
                        .files
                        .checked_add(receipt.directories)
                        .is_none_or(|count| count > managed_snapshot::MAX_ENTRIES)
                    || receipt.total_bytes > managed_snapshot::MAX_TOTAL_BYTES
                    || receipt.production_ready
                    || receipt.migration_complete
                    || receipt.workspace_sha256 != self.source.workspace_sha256
                    || receipt.files != self.source.files
                    || receipt.directories != self.source.directories
                    || receipt.total_bytes != self.source.total_bytes
                {
                    return Err("运行准备原生回执无效或越过未完成的切换边界".into());
                }
            }
        }
        Ok(Record {
            root,
            intent,
            intent_sha256,
            intent_file,
            decision,
            decision_file,
        })
    }

    fn ids(&self) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.root.path()).map_err(|error| error.to_string())? {
            if ids.len() == super::MAX_OPERATIONS {
                return Err("运行准备记录数量超限".into());
            }
            let name = entry
                .map_err(|error| error.to_string())?
                .file_name()
                .into_string()
                .map_err(|_| "运行准备记录名称无效")?;
            if !uuid(&name) {
                return Err("运行准备目录包含未知内容，未忽略或删除".into());
            }
            ids.push(name);
        }
        ids.sort();
        Ok(ids)
    }

    fn recover(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
        held: Option<&Receipt>,
    ) -> Result<Vec<Status>, String> {
        let mut statuses = Vec::new();
        for id in self.ids()? {
            active(cancel, current)?;
            if let Some(receipt) = held.filter(|receipt| receipt.id == id) {
                if receipt.preparation_id != self.preparation_id
                    || receipt.snapshot_receipt_sha256 != self.snapshot_receipt_sha256
                {
                    return Err("存活运行准备回执不属于当前原生来源".into());
                }
                statuses.push(Status {
                    id,
                    outcome: Outcome::Prepared {
                        receipt: receipt.clone(),
                    },
                });
                continue;
            }
            let record = self.record(&id)?;
            if let Some(decision) = record.decision {
                statuses.push(Status {
                    id,
                    outcome: decision.outcome,
                });
            } else {
                active(cancel, current)?;
                publish(
                    &record.root,
                    "decision.json",
                    &Decision {
                        format: "dustdesk-runtime-data-decision".into(),
                        version: 1,
                        id: id.clone(),
                        intent_sha256: record.intent_sha256,
                        outcome: Outcome::Aborted,
                    },
                )?;
                statuses.push(Status {
                    id,
                    outcome: Outcome::Aborted,
                });
            }
        }
        active(cancel, current)?;
        Ok(statuses)
    }

    pub(super) fn prepare(
        &self,
        target: &mut VerifiedTarget,
        destination: &Path,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
        mut final_check: impl FnMut() -> Result<(), String>,
    ) -> Result<Prepared, String> {
        active(cancel, current)?;
        if self
            .recover(cancel, current, None)?
            .iter()
            .any(|status| matches!(&status.outcome, Outcome::Prepared { .. }))
        {
            return Err("已有成功运行准备，须显式核验原运行准备 ID，未创建另一目录".into());
        }
        let parent = Directory::open(destination.parent().ok_or("运行准备目录缺少父目录")?)
            .map_err(|error| operation(error, destination))?;
        let name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("运行准备目录名无效")?;
        if crate::lan::protocol::path_key(name)?.contains('/') {
            return Err("运行准备必须为单个目录名".into());
        }
        let destination = parent.path().join(name);
        let id = Uuid::new_v4().to_string();
        fs::create_dir(self.root.path().join(&id))
            .map_err(|error| operation(error, self.root.path()))?;
        let record = self
            .root
            .child(&id, false)
            .map_err(|error| error.to_string())?;
        let intent = Intent {
            format: "dustdesk-runtime-data-intent".into(),
            version: 1,
            id: id.clone(),
            preparation_id: self.preparation_id.clone(),
            snapshot_receipt_sha256: self.snapshot_receipt_sha256.clone(),
            destination: destination
                .to_str()
                .ok_or("运行目录不是有效 Unicode")?
                .to_owned(),
            destination_parent_identity: parent.identity().map_err(|error| error.to_string())?,
        };
        let intent_sha256 = publish(&record, "intent.json", &intent)?;
        active(cancel, current)?;
        let data = target.materialize(&destination, &id, cancel, current)?;
        final_check()?;
        active(cancel, current)?;
        let inventory_sha256 = publish_inventory(&record, data.manifest())?;
        let manifest = data.manifest();
        let (files, directories, total_bytes) = summary(manifest);
        let receipt = Receipt {
            format: "dustdesk-runtime-data-prepared".into(),
            version: 1,
            id: id.clone(),
            preparation_id: self.preparation_id.clone(),
            snapshot_receipt_sha256: self.snapshot_receipt_sha256.clone(),
            inventory_sha256,
            destination_identity: manifest.source_identity.clone(),
            workspace_sha256: manifest.workspace_sha256.clone(),
            files,
            directories,
            total_bytes,
            production_ready: false,
            migration_complete: false,
        };
        target.confirm(cancel, current)?;
        data.confirm(cancel, current)?;
        final_check()?;
        active(cancel, current)?;
        publish(
            &record,
            "decision.json",
            &Decision {
                format: "dustdesk-runtime-data-decision".into(),
                version: 1,
                id: id.clone(),
                intent_sha256,
                outcome: Outcome::Prepared {
                    receipt: receipt.clone(),
                },
            },
        )?;
        let record = self.record(&id)?;
        if !matches!(&record.decision, Some(Decision { outcome:Outcome::Prepared { receipt:observed }, .. }) if observed == &receipt)
        {
            return Err("运行准备发布后的原生决定与实际目标回执不一致".into());
        }
        let (_, inventory) = read_inventory(&record.root, &receipt.inventory_sha256)?;
        let prepared = Prepared {
            _record: record.root,
            _parent: parent,
            intent: record.intent_file,
            decision: record.decision_file.ok_or("运行准备成功决定未固定")?,
            inventory,
            data,
            receipt,
        };
        prepared.confirm(cancel, current)?;
        Ok(prepared)
    }

    pub(super) fn load(
        &self,
        id: &str,
        source: &Manifest,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Prepared, String> {
        active(cancel, current)?;
        let _ = self.recover(cancel, current, None)?;
        let record = self.record(id)?;
        ownership::require_prepared(&record, cancel, current)?;
        let Some(Decision {
            outcome: Outcome::Prepared { receipt },
            ..
        }) = record.decision
        else {
            return Err("运行准备没有原生成功决定，完整文件与清单不能替代决定".into());
        };
        let parent = Directory::open(
            Path::new(&record.intent.destination)
                .parent()
                .ok_or("运行准备父目录无效")?,
        )
        .map_err(|error| error.to_string())?;
        if parent.identity().map_err(|error| error.to_string())?
            != record.intent.destination_parent_identity
        {
            return Err("运行准备父目录身份已变化".into());
        }
        let (manifest, inventory) = read_inventory(&record.root, &receipt.inventory_sha256)?;
        let (files, directories, total_bytes) = summary(&manifest);
        if manifest.id != id
            || manifest.source_path != record.intent.destination
            || manifest.source_identity != receipt.destination_identity
            || manifest.workspace_sha256 != receipt.workspace_sha256
            || files != receipt.files
            || directories != receipt.directories
            || total_bytes != receipt.total_bytes
        {
            return Err("运行准备清单与原生意图、回执或物理目标不匹配".into());
        }
        let data = PreparedData::capture(manifest, source, cancel, current)?;
        let prepared = Prepared {
            _record: record.root,
            _parent: parent,
            intent: record.intent_file,
            decision: record.decision_file.ok_or("运行准备成功决定未固定")?,
            inventory,
            data,
            receipt,
        };
        prepared.confirm(cancel, current)?;
        Ok(prepared)
    }
}

fn summary(manifest: &Manifest) -> (usize, usize, u64) {
    let mut files = 0;
    let mut total = 0;
    for entry in &manifest.entries {
        if let managed_snapshot::Entry::File { stamp, .. } = entry {
            files += 1;
            total += stamp.size;
        }
    }
    (files, manifest.entries.len() - files, total)
}

fn publish_inventory(record: &Arc<Directory>, manifest: &Manifest) -> Result<String, String> {
    let bytes = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
    if bytes.len() > managed_snapshot::MAX_MANIFEST_BYTES {
        return Err("运行准备完整清单超过上限，未截断或决定成功".into());
    }
    let mut file = record
        .create(&format!("inventory-{}.part", Uuid::new_v4()))
        .map_err(|error| operation(error, record.path()))?;
    file.write_all(&bytes)
        .and_then(|_| file.sync())
        .and_then(|_| file.publish(record, "inventory.json"))
        .map_err(|error| operation(error, &file.path()))?;
    drop(file);
    let digest = hash(&bytes);
    read_inventory(record, &digest)?;
    Ok(digest)
}

fn read_inventory(record: &Arc<Directory>, expected: &str) -> Result<(Manifest, File), String> {
    let mut file = record
        .read("inventory.json")
        .map_err(|error| operation(error, record.path()))?;
    let bytes = file
        .read_bounded(managed_snapshot::MAX_MANIFEST_BYTES)
        .map_err(|error| operation(error, &file.path()))?;
    if hash(&bytes) != expected {
        return Err("运行准备完整清单摘要不匹配".into());
    }
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    managed_snapshot::validate(&manifest)?;
    Ok((manifest, File::capture(file, expected.to_owned())?))
}

#[cfg(test)]
mod tests;
