//! A terminal checkpoint of the latest owned Data and native-observed browser
//! archive. It does not overwrite the original source or authorize activation.
use crate::{
    lan::{files::Directory, migration::Checkpoint},
    managed_snapshot::{
        bundle::{draft_proof, DraftProof},
        preparation::{
            publish, read_retained,
            runtime::ownership::{profile::Binding, Active},
        },
        source::SourceInventory,
        target::File,
        Manifest,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{fs, sync::Arc};
use tokio_util::sync::CancellationToken;

const MAX_BYTES: usize = 64 * 1024 * 1024;
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct LanProof {
    pub(super) checkpoint: Checkpoint,
    pub(super) handback_intent_sha256: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    ownership_id: String,
    ownership_sha256: String,
    data_manifest_sha256: String,
    workspace_sha256: String,
    drafts: DraftProof,
    browser: Binding,
    lan: LanProof,
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

/// Metadata only; the actual owner and pinned checkpoint must stay alive until
/// the native host has stopped. This is not a permission to reopen either Data.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Receipt {
    pub ownership_id: String,
    pub intent_sha256: String,
    pub data_manifest_sha256: String,
    pub workspace_sha256: String,
    pub drafts: DraftProof,
    pub browser: Binding,
    pub lan: LanProof,
    pub production_ready: bool,
    pub migration_complete: bool,
}

pub(super) struct Retained {
    record: Arc<Directory>,
    intent: File,
    data: File,
    drafts: File,
    decision: Option<File>,
    inventory: SourceInventory,
    receipt: Receipt,
}

fn names(record: &Directory, completed: bool) -> Result<(), String> {
    let mut names = fs::read_dir(record.path())
        .map_err(|error| error.to_string())?
        .take(5)
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    let expected = if completed {
        vec![
            "browser-drafts.json",
            "data.json",
            "decision.json",
            "intent.json",
        ]
    } else {
        vec!["browser-drafts.json", "data.json", "intent.json"]
    };
    if names
        != expected
            .into_iter()
            .map(std::ffi::OsString::from)
            .collect::<Vec<_>>()
    {
        return Err("整体运行交还包含未知、缺失或中断记录，未覆盖或猜测修复".into());
    }
    Ok(())
}

fn publish_bytes(record: &Arc<Directory>, name: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > MAX_BYTES {
        return Err("整体交还载荷超过 64 MiB，未截断".into());
    }
    let mut file = record
        .create(&format!("checkpoint-{}.part", uuid::Uuid::new_v4()))
        .map_err(|error| error.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync())
        .and_then(|_| file.publish(record, name))
        .map_err(|error| error.to_string())
}

fn read_bytes(
    record: &Arc<Directory>,
    name: &str,
    expected: &str,
    cancel: &CancellationToken,
    current: &impl Fn() -> Result<(), String>,
) -> Result<(File, zeroize::Zeroizing<Vec<u8>>), String> {
    let mut file = File::capture(
        record.read(name).map_err(|error| error.to_string())?,
        expected.into(),
    )?;
    let bytes = file.read_verified(MAX_BYTES, cancel, current)?;
    Ok((file, bytes))
}

fn browser_proof(bytes: &[u8], workspace: &str, binding: &str) -> Result<DraftProof, String> {
    let proof = draft_proof(bytes, workspace, binding, false)?;
    let archive: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
    let payload: serde_json::Value =
        serde_json::from_str(archive["payload"].as_str().ok_or("交还草稿缺少载荷")?)
            .map_err(|error| error.to_string())?;
    if payload["source"]["runtime"] != "tauri" {
        return Err("整体交还必须来自当前 Tauri 浏览器，不能回放旧来源草稿".into());
    }
    Ok(proof)
}

impl Retained {
    pub(super) fn application_inputs(
        &mut self,
        destination: &std::path::Path,
        id: &str,
        cancel: &CancellationToken,
        current: &impl Fn() -> Result<(), String>,
    ) -> Result<
        (
            crate::managed_snapshot::runtime_data::PreparedData,
            zeroize::Zeroizing<Vec<u8>>,
        ),
        String,
    > {
        self.complete(cancel, current)?;
        let drafts = self.drafts.read_verified(MAX_BYTES, cancel, current)?;
        let data = self
            .inventory
            .materialize(destination, id, cancel, current)?;
        self.confirm(cancel, current)?;
        Ok((data, drafts))
    }

    pub(super) fn manifest(&self) -> &Manifest {
        self.inventory.manifest()
    }

    pub(super) fn seal(
        owner: &Active,
        browser: &Binding,
        lan: &LanProof,
        drafts: &[u8],
        workspace: &str,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        owner.require_runtime_writable()?;
        owner.confirm(cancel, &current)?;
        let inventory =
            SourceInventory::capture_current(owner.data_root(), workspace, cancel, &current)?;
        let data = serde_json::to_vec(inventory.manifest()).map_err(|error| error.to_string())?;
        if data.len() > MAX_BYTES {
            return Err("整体交还清单超过上限".into());
        }
        let drafts_proof = browser_proof(drafts, workspace, &browser.fingerprint())?;
        let intent = Intent {
            format: "dustdesk-runtime-handback-intent".into(),
            version: 1,
            ownership_id: owner.receipt().id.clone(),
            ownership_sha256: hash(
                &serde_json::to_vec(owner.receipt()).map_err(|error| error.to_string())?,
            ),
            data_manifest_sha256: hash(&data),
            workspace_sha256: workspace.into(),
            drafts: drafts_proof,
            browser: browser.clone(),
            lan: lan.clone(),
        };
        current()?;
        let record = owner.runtime_handback_record(true)?;
        if fs::read_dir(record.path())
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
        {
            return Err("整体交还记录已存在，须显式恢复；未覆盖".into());
        }
        publish(&record, "intent.json", &intent)?;
        current()?;
        publish_bytes(&record, "data.json", &data)?;
        current()?;
        publish_bytes(&record, "browser-drafts.json", drafts)?;
        current()?;
        let mut retained = Self::load(owner, browser, lan, Some(inventory), cancel, &current)?;
        retained.complete(cancel, current)?;
        Ok(retained)
    }

    pub(super) fn load(
        owner: &Active,
        browser: &Binding,
        lan: &LanProof,
        inventory: Option<SourceInventory>,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<Self, String> {
        owner.confirm(cancel, &current)?;
        let record = owner.runtime_handback_record(false)?;
        let decision = read_retained::<Decision>(&record, "decision.json")?;
        names(&record, decision.is_some())?;
        let (intent, intent_sha256, intent_file) =
            read_retained::<Intent>(&record, "intent.json")?.ok_or("整体交还意图缺失")?;
        if intent.format != "dustdesk-runtime-handback-intent"
            || intent.version != 1
            || intent.ownership_id != owner.receipt().id
            || intent.ownership_sha256
                != hash(&serde_json::to_vec(owner.receipt()).map_err(|error| error.to_string())?)
            || &intent.browser != browser
            || &intent.lan != lan
            || intent.drafts.browser_binding != browser.fingerprint()
        {
            return Err("整体交还不属于原所有权、实际浏览器或原 LAN 终态".into());
        }
        let (data, bytes) = read_bytes(
            &record,
            "data.json",
            &intent.data_manifest_sha256,
            cancel,
            &current,
        )?;
        let manifest: Manifest =
            serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
        if manifest.source_path != owner.path().to_str().ok_or("运行目录路径无效")?
            || manifest.source_identity != owner.receipt().destination_identity
            || manifest.workspace_sha256 != intent.workspace_sha256
        {
            return Err("整体交还清单不属于原物理运行 Data 与最新工作区".into());
        }
        let inventory = match inventory {
            Some(inventory) => {
                if serde_json::to_vec(inventory.manifest())
                    .map_err(|error| error.to_string())?
                    .as_slice()
                    != bytes.as_slice()
                {
                    return Err("整体交还的实际封存清单已改变".into());
                }
                inventory.confirm(cancel, &current)?;
                inventory
            }
            None => SourceInventory::capture(owner.data_root(), manifest, cancel, &current)?,
        };
        let (drafts, bytes) = read_bytes(
            &record,
            "browser-drafts.json",
            &intent.drafts.archive_sha256,
            cancel,
            &current,
        )?;
        if browser_proof(
            &bytes,
            &intent.workspace_sha256,
            &intent.drafts.browser_binding,
        )? != intent.drafts
        {
            return Err("整体交还浏览器原文与持久意图不匹配".into());
        }
        let decision = match decision {
            Some((decision, _, file)) => {
                if decision.format != "dustdesk-runtime-handed-back"
                    || decision.version != 1
                    || decision.intent_sha256 != intent_sha256
                    || decision.production_ready
                    || decision.migration_complete
                {
                    return Err("整体交还决定与意图不匹配或越过生产切换边界".into());
                }
                Some(file)
            }
            None => None,
        };
        let retained = Self {
            record,
            intent: intent_file,
            data,
            drafts,
            decision,
            inventory,
            receipt: Receipt {
                ownership_id: intent.ownership_id,
                intent_sha256,
                data_manifest_sha256: intent.data_manifest_sha256,
                workspace_sha256: intent.workspace_sha256,
                drafts: intent.drafts,
                browser: intent.browser,
                lan: intent.lan,
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
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        names(&self.record, self.decision.is_some())?;
        self.intent.confirm()?;
        self.data.confirm()?;
        self.drafts.confirm()?;
        if let Some(file) = &self.decision {
            file.confirm()?;
        }
        self.inventory.confirm(cancel, current)
    }

    pub(super) fn complete(
        &mut self,
        cancel: &CancellationToken,
        current: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        self.confirm(cancel, &current)?;
        if self.decision.is_none() {
            publish(
                &self.record,
                "decision.json",
                &Decision {
                    format: "dustdesk-runtime-handed-back".into(),
                    version: 1,
                    intent_sha256: self.receipt.intent_sha256.clone(),
                    production_ready: false,
                    migration_complete: false,
                },
            )?;
            self.decision = Some(
                read_retained::<Decision>(&self.record, "decision.json")?
                    .ok_or("整体交还决定未发布")?
                    .2,
            );
        }
        self.confirm(cancel, current)
    }

    pub(super) fn receipt(&self) -> Receipt {
        self.receipt.clone()
    }
}
