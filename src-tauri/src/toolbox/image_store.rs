use serde::Serialize;
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

pub const MAX_BYTES: usize = 100 * 1024 * 1024;
const MAX_ITEMS: usize = 10000;

#[derive(Clone, Serialize)]
pub struct Asset {
    pub id: String,
    pub name: String,
    pub size: usize,
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "dustdesk-rust-tool-images-{}",
                uuid::Uuid::new_v4()
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }
    fn png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 1, 1);
            encoder.set_color(png::ColorType::Rgba);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[10, 20, 30, 128]).unwrap();
        }
        bytes
    }
    #[test]
    fn validates_static_formats_animation_dimensions_and_corrupt_headers_without_panics() {
        let bytes = png();
        assert_eq!(inspect(&bytes).unwrap(), "png");
        let mut animated = bytes.clone();
        animated.splice(33..33, [0, 0, 0, 0, b'a', b'c', b'T', b'L', 0, 0, 0, 0]);
        assert!(inspect(&animated).unwrap_err().contains("动画"));
        let mut huge = bytes.clone();
        huge[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
        assert!(inspect(&huge).unwrap_err().contains("6400"));
        for length in 0..24 {
            assert!(inspect(&bytes[..length]).is_err());
        }
        assert!(inspect(&vec![0; MAX_BYTES + 1]).is_err());
        let mut exact = bytes.clone();
        exact.resize(MAX_BYTES, 0);
        assert_eq!(inspect(&exact).unwrap(), "png");
        exact.push(0);
        assert!(inspect(&exact).is_err());
        let mut webp =
            b"RIFF\x00\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"
                .to_vec();
        assert_eq!(inspect(&webp).unwrap(), "webp");
        webp[20] = 2;
        assert!(inspect(&webp).unwrap_err().contains("动画"));
        assert_eq!(
            inspect(&[255, 216, 255, 192, 0, 7, 8, 0, 1, 0, 2]).unwrap(),
            "jpeg"
        );
        for malformed in [
            vec![255, 216, 255, 255, 255],
            vec![255, 216, 255, 192, 255, 255],
            b"GIF89a".to_vec(),
        ] {
            assert!(inspect(&malformed).is_err());
        }
    }
    #[test]
    fn imported_bytes_are_exact_and_assets_are_revoked_on_release_reset_or_old_epoch() {
        let service = Service::default();
        let asset = service.import(0, png(), "中文🪶.png", || Ok(())).unwrap();
        assert_eq!(asset.name, "中文🪶.png");
        assert_eq!(service.read(0, &asset.id, || Ok(())).unwrap(), png());
        service
            .release(0, std::slice::from_ref(&asset.id), || Ok(()))
            .unwrap();
        assert!(service.read(0, &asset.id, || Ok(())).is_err());
        let asset = service
            .import(0, png(), "clipboard.png", || Ok(()))
            .unwrap();
        service.reset();
        assert!(service.read(0, &asset.id, || Ok(())).is_err());
        assert!(service.read(1, &asset.id, || Ok(())).is_err());
        assert!(service.import(0, png(), "old.png", || Ok(())).is_err());
        assert!(service.state.lock().unwrap().assets.is_empty());
    }
    #[test]
    fn registration_is_all_or_nothing_and_path_reads_observe_changes() {
        let root = Fixture::new();
        let service = Service::default();
        let image = root.0.join("selected.png");
        fs::write(&image, png()).unwrap();
        assert!(service
            .register(
                0,
                vec![image.clone(), root.0.join("missing.png")],
                || Ok(())
            )
            .is_err());
        assert!(service.state.lock().unwrap().assets.is_empty());
        let asset = service
            .register(0, vec![image.clone()], || Ok(()))
            .unwrap()
            .remove(0);
        assert_eq!(service.read(0, &asset.id, || Ok(())).unwrap(), png());
        fs::write(&image, b"not an image").unwrap();
        assert!(service.read(0, &asset.id, || Ok(())).is_err());
        assert!(service
            .register(0, vec![root.0.clone()], || Ok(()))
            .is_err());
    }
    #[test]
    fn single_images_preserve_bytes_and_choose_a_new_name_instead_of_overwriting() {
        let root = Fixture::new();
        let service = Service::default();
        let target = root.0.join("result.png");
        fs::write(&target, b"keep").unwrap();
        let batch = service.begin(0, target.clone(), 1, || Ok(())).unwrap();
        service
            .write(0, &batch, "../中文.png", &png(), || Ok(()))
            .unwrap();
        let output = service.finish(0, &batch, || Ok(())).unwrap();
        assert_eq!(output.count, 1);
        assert_eq!(
            Path::new(output.path.as_ref().unwrap()),
            root.0.join("result-1.png")
        );
        assert_eq!(fs::read(output.path.unwrap()).unwrap(), png());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 2);
        assert_eq!(service.finish(0, &batch, || Ok(())).unwrap().count, 0);
    }
    #[test]
    fn zip_keeps_unicode_unique_names_and_partial_success_without_private_files() {
        let root = Fixture::new();
        let service = Service::default();
        let batch = service
            .begin(0, root.0.join("图片.zip"), 4, || Ok(()))
            .unwrap();
        for name in ["中文.png", "中文.png", "output.zip"] {
            service.write(0, &batch, name, &png(), || Ok(())).unwrap();
        }
        assert!(service
            .write(0, &batch, "broken.png", b"broken", || Ok(()))
            .is_err());
        let output = service.finish(0, &batch, || Ok(())).unwrap();
        assert_eq!(output.count, 3);
        let mut archive = zip::ZipArchive::new(File::open(output.path.unwrap()).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        for name in ["中文.png", "中文-1.png", "output.zip"] {
            let mut entry = archive.by_name(name).unwrap();
            assert_eq!(entry.compression(), zip::CompressionMethod::Stored);
            let mut bytes = Vec::new();
            entry.read_to_end(&mut bytes).unwrap();
            assert_eq!(bytes, png());
        }
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }
    #[test]
    fn active_batch_rejects_overflow_and_empty_or_cancelled_batches_leave_no_outputs() {
        let root = Fixture::new();
        let service = Service::default();
        let batch = service
            .begin(0, root.0.join("result.png"), 1, || Ok(()))
            .unwrap();
        assert!(service
            .begin(0, root.0.join("other.png"), 1, || Ok(()))
            .is_err());
        service
            .write(0, &batch, "image.png", &png(), || Ok(()))
            .unwrap();
        assert!(service
            .write(0, &batch, "overflow.png", &png(), || Ok(()))
            .is_err());
        service.cancel_batches();
        assert_eq!(service.finish(0, &batch, || Ok(())).unwrap().count, 0);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
        let batch = service
            .begin(0, root.0.join("empty.zip"), 2, || Ok(()))
            .unwrap();
        assert_eq!(service.finish(0, &batch, || Ok(())).unwrap().count, 0);
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
    #[test]
    fn cancellation_immediately_before_publication_preserves_existing_file_and_cleans_staging() {
        let root = Fixture::new();
        let service = Service::default();
        let target = root.0.join("keep.png");
        fs::write(&target, b"keep").unwrap();
        let batch = service.begin(0, target.clone(), 1, || Ok(())).unwrap();
        service
            .write(0, &batch, "image.png", &png(), || Ok(()))
            .unwrap();
        let calls = std::cell::Cell::new(0);
        assert!(service
            .finish(0, &batch, || {
                calls.set(calls.get() + 1);
                if calls.get() == 2 {
                    Err("cancel before publication".into())
                } else {
                    Ok(())
                }
            })
            .is_err());
        assert_eq!(fs::read(&target).unwrap(), b"keep");
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 1);
    }
    #[test]
    fn export_names_use_real_original_type_and_reject_invalid_or_revoked_selections() {
        let service = Service::default();
        let asset = service.import(0, png(), "wrong.jpg", || Ok(())).unwrap();
        assert_eq!(
            service
                .export_name(0, std::slice::from_ref(&asset.id), "original", || Ok(()))
                .unwrap(),
            ("wrong-处理后.png".into(), "png".into())
        );
        assert_eq!(
            service
                .export_name(0, std::slice::from_ref(&asset.id), "jpeg", || Ok(()))
                .unwrap()
                .1,
            "jpg"
        );
        assert_eq!(
            service
                .export_name(0, &[asset.id.clone(), asset.id.clone()], "webp", || Ok(()))
                .unwrap()
                .1,
            "zip"
        );
        for ids in [vec![], vec!["revoked".to_string()]] {
            assert!(service.export_name(0, &ids, "png", || Ok(())).is_err());
        }
        assert!(service
            .export_name(0, &[asset.id], "svg", || Ok(()))
            .is_err());
        assert!(!safe_name("../a:b\0.png").contains(['/', ':', '\0']));
    }
    #[test]
    fn replacing_a_staged_file_with_a_directory_fails_closed_and_cleans_the_batch() {
        let root = Fixture::new();
        let service = Service::default();
        let target = root.0.join("must-not-publish.png");
        let batch = service.begin(0, target.clone(), 1, || Ok(())).unwrap();
        let staged = service
            .write(0, &batch, "image.png", &png(), || Ok(()))
            .unwrap();
        fs::remove_file(&staged).unwrap();
        fs::create_dir(&staged).unwrap();
        assert!(service.finish(0, &batch, || Ok(())).is_err());
        assert!(!target.exists());
        assert_eq!(fs::read_dir(&root.0).unwrap().count(), 0);
    }
}
enum Source {
    Bytes(Vec<u8>),
    Path(PathBuf),
}
struct Entry {
    asset: Asset,
    source: Source,
}
struct Batch {
    target: PathBuf,
    directory: PathBuf,
    count: usize,
    files: Vec<PathBuf>,
}
impl Drop for Batch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
#[derive(Default)]
struct State {
    assets: HashMap<String, Entry>,
    batches: HashMap<String, Batch>,
}
#[derive(Default)]
pub struct Service {
    epoch: AtomicU64,
    state: Mutex<State>,
}
#[derive(Serialize)]
pub struct Output {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    pub count: usize,
}

