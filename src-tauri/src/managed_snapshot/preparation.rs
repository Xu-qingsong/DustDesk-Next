use super::{active, hash, valid_hash, Receipt};
use crate::lan::files::{Directory, FileIdentity, OwnedFile};
use chrono::{SecondsFormat, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{fs, io, path::Path, sync::Arc};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

const MAX_RECORD_BYTES: usize = 128 * 1024;
const MAX_OPERATIONS: usize = 4096;

pub mod runtime;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Binding {
    format: String,
    version: u32,
    id: String,
    source_identity: FileIdentity,
    catalog_identity: FileIdentity,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    id: String,
    catalog_sha256: String,
    created_at: String,
    request_id: String,
    destination: String,
    destination_parent_identity: FileIdentity,
    workspace_sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    components_sha256: Option<String>,
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
    HandoffPrepared { receipt: super::bundle::Receipt },
    Aborted,
}

#[derive(Debug)]
pub struct Status {
    pub id: String,
    pub outcome: Outcome,
}

pub struct Catalog {
    root: Arc<Directory>,
    source: Arc<Directory>,
    _lock: OwnedFile,
    _binding: OwnedFile,
    binding_sha256: String,
}

struct Record {
    directory: Arc<Directory>,
    intent: Intent,
    intent_sha256: String,
    decision: Option<Decision>,
    intent_file: super::target::File,
    decision_file: Option<super::target::File>,
}

pub(crate) struct VerifiedHandoff {
    _catalog: Catalog,
    _record: Arc<Directory>,
    _parent: Arc<Directory>,
    intent: super::target::File,
    decision: super::target::File,
    target: super::bundle::VerifiedTarget,
    receipt: super::bundle::Receipt,
    runtime: Option<runtime::Prepared>,
}

impl VerifiedHandoff {
    pub(crate) fn original_lan(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<crate::lan::migration::OriginalLan, String> {
        self.confirm(cancel, &current)?;
        self.target.original_lan(cancel, &current)
    }
    pub(crate) fn take_runtime(&mut self, id: &str) -> Result<runtime::Prepared, String> {
        if self
            .runtime
            .as_ref()
            .is_none_or(|runtime| runtime.receipt().id != id)
        {
            return Err("运行所有权必须消费当前同 ID 的真实准备护栏".into());
        }
        self.runtime.take().ok_or("运行准备护栏缺失".into())
    }

    pub(crate) fn runtime_ownership_statuses(
        &self,
        preparation_id: &str,
        runtime_id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<runtime::ownership::Status>, String> {
        self.confirm(cancel, &current)?;
        let context = runtime::Context::open(&self._record, preparation_id, &self.receipt, false)?;
        runtime::ownership::statuses(
            &context,
            runtime_id,
            self.target.data(),
            self.runtime.as_ref(),
            cancel,
            &current,
        )
    }

    pub(crate) fn resume_runtime_ownership(
        &self,
        preparation_id: &str,
        runtime_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<runtime::ownership::Active, String> {
        self.confirm(cancel, &current)?;
        if self.runtime.is_some() {
            return Err("当前会话仍持有只读运行准备，未混用可写所有权恢复".into());
        }
        let context = runtime::Context::open(&self._record, preparation_id, &self.receipt, false)?;
        runtime::ownership::Active::resume(
            &context,
            runtime_id,
            id,
            self.target.data(),
            cancel,
            &current,
        )
    }

    pub(crate) fn runtime_statuses(
        &self,
        preparation_id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<runtime::Status>, String> {
        self.confirm(cancel, &current)?;
        let statuses = runtime::Context::statuses(
            &self._record,
            preparation_id,
            &self.receipt,
            self.runtime.as_ref().map(|runtime| runtime.receipt()),
            cancel,
            &current,
        )?;
        self.confirm(cancel, current)?;
        Ok(statuses)
    }

    pub(crate) fn receipt(&self) -> &super::bundle::Receipt {
        &self.receipt
    }

    pub(crate) fn data(&self) -> &super::Manifest {
        self.target.data()
    }

    pub(crate) fn browser_archive(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(zeroize::Zeroizing<Vec<u8>>, super::bundle::DraftProof), String> {
        self.confirm(cancel, &current)?;
        let archive = self.target.browser_archive(cancel, &current)?;
        self.confirm(cancel, &current)?;
        Ok(archive)
    }

    pub(crate) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        active(cancel, &current)?;
        self.intent.confirm()?;
        self.decision.confirm()?;
        if let Some(runtime) = &self.runtime {
            runtime.confirm(cancel, &current)?;
        }
        self.target.confirm(cancel, &current)
    }

    pub(crate) fn verify(
        &mut self,
        source: &crate::legacy_source::binding::Binding,
        lan: &crate::lan::migration::Checkpoint,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, &current)?;
        self.intent.verify(cancel, &current)?;
        self.decision.verify(cancel, &current)?;
        self.target.require_source(source, lan)?;
        self.target.verify(cancel, &current)?;
        if let Some(runtime) = &mut self.runtime {
            runtime.verify(cancel, &current)?;
        }
        self.confirm(cancel, current)
    }

    pub(crate) fn prepare_runtime(
        &mut self,
        preparation_id: &str,
        destination: &Path,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
        mut final_check: impl FnMut() -> Result<(), String>,
    ) -> Result<runtime::Receipt, String> {
        self.confirm(cancel, &current)?;
        if let Some(runtime) = &mut self.runtime {
            if Path::new(&runtime.data().source_path) != destination {
                return Err("同一会话已经绑定另一运行准备目录".into());
            }
            runtime.verify(cancel, &current)?;
            final_check()?;
            return Ok(runtime.receipt().clone());
        }
        let context = runtime::Context::open(&self._record, preparation_id, &self.receipt, true)?;
        let runtime =
            context.prepare(&mut self.target, destination, cancel, &current, final_check)?;
        let receipt = runtime.receipt().clone();
        self.runtime = Some(runtime);
        self.confirm(cancel, current)?;
        Ok(receipt)
    }

    pub(crate) fn verify_runtime(
        &mut self,
        preparation_id: &str,
        id: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<runtime::Receipt, String> {
        self.confirm(cancel, &current)?;
        if let Some(runtime) = &mut self.runtime {
            if runtime.receipt().id != id {
                return Err("同一会话仅绑定同一运行准备记录".into());
            }
            runtime.verify(cancel, &current)?;
        } else {
            let context =
                runtime::Context::open(&self._record, preparation_id, &self.receipt, false)?;
            self.runtime = Some(context.load(id, self.target.data(), cancel, &current)?);
        }
        self.confirm(cancel, current)?;
        self.runtime
            .as_ref()
            .map(|runtime| runtime.receipt().clone())
            .ok_or("运行准备核验未完成".into())
    }
}

fn uuid(value: &str) -> bool {
    Uuid::parse_str(value).is_ok_and(|parsed| {
        parsed.get_version_num() == 4
            && parsed.get_variant() == uuid::Variant::RFC4122
            && parsed.to_string() == value
    })
}

fn operation(error: impl std::fmt::Display, path: &Path) -> String {
    format!("原生快照准备记录失败（{}）：{error}", path.display())
}

pub fn require_external_destination(destination: &Path, protected: &Path) -> Result<(), String> {
    let parent = Directory::open(destination.parent().ok_or("快照目标必须有父目录")?)
        .map_err(|error| operation(error, destination))?;
    let protected = Directory::open(protected).map_err(|error| operation(error, protected))?;
    if parent
        .contains_identity(&protected.identity().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?
    {
        return Err("不能把 Data 快照放入应用 profile 或其内部目录".into());
    }
    Ok(())
}

fn read<Data: DeserializeOwned>(
    directory: &Arc<Directory>,
    name: &str,
) -> Result<Option<(Data, String)>, String> {
    read_retained(directory, name).map(|value| value.map(|(data, digest, _)| (data, digest)))
}

pub(crate) fn read_retained<Data: DeserializeOwned>(
    directory: &Arc<Directory>,
    name: &str,
) -> Result<Option<(Data, String, super::target::File)>, String> {
    let mut file = match directory.read(name) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(operation(error, &directory.path().join(name))),
    };
    let bytes = file
        .read_bounded(MAX_RECORD_BYTES)
        .map_err(|error| operation(error, &file.path()))?;
    let parsed = serde_json::from_slice(&bytes).map_err(|error| operation(error, &file.path()))?;
    let digest = hash(&bytes);
    let file = super::target::File::capture(file, digest.clone())?;
    Ok(Some((parsed, digest, file)))
}

pub(crate) fn publish<Data: Serialize>(
    directory: &Arc<Directory>,
    name: &str,
    value: &Data,
) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_RECORD_BYTES {
        return Err("原生快照准备记录超过上限，未截断或发布".into());
    }
    let mut temporary = directory
        .create(&format!("record-{}.part", Uuid::new_v4()))
        .map_err(|error| operation(error, directory.path()))?;
    temporary
        .write_all(&bytes)
        .and_then(|_| temporary.sync())
        .map_err(|error| operation(error, &temporary.path()))?;
    temporary
        .publish(directory, name)
        .map_err(|error| operation(error, &directory.path().join(name)))?;
    drop(temporary);
    let observed =
        read::<serde_json::Value>(directory, name)?.ok_or("刚发布的原生快照准备记录缺失")?;
    if observed.1 != hash(&bytes) {
        return Err("原生快照准备记录发布后摘要不匹配".into());
    }
    Ok(observed.1)
}

impl Catalog {
    pub fn open(source: &Path, root: &Path) -> Result<Self, String> {
        let source = Directory::open(source).map_err(|error| operation(error, source))?;
        let root = Directory::open(root).map_err(|error| operation(error, root))?;
        let source_identity = source.identity().map_err(|error| error.to_string())?;
        let catalog_identity = root.identity().map_err(|error| error.to_string())?;
        if root
            .contains_identity(&source_identity)
            .map_err(|error| error.to_string())?
            || source
                .contains_identity(&catalog_identity)
                .map_err(|error| error.to_string())?
        {
            return Err("原生准备记录目录不能与源 Data 目录重叠".into());
        }
        let lock = match root.create("catalog.lock") {
            Ok(lock) => lock,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => root
                .part("catalog.lock")
                .map_err(|error| operation(error, &root.path().join("catalog.lock")))?,
            Err(error) => return Err(operation(error, &root.path().join("catalog.lock"))),
        };
        let binding_sha256 = if let Some((binding, digest)) =
            read::<Binding>(&root, "catalog.json")?
        {
            if binding.format != "dustdesk-snapshot-preparation-catalog"
                || binding.version != 1
                || !uuid(&binding.id)
                || binding.source_identity != source_identity
                || binding.catalog_identity != catalog_identity
            {
                return Err("原生准备记录不属于实际源或记录目录，复制记录不授予授权".into());
            }
            digest
        } else {
            let names = fs::read_dir(root.path()).map_err(|error| operation(error, root.path()))?;
            for entry in names {
                if entry.map_err(|error| error.to_string())?.file_name() != "catalog.lock" {
                    return Err("未初始化的准备记录目录包含未知或中断内容，未覆盖".into());
                }
            }
            publish(
                &root,
                "catalog.json",
                &Binding {
                    format: "dustdesk-snapshot-preparation-catalog".into(),
                    version: 1,
                    id: Uuid::new_v4().to_string(),
                    source_identity,
                    catalog_identity,
                },
            )?
        };
        let mut binding = root
            .read("catalog.json")
            .map_err(|error| error.to_string())?;
        let observed = binding
            .read_bounded(MAX_RECORD_BYTES)
            .map_err(|error| error.to_string())?;
        if hash(&observed) != binding_sha256 {
            return Err("原生准备目录绑定在固定前已变化".into());
        }
        Ok(Self {
            root,
            source,
            _lock: lock,
            _binding: binding,
            binding_sha256,
        })
    }

    fn ids(&self) -> Result<Vec<String>, String> {
        let mut ids = Vec::new();
        for entry in fs::read_dir(self.root.path()).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry
                .file_name()
                .into_string()
                .map_err(|_| "准备记录名称无效")?;
            if matches!(name.as_str(), "catalog.lock" | "catalog.json") {
                continue;
            }
            if !uuid(&name) || ids.len() >= MAX_OPERATIONS {
                return Err("准备记录含未知内容或超过 4096 项，未忽略或清理".into());
            }
            self.root
                .child(&name, false)
                .map_err(|error| operation(error, &entry.path()))?;
            ids.push(name);
        }
        ids.sort();
        Ok(ids)
    }

    fn load(&self, id: &str) -> Result<(Arc<Directory>, Intent, String, Option<Decision>), String> {
        let record = self.load_retained(id)?;
        Ok((
            record.directory,
            record.intent,
            record.intent_sha256,
            record.decision,
        ))
    }

    fn load_retained(&self, id: &str) -> Result<Record, String> {
        if !uuid(id) {
            return Err("准备记录 ID 无效".into());
        }
        let directory = self
            .root
            .child(id, false)
            .map_err(|error| error.to_string())?;
        let (intent, intent_sha256, intent_file) =
            read_retained::<Intent>(&directory, "intent.json")?
                .ok_or("准备意图缺失，未根据快照清单猜测成功")?;
        if intent.format != "dustdesk-snapshot-preparation-intent"
            || !matches!(intent.version, 1 | 2)
            || match (&intent.components_sha256, intent.version) {
                (None, 1) => false,
                (Some(hash), 2) => !valid_hash(hash),
                _ => true,
            }
            || intent.id != id
            || intent.catalog_sha256 != self.binding_sha256
            || !uuid(&intent.request_id)
            || !valid_hash(&intent.workspace_sha256)
            || intent.created_at.len() > 64
            || chrono::DateTime::parse_from_rfc3339(&intent.created_at).is_err()
            || !Path::new(&intent.destination).is_absolute()
        {
            return Err("原生快照准备意图无效或不属于当前目录".into());
        }
        let (decision, decision_file) =
            match read_retained::<Decision>(&directory, "decision.json")? {
                Some((value, _, file)) => (Some(value), Some(file)),
                None => (None, None),
            };
        if let Some(value) = &decision {
            if value.format != "dustdesk-snapshot-preparation-decision"
                || value.version != intent.version
                || value.id != id
                || value.intent_sha256 != intent_sha256
            {
                return Err("原生快照准备决定与持久意图不匹配".into());
            }
            let receipt = match (&value.outcome, intent.version) {
                (Outcome::Prepared { receipt }, 1) => Some(receipt),
                (Outcome::HandoffPrepared { receipt }, 2) => {
                    if !uuid(&receipt.id)
                        || !valid_hash(&receipt.manifest_sha256)
                        || Some(&receipt.components_sha256) != intent.components_sha256.as_ref()
                    {
                        return Err("组合快照原生回执与写前意图不匹配".into());
                    }
                    Some(&receipt.data)
                }
                (Outcome::Aborted, _) => None,
                _ => return Err("准备决定类型与原生意图版本不匹配".into()),
            };
            if let Some(receipt) = receipt {
                if !uuid(&receipt.id)
                    || !valid_hash(&receipt.manifest_sha256)
                    || receipt.files == 0
                    || receipt
                        .files
                        .checked_add(receipt.directories)
                        .is_none_or(|count| count > super::MAX_ENTRIES)
                    || receipt.total_bytes > super::MAX_TOTAL_BYTES
                    || receipt.source_identity
                        != self.source.identity().map_err(|error| error.to_string())?
                    || receipt.workspace_sha256 != intent.workspace_sha256
                {
                    return Err("原生快照回执与准备意图不匹配".into());
                }
            }
        }
        Ok(Record {
            directory,
            intent,
            intent_sha256,
            decision,
            intent_file,
            decision_file,
        })
    }

    fn begin(
        &self,
        destination: &Path,
        request: &str,
        fingerprint: &str,
    ) -> Result<String, String> {
        self.begin_components(destination, request, fingerprint, None)
    }

    fn begin_components(
        &self,
        destination: &Path,
        request: &str,
        fingerprint: &str,
        components_sha256: Option<&str>,
    ) -> Result<String, String> {
        if !uuid(request) || !valid_hash(fingerprint) {
            return Err("准备记录必须使用原生请求与工作区检查点".into());
        }
        let ids = self.ids()?;
        if ids.len() >= MAX_OPERATIONS {
            return Err("快照准备记录已达上限，未删除历史记录".into());
        }
        for id in ids {
            if self.load(&id)?.3.is_none() {
                return Err("存在未决快照准备意图，须先完成原生中断恢复".into());
            }
        }
        let parent = Directory::open(destination.parent().ok_or("快照目标必须有父目录")?)
            .map_err(|error| operation(error, destination))?;
        let source_identity = self.source.identity().map_err(|error| error.to_string())?;
        let root_identity = self.root.identity().map_err(|error| error.to_string())?;
        if parent
            .contains_identity(&source_identity)
            .map_err(|error| error.to_string())?
            || parent
                .contains_identity(&root_identity)
                .map_err(|error| error.to_string())?
        {
            return Err("快照目标不能写入源 Data 或准备记录目录".into());
        }
        let name = destination
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or("目标名称无效")?;
        if crate::lan::protocol::path_key(name)?.contains('/') {
            return Err("目标名称无效".into());
        }
        match fs::symlink_metadata(destination) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Ok(_) => return Err("快照目标已存在，未覆盖".into()),
            Err(error) => return Err(operation(error, destination)),
        }
        let destination = parent
            .path()
            .join(name)
            .to_str()
            .ok_or("目标路径无效")?
            .to_owned();
        let destination_parent_identity = parent.identity().map_err(|error| error.to_string())?;
        let id = Uuid::new_v4().to_string();
        fs::create_dir(self.root.path().join(&id)).map_err(|error| error.to_string())?;
        let directory = self
            .root
            .child(&id, false)
            .map_err(|error| error.to_string())?;
        publish(
            &directory,
            "intent.json",
            &Intent {
                format: "dustdesk-snapshot-preparation-intent".into(),
                version: if components_sha256.is_some() { 2 } else { 1 },
                id: id.clone(),
                catalog_sha256: self.binding_sha256.clone(),
                created_at: Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
                request_id: request.into(),
                destination,
                destination_parent_identity,
                workspace_sha256: fingerprint.into(),
                components_sha256: components_sha256.map(str::to_owned),
            },
        )?;
        Ok(id)
    }

    fn decide(&self, id: &str, outcome: Outcome) -> Result<Status, String> {
        let (directory, intent, intent_sha256, previous) = self.load(id)?;
        if previous.is_some() {
            return Err("快照准备决定已存在，未改写或反转".into());
        }
        if !matches!(
            (intent.version, &outcome),
            (1, Outcome::Prepared { .. })
                | (2, Outcome::HandoffPrepared { .. })
                | (_, Outcome::Aborted)
        ) {
            return Err("准备决定类型与持久意图不匹配，未发布".into());
        }
        publish(
            &directory,
            "decision.json",
            &Decision {
                format: "dustdesk-snapshot-preparation-decision".into(),
                version: intent.version,
                id: id.into(),
                intent_sha256,
                outcome: outcome.clone(),
            },
        )?;
        Ok(Status {
            id: id.into(),
            outcome,
        })
    }

    pub fn prepare(
        &self,
        destination: &Path,
        request: &str,
        fingerprint: &str,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Status, String> {
        active(cancel, &require_active)?;
        let destination_parent =
            Directory::open(destination.parent().ok_or("快照目标必须有父目录")?)
                .map_err(|error| operation(error, destination))?;
        let id = self.begin(destination, request, fingerprint)?;
        active(cancel, &require_active)?;
        let receipt = super::prepare(
            self.source.path(),
            destination,
            fingerprint,
            cancel,
            &require_active,
        )?;
        active(cancel, &require_active)?;
        super::verify_receipt(destination, &receipt, cancel)?;
        active(cancel, &require_active)?;
        let result = self.decide(&id, Outcome::Prepared { receipt });
        drop(destination_parent);
        result
    }

    pub fn prepare_handoff(
        &self,
        destination: &Path,
        mut inputs: super::bundle::Inputs<'_>,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Status, String> {
        active(cancel, &require_active)?;
        let parent = Directory::open(destination.parent().ok_or("组合快照目标必须有父目录")?)
            .map_err(|error| error.to_string())?;
        inputs.lan.confirm(cancel, &require_active)?;
        let components = super::bundle::components_hash(&super::bundle::components(&inputs)?)?;
        let id = self.begin_components(
            destination,
            inputs.request_id,
            inputs.workspace_sha256,
            Some(&components),
        )?;
        active(cancel, &require_active)?;
        let receipt = super::bundle::prepare(
            self.source.path(),
            destination,
            &mut inputs,
            cancel,
            &require_active,
        )?;
        if receipt.components_sha256 != components {
            return Err("组合快照组件与原生写前意图不匹配".into());
        }
        active(cancel, &require_active)?;
        let result = self.decide(&id, Outcome::HandoffPrepared { receipt });
        drop(parent);
        result
    }

    pub fn recover(&self) -> Result<Vec<Status>, String> {
        self.recover_active(&CancellationToken::new(), || Ok(()))
    }

    pub(crate) fn recover_active(
        &self,
        cancel: &CancellationToken,
        require_active: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<Status>, String> {
        active(cancel, &require_active)?;
        let mut statuses = Vec::new();
        for id in self.ids()? {
            active(cancel, &require_active)?;
            let (_, _, _, decision) = self.load(&id)?;
            statuses.push(match decision {
                Some(decision) => Status {
                    id,
                    outcome: decision.outcome,
                },
                None => self.decide(&id, Outcome::Aborted)?,
            });
        }
        active(cancel, &require_active)?;
        Ok(statuses)
    }

    pub fn verify_prepared(&self, id: &str, cancel: &CancellationToken) -> Result<Receipt, String> {
        let (_, intent, _, decision) = self.load(id)?;
        let Some(Decision {
            outcome: Outcome::Prepared { receipt },
            ..
        }) = decision
        else {
            return Err("原生准备记录没有成功决定，完成清单不能替代原生决定".into());
        };
        let parent = Directory::open(
            Path::new(&intent.destination)
                .parent()
                .ok_or("准备目标父目录无效")?,
        )
        .map_err(|error| operation(error, Path::new(&intent.destination)))?;
        if parent.identity().map_err(|error| error.to_string())?
            != intent.destination_parent_identity
        {
            return Err("原生准备目标的父目录身份已变化，未授权复制目录".into());
        }
        super::verify_receipt(Path::new(&intent.destination), &receipt, cancel)?;
        Ok(receipt)
    }

    pub fn verify_handoff(
        &self,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<super::bundle::Receipt, String> {
        self.verified_handoff(id, cancel)
            .map(|(receipt, _, _)| receipt)
    }

    pub(crate) fn retain_source_handoff(
        self,
        id: &str,
        source: &crate::legacy_source::binding::Binding,
        lan: &crate::lan::migration::Checkpoint,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<VerifiedHandoff, String> {
        let handoff = self.retain_runtime_source_handoff(id, source, cancel, &current)?;
        handoff.target.require_source(source, lan)?;
        Ok(handoff)
    }

    /// Retains the original snapshot and exact source binding only. The
    /// caller must validate a durable LAN grant against its original checkpoint
    /// before this can authorize a runtime with legitimately changed LAN state.
    pub(crate) fn retain_runtime_source_handoff(
        self,
        id: &str,
        source: &crate::legacy_source::binding::Binding,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<VerifiedHandoff, String> {
        active(cancel, &current)?;
        let record = self.load_retained(id)?;
        let Some(Decision {
            outcome: Outcome::HandoffPrepared { receipt },
            ..
        }) = record.decision
        else {
            return Err("原生记录没有组合快照成功决定，Data 清单不能替代整体决定".into());
        };
        let parent = Directory::open(
            Path::new(&record.intent.destination)
                .parent()
                .ok_or("组合快照父目录无效")?,
        )
        .map_err(|error| error.to_string())?;
        if parent.identity().map_err(|error| error.to_string())?
            != record.intent.destination_parent_identity
        {
            return Err("组合快照目标父目录身份已变化".into());
        }
        let target = super::bundle::VerifiedTarget::capture(
            Path::new(&record.intent.destination),
            &receipt,
            cancel,
            &current,
        )?;
        target.require_binding(source)?;
        let handoff = VerifiedHandoff {
            _catalog: self,
            _record: record.directory,
            _parent: parent,
            intent: record.intent_file,
            decision: record.decision_file.ok_or("原生成功决定缺少实际固定句柄")?,
            target,
            receipt,
            runtime: None,
        };
        handoff.confirm(cancel, current)?;
        Ok(handoff)
    }

    fn verified_handoff(
        &self,
        id: &str,
        cancel: &CancellationToken,
    ) -> Result<
        (
            super::bundle::Receipt,
            super::bundle::Manifest,
            super::Manifest,
        ),
        String,
    > {
        let (_, intent, _, decision) = self.load(id)?;
        let Some(Decision {
            outcome: Outcome::HandoffPrepared { receipt },
            ..
        }) = decision
        else {
            return Err("原生记录没有组合快照成功决定，Data 清单不能替代整体决定".into());
        };
        let parent = Directory::open(
            Path::new(&intent.destination)
                .parent()
                .ok_or("组合快照父目录无效")?,
        )
        .map_err(|error| error.to_string())?;
        if parent.identity().map_err(|error| error.to_string())?
            != intent.destination_parent_identity
        {
            return Err("组合快照目标父目录身份已变化".into());
        }
        let (manifest, data) = super::bundle::verify_receipt_with_data(
            Path::new(&intent.destination),
            &receipt,
            cancel,
        )?;
        Ok((receipt, manifest, data))
    }
}

#[cfg(test)]
mod tests;
