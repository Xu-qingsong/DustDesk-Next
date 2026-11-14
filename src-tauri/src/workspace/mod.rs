pub mod api;
mod assets;
pub mod backup;
pub mod backup_api;
mod clipboard;
pub mod commands;
pub mod draft_browser;
pub mod draft_export;
pub mod draft_import;
pub mod draft_lineage;
pub mod draft_transaction;
pub(crate) mod export_file;
#[cfg(windows)]
pub mod handoff_snapshot;
#[cfg(windows)]
pub mod legacy_source;
pub mod merge;
#[cfg(windows)]
mod native_record_replace;
pub mod normalize;
pub mod note_image_api;
pub mod note_images;
mod ownership;
pub mod productivity;
pub mod project_export;
pub mod resource_api;
pub mod resources;
#[cfg(all(windows, debug_assertions))]
pub mod runtime_boot;
#[cfg(windows)]
pub mod snapshot_preparation;
pub mod validation;
pub mod widgets;

use chrono::{Duration, SecondsFormat, Utc};
use fs2::FileExt;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_BYTES: u64 = 64 * 1024 * 1024;

mod organizer;
pub mod organizer_api;
mod organizer_files;
mod organizer_journal;
mod organizer_positions;
mod organizer_session;
mod organizer_smart;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub state: Value,
    pub revision: u64,
    pub path: String,
}

pub struct WorkspaceStore {
    root: PathBuf,
    _ownership: ownership::Ownership,
    _lock: File,
    revision: u64,
    seen: bool,
    productivity_ready: bool,
    backup_status: backup::BackupStatus,
    last_backup_check: Option<std::time::Instant>,
    clients: HashMap<String, Value>,
    organizer_desktop: Option<PathBuf>,
    organizer_session_ready: bool,
    organizer_session_starting: bool,
    draft_browser_verified: std::sync::atomic::AtomicBool,
}

pub(crate) fn require_plain_file(file: &File) -> Result<(), String> {
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
        || ownership::inspect_file(file)?.reparse
    {
        return Err("文件不是普通文件或包含重解析点".into());
    }
    Ok(())
}

pub(crate) fn checked_path(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                let mut redirected = metadata.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    redirected |= metadata.file_attributes() & 0x400 != 0;
                }
                if redirected {
                    return Err("工作区路径含符号链接或重解析点，操作已拒绝".into());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "检查工作区路径失败（{}）：{error}",
                    ancestor.display()
                ))
            }
        }
    }
    Ok(())
}

fn read_json(path: &Path) -> Result<Option<Value>, ReadFailure> {
    checked_path(path).map_err(ReadFailure::Io)?;
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ReadFailure::Io(error.to_string())),
    };
    let metadata = file
        .metadata()
        .map_err(|error| ReadFailure::Io(error.to_string()))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(ReadFailure::Io("工作区不是普通文件或超过大小限制".into()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ReadFailure::Io(error.to_string()))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ReadFailure::Io("工作区超过大小限制".into()));
    }
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| ReadFailure::Corrupt)?;
    if value["SchemaVersion"]
        .as_f64()
        .is_some_and(|version| version > 3.0)
    {
        return Err(ReadFailure::Io("工作区版本较新，请使用新版应用打开".into()));
    }
    validation::validate_input(&value).map_err(|_| ReadFailure::Corrupt)?;
    Ok(Some(value))
}

enum ReadFailure {
    Io(String),
    Corrupt,
}

#[cfg(windows)]
fn replacement_path_diagnostic(path: &Path) -> String {
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let attributes = match fs::symlink_metadata(path) {
        Ok(metadata) => format!(
            "属性=0x{:08x}，只读={}",
            metadata.file_attributes(),
            metadata.permissions().readonly()
        ),
        Err(error) => format!("读取属性失败：{error}"),
    };
    let access = match OpenOptions::new()
        .access_mode(0x0001_0080)
        .share_mode(FILE_SHARE_READ.0 | FILE_SHARE_WRITE.0 | FILE_SHARE_DELETE.0)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT.0 | FILE_FLAG_BACKUP_SEMANTICS.0)
        .open(path)
    {
        Ok(_handle) => "可打开（未执行删除）".to_string(),
        Err(error) => error.to_string(),
    };
    format!("{attributes}，DELETE 访问探测={access}")
}