pub fn inspect(bytes: &[u8]) -> Result<&'static str, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("单张图片最多 100 MiB".into());
    }
    let dimensions = |format, width: u32, height: u32| {
        if width == 0 || height == 0 {
            Err("图片尺寸无效或文件损坏".into())
        } else if u64::from(width) * u64::from(height) > 64_000_000 {
            Err("图片最多 6400 万像素".into())
        } else {
            Ok(format)
        }
    };
    if bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
        let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
        let mut offset = 8;
        while offset + 12 <= bytes.len() {
            let length = u32::from_be_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            if length > bytes.len() - offset - 12 {
                return Err("PNG 文件损坏".into());
            }
            if &bytes[offset + 4..offset + 8] == b"acTL" {
                return Err("暂不支持动画 PNG".into());
            }
            offset += length + 12;
        }
        return dimensions("png", width, height);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        let (mut width, mut height) = (0, 0);
        let mut offset = 12;
        while offset + 8 <= bytes.len() {
            let kind = &bytes[offset..offset + 4];
            let length =
                u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
            let payload = offset + 8;
            if length > bytes.len() - payload {
                return Err("WebP 文件损坏".into());
            }
            if kind == b"ANIM"
                || kind == b"ANMF"
                || (kind == b"VP8X" && length > 0 && bytes[payload] & 2 != 0)
            {
                return Err("暂不支持动画 WebP".into());
            }
            if kind == b"VP8X" && length >= 10 {
                width = 1 + u32::from_le_bytes([
                    bytes[payload + 4],
                    bytes[payload + 5],
                    bytes[payload + 6],
                    0,
                ]);
                height = 1 + u32::from_le_bytes([
                    bytes[payload + 7],
                    bytes[payload + 8],
                    bytes[payload + 9],
                    0,
                ]);
            }
            if width == 0 && kind == b"VP8 " && length >= 10 {
                width = u32::from(
                    u16::from_le_bytes(bytes[payload + 6..payload + 8].try_into().unwrap()) & 16383,
                );
                height = u32::from(
                    u16::from_le_bytes(bytes[payload + 8..payload + 10].try_into().unwrap())
                        & 16383,
                );
            }
            if width == 0 && kind == b"VP8L" && length >= 5 {
                let value = u32::from_le_bytes(bytes[payload + 1..payload + 5].try_into().unwrap());
                width = (value & 16383) + 1;
                height = ((value >> 14) & 16383) + 1;
            }
            offset = payload + length + (length & 1);
        }
        return dimensions("webp", width, height);
    }
    if bytes.starts_with(&[255, 216]) {
        let mut offset = 2;
        while offset + 4 <= bytes.len() {
            if bytes[offset] != 255 {
                return Err("JPG 文件损坏".into());
            }
            while offset < bytes.len() && bytes[offset] == 255 {
                offset += 1;
            }
            let Some(&marker) = bytes.get(offset) else {
                break;
            };
            offset += 1;
            if marker == 217 || marker == 218 {
                break;
            }
            if marker == 1 || (208..=215).contains(&marker) {
                continue;
            }
            if offset + 2 > bytes.len() {
                return Err("JPG 文件损坏".into());
            }
            let length = usize::from(u16::from_be_bytes(
                bytes[offset..offset + 2].try_into().unwrap(),
            ));
            if length < 2 || length > bytes.len() - offset {
                return Err("JPG 文件损坏".into());
            }
            if [
                192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
            ]
            .contains(&marker)
                && length >= 7
            {
                let height = u32::from(u16::from_be_bytes(
                    bytes[offset + 3..offset + 5].try_into().unwrap(),
                ));
                let width = u32::from(u16::from_be_bytes(
                    bytes[offset + 5..offset + 7].try_into().unwrap(),
                ));
                return dimensions("jpeg", width, height);
            }
            offset += length;
        }
        return Err("图片尺寸无效或文件损坏".into());
    }
    Err("请选择静态 PNG、JPG 或 WebP 图片".into())
}

fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']);
    if cleaned.is_empty() || cleaned.chars().all(|character| character == '.') {
        "未命名".into()
    } else {
        cleaned.chars().take(180).collect()
    }
}
fn read_source(path: &Path) -> Result<Vec<u8>, String> {
    crate::system::path_key(path.to_str().ok_or("图片路径无效")?)?;
    crate::workspace::checked_path(path)?;
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    crate::workspace::require_plain_file(&file)?;
    if metadata.len() > MAX_BYTES as u64 {
        return Err("图片文件已变化或超过限制".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    inspect(&bytes)?;
    crate::workspace::checked_path(path)?;
    Ok(bytes)
}
fn bytes(entry: &Entry) -> Result<Vec<u8>, String> {
    match &entry.source {
        Source::Bytes(bytes) => Ok(bytes.clone()),
        Source::Path(path) => read_source(path),
    }
}
fn candidate(path: &Path, index: usize) -> PathBuf {
    if index == 0 {
        return path.into();
    }
    let stem = path.file_stem().unwrap_or_default().to_string_lossy();
    let extension = path
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    path.with_file_name(format!("{stem}-{index}{extension}"))
}

impl Service {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::SeqCst)
    }
    fn check(&self, epoch: u64, active: &impl Fn() -> Result<(), String>) -> Result<(), String> {
        if self.epoch() != epoch {
            return Err("图片会话已失效，请重新导入".into());
        }
        active()
    }
    pub fn reset(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut state) = self.state.lock() {
            *state = State::default();
        }
    }
    pub fn cancel_batches(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.batches.clear();
        }
    }
    pub fn import(
        &self,
        epoch: u64,
        bytes: Vec<u8>,
        name: &str,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Asset, String> {
        inspect(&bytes)?;
        let asset = Asset {
            id: uuid::Uuid::new_v4().to_string(),
            name: safe_name(if name.is_empty() {
                "剪贴板.png"
            } else {
                name
            }),
            size: bytes.len(),
        };
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        if state.assets.len() >= MAX_ITEMS {
            return Err("图片列表最多 10000 项，请先移除不用的图片".into());
        }
        state.assets.insert(
            asset.id.clone(),
            Entry {
                asset: asset.clone(),
                source: Source::Bytes(bytes),
            },
        );
        Ok(asset)
    }
    pub fn register(
        &self,
        epoch: u64,
        paths: Vec<PathBuf>,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<Asset>, String> {
        if paths.len() > MAX_ITEMS {
            return Err("导入参数无效".into());
        }
        let mut staged = Vec::new();
        for path in paths {
            self.check(epoch, &active)?;
            let size = read_source(&path)?.len();
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("图片文件名无效")?
                .to_string();
            let asset = Asset {
                id: uuid::Uuid::new_v4().to_string(),
                name,
                size,
            };
            staged.push(Entry {
                asset,
                source: Source::Path(path),
            });
        }
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        if state.assets.len() + staged.len() > MAX_ITEMS {
            return Err("图片列表最多 10000 项，请先移除不用的图片".into());
        }
        let assets = staged.iter().map(|entry| entry.asset.clone()).collect();
        for entry in staged {
            state.assets.insert(entry.asset.id.clone(), entry);
        }
        Ok(assets)
    }
    pub fn read(
        &self,
        epoch: u64,
        id: &str,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Vec<u8>, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        let output = bytes(state.assets.get(id).ok_or("图片授权已失效，请重新导入")?)?;
        self.check(epoch, &active)?;
        Ok(output)
    }
    pub fn release(
        &self,
        epoch: u64,
        ids: &[String],
        active: impl Fn() -> Result<(), String>,
    ) -> Result<(), String> {
        if ids.len() > MAX_ITEMS {
            return Err("图片列表参数无效".into());
        }
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        for id in ids {
            state.assets.remove(id);
        }
        Ok(())
    }
    pub fn export_name(
        &self,
        epoch: u64,
        ids: &[String],
        format: &str,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<(String, String), String> {
        if ids.is_empty()
            || ids.len() > MAX_ITEMS
            || !["original", "png", "jpeg", "webp"].contains(&format)
        {
            return Err("图片导出参数无效".into());
        }
        let state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        for id in ids {
            if !state.assets.contains_key(id) {
                return Err("图片授权已失效，请重新导入".into());
            }
        }
        if ids.len() > 1 {
            return Ok(("DustDesk-图片.zip".into(), "zip".into()));
        }
        let entry = &state.assets[&ids[0]];
        let original;
        let format = if format == "original" {
            original = bytes(entry)?;
            inspect(&original)?
        } else {
            format
        };
        let extension = if format == "jpeg" { "jpg" } else { format };
        let stem = Path::new(&entry.asset.name)
            .file_stem()
            .unwrap_or_default()
            .to_string_lossy();
        Ok((
            format!("{}-处理后.{extension}", safe_name(&stem)),
            extension.into(),
        ))
    }
    pub fn begin(
        &self,
        epoch: u64,
        target: PathBuf,
        count: usize,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<String, String> {
        if count == 0 || count > MAX_ITEMS {
            return Err("图片导出参数无效".into());
        }
        crate::system::path_key(target.to_str().ok_or("导出路径无效")?)?;
        crate::workspace::checked_path(&target)?;
        let parent = target.parent().ok_or("导出目录无效")?;
        if !parent.is_dir() {
            return Err("导出目录不存在".into());
        }
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        if !state.batches.is_empty() {
            return Err("已有图片导出批次，请先完成或取消".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = parent.join(format!(".dustdesk-images-{id}"));
        fs::create_dir(&directory).map_err(|error| error.to_string())?;
        let batch = Batch {
            target,
            directory,
            count,
            files: Vec::new(),
        };
        self.check(epoch, &active)?;
        state.batches.insert(id.clone(), batch);
        Ok(id)
    }
    pub fn write(
        &self,
        epoch: u64,
        id: &str,
        name: &str,
        bytes: &[u8],
        active: impl Fn() -> Result<(), String>,
    ) -> Result<String, String> {
        inspect(bytes)?;
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        let batch = state.batches.get_mut(id).ok_or("导出批次已结束")?;
        if batch.files.len() >= batch.count {
            return Err("导出图片数量超过本次选择".into());
        }
        crate::workspace::checked_path(&batch.directory)?;
        let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let target = batch.directory.join(safe_name(name));
        for index in 0..MAX_ITEMS {
            let path = candidate(&target, index);
            let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            };
            let written = file.write_all(bytes).and_then(|_| file.sync_all());
            drop(file);
            if let Err(error) = written {
                let _ = fs::remove_file(&path);
                return Err(error.to_string());
            }
            if let Err(error) = self.check(epoch, &active) {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
            batch.files.push(path.clone());
            return Ok(path.display().to_string());
        }
        Err("同名文件过多".into())
    }
    pub fn finish(
        &self,
        epoch: u64,
        id: &str,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Output, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        self.check(epoch, &active)?;
        let Some(batch) = state.batches.remove(id) else {
            return Ok(Output {
                path: None,
                directory: None,
                count: 0,
            });
        };
        if batch.files.is_empty() {
            return Ok(Output {
                path: None,
                directory: None,
                count: 0,
            });
        }
        crate::workspace::checked_path(&batch.directory)?;
        for path in &batch.files {
            crate::workspace::checked_path(path)?;
            let file = File::open(path).map_err(|error| error.to_string())?;
            crate::workspace::require_plain_file(&file)?;
        }
        let source = if batch.count == 1 {
            batch.files[0].clone()
        } else {
            let source = batch
                .directory
                .join(format!(".archive-{}.zip", uuid::Uuid::new_v4()));
            let file = OpenOptions::new()
                .create_new(true)
                .read(true)
                .write(true)
                .open(&source)
                .map_err(|error| error.to_string())?;
            let mut archive = zip::ZipWriter::new(file);
            for path in &batch.files {
                self.check(epoch, &active)?;
                let name = path
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or("图片文件名无效")?;
                archive
                    .start_file(
                        name,
                        zip::write::SimpleFileOptions::default()
                            .compression_method(zip::CompressionMethod::Stored),
                    )
                    .map_err(|error| error.to_string())?;
                let mut input = File::open(path).map_err(|error| error.to_string())?;
                std::io::copy(&mut input, &mut archive).map_err(|error| error.to_string())?;
            }
            archive
                .finish()
                .map_err(|error| error.to_string())?
                .sync_all()
                .map_err(|error| error.to_string())?;
            source
        };
        for index in 0..MAX_ITEMS {
            let destination = candidate(&batch.target, index);
            crate::workspace::checked_path(&destination)?;
            self.check(epoch, &active)?;
            match fs::hard_link(&source, &destination) {
                Ok(()) => {
                    return Ok(Output {
                        path: Some(destination.display().to_string()),
                        directory: destination
                            .parent()
                            .map(|value| value.display().to_string()),
                        count: batch.files.len(),
                    })
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.to_string()),
            }
        }
        Err("同名文件过多".into())
    }
}
