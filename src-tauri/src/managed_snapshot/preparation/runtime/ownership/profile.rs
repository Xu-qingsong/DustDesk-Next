use super::{active, hash, publish, read_retained, Active, Directory, File};
use crate::lan::files::FileIdentity;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio_util::sync::CancellationToken;

const FOLDER: &str = "BrowserProfile";
const ORIGIN: &str = "http://tauri.localhost";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Binding {
    ownership_id: String,
    path: PathBuf,
    identity: FileIdentity,
    origin: String,
}

impl Binding {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn ownership_id(&self) -> &str {
        &self.ownership_id
    }
    pub fn fingerprint(&self) -> String {
        hash(
            format!(
                "{:016x}:{:016x}:{}",
                self.identity.volume, self.identity.index, self.origin
            )
            .as_bytes(),
        )
    }
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Intent {
    format: String,
    version: u32,
    ownership_id: String,
    ownership_sha256: String,
    parent_identity: FileIdentity,
    destination: PathBuf,
    origin: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Decision {
    format: String,
    version: u32,
    intent_sha256: String,
    identity: FileIdentity,
}

pub(crate) struct Profile {
    root: Arc<Directory>,
    record: Arc<Directory>,
    intent: File,
    decision: File,
    binding: Binding,
}

fn destination(owner: &Active) -> Result<(Arc<Directory>, String), String> {
    let parent = Directory::open(owner.path().parent().ok_or("运行目录没有父目录")?)
        .map_err(|error| error.to_string())?;
    if parent.identity().map_err(|error| error.to_string())? != owner.proof.parent_identity {
        return Err("浏览器配置必须属于原运行 Data 父目录".into());
    }
    Ok((parent, format!("DustDesk-WebView2-{}", owner.receipt.id)))
}

fn ownership_hash(owner: &Active) -> Result<String, String> {
    Ok(hash(
        &serde_json::to_vec(owner.receipt()).map_err(|error| error.to_string())?,
    ))
}

fn exact_records(root: &Directory) -> Result<(), String> {
    let mut names = fs::read_dir(root.path())
        .map_err(|error| error.to_string())?
        .map(|entry| {
            entry
                .map(|entry| entry.file_name())
                .map_err(|error| error.to_string())
        })
        .collect::<Result<Vec<_>, _>>()?;
    names.sort();
    if names
        != [
            std::ffi::OsString::from("decision.json"),
            std::ffi::OsString::from("intent.json"),
        ]
    {
        return Err("浏览器配置绑定包含未知或中断记录，未修复或覆盖".into());
    }
    Ok(())
}

impl Profile {
    pub(crate) fn create(owner: &Active, cancel: &CancellationToken) -> Result<Self, String> {
        owner.confirm(cancel, &|| Ok(()))?;
        let (parent, name) = destination(owner)?;
        let path = parent.path().join(&name);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            _ => return Err("浏览器目标已存在或无法检查，未复用旧 profile".into()),
        }
        fs::create_dir(owner._record.path().join(FOLDER))
            .map_err(|error| format!("浏览器绑定记录已存在或创建失败，须显式恢复：{error}"))?;
        let record = owner
            ._record
            .child(FOLDER, false)
            .map_err(|error| error.to_string())?;
        active(cancel, &|| Ok(()))?;
        let intent_sha256 = publish(
            &record,
            "intent.json",
            &Intent {
                format: "dustdesk-runtime-browser-intent".into(),
                version: 1,
                ownership_id: owner.receipt.id.clone(),
                ownership_sha256: ownership_hash(owner)?,
                parent_identity: parent.identity().map_err(|error| error.to_string())?,
                destination: path.clone(),
                origin: ORIGIN.into(),
            },
        )?;
        active(cancel, &|| Ok(()))?;
        fs::create_dir(&path).map_err(|error| format!("未创建全新浏览器 profile：{error}"))?;
        let root = parent
            .child(&name, false)
            .map_err(|error| error.to_string())?;
        if fs::read_dir(root.path())
            .map_err(|error| error.to_string())?
            .next()
            .is_some()
        {
            return Err("全新浏览器 profile 在绑定前已包含内容".into());
        }
        owner.confirm(cancel, &|| Ok(()))?;
        publish(
            &record,
            "decision.json",
            &Decision {
                format: "dustdesk-runtime-browser-bound".into(),
                version: 1,
                intent_sha256,
                identity: root.identity().map_err(|error| error.to_string())?,
            },
        )?;
        drop(root);
        Self::resume(owner, cancel)
    }

    pub(crate) fn resume(owner: &Active, cancel: &CancellationToken) -> Result<Self, String> {
        owner.confirm(cancel, &|| Ok(()))?;
        let record = owner
            ._record
            .child(FOLDER, false)
            .map_err(|error| error.to_string())?;
        exact_records(&record)?;
        let (intent, intent_sha256, intent_file) = read_retained::<Intent>(&record, "intent.json")?
            .ok_or("浏览器绑定意图缺失，未猜测原 profile")?;
        let (decision, _, decision_file) = read_retained::<Decision>(&record, "decision.json")?
            .ok_or("浏览器绑定未持久完成，未复用或替换已存在目录")?;
        let (parent, name) = destination(owner)?;
        let path = parent.path().join(&name);
        if intent.format != "dustdesk-runtime-browser-intent"
            || intent.version != 1
            || intent.ownership_id != owner.receipt.id
            || intent.ownership_sha256 != ownership_hash(owner)?
            || intent.parent_identity != parent.identity().map_err(|error| error.to_string())?
            || intent.destination != path
            || intent.origin != ORIGIN
            || decision.format != "dustdesk-runtime-browser-bound"
            || decision.version != 1
            || decision.intent_sha256 != intent_sha256
        {
            return Err("浏览器绑定不属于原运行所有权、父目录或固定来源".into());
        }
        let root = parent
            .child(&name, false)
            .map_err(|error| error.to_string())?;
        if root.identity().map_err(|error| error.to_string())? != decision.identity {
            return Err("浏览器 profile 物理身份已变化，未授权复制目录".into());
        }
        let profile = Self {
            root,
            record,
            intent: intent_file,
            decision: decision_file,
            binding: Binding {
                ownership_id: owner.receipt.id.clone(),
                path,
                identity: decision.identity,
                origin: ORIGIN.into(),
            },
        };
        profile.confirm(cancel)?;
        owner.confirm(cancel, &|| Ok(()))?;
        Ok(profile)
    }

    pub(crate) fn binding(&self) -> &Binding {
        &self.binding
    }

    pub(crate) fn confirm(&self, cancel: &CancellationToken) -> Result<(), String> {
        active(cancel, &|| Ok(()))?;
        exact_records(&self.record)?;
        self.intent.confirm()?;
        self.decision.confirm()?;
        if self.root.identity().map_err(|error| error.to_string())? != self.binding.identity {
            return Err("已绑定浏览器 profile 物理身份失效".into());
        }
        active(cancel, &|| Ok(()))
    }

    pub(crate) fn verify(&mut self, cancel: &CancellationToken) -> Result<(), String> {
        self.confirm(cancel)?;
        self.intent.verify(cancel, &|| Ok(()))?;
        self.decision.verify(cancel, &|| Ok(()))?;
        self.confirm(cancel)
    }
}
