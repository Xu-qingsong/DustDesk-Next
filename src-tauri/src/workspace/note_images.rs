use super::{backup, checked_path, productivity, Snapshot, WorkspaceStore};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub const MAX_BYTES: u64 = 12 * 1024 * 1024;
pub struct ImageSource {
    pub extension: String,
    pub bytes: Vec<u8>,
}
fn extension(source: &Path) -> Result<String, String> {
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !["png", "jpg", "jpeg", "webp", "gif", "bmp"].contains(&extension.as_str()) {
        return Err("请选择 PNG、JPG、WebP、GIF 或 BMP 图片".into());
    }
    Ok(extension)
}
pub fn read_source(source: &str) -> Result<ImageSource, String> {
    if productivity::trim(source).is_empty()
        || source.encode_utf16().count() > 4096
        || source.contains('\0')
    {
        return Err("请输入有效的图片文件路径".into());
    }
    let path =
        std::path::absolute(productivity::trim(source)).map_err(|error| error.to_string())?;
    crate::system::path_key(path.to_str().ok_or("图片路径无效")?)?;
    let extension = extension(&path)?;
    checked_path(&path)?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("请选择普通图片文件，不支持目录或符号链接".into());
    }
    let file = File::open(&path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_BYTES {
        return Err("图片为空或超过 12 MB".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.is_empty() || bytes.len() as u64 > MAX_BYTES {
        return Err("图片为空或超过 12 MB".into());
    }
    checked_path(&path)?;
    Ok(ImageSource { extension, bytes })
}
fn mime(extension: &str) -> &'static str {
    match extension {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}
fn note<'state>(
    state: &'state mut Value,
    id: &str,
    expected: &Option<Option<String>>,
) -> Result<&'state mut Value, String> {
    let note = state["Notes"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|note| note["Id"] == id)
        .ok_or("便签不存在，请重新选择")?;
    if let Some(expected) = expected {
        if note["BackgroundImagePath"].as_str().unwrap_or("") != expected.as_deref().unwrap_or("") {
            return Err("背景已在其他窗口修改，请重新操作".into());
        }
    }
    Ok(note)
}
struct Staged(Option<PathBuf>);
impl Drop for Staged {
    fn drop(&mut self) {
        if let Some(path) = &self.0 {
            let _ = fs::remove_file(path);
        }
    }
}
fn referenced(state: &Value, path: &str) -> bool {
    state["Notes"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            state["RecycleBin"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|entry| entry["kind"] == "note")
                .map(|entry| &entry["value"]),
        )
        .any(|note| {
            note["BackgroundImagePath"]
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case(path))
        })
}
impl WorkspaceStore {
    pub fn check_note_image(
        &mut self,
        id: &str,
        expected: &Option<Option<String>>,
    ) -> Result<(), String> {
        note(&mut self.read()?, id, expected).map(|_| ())
    }
    fn cleanup_note_image(&self, state: &Value, previous: Option<String>) {
        let Some(previous) = previous.filter(|value| !value.is_empty()) else {
            return;
        };
        if referenced(state, &previous) {
            return;
        }
        match super::read_json(&self.backup()) {
            Ok(Some(recovery)) => {
                if referenced(&recovery, &previous) {
                    return;
                }
            }
            Ok(None) => {}
            Err(_) => return,
        }
        let path = Path::new(&previous);
        if backup::within(&self.root.join("NoteBackgrounds"), path).is_err() {
            return;
        }
        let _ = fs::remove_file(path);
    }
    pub fn import_note_image(
        &mut self,
        id: &str,
        image: ImageSource,
        expected: Option<Option<String>>,
    ) -> Result<(Snapshot, Value), String> {
        let mut state = self.read()?;
        let note = note(&mut state, id, &expected)?;
        let previous = note["BackgroundImagePath"].as_str().map(str::to_owned);
        let directory = self.root.join("NoteBackgrounds");
        checked_path(&directory)?;
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        checked_path(&directory)?;
        let name = format!("note-{}.{}", Uuid::new_v4(), image.extension);
        let path = directory.join(&name);
        checked_path(&path)?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|error| error.to_string())?;
        let mut staged = Staged(Some(path.clone()));
        let written = file
            .write_all(&image.bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string());
        drop(file);
        written?;
        note["BackgroundImagePath"] = json!(path.display().to_string());
        note["BackgroundImageFileName"] = json!(name);
        note["UpdatedAt"] = json!(productivity::time(chrono::Utc::now()));
        self.write(&mut state, true)?;
        staged.0 = None;
        self.cleanup_note_image(&state, previous);
        let result = json!({"ok":true,"path":path.display().to_string(),"fileName":name,"dataUrl":format!("data:{};base64,{}",mime(&image.extension),STANDARD.encode(&image.bytes))});
        Ok((self.snapshot(state), result))
    }
    pub fn clear_note_image(
        &mut self,
        id: &str,
        expected: Option<Option<String>>,
    ) -> Result<Snapshot, String> {
        let mut state = self.read()?;
        let note = note(&mut state, id, &expected)?;
        let previous = note["BackgroundImagePath"].as_str().map(str::to_owned);
        note["BackgroundImagePath"] = Value::Null;
        note["BackgroundImageFileName"] = json!("");
        note["ImageOnly"] = json!(false);
        note["UpdatedAt"] = json!(productivity::time(chrono::Utc::now()));
        self.write(&mut state, true)?;
        self.cleanup_note_image(&state, previous);
        Ok(self.snapshot(state))
    }
}
