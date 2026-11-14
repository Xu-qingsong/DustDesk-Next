//! Durable inputs for whole-runtime application. Both checkpoints and exact
//! browser reconciliation are retained before any original file pin is released.
//! A prepared checkpoint is not authority to apply or reopen either runtime.
use super::{handback, Binding, RuntimeOwner};
use crate::{
    lan::files::Directory,
    managed_snapshot::{
        bundle::{draft_proof, DraftProof},
        drafts::{validate, Entry},
        preparation::{publish, read_retained, runtime::ownership::Active},
        runtime_data::PreparedData,
        target::File,
        Manifest,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, sync::Arc};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 64 * 1024 * 1024;
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct DraftChange {
    pub key: String,
    pub before: Option<String>,
    pub after: Option<String>,
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
struct Source {
    runtime: String,
    app_version: String,
    workspace_fingerprint: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Payload {
    id: String,
    created_at: String,
    source: Source,
    #[serde(deserialize_with = "bounded_entries")]
    entries: Vec<Entry>,
}
fn bounded_entries<'de, Data: serde::Deserializer<'de>>(
    data: Data,
) -> Result<Vec<Entry>, Data::Error> {
    crate::managed_snapshot::bounded_list::<Data, Entry, 5000>(data)
}

fn entries(
    bytes: &[u8],
    proof: &DraftProof,
    workspace: &str,
    runtime: &str,
) -> Result<BTreeMap<String, String>, String> {
    if bytes.len() > MAX_BYTES
        || draft_proof(
            bytes,
            workspace,
            &proof.browser_binding,
            runtime == "electron",
        )? != *proof
    {
        return Err("整体应用草稿不属于原生封存证明".into());
    }
    let archive: Archive = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let payload: Payload =
        serde_json::from_str(&archive.payload).map_err(|error| error.to_string())?;
    if archive.format != "dustdesk-browser-drafts"
        || archive.version != 1
        || hash(archive.payload.as_bytes()) != archive.sha256
        || payload.id != proof.archive_id
        || payload.source.runtime != runtime
        || payload.source.workspace_fingerprint != workspace
        || payload.source.app_version.is_empty()
        || payload.created_at.is_empty()
        || payload.entries.len() > 5000
    {
        return Err("整体应用草稿来源或数量无效".into());
    }
    let mut result = BTreeMap::new();
    for entry in payload.entries {
        validate(&entry)?;
        if result.insert(entry.key, entry.value).is_some() {
            return Err("整体应用草稿存在重复键，未合并".into());
        }
    }
    Ok(result)
}

fn reconciliation(
    before: &BTreeMap<String, String>,
    after: &BTreeMap<String, String>,
) -> Vec<DraftChange> {
    let mut keys = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<Vec<_>>();
    keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    keys.dedup();
    keys.into_iter()
        .map(|key| DraftChange {
            before: before.get(&key).cloned(),
            after: after.get(&key).cloned(),
            key,
        })
        .collect()
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    id: String,
    preparation_id: String,
    runtime_id: String,
    source: Binding,
    handback: handback::Receipt,
    original_data_sha256: String,
    sealed_data_sha256: String,
    original_drafts: DraftProof,
    plan_sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Decision {
    format: String,
    version: u32,
    intent_sha256: String,
    staged_data_sha256: String,
    application_ready: bool,
    original_data_applied: bool,
    session_applied: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub id: String,
    pub intent_sha256: String,
    pub handback_intent_sha256: String,
    pub original_data_sha256: String,
    pub sealed_data_sha256: String,
    pub staged_data_sha256: String,
    pub plan_sha256: String,
    pub original_drafts: DraftProof,
    pub latest_drafts: DraftProof,
    pub application_ready: bool,
    pub original_data_applied: bool,
    pub session_applied: bool,
    pub production_ready: bool,
    pub migration_complete: bool,
}

pub(super) struct Retained {
    root: Arc<Directory>,
    intent: File,
    payloads: Vec<File>,
    staged: PreparedData,
    decision: Option<File>,
    receipt: Receipt,
}

struct OriginalCheckpoint<'a> {
    source: &'a Binding,
    data: &'a Manifest,
    drafts: &'a DraftProof,
}

fn names(root: &Directory, decided: bool) -> Result<(), String> {
    let mut names = fs::read_dir(root.path())
        .map_err(|error| error.to_string())?
        .take(11)
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    let mut expected = vec![
        "Incoming",
        "draft-plan.json",
        "intent.json",
        "latest-drafts.json",
        "original-data.json",
        "original-drafts.json",
        "preparing.json",
        "sealed-data.json",
        "staged-data.json",
    ];
    if decided {
        expected.push("decision.json");
    }
    expected.sort();
    if names
        != expected
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>()
    {
        return Err("整体应用准备包含缺失、未知或中断文件，未猜测修复".into());
    }
    Ok(())
}

fn write(root: &Arc<Directory>, name: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES {
        return Err("整体应用准备载荷超过 64 MiB".into());
    }
    let mut file = root
        .create(&format!("payload-{}.part", uuid::Uuid::new_v4()))
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync())
        .and_then(|_| file.publish(root, name))
        .map_err(|error| error.to_string())
}

fn read(
    root: &Arc<Directory>,
    name: &str,
    expected: Option<&str>,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<(File, zeroize::Zeroizing<Vec<u8>>), String> {
    current()?;
    let mut file = root.read(name).map_err(|error| error.to_string())?;
    let bytes = zeroize::Zeroizing::new(
        file.read_bounded(MAX_BYTES)
            .map_err(|error| error.to_string())?,
    );
    let digest = hash(&bytes);
    if expected.is_some_and(|expected| expected != digest) {
        return Err("整体应用准备载荷摘要不符".into());
    }
    let mut file = File::capture(file, digest)?;
    file.verify(cancel, current)?;
    Ok((file, bytes))
}

impl Retained {
    fn prepare(
        owner: &Active,
        checkpoint: OriginalCheckpoint<'_>,
        original_drafts: &[u8],
        terminal: &mut handback::Retained,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        let OriginalCheckpoint {
            source,
            data: original,
            drafts: original_proof,
        } = checkpoint;
        terminal.complete(cancel, current)?;
        let receipt = terminal.receipt();
        let sealed = serde_json::to_vec(terminal.manifest()).map_err(|error| error.to_string())?;
        let original_data = serde_json::to_vec(original).map_err(|error| error.to_string())?;
        let original_entries = entries(
            original_drafts,
            original_proof,
            &original.workspace_sha256,
            "electron",
        )?;
        let root = owner.runtime_application_record(true)?;
        let id = uuid::Uuid::new_v4().to_string();
        // Make the durable original/latest binding before creating any copied
        // assets. Nothing here drops the original source or terminal pins.
        let preliminary = serde_json::json!({"format":"dustdesk-runtime-application-preparing","version":1,"id":id,
            "source":source,"handback":receipt,"originalDataSha256":hash(&original_data),"sealedDataSha256":hash(&sealed),"originalDrafts":original_proof});
        publish(&root, "preparing.json", &preliminary)?;
        current()?;
        let (staged, latest_drafts) =
            terminal.application_inputs(&root.path().join("Incoming"), &id, cancel, current)?;
        let latest_entries = entries(
            &latest_drafts,
            &receipt.drafts,
            &receipt.workspace_sha256,
            "tauri",
        )?;
        let plan = serde_json::to_vec(&reconciliation(&original_entries, &latest_entries))
            .map_err(|error| error.to_string())?;
        let intent = Intent {
            format: "dustdesk-runtime-application-inputs".into(),
            version: 1,
            id,
            preparation_id: owner.runtime_receipt().preparation_id.clone(),
            runtime_id: owner.runtime_receipt().id.clone(),
            source: source.clone(),
            handback: receipt,
            original_data_sha256: hash(&original_data),
            sealed_data_sha256: hash(&sealed),
            original_drafts: original_proof.clone(),
            plan_sha256: hash(&plan),
        };
        publish(&root, "intent.json", &intent)?;
        for (name, bytes) in [
            ("original-data.json", original_data.as_slice()),
            ("sealed-data.json", sealed.as_slice()),
            ("original-drafts.json", original_drafts),
            ("latest-drafts.json", latest_drafts.as_slice()),
            ("draft-plan.json", plan.as_slice()),
        ] {
            write(&root, name, bytes)?;
            current()?;
        }
        write(
            &root,
            "staged-data.json",
            &serde_json::to_vec(staged.manifest()).map_err(|error| error.to_string())?,
        )?;
        // Keep the initial marker as immutable evidence too. It cannot serve
        // as an application decision if preparation is interrupted.
        let mut retained = Self::load(
            owner,
            OriginalCheckpoint {
                source,
                data: original,
                drafts: original_proof,
            },
            terminal,
            Some(staged),
            cancel,
            current,
        )?;
        retained.complete(cancel, current)?;
        Ok(retained)
    }

    fn load(
        owner: &Active,
        checkpoint: OriginalCheckpoint<'_>,
        terminal: &handback::Retained,
        staged: Option<PreparedData>,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        let OriginalCheckpoint {
            source,
            data: original,
            drafts: original_proof,
        } = checkpoint;
        owner.confirm(cancel, current)?;
        terminal.confirm(cancel, current)?;
        let root = owner.runtime_application_record(false)?;
        let decision = read_retained::<Decision>(&root, "decision.json")?;
        names(&root, decision.is_some())?;
        let (intent, intent_sha256, intent_file) =
            read_retained::<Intent>(&root, "intent.json")?.ok_or("整体应用准备意图缺失")?;
        if intent.format != "dustdesk-runtime-application-inputs"
            || intent.version != 1
            || intent.source != *source
            || intent.handback != terminal.receipt()
            || intent.preparation_id != owner.runtime_receipt().preparation_id
            || intent.runtime_id != owner.runtime_receipt().id
            || intent.original_drafts != *original_proof
            || intent.original_data_sha256
                != hash(&serde_json::to_vec(original).map_err(|error| error.to_string())?)
            || intent.sealed_data_sha256
                != hash(
                    &serde_json::to_vec(terminal.manifest()).map_err(|error| error.to_string())?,
                )
        {
            return Err("整体应用准备不属于同一原来源、快照与最新封存决定".into());
        }
        let mut payloads = Vec::new();
        let (preparing, _, preparing_file) =
            read_retained::<serde_json::Value>(&root, "preparing.json")?
                .ok_or("整体应用初始记录缺失")?;
        if preparing
            != serde_json::json!({"format":"dustdesk-runtime-application-preparing","version":1,"id":intent.id,
            "source":source,"handback":intent.handback,"originalDataSha256":intent.original_data_sha256,"sealedDataSha256":intent.sealed_data_sha256,"originalDrafts":original_proof})
        {
            return Err("整体应用初始记录与意图不匹配".into());
        }
        payloads.push(preparing_file);
        let (file, _) = read(
            &root,
            "original-data.json",
            Some(&intent.original_data_sha256),
            cancel,
            current,
        )?;
        payloads.push(file);
        let (file, _) = read(
            &root,
            "sealed-data.json",
            Some(&intent.sealed_data_sha256),
            cancel,
            current,
        )?;
        payloads.push(file);
        let (file, before) = read(
            &root,
            "original-drafts.json",
            Some(&original_proof.archive_sha256),
            cancel,
            current,
        )?;
        payloads.push(file);
        let (file, after) = read(
            &root,
            "latest-drafts.json",
            Some(&intent.handback.drafts.archive_sha256),
            cancel,
            current,
        )?;
        payloads.push(file);
        let expected_plan = serde_json::to_vec(&reconciliation(
            &entries(
                &before,
                original_proof,
                &original.workspace_sha256,
                "electron",
            )?,
            &entries(
                &after,
                &intent.handback.drafts,
                &intent.handback.workspace_sha256,
                "tauri",
            )?,
        ))
        .map_err(|error| error.to_string())?;
        let (file, plan) = read(
            &root,
            "draft-plan.json",
            Some(&intent.plan_sha256),
            cancel,
            current,
        )?;
        if plan.as_slice() != expected_plan.as_slice() {
            return Err("整体应用覆盖／删除计划与原始归档不匹配".into());
        }
        payloads.push(file);
        let (file, bytes) = read(&root, "staged-data.json", None, cancel, current)?;
        let staged_sha256 = hash(&bytes);
        let staged_manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if staged_manifest.id != intent.id
            || std::path::Path::new(&staged_manifest.source_path) != root.path().join("Incoming")
        {
            return Err("整体应用副本不属于原独占准备目录".into());
        }
        payloads.push(file);
        let staged = match staged {
            Some(staged) => {
                if serde_json::to_vec(staged.manifest())
                    .map_err(|error| error.to_string())?
                    .as_slice()
                    != bytes.as_slice()
                {
                    return Err("整体应用副本物理清单变化".into());
                }
                staged
            }
            None => PreparedData::capture(staged_manifest, terminal.manifest(), cancel, current)?,
        };
        let decision = match decision {
            Some((decision, _, file)) => {
                if decision.format != "dustdesk-runtime-application-prepared"
                    || decision.version != 1
                    || decision.intent_sha256 != intent_sha256
                    || decision.staged_data_sha256 != staged_sha256
                    || decision.application_ready
                    || decision.original_data_applied
                    || decision.session_applied
                {
                    return Err("整体应用准备决定不匹配或越过应用权限".into());
                }
                Some(file)
            }
            None => None,
        };
        let retained = Self {
            root,
            intent: intent_file,
            payloads,
            staged,
            decision,
            receipt: Receipt {
                id: intent.id,
                intent_sha256,
                handback_intent_sha256: intent.handback.intent_sha256,
                original_data_sha256: intent.original_data_sha256,
                sealed_data_sha256: intent.sealed_data_sha256,
                staged_data_sha256: staged_sha256,
                plan_sha256: intent.plan_sha256,
                original_drafts: intent.original_drafts,
                latest_drafts: intent.handback.drafts,
                application_ready: false,
                original_data_applied: false,
                session_applied: false,
                production_ready: false,
                migration_complete: false,
            },
        };
        retained.confirm(cancel, current)?;
        Ok(retained)
    }

    pub(super) fn confirm(
        &self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        names(&self.root, self.decision.is_some())?;
        self.intent.confirm()?;
        for file in &self.payloads {
            file.confirm()?;
        }
        if let Some(file) = &self.decision {
            file.confirm()?;
        }
        self.staged.confirm(cancel, current)
    }

    pub(super) fn complete(
        &mut self,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, current)?;
        if self.decision.is_none() {
            publish(
                &self.root,
                "decision.json",
                &Decision {
                    format: "dustdesk-runtime-application-prepared".into(),
                    version: 1,
                    intent_sha256: self.receipt.intent_sha256.clone(),
                    staged_data_sha256: self.receipt.staged_data_sha256.clone(),
                    application_ready: false,
                    original_data_applied: false,
                    session_applied: false,
                },
            )?;
            self.decision = Some(
                read_retained::<Decision>(&self.root, "decision.json")?
                    .ok_or("整体应用准备决定未发布")?
                    .2,
            );
        }
        self.confirm(cancel, current)
    }

    pub(super) fn receipt(&self) -> Receipt {
        self.receipt.clone()
    }
}

impl RuntimeOwner {
    /// Persist the complete application inputs while retaining both sources.
    /// The copied migration control records remain historical proofs; this
    /// method never adopts them at another physical Data identity.
    pub fn prepare_runtime_application_preview(
        &mut self,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        crate::lan::migration::handover::require_preview(
            self.path(),
            self.source.source.user_data.path(),
        )?;
        self.resume_runtime_handback_preview(&current)?;
        if self.application.is_none() {
            let prepared = self.source.prepared.as_mut().ok_or("整体应用缺少原快照")?;
            let (drafts, proof) = prepared.target.browser_archive(&self.cancel, &current)?;
            let source = std::cell::RefCell::new(&mut self.source);
            let check = || {
                source
                    .borrow_mut()
                    .confirm_runtime_custody(&self.cancel, &current)
            };
            let terminal = self.handback.as_mut().ok_or("整体应用缺少最新封存终态")?;
            // Clone metadata only. Actual source handles stay with RuntimeOwner.
            let (binding, original) = {
                let source = source.borrow();
                (
                    source.binding().clone(),
                    source
                        .prepared
                        .as_ref()
                        .ok_or("整体应用原清单缺失")?
                        .target
                        .data()
                        .clone(),
                )
            };
            self.application = Some(Retained::prepare(
                &self.active,
                OriginalCheckpoint {
                    source: &binding,
                    data: &original,
                    drafts: &proof,
                },
                &drafts,
                terminal,
                &self.cancel,
                &check,
            )?);
        }
        self.confirm_application_inputs(&current)
    }

    pub fn resume_runtime_application_preview(
        &mut self,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        crate::lan::migration::handover::require_preview(
            self.path(),
            self.source.source.user_data.path(),
        )?;
        self.resume_runtime_handback_preview(&current)?;
        if self.application.is_none() {
            let binding = self.source.binding().clone();
            let prepared = self
                .source
                .prepared
                .as_mut()
                .ok_or("整体应用恢复缺少原快照")?;
            let (_, proof) = prepared.target.browser_archive(&self.cancel, &current)?;
            self.application = Some(Retained::load(
                &self.active,
                OriginalCheckpoint {
                    source: &binding,
                    data: prepared.target.data(),
                    drafts: &proof,
                },
                self.handback.as_ref().ok_or("整体应用恢复缺少终态")?,
                None,
                &self.cancel,
                &current,
            )?);
        }
        let retained = self.application.as_mut().ok_or("整体应用准备未取得")?;
        retained.complete(&self.cancel, &current)?;
        self.confirm_application_inputs(&current)
    }

    fn confirm_application_inputs(
        &mut self,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<Receipt, String> {
        self.confirm_custody()?;
        self.handback
            .as_ref()
            .ok_or("整体应用准备缺少终态")?
            .confirm(&self.cancel, current)?;
        let retained = self.application.as_ref().ok_or("整体应用准备缺失")?;
        retained.confirm(&self.cancel, current)?;
        Ok(retained.receipt())
    }
}
