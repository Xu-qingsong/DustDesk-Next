use super::{
    assets, checked_path, normalize, productivity, replace_file, validation, Snapshot,
    TemporaryFile, WorkspaceStore, MAX_BYTES,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::{DateTime, Local, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_IMAGE: u64 = 12 * 1024 * 1024;

fn reserve_backup(size: &mut usize, additional: usize) -> Result<(), String> {
    *size = size.saturating_add(additional);
    if *size as u64 > MAX_BYTES {
        return Err("备份超过 64 MiB 大小限制".into());
    }
    Ok(())
}

#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupStatus {
    pub error: String,
    pub last_automatic_backup_at: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub modified_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub path: String,
    pub modified_at: String,
    pub tasks: usize,
    pub notes: usize,
    pub projects: usize,
    pub links: usize,
    pub focus_sessions: usize,
    pub recycle_entries: usize,
    pub fingerprint: String,
    pub warnings: Vec<String>,
}

fn timestamp(metadata: &Metadata) -> Result<String, String> {
    let modified: DateTime<Utc> = metadata
        .modified()
        .map_err(|error| error.to_string())?
        .into();
    Ok(modified.to_rfc3339_opts(SecondsFormat::Millis, true))
}

fn read_bytes(path: &Path, limit: u64) -> Result<(Vec<u8>, Metadata), String> {
    checked_path(path)?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("文件不是普通文件或超过大小限制".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > limit {
        return Err("文件超过大小限制".into());
    }
    Ok((bytes, metadata))
}

pub(super) fn within(root: &Path, target: &Path) -> Result<(), String> {
    if !target.is_absolute()
        || target
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err("资源路径无效".into());
    }
    checked_path(target)?;
    checked_path(root)?;
    let canonical_root = fs::canonicalize(root).map_err(|error| error.to_string())?;
    let canonical_target = fs::canonicalize(target).map_err(|error| error.to_string())?;
    if canonical_target == canonical_root || !canonical_target.starts_with(&canonical_root) {
        return Err("资源路径超出受管目录".into());
    }
    Ok(())
}

fn image_payload(content: &str) -> Result<Vec<u8>, String> {
    if content.is_empty() || content.len() > (MAX_IMAGE as usize).div_ceil(3) * 4 {
        return Err("备份中的图片数据无效或过大".into());
    }
    let bytes = STANDARD
        .decode(content)
        .map_err(|_| "备份中的图片编码无效")?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE || STANDARD.encode(&bytes) != content {
        return Err("备份中的图片编码无效或过大".into());
    }
    Ok(bytes)
}

fn extension(original: &str) -> Result<String, String> {
    let extension = Path::new(original)
        .extension()
        .and_then(|text| text.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "bmp"].contains(&extension.as_str()) {
        return Err("备份图片格式无效".into());
    }
    Ok(extension)
}

fn note_payloads(state: &Value) -> Result<Vec<(String, String, Vec<u8>)>, String> {
    let Some(value) = state.get("BackupNoteAssets") else {
        return Ok(Vec::new());
    };
    let items = value.as_object().ok_or("备份中的图片集合无效")?;
    items
        .iter()
        .map(|(original, content)| {
            Ok((
                original.clone(),
                extension(original)?,
                image_payload(content.as_str().ok_or("备份中的图片数据无效")?)?,
            ))
        })
        .collect()
}

fn notes(state: &Value) -> Vec<&Value> {
    state["Notes"]
        .as_array()
        .unwrap()
        .iter()
        .chain(
            state["RecycleBin"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|item| item["kind"] == "note")
                .map(|item| &item["value"]),
        )
        .collect()
}

struct RestoredAssets {
    created: Vec<PathBuf>,
    committed: bool,
}
impl Drop for RestoredAssets {
    fn drop(&mut self) {
        if !self.committed {
            for target in &self.created {
                let _ = fs::remove_file(target);
            }
        }
    }
}

impl WorkspaceStore {
    fn backup_directory(&self) -> PathBuf {
        self.root.join("Backups")
    }

    fn publish_backup(&self, bytes: &[u8], kind: &str) -> Result<PathBuf, String> {
        if bytes.len() as u64 > MAX_BYTES {
            return Err("备份超过 64 MiB 大小限制".into());
        }
        let directory = self.backup_directory();
        checked_path(&directory)?;
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        checked_path(&directory)?;
        let name = format!(
            "{}-{}-{}.json",
            kind,
            productivity::time(Utc::now()).replace([':', '.'], "-"),
            Uuid::new_v4()
        );
        let target = directory.join(name);
        checked_path(&target)?;
        let temporary = TemporaryFile(target.with_extension("json.tmp"));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary.0)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        let copied = read_bytes(&temporary.0, MAX_BYTES)?.0;
        if copied != bytes {
            return Err("备份临时文件校验失败".into());
        }
        if target.try_exists().map_err(|error| error.to_string())? {
            return Err("备份目标已存在".into());
        }
        checked_path(&target)?;
        replace_file(&temporary.0, &target)?;
        Ok(target)
    }

    fn export_backup(&self, state: &Value, kind: &str) -> Result<PathBuf, String> {
        let mut portable = state.clone();
        portable["BackupNoteAssets"] = json!({});
        portable["BackupWarnings"] = json!([]);
        let mut size = serde_json::to_vec(&portable)
            .map_err(|error| error.to_string())?
            .len();
        reserve_backup(&mut size, 0)?;
        let mut images = Map::new();
        let mut warnings = Vec::new();
        for note in notes(state) {
            let Some(original) = note["BackgroundImagePath"]
                .as_str()
                .filter(|text| !text.is_empty())
            else {
                continue;
            };
            if images.contains_key(original) {
                continue;
            }
            let target = PathBuf::from(original);
            let result = (|| {
                within(&self.root.join("NoteBackgrounds"), &target)?;
                read_bytes(&target, MAX_IMAGE).map(|result| result.0)
            })();
            match result {
                Ok(bytes) => {
                    let key_size = serde_json::to_vec(original)
                        .map_err(|error| error.to_string())?
                        .len();
                    reserve_backup(&mut size, key_size + bytes.len().div_ceil(3) * 4 + 4)?;
                    images.insert(original.into(), json!(STANDARD.encode(bytes)));
                }
                Err(_) if kind == "before-restore" => {
                    let warning = format!(
                        "便签「{}」的背景未能读取，已保留原路径：{}",
                        note["Title"].as_str().unwrap_or(""),
                        original
                    );
                    reserve_backup(
                        &mut size,
                        serde_json::to_vec(&warning)
                            .map_err(|error| error.to_string())?
                            .len()
                            + 1,
                    )?;
                    warnings.push(warning);
                }
                Err(error) => return Err(error),
            }
        }
        for item in portable["ClipboardHistory"].as_array_mut().unwrap() {
            if item["Kind"] != "Image" {
                continue;
            }
            match assets::read(&self.root, item) {
                Ok(bytes) => {
                    let before = serde_json::to_vec(&item)
                        .map_err(|error| error.to_string())?
                        .len();
                    item["ImagePngBase64"] = json!(STANDARD.encode(bytes));
                    let after = serde_json::to_vec(&item)
                        .map_err(|error| error.to_string())?
                        .len();
                    reserve_backup(&mut size, after.saturating_sub(before))?;
                }
                Err(_) if kind == "before-restore" => {
                    let warning = format!(
                        "剪贴板图片未能读取，已保留原引用：{}",
                        item["ImageFileName"].as_str().unwrap_or("")
                    );
                    reserve_backup(
                        &mut size,
                        serde_json::to_vec(&warning)
                            .map_err(|error| error.to_string())?
                            .len()
                            + 1,
                    )?;
                    warnings.push(warning);
                }
                Err(error) => return Err(error),
            }
        }
        portable["BackupNoteAssets"] = Value::Object(images);
        portable["BackupWarnings"] = json!(warnings);
        let bytes = serde_json::to_vec(&portable).map_err(|error| error.to_string())?;
        self.publish_backup(&bytes, kind)
    }

    pub fn create_backup(&mut self) -> Result<String, String> {
        let state = self.read()?;
        Ok(self.export_backup(&state, "manual")?.display().to_string())
    }

    pub fn list_backups(&self) -> Result<Vec<BackupEntry>, String> {
        let directory = self.backup_directory();
        checked_path(&directory)?;
        if !directory.try_exists().map_err(|error| error.to_string())? {
            return Ok(Vec::new());
        }
        let mut output = Vec::new();
        for entry in fs::read_dir(&directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                continue;
            }
            let target = entry.path();
            if !target
                .extension()
                .and_then(|text| text.to_str())
                .is_some_and(|text| text.eq_ignore_ascii_case("json"))
            {
                continue;
            }
            checked_path(&target)?;
            let metadata = fs::metadata(&target).map_err(|error| error.to_string())?;
            output.push(BackupEntry {
                path: target.display().to_string(),
                name: entry.file_name().to_string_lossy().into_owned(),
                size: metadata.len(),
                modified_at: timestamp(&metadata)?,
            });
        }
        output.sort_by(|first, second| {
            second
                .modified_at
                .cmp(&first.modified_at)
                .then_with(|| second.name.cmp(&first.name))
        });
        Ok(output)
    }

    fn inspect_backup(&self, target: &Path) -> Result<(Value, BackupPreview), String> {
        if target.extension().and_then(|text| text.to_str()) != Some("json") {
            return Err("备份路径无效".into());
        }
        within(&self.backup_directory(), target)?;
        let (bytes, metadata) = read_bytes(target, MAX_BYTES)?;
        let raw: Value =
            serde_json::from_slice(&bytes).map_err(|_| "备份文件不完整或版本不受支持")?;
        validation::validate_input(&raw)?;
        note_payloads(&raw)?;
        let preview = BackupPreview {
            path: target.display().to_string(),
            modified_at: timestamp(&metadata)?,
            tasks: raw["Todos"].as_array().unwrap().len(),
            notes: raw["Notes"].as_array().unwrap().len(),
            projects: raw["Projects"].as_array().unwrap().len(),
            links: raw["LinkGroups"]
                .as_array()
                .unwrap()
                .iter()
                .map(|group| group["Links"].as_array().unwrap().len())
                .sum(),
            focus_sessions: raw["FocusSessions"].as_array().map_or(0, Vec::len),
            recycle_entries: raw["RecycleBin"].as_array().map_or(0, Vec::len),
            fingerprint: format!("{:x}", Sha256::digest(&bytes)),
            warnings: raw["BackupWarnings"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect(),
        };
        Ok((raw, preview))
    }

    pub fn preview_backup(&self, target: &str) -> Result<BackupPreview, String> {
        Ok(self.inspect_backup(Path::new(target))?.1)
    }

    fn protect_before_restore(&self) -> Result<(), String> {
        if self
            .path()
            .try_exists()
            .map_err(|error| error.to_string())?
        {
            let bytes = read_bytes(&self.path(), MAX_BYTES)?.0;
            if let Ok(state) = serde_json::from_slice::<Value>(&bytes) {
                if validation::validate_input(&state).is_ok() {
                    let normalized = normalize::normalize(state)?;
                    self.export_backup(&normalized, "before-restore")?;
                    return Ok(());
                }
            }
        }
        for path in [self.path(), self.backup()] {
            if path.try_exists().map_err(|error| error.to_string())? {
                let bytes = read_bytes(&path, MAX_BYTES)?.0;
                self.publish_backup(&bytes, "before-restore-damaged")?;
            }
        }
        Ok(())
    }

    pub fn restore_backup(
        &mut self,
        target: Option<String>,
        fingerprint: Option<String>,
    ) -> Result<Snapshot, String> {
        self.recover_organizer()?;
        let selected = match target.filter(|text| !text.is_empty()) {
            Some(target) => target,
            None => self
                .list_backups()?
                .first()
                .map(|entry| entry.path.clone())
                .ok_or("暂无可恢复的备份")?,
        };
        let (raw, preview) = self.inspect_backup(Path::new(&selected))?;
        if fingerprint
            .as_ref()
            .is_some_and(|value| !value.is_empty() && *value != preview.fingerprint)
        {
            return Err("备份已变化，请重新预览".into());
        }
        let payloads = note_payloads(&raw)?;
        let mut restored = normalize::normalize(raw)?;
        self.protect_before_restore()?;
        let mut staged = RestoredAssets {
            created: Vec::new(),
            committed: false,
        };
        let mut replacements = HashMap::new();
        if !payloads.is_empty() {
            let directory = self.root.join("NoteBackgrounds");
            checked_path(&directory)?;
            fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
            checked_path(&directory)?;
            for (original, extension, bytes) in payloads {
                let target = directory.join(format!("restored-{}.{}", Uuid::new_v4(), extension));
                checked_path(&target)?;
                let mut file = OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&target)
                    .map_err(|error| error.to_string())?;
                staged.created.push(target.clone());
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|error| error.to_string())?;
                replacements.insert(original, target);
            }
        }
        fn remap(note: &mut Value, replacements: &HashMap<String, PathBuf>) {
            if let Some(target) = note["BackgroundImagePath"]
                .as_str()
                .and_then(|source| replacements.get(source))
            {
                note["BackgroundImagePath"] = json!(target.display().to_string());
                note["BackgroundImageFileName"] =
                    json!(target.file_name().unwrap().to_string_lossy());
            }
        }
        for note in restored["Notes"].as_array_mut().unwrap() {
            remap(note, &replacements);
        }
        for item in restored["RecycleBin"].as_array_mut().unwrap() {
            if item["kind"] == "note" {
                remap(&mut item["value"], &replacements);
            }
        }
        for note in notes(&restored) {
            if let Some(path) = note["BackgroundImagePath"]
                .as_str()
                .filter(|text| !text.is_empty())
            {
                let path = Path::new(path);
                within(&self.root.join("NoteBackgrounds"), path)?;
                read_bytes(path, MAX_IMAGE)?;
            }
        }
        for item in restored["ClipboardHistory"].as_array().unwrap() {
            if item["Kind"] == "Image" {
                assets::read(&self.root, item)?;
            }
        }
        assets::externalize_tracked(&self.root, &mut restored, &mut staged.created)?;
        if !restored["ActiveFocus"].is_null() {
            let checkpoint =
                validation::parse_date(&restored["ActiveFocus"]["CheckpointAt"]).unwrap();
            restored["ActiveFocus"]["ElapsedSeconds"] =
                json!(productivity::elapsed(&restored["ActiveFocus"], checkpoint));
            restored["ActiveFocus"]["RunningSince"] = Value::Null;
        }
        restored.as_object_mut().unwrap().remove("BackupNoteAssets");
        restored.as_object_mut().unwrap().remove("BackupWarnings");
        self.write(&mut restored, false)?;
        staged.committed = true;
        self.productivity_ready = true;
        self.clients.clear();
        self.last_backup_check = None;
        Ok(self.snapshot(restored))
    }

    pub fn backup_status(&self) -> BackupStatus {
        self.backup_status.clone()
    }

    pub fn read_note_image(&mut self, path: &str) -> Result<String, String> {
        let state = self.read()?;
        if !notes(&state)
            .iter()
            .any(|note| note["BackgroundImagePath"] == path)
        {
            return Err("图片未被当前工作区授权引用".into());
        }
        let target = Path::new(path);
        within(&self.root.join("NoteBackgrounds"), target)?;
        let bytes = read_bytes(target, MAX_IMAGE)?.0;
        let kind = match extension(path)?.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            "bmp" => "image/bmp",
            _ => unreachable!(),
        };
        Ok(format!("data:{};base64,{}", kind, STANDARD.encode(bytes)))
    }

    pub fn backup_maintenance(&mut self) {
        if self
            .last_backup_check
            .is_some_and(|instant| instant.elapsed() < Duration::from_secs(60))
        {
            return;
        }
        self.last_backup_check = Some(Instant::now());
        let outcome = self.maintain_backups(Utc::now());
        self.backup_status.error = outcome.err().unwrap_or_default();
    }

    pub(super) fn maintain_backups(&mut self, now: DateTime<Utc>) -> Result<(), String> {
        let state = self.read()?;
        if state["Settings"]["AutomaticBackupEnabled"] != true {
            return Ok(());
        }
        let today = now.with_timezone(&Local).date_naive();
        let points: Vec<_> = self
            .list_backups()?
            .into_iter()
            .filter(|entry| entry.name.starts_with("auto-"))
            .collect();
        self.backup_status.last_automatic_backup_at = points
            .first()
            .map(|entry| entry.modified_at.clone())
            .unwrap_or_default();
        if !points.iter().any(|entry| {
            DateTime::parse_from_rfc3339(&entry.modified_at)
                .is_ok_and(|date| date.with_timezone(&Local).date_naive() == today)
        }) {
            self.export_backup(&state, "auto")?;
            self.backup_status.last_automatic_backup_at = productivity::time(Utc::now());
        }
        let retention = state["Settings"]["BackupRetentionDays"]
            .as_f64()
            .unwrap_or(30.0)
            .round()
            .clamp(1.0, 365.0);
        for entry in points {
            if DateTime::parse_from_rfc3339(&entry.modified_at).is_ok_and(|date| {
                (now - date.with_timezone(&Utc)).num_milliseconds() as f64
                    > retention * 86_400_000.0
            }) {
                let target = Path::new(&entry.path);
                within(&self.backup_directory(), target)?;
                fs::remove_file(target).map_err(|error| error.to_string())?;
            }
        }
        Ok(())
    }
}
