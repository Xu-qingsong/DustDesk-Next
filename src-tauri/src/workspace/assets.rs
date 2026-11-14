use super::{checked_path, replace_file, TemporaryFile};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;

fn decode(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() || value.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("剪贴板图片无效或过大".into());
    }
    let bytes = STANDARD
        .decode(value)
        .map_err(|_| "剪贴板图片编码无效".to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES || STANDARD.encode(&bytes) != value {
        return Err("剪贴板图片编码无效".into());
    }
    Ok(bytes)
}

fn asset_name(bytes: &[u8]) -> String {
    format!("{:x}.png", Sha256::digest(bytes))
}

pub fn read(root: &Path, item: &Value) -> Result<Vec<u8>, String> {
    if let Some(inline) = item["ImagePngBase64"]
        .as_str()
        .filter(|text| !text.is_empty())
    {
        return decode(inline);
    }
    let name = item["ImageAssetName"]
        .as_str()
        .ok_or("剪贴板图片引用无效")?;
    if name.len() != 68
        || !name.ends_with(".png")
        || !name.as_bytes()[..64]
            .iter()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err("剪贴板图片引用无效".into());
    }
    let path = root.join("ClipboardImages").join(name);
    checked_path(&path)?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_BYTES as u64 {
        return Err("剪贴板图片过大或不是普通文件".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_IMAGE_BYTES || asset_name(&bytes) != name {
        return Err("剪贴板图片已损坏".into());
    }
    Ok(bytes)
}

pub fn externalize(root: &Path, state: &mut Value) -> Result<(), String> {
    externalize_tracked(root, state, &mut Vec::new())
}

pub(super) fn externalize_tracked(
    root: &Path,
    state: &mut Value,
    created: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let images = state["ClipboardHistory"]
        .as_array_mut()
        .ok_or("剪贴板历史不完整")?;
    for item in images {
        if item["Kind"] != "Image" {
            continue;
        }
        let Some(content) = item["ImagePngBase64"]
            .as_str()
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        let bytes = decode(content)?;
        let name = asset_name(&bytes);
        let directory = root.join("ClipboardImages");
        checked_path(&directory)?;
        fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
        checked_path(&directory)?;
        let target = directory.join(&name);
        checked_path(&target)?;
        let existed = target.try_exists().map_err(|error| error.to_string())?;
        if fs::metadata(&target)
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MAX_IMAGE_BYTES as u64)
            && fs::read(&target).is_ok_and(|existing| existing == bytes)
        {
            item["ImageAssetName"] = json!(name);
            item["ImagePngBase64"] = json!("");
            continue;
        }
        let temporary = TemporaryFile(directory.join(format!("{}.tmp", Uuid::new_v4())));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary.0)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        checked_path(&target)?;
        replace_file(&temporary.0, &target)?;
        if !existed {
            created.push(target);
        }
        item["ImageAssetName"] = json!(name);
        item["ImagePngBase64"] = json!("");
    }
    Ok(())
}
