use super::protocol::{
    fingerprint, safe_integer, utf16_len, valid_fingerprint, Device, Manifest, MAX_JSON_BYTES,
    MAX_SAFE_INTEGER,
};
use rustls::{
    pki_types::{pem::PemObject, CertificateDer, PrivateKeyDer},
    sign::CertifiedKey,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::HashSet,
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
};

// Deliberately no Debug/Serialize: error messages and reports must never include
// a private key. Loading an absent identity does not create one.
pub struct Identity {
    pub id: String,
    pub fingerprint: String,
    certified_key: Arc<CertifiedKey>,
}

#[derive(Deserialize)]
struct IdentityData {
    id: String,
    cert: String,
    key: String,
    fingerprint: String,
}

impl Drop for IdentityData {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.key.zeroize();
    }
}

impl Identity {
    pub fn load(root: &Path) -> Result<Option<Self>, String> {
        read_optional(root, "identity.json", 1024 * 1024)?
            .map(|bytes| Self::parse(&zeroize::Zeroizing::new(bytes)))
            .transpose()
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > 1024 * 1024 {
            return Err("设备身份文件过大".into());
        }
        let mut data: IdentityData =
            serde_json::from_slice(bytes).map_err(|_| "设备身份文件损坏")?;
        if data.id.is_empty() || utf16_len(&data.id) > 80 || !valid_fingerprint(&data.fingerprint) {
            return Err("设备身份文件损坏".into());
        }
        let certs = CertificateDer::pem_slice_iter(data.cert.as_bytes())
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "设备证书无效")?;
        if certs.len() != 1 || fingerprint(certs[0].as_ref()) != data.fingerprint {
            return Err("设备证书指纹不一致".into());
        }
        let key = PrivateKeyDer::from_pem_slice(data.key.as_bytes()).map_err(|_| "设备私钥无效")?;
        let provider = rustls::crypto::ring::default_provider();
        let certified_key = CertifiedKey::from_der(certs, key, &provider)
            .map_err(|_| "设备证书与私钥不匹配或不可用")?;
        certified_key
            .keys_match()
            .map_err(|_| "设备证书与私钥不匹配或无法核验")?;
        Ok(Self {
            id: std::mem::take(&mut data.id),
            fingerprint: std::mem::take(&mut data.fingerprint),
            certified_key: Arc::new(certified_key),
        })
    }

    pub fn certified_key(&self) -> Arc<CertifiedKey> {
        self.certified_key.clone()
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Direction {
    Send,
    Receive,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Preparing,
    Waiting,
    Transferring,
    Paused,
    Failed,
    Completed,
    Canceled,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TransferView {
    pub id: String,
    pub direction: Direction,
    pub device: String,
    pub name: String,
    #[serde(deserialize_with = "safe_integer")]
    pub total: u64,
    #[serde(deserialize_with = "safe_integer")]
    pub done: u64,
    pub speed: f64,
    pub status: Status,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Task {
    pub view: TransferView,
    pub peer: Device,
    pub manifest: Manifest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sources: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prepared: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub staging: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub files: Option<Map<String, Value>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Task {
    pub(super) fn validate(&self) -> Result<(), String> {
        self.manifest.validate()?;
        self.peer.validate()?;
        let expected = match self.view.direction {
            Direction::Send => self.manifest.id.clone(),
            Direction::Receive => format!("{}-{}", self.peer.fingerprint, self.manifest.id),
        };
        if self.view.id != expected
            || !self.view.speed.is_finite()
            || self.view.speed < 0.0
            || self.view.total > MAX_SAFE_INTEGER
            || self.view.done > MAX_SAFE_INTEGER
        {
            return Err("续传任务身份或进度无效".into());
        }
        if let Some(files) = &self.files {
            for (index, target) in files {
                let index = index.parse::<usize>().ok().filter(|value| {
                    value.to_string() == *index && *value < self.manifest.entries.len()
                });
                if index.is_none() || target.as_str().is_none_or(str::is_empty) {
                    return Err("续传文件映射无效".into());
                }
            }
        }
        Ok(())
    }

    pub(super) fn restart(&mut self) {
        for name in ["token", "controller", "running"] {
            self.extra.remove(name);
        }
        self.view.speed = 0.0;
        if !matches!(self.view.status, Status::Completed | Status::Canceled) {
            self.view.status = Status::Paused;
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct State {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: Vec<String>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl State {
    pub fn load(root: &Path) -> Result<Self, String> {
        match read_optional(root, "state.json", MAX_JSON_BYTES)? {
            Some(bytes) => Self::parse(&bytes),
            None => Ok(Self::default()),
        }
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() > MAX_JSON_BYTES {
            return Err("续传状态过大".into());
        }
        let mut state: Self =
            serde_json::from_slice(bytes).map_err(|_| "续传状态无法读取：格式无效")?;
        let mut trusted = HashSet::new();
        state
            .trusted
            .retain(|fp| valid_fingerprint(fp) && trusted.insert(fp.clone()));
        let mut ids = HashSet::new();
        for task in &mut state.tasks {
            task.validate()?;
            if !ids.insert(task.view.id.clone()) {
                return Err("续传状态含重复任务".into());
            }
            task.restart();
        }
        Ok(state)
    }

    /// Serialization only. The service must own a shutdown/persistence gate
    /// before atomically publishing these bytes; this core never writes files.
    pub fn encode_for_restart(&self) -> Result<Vec<u8>, String> {
        let mut state = self.clone();
        state.tasks.retain(|task| task.manifest.text.is_none());
        for task in &mut state.tasks {
            task.validate()?;
            task.restart();
        }
        let bytes = serde_json::to_vec(&state).map_err(|_| "续传状态无法编码")?;
        if bytes.len() > MAX_JSON_BYTES {
            return Err("续传状态过大".into());
        }
        Ok(bytes)
    }
}

fn read_optional(root: &Path, name: &str, limit: usize) -> Result<Option<Vec<u8>>, String> {
    if !root.is_absolute() {
        return Err("局域网状态目录必须为绝对路径".into());
    }
    let path = root.join(name);
    let mut ancestor = PathBuf::new();
    for component in path.components() {
        ancestor.push(component);
        match std::fs::symlink_metadata(&ancestor) {
            Ok(info) => {
                #[cfg(windows)]
                let linked = {
                    use std::os::windows::fs::MetadataExt;
                    info.file_attributes() & 0x400 != 0
                };
                #[cfg(not(windows))]
                let linked = info.file_type().is_symlink();
                if linked {
                    return Err("局域网状态路径不能包含链接或重解析点".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(format!(
                    "无法检查局域网状态 {}：{error}",
                    ancestor.display()
                ))
            }
        }
    }
    let mut options = File::options();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1).custom_flags(0x0020_0000); // Read sharing; OPEN_REPARSE_POINT.
    }
    let mut file = options
        .open(&path)
        .map_err(|error| format!("无法读取局域网状态 {}：{error}", path.display()))?;
    let info = file.metadata().map_err(|error| error.to_string())?;
    if !info.is_file() || info.len() > limit as u64 {
        return Err("局域网状态不是普通文件或超过大小限制".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if info.file_attributes() & 0x400 != 0 {
            return Err("局域网状态不能为重解析点".into());
        }
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取局域网状态失败 {}：{error}", path.display()))?;
    if bytes.len() > limit {
        return Err("局域网状态超过大小限制".into());
    }
    Ok(Some(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn task() -> Value {
        json!({"peer":{"id":"peer","name":"设备","address":"127.0.0.1","port":12345,"fingerprint":"a".repeat(64),"lastSeen":1.25},
            "manifest":{"id":"task","name":"文件","entries":[],"directories":[]},
            "view":{"id":"task","direction":"send","device":"设备","name":"文件","total":0,"done":0,"speed":123,"status":"transferring"},
            "token":"b".repeat(64),"controller":{},"running":{},"prepared":false,"sources":["C:/original"],"future":{"kept":true}})
    }

    fn parse(value: &Value) -> Result<State, String> {
        State::parse(&serde_json::to_vec(value).unwrap())
    }

    #[test]
    fn restart_revokes_session_credentials_and_preserves_unknown_local_state_without_writes() {
        let value = json!({"enabled":true,"trusted":["a".repeat(64),"bad","a".repeat(64)],"tasks":[task()],"future":123});
        let state = parse(&value).unwrap();
        assert_eq!(state.trusted.len(), 1);
        assert_eq!(state.tasks[0].view.status, Status::Paused);
        assert_eq!(state.tasks[0].view.speed, 0.0);
        let saved: Value = serde_json::from_slice(&state.encode_for_restart().unwrap()).unwrap();
        for name in ["token", "running", "controller"] {
            assert!(saved["tasks"][0].get(name).is_none());
        }
        assert_eq!(saved["tasks"][0]["future"]["kept"], true);
        assert_eq!(saved["future"], 123);
        assert_eq!(saved["tasks"][0]["sources"][0], "C:/original");
        assert!(value["tasks"][0].get("token").is_some());
    }

    #[test]
    fn every_nonterminal_status_restarts_paused_and_terminal_statuses_remain_terminal() {
        for status in [
            "preparing",
            "waiting",
            "transferring",
            "paused",
            "failed",
            "completed",
            "canceled",
        ] {
            let mut task = task();
            task["view"]["status"] = json!(status);
            let state = parse(&json!({"tasks":[task]})).unwrap();
            assert_eq!(
                serde_json::to_value(state.tasks[0].view.status).unwrap(),
                if ["completed", "canceled"].contains(&status) {
                    json!(status)
                } else {
                    json!("paused")
                }
            );
        }
    }

    #[test]
    fn corrupt_or_misattributed_tasks_are_rejected_without_partial_recovery() {
        for change in ["direction", "id", "port", "file-index", "duplicate"] {
            let mut task = task();
            match change {
                "direction" => task["view"]["direction"] = json!("other"),
                "id" => task["view"]["id"] = json!("other"),
                "port" => task["peer"]["port"] = json!(65536),
                "file-index" => task["files"] = json!({"0":"C:/outside"}),
                _ => {}
            }
            let tasks = if change == "duplicate" {
                vec![task.clone(), task]
            } else {
                vec![task]
            };
            assert!(parse(&json!({"tasks":tasks})).is_err(), "{change}");
        }
    }

    #[test]
    fn text_is_never_persisted_as_a_restart_task() {
        let mut task = task();
        task["manifest"]["text"] = json!("仅在本次运行");
        task["view"]["text"] = json!("仅在本次运行");
        let state = parse(&json!({"tasks":[task]})).unwrap();
        let saved: Value = serde_json::from_slice(&state.encode_for_restart().unwrap()).unwrap();
        assert!(saved["tasks"].as_array().unwrap().is_empty());
    }

    #[test]
    fn missing_state_is_lazy_and_corrupt_state_or_identity_remains_untouched() {
        let root = std::env::temp_dir().join(format!("dustdesk-lan-core-{}", uuid::Uuid::new_v4()));
        assert!(!State::load(&root).unwrap().enabled);
        assert!(Identity::load(&root).unwrap().is_none());
        assert!(!root.exists());
        std::fs::create_dir(&root).unwrap();
        for name in ["state.json", "identity.json"] {
            std::fs::write(root.join(name), b"broken-private-data").unwrap();
        }
        assert!(State::load(&root).is_err());
        assert!(Identity::load(&root).is_err());
        for name in ["state.json", "identity.json"] {
            assert_eq!(
                std::fs::read(root.join(name)).unwrap(),
                b"broken-private-data"
            );
        }
        assert!(State::load(Path::new("relative")).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