#[cfg(windows)]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(source: *const u16, target: *const u16, flags: u32) -> i32;
    }
    let source_wide: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileExW(source_wide.as_ptr(), target_wide.as_ptr(), 1 | 8) } == 0 {
        let error = std::io::Error::last_os_error();
        return Err(format!(
            "原子替换文件失败（MoveFileExW，{} -> {}）：{}；失败后即时采样：源[{}]，目标[{}]",
            source.display(),
            target.display(),
            error,
            replacement_path_diagnostic(source),
            replacement_path_diagnostic(target)
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_file(source: &Path, target: &Path) -> Result<(), String> {
    fs::rename(source, target).map_err(|error| error.to_string())
}

struct TemporaryFile(PathBuf);
impl Drop for TemporaryFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(windows)]
impl TryFrom<dustdesk_tauri::legacy_source::binding::snapshot::RuntimeOwner> for WorkspaceStore {
    type Error = String;

    fn try_from(
        owner: dustdesk_tauri::legacy_source::binding::snapshot::RuntimeOwner,
    ) -> Result<Self, Self::Error> {
        let root = owner.path().to_path_buf();
        Self::open_owned(root, ownership::Ownership::from_runtime(owner)?)
    }
}

impl WorkspaceStore {
    pub fn open(root: PathBuf) -> Result<Self, String> {
        if !root.is_absolute() {
            return Err("工作区目录必须为绝对路径".into());
        }
        checked_path(&root)?;
        fs::create_dir_all(&root).map_err(|error| error.to_string())?;
        checked_path(&root)?;
        let ownership = ownership::Ownership::acquire(&root)?;
        Self::open_owned(root, ownership)
    }

    fn open_owned(root: PathBuf, ownership: ownership::Ownership) -> Result<Self, String> {
        checked_path(&root)?;
        draft_transaction::require_electron_complete(&root, &ownership.identity(&root)?)?;
        #[cfg(windows)]
        snapshot_preparation::recover(&root, &ownership)?;
        let lock_path = root.join("workspace.lock");
        checked_path(&lock_path)?;
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        lock.try_lock_exclusive()
            .map_err(|_| "工作区正由另一个进程使用，未打开".to_string())?;
        Ok(Self {
            root,
            _ownership: ownership,
            _lock: lock,
            revision: 0,
            seen: false,
            productivity_ready: false,
            backup_status: backup::BackupStatus::default(),
            last_backup_check: None,
            clients: HashMap::new(),
            organizer_desktop: None,
            organizer_session_ready: false,
            organizer_session_starting: false,
            draft_browser_verified: std::sync::atomic::AtomicBool::new(false),
        })
    }

    fn path(&self) -> PathBuf {
        self.root.join("workspace.json")
    }
    fn backup(&self) -> PathBuf {
        self.root.join("workspace.json.bak")
    }

    fn snapshot(&self, state: Value) -> Snapshot {
        Snapshot {
            state,
            revision: self.revision,
            path: self.root.display().to_string(),
        }
    }

    fn read(&mut self) -> Result<Value, String> {
        self._ownership.confirm_runtime()?;
        self.require_draft_recovered()?;
        self.recover_organizer()?;
        let mut exists = false;
        match read_json(&self.path()) {
            Ok(Some(state)) => {
                let mut normalized = normalize::normalize(state.clone())?;
                let inline_images = normalized["ClipboardHistory"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|item| {
                        item["Kind"] == "Image"
                            && item["ImagePngBase64"]
                                .as_str()
                                .is_some_and(|text| !text.is_empty())
                    });
                if normalized != state || inline_images {
                    self.write(&mut normalized, true)?;
                }
                self.seen = true;
                return self.finish_organizer_startup(normalized);
            }
            Ok(None) => {}
            Err(ReadFailure::Corrupt) => exists = true,
            Err(ReadFailure::Io(error)) => return Err(error),
        }
        match read_json(&self.backup()) {
            Ok(Some(state)) => {
                let mut state = normalize::normalize(state)?;
                self.write(&mut state, false)?;
                return self.finish_organizer_startup(state);
            }
            Ok(None) => {}
            Err(ReadFailure::Corrupt) => exists = true,
            Err(ReadFailure::Io(error)) => return Err(error),
        }
        if exists {
            return Err("工作区与备份均无法完整读取，原文件已保留".into());
        }
        if self.seen {
            return Err("工作区文件已丢失，未创建空白数据".into());
        }
        Err("工作区尚未初始化".into())
    }

    fn temporary(&self) -> Result<(TemporaryFile, File), String> {
        let path = self.root.join(format!(
            "workspace.json.tauri-tmp-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        checked_path(&path)?;
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        Ok((TemporaryFile(path), file))
    }

    fn write(&mut self, state: &mut Value, backup: bool) -> Result<(), String> {
        self._ownership.confirm_runtime()?;
        self.require_draft_recovered()?;
        validation::validate(state)?;
        assets::externalize(&self.root, state)?;
        let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err("工作区超过大小限制".into());
        }
        checked_path(&self.path())?;
        checked_path(&self.backup())?;
        match fs::metadata(self.backup()) {
            Ok(metadata) if !metadata.is_file() => {
                return Err("保存失败：恢复副本不是普通文件".into())
            }
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => {
                return Err(error.to_string())
            }
            _ => {}
        }
        let (temporary, mut file) = self.temporary()?;
        file.write_all(&bytes).map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        if !matches!(read_json(&temporary.0), Ok(Some(_))) {
            return Err("临时工作区校验失败".into());
        }
        if backup
            && self
                .path()
                .try_exists()
                .map_err(|error| error.to_string())?
        {
            let (temporary_backup, backup_file) = self.temporary()?;
            drop(backup_file);
            fs::copy(self.path(), &temporary_backup.0).map_err(|error| error.to_string())?;
            OpenOptions::new()
                .write(true)
                .open(&temporary_backup.0)
                .and_then(|file| file.sync_all())
                .map_err(|error| error.to_string())?;
            replace_file(&temporary_backup.0, &self.backup())?;
        }
        checked_path(&self.path())?;
        replace_file(&temporary.0, &self.path())?;
        self.revision += 1;
        self.seen = true;
        Ok(())
    }

    pub fn initialize(&mut self, state: Value, client: &str) -> Result<Snapshot, String> {
        self.require_draft_recovered()?;
        self.recover_organizer()?;
        validation::validate_input(&state)?;
        let mut state = normalize::normalize(state)?;
        if self.seen
            || self
                .path()
                .try_exists()
                .map_err(|error| error.to_string())?
            || self
                .backup()
                .try_exists()
                .map_err(|error| error.to_string())?
        {
            return Err("已有工作区或恢复副本，禁止覆盖初始化".into());
        }
        self.write(&mut state, false)?;
        self.clients.insert(client.into(), state.clone());
        Ok(self.snapshot(state))
    }

    pub fn load(&mut self, client: &str) -> Result<Snapshot, String> {
        let state = self.read()?;
        self.clients.insert(client.into(), state.clone());
        Ok(self.snapshot(state))
    }

    pub fn image(&mut self, id: &str) -> Result<Vec<u8>, String> {
        let state = self.read()?;
        let item = state["ClipboardHistory"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["Id"] == id && item["Kind"] == "Image")
            .ok_or("剪贴板图片记录不存在")?;
        assets::read(&self.root, item)
    }

    pub fn ensure_productivity(&mut self) -> Result<Option<Snapshot>, String> {
        if self.productivity_ready {
            return Ok(None);
        }
        let mut state = self.read()?;
        let changed = productivity::recover(&mut state);
        if changed {
            self.write(&mut state, true)?;
        }
        self.productivity_ready = true;
        Ok(changed.then(|| self.snapshot(state)))
    }

    pub fn productivity_action(
        &mut self,
        action: Value,
    ) -> Result<Snapshot, productivity::ActionFailure> {
        let action = serde_json::from_value(action)
            .map_err(|_| productivity::ActionFailure::from("操作参数无效"))?;
        self.ensure_productivity()?;
        let mut state = self.read()?;
        match action {
            productivity::Action::ResourceRelink {
                resource,
                replacement,
            } => resources::relink(&self.root, &mut state, &resource, &replacement, Utc::now())?,
            action => productivity::apply(&mut state, action, Utc::now())?,
        }
        let mut state = normalize::normalize(state)?;
        self.write(&mut state, true)?;
        Ok(self.snapshot(state))
    }

    pub fn productivity_tick(
        &mut self,
    ) -> Result<(Option<Snapshot>, Vec<productivity::Notification>), String> {
        let recovered = self.ensure_productivity()?;
        let mut state = self.read()?;
        let was_running =
            !state["ActiveFocus"].is_null() && !state["ActiveFocus"]["RunningSince"].is_null();
        let now = Utc::now();
        let changed = productivity::tick(&mut state, now);
        let mut notifications = productivity::reminders(&mut state, now);
        if was_running && state["ActiveFocus"].is_null() {
            notifications.push(productivity::Notification {
                title: "专注完成",
                body: "本轮专注已记录，可以休息一下。".into(),
            });
        }
        if !changed && notifications.is_empty() {
            return Ok((recovered, notifications));
        }
        self.write(&mut state, true)?;
        Ok((Some(self.snapshot(state)), notifications))
    }

    pub fn stop_productivity(&mut self) -> Result<Option<Snapshot>, String> {
        if !self.productivity_ready {
            return Ok(None);
        }
        let mut state = self.read()?;
        if state["ActiveFocus"].is_null() || state["ActiveFocus"]["RunningSince"].is_null() {
            return Ok(None);
        }
        productivity::apply(&mut state, productivity::Action::FocusPause, Utc::now())
            .map_err(|error| error.error)?;
        self.write(&mut state, true)?;
        Ok(Some(self.snapshot(state)))
    }

    pub fn save(
        &mut self,
        incoming: Value,
        baseline: Option<Value>,
        client: &str,
    ) -> Result<Snapshot, String> {
        validation::validate_input(&incoming)?;
        if let Some(baseline) = &baseline {
            validation::validate_input(baseline)?;
        }
        let latest = self.read()?;
        let baseline = baseline
            .or_else(|| self.clients.get(client).cloned())
            .unwrap_or_else(|| latest.clone());
        let mut merged =
            normalize::normalize(merge::merge_workspace(&latest, &incoming, &baseline))?;
        preserve_owned_state(&latest, &mut merged)?;
        self.write(&mut merged, true)?;
        self.clients.insert(client.into(), merged.clone());
        Ok(self.snapshot(merged))
    }
}

fn preserve_owned_state(previous: &Value, next: &mut Value) -> Result<(), String> {
    let now = Utc::now();
    let time = now.to_rfc3339_opts(SecondsFormat::Millis, true);
    let expires = (now + Duration::days(30)).to_rfc3339_opts(SecondsFormat::Millis, true);
    let mut recycled: Vec<Value> = previous["RecycleBin"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter(|item| {
                    validation::parse_date(&item["ExpiresAt"]).is_some_and(|date| date > now)
                })
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    for (name, kind) in [
        ("Todos", "task"),
        ("Notes", "note"),
        ("Projects", "project"),
        ("Launchers", "launcher"),
        ("LinkGroups", "group"),
    ] {
        for value in previous[name].as_array().ok_or("原工作区数据不完整")? {
            if !next[name]
                .as_array()
                .ok_or("新工作区数据不完整")?
                .iter()
                .any(|item| item["Id"] == value["Id"])
            {
                recycled.push(json!({"Id":Uuid::new_v4().to_string(),"kind":kind,"value":value,"DeletedAt":time,"ExpiresAt":expires}));
            }
        }
    }
    for group in previous["LinkGroups"]
        .as_array()
        .ok_or("链接分组数据不完整")?
    {
        if !next["LinkGroups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["Id"] == group["Id"])
        {
            continue;
        }
        for value in group["Links"].as_array().unwrap() {
            if !next["LinkGroups"].as_array().unwrap().iter().any(|item| {
                item["Links"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|link| link["Id"] == value["Id"])
            }) {
                recycled.push(json!({"Id":Uuid::new_v4().to_string(),"kind":"link","value":value,"parent":{"Id":group["Id"],"Name":group["Name"]},"DeletedAt":time,"ExpiresAt":expires}));
            }
        }
    }
    next["RecycleBin"] = Value::Array(recycled);
    for key in [
        "ActiveFocus",
        "FocusSessions",
        "OrganizerUndoStack",
        "OrganizerDesktopRestores",
        "OrganizerDesktopPositions",
        "OrganizerTransactionId",
    ] {
        if let Some(value) = previous.get(key) {
            next[key] = value.clone();
        } else {
            next.as_object_mut().unwrap().remove(key);
        }
    }
    next["OrganizerRules"] = Value::Array(
        previous["OrganizerRules"]
            .as_array()
            .map(|rules| {
                rules
                    .iter()
                    .filter(|rule| {
                        next["DesktopCategories"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .any(|category| category["Id"] == rule["CategoryId"])
                    })
                    .cloned()
                    .collect()
            })
            .unwrap_or_default(),
    );
    validation::validate(next)
}

#[cfg(test)]
mod backup_tests;
#[cfg(test)]
mod note_image_tests;
#[cfg(test)]
mod productivity_tests;
#[cfg(test)]
mod resource_tests;
#[cfg(test)]
mod tests;
