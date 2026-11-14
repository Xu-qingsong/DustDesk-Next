use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    io::Cursor,
    sync::{Arc, Mutex},
};
use tokio::sync::Semaphore;

pub const MAX_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 40_000_000;
const MAX_SESSIONS: usize = 64;
const MAX_TOTAL_BYTES: usize = 256 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Document {
    pub id: String,
    pub source_asset_id: String,
    pub width: u32,
    pub height: u32,
    pub crop: Rect,
    pub annotations: Vec<serde_json::Value>,
    pub revision: f64,
    pub next_number: f64,
    #[serde(
        default,
        deserialize_with = "supplied_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub source_rect: Option<Rect>,
    #[serde(
        default,
        deserialize_with = "supplied_optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub target_pin_id: Option<String>,
}
fn supplied_optional<'de, Value: Deserialize<'de>, Deserializer: serde::Deserializer<'de>>(
    deserializer: Deserializer,
) -> Result<Option<Value>, Deserializer::Error> {
    Value::deserialize(deserializer).map(Some)
}
pub struct Decoded {
    pub png: Vec<u8>,
    pub width: u32,
    pub height: u32,
}
pub fn read_file(path: &std::path::Path) -> Result<Decoded, String> {
    use std::{fs::OpenOptions, io::Read};
    crate::system::path_key(path.to_str().ok_or("截图文件路径无效")?)?;
    crate::workspace::checked_path(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ);
    }
    let mut file = options
        .open(path)
        .map_err(|error| format!("无法读取截图文件（{}）：{error}", path.display()))?;
    crate::workspace::require_plain_file(&file)?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.len() == 0 || metadata.len() > MAX_BYTES as u64 {
        return Err("图片无效或过大（最大 32 MB）".into());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    Read::by_ref(&mut file)
        .take(MAX_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    let current = file.metadata().map_err(|error| error.to_string())?;
    if current.len() != metadata.len()
        || bytes.len() as u64 != metadata.len()
        || current.modified().map_err(|error| error.to_string())?
            != metadata.modified().map_err(|error| error.to_string())?
    {
        return Err("截图文件已变化，请重新拖入".into());
    }
    crate::workspace::checked_path(path)?;
    decode(&bytes)
}
pub fn decode(bytes: &[u8]) -> Result<Decoded, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("图片无效或过大（最大 32 MB）".into());
    }
    let format = image::guess_format(bytes).map_err(|_| "请选择 PNG、JPG、WebP 或 BMP 图片")?;
    if !matches!(
        format,
        ImageFormat::Png | ImageFormat::Jpeg | ImageFormat::WebP | ImageFormat::Bmp
    ) {
        return Err("请选择 PNG、JPG、WebP 或 BMP 图片".into());
    }
    let image = crate::clipboard::decode_image_limited(bytes, MAX_PIXELS)
        .map_err(|error| format!("截图图片无法解码：{error}"))?;
    if format == ImageFormat::Png {
        return Ok(Decoded {
            png: bytes.to_vec(),
            width: image.width(),
            height: image.height(),
        });
    }
    encode(image)
}
pub(crate) fn encode(image: DynamicImage) -> Result<Decoded, String> {
    let width = image.width();
    let height = image.height();
    let mut output = Cursor::new(Vec::new());
    image
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let png = output.into_inner();
    if png.len() > MAX_BYTES {
        return Err("解码后的图片过大（最大 32 MB）".into());
    }
    Ok(Decoded { png, width, height })
}
struct Session {
    owner: String,
    document: Document,
    source: Arc<[u8]>,
}
#[derive(Default)]
struct State {
    generation: u64,
    bytes: usize,
    sessions: HashMap<String, Session>,
    completed: VecDeque<crate::screenshot_output::Completed>,
}
pub struct Service {
    state: Mutex<State>,
    pub slot: Arc<Semaphore>,
    pub output_queue: Arc<Semaphore>,
    pub windows: crate::screenshot_windows::Sources,
}
impl Default for Service {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            slot: Arc::new(Semaphore::new(1)),
            output_queue: Arc::new(Semaphore::new(2)),
            windows: crate::screenshot_windows::Sources::default(),
        }
    }
}
impl Service {
    pub fn busy(&self) -> bool {
        self.slot.available_permits() == 0
            || self
                .state
                .lock()
                .map_or(true, |state| !state.sessions.is_empty())
    }
    pub fn generation(&self) -> Result<u64, String> {
        Ok(self
            .state
            .lock()
            .map_err(|error| error.to_string())?
            .generation)
    }
    pub fn cancel_pending(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
        }
        self.windows.clear();
    }
    pub fn reset(&self) {
        self.reset_retaining(false);
    }
    pub fn reset_main(&self) {
        self.reset_retaining(true);
    }
    fn reset_retaining(&self, overlays: bool) {
        if let Ok(mut state) = self.state.lock() {
            state.generation = state.generation.wrapping_add(1);
            state.sessions.retain(|_, session| {
                session.owner.starts_with("screenshot-pin-")
                    || overlays && session.owner.starts_with("screenshot-overlay-")
            });
            state.bytes = state
                .sessions
                .values()
                .map(|session| session.source.len())
                .sum();
            let State {
                sessions,
                completed,
                ..
            } = &mut *state;
            completed.retain(|entry| sessions.contains_key(&entry.document_id));
        }
        self.windows.clear();
    }
    pub fn create(
        &self,
        generation: u64,
        decoded: Decoded,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Document, String> {
        self.create_owned(generation, decoded, "workspace-main", active)
    }
    pub fn create_owned(
        &self,
        generation: u64,
        decoded: Decoded,
        owner: &str,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Document, String> {
        self.create_positioned(generation, decoded, owner, None, active)
    }
    pub fn create_positioned(
        &self,
        generation: u64,
        decoded: Decoded,
        owner: &str,
        region: Option<(u32, u32, Rect)>,
        active: impl Fn() -> Result<(), String>,
    ) -> Result<Document, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.generation != generation {
            return Err("截图会话已失效，请重新导入图片".into());
        }
        active()?;
        if decoded.png.len() > MAX_BYTES
            || decoded.width == 0
            || decoded.height == 0
            || u64::from(decoded.width) * u64::from(decoded.height) > MAX_PIXELS
        {
            return Err("截图图像无效或过大".into());
        }
        if state.sessions.len() >= MAX_SESSIONS
            || state.bytes.saturating_add(decoded.png.len()) > MAX_TOTAL_BYTES
        {
            return Err("截图占用较多内存，请关闭部分截图后重试".into());
        }
        let mut document = Document {
            id: uuid::Uuid::new_v4().to_string(),
            source_asset_id: uuid::Uuid::new_v4().to_string(),
            width: decoded.width,
            height: decoded.height,
            crop: Rect {
                x: 0.0,
                y: 0.0,
                width: f64::from(decoded.width),
                height: f64::from(decoded.height),
            },
            annotations: Vec::new(),
            revision: 0.0,
            next_number: 1.0,
            source_rect: None,
            target_pin_id: None,
        };
        if let Some((width, height, rect)) = region {
            document.width = width;
            document.height = height;
            document.crop = rect.clone();
            document.source_rect = Some(rect.clone());
            if !crate::screenshot_output::valid_document(&document)
                || rect.width != f64::from(decoded.width)
                || rect.height != f64::from(decoded.height)
            {
                return Err("截图区域与源图尺寸不一致".into());
            }
        }
        state.bytes += decoded.png.len();
        state.sessions.insert(
            document.id.clone(),
            Session {
                owner: owner.into(),
                document: document.clone(),
                source: decoded.png.into(),
            },
        );
        Ok(document)
    }
    pub fn stage_editor(
        &self,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
        owner: &str,
        active: impl FnOnce() -> Result<(), String>,
    ) -> Result<Document, String> {
        if packet.metadata.action != crate::screenshot_output::Action::OpenEditor
            || !packet.png().is_empty()
            || !packet.jpeg().is_empty()
        {
            return Err("截图编辑交接请求无效".into());
        }
        self.snapshot_owned(generation, packet, owner, "workspace-main", active)
    }
    pub fn snapshot_owned(
        &self,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
        owner: &str,
        target: &str,
        active: impl FnOnce() -> Result<(), String>,
    ) -> Result<Document, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        active()?;
        if Self::check_locked(&state, generation, packet, owner)?.is_some() {
            return Err("截图编辑交接请求无效或已完成".into());
        }
        let session = state
            .sessions
            .get(&packet.metadata.document.id)
            .ok_or("截图会话已结束")?;
        let source = session.source.clone();
        let mut document = packet.metadata.document.clone();
        document.id = uuid::Uuid::new_v4().to_string();
        document.source_asset_id = uuid::Uuid::new_v4().to_string();
        document.target_pin_id = None;
        document.revision = 0.0;
        if let Some(region) = document.source_rect.take() {
            document.width = region.width as u32;
            document.height = region.height as u32;
            document.crop.x -= region.x;
            document.crop.y -= region.y;
            for annotation in &mut document.annotations {
                for point in annotation["points"].as_array_mut().ok_or("标注坐标无效")? {
                    point["x"] =
                        serde_json::json!(point["x"].as_f64().ok_or("标注坐标无效")? - region.x);
                    point["y"] =
                        serde_json::json!(point["y"].as_f64().ok_or("标注坐标无效")? - region.y);
                }
            }
        }
        if !crate::screenshot_output::valid_document(&document) {
            return Err("请先重新捕获调整后的选区".into());
        }
        if state.sessions.len() >= MAX_SESSIONS
            || state.bytes.saturating_add(source.len()) > MAX_TOTAL_BYTES
        {
            return Err("截图占用较多内存，请关闭部分截图后重试".into());
        }
        state.bytes += source.len();
        state.sessions.insert(
            document.id.clone(),
            Session {
                owner: target.into(),
                document: document.clone(),
                source,
            },
        );
        Ok(document)
    }
    pub fn edit_pin(
        &self,
        id: &str,
        owner: &str,
        target: &str,
        pin: &str,
    ) -> Result<Document, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let session = state
            .sessions
            .get(id)
            .filter(|session| session.owner == owner)
            .ok_or("贴图原始文档已失效")?;
        let source = session.source.clone();
        let mut document = session.document.clone();
        if state.sessions.len() >= MAX_SESSIONS
            || state.bytes.saturating_add(source.len()) > MAX_TOTAL_BYTES
        {
            return Err("截图占用较多内存，请关闭部分截图后重试".into());
        }
        document.id = uuid::Uuid::new_v4().to_string();
        document.source_asset_id = uuid::Uuid::new_v4().to_string();
        document.target_pin_id = Some(pin.into());
        document.revision = 0.0;
        state.bytes += source.len();
        state.sessions.insert(
            document.id.clone(),
            Session {
                owner: target.into(),
                document: document.clone(),
                source,
            },
        );
        Ok(document)
    }
    #[cfg(test)]
    pub fn read(&self, id: &str) -> Result<(Document, Arc<[u8]>), String> {
        self.read_owned(id, "workspace-main")
    }
    pub fn read_owned(&self, id: &str, owner: &str) -> Result<(Document, Arc<[u8]>), String> {
        if id.is_empty() || id.len() > 128 {
            return Err("截图请求无效".into());
        }
        let state = self.state.lock().map_err(|error| error.to_string())?;
        let session = state
            .sessions
            .get(id)
            .ok_or("截图会话已结束，请重新打开图片")?;
        if session.owner != owner {
            return Err("此窗口无截图文档权限".into());
        }
        Ok((session.document.clone(), session.source.clone()))
    }
    pub fn remove(&self, id: &str) -> Result<(), String> {
        self.remove_owned(id, None)
    }
    pub fn remove_owned(&self, id: &str, owner: Option<&str>) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state
            .sessions
            .get(id)
            .is_some_and(|session| owner.is_some_and(|owner| session.owner != owner))
        {
            return Err("此窗口无截图文档权限".into());
        }
        if let Some(session) = state.sessions.remove(id) {
            state.bytes -= session.source.len();
        }
        state.completed.retain(|entry| entry.document_id != id);
        Ok(())
    }

    #[cfg(test)]
    pub fn check_finish(
        &self,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
    ) -> Result<Option<crate::screenshot_output::Output>, String> {
        self.check_finish_owned(generation, packet, "workspace-main")
    }
    pub fn check_finish_owned(
        &self,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
        owner: &str,
    ) -> Result<Option<crate::screenshot_output::Output>, String> {
        let state = self.state.lock().map_err(|error| error.to_string())?;
        Self::check_locked(&state, generation, packet, owner)
    }
    fn check_locked(
        state: &State,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
        owner: &str,
    ) -> Result<Option<crate::screenshot_output::Output>, String> {
        if state.generation != generation {
            return Err("截图会话已失效".into());
        }
        let document = &packet.metadata.document;
        if state
            .sessions
            .get(&document.id)
            .is_none_or(|session| session.owner != owner)
        {
            return Err("此窗口无截图文档权限或会话已结束".into());
        }
        let previous = &state
            .sessions
            .get(&document.id)
            .ok_or("截图会话已结束，请重新打开图片")?
            .document;
        if previous.source_asset_id != document.source_asset_id
            || previous.width != document.width
            || previous.height != document.height
            || previous.source_rect != document.source_rect
            || previous.target_pin_id != document.target_pin_id
            || document.revision < previous.revision
        {
            return Err("截图已更改或会话已结束，请重新载入".into());
        }
        if let Some(entry) = state.completed.iter().find(|entry| {
            entry.document_id == document.id && entry.request_id == packet.metadata.request_id
        }) {
            if entry.digest != packet.digest {
                return Err("截图请求编号已用于不同的输出数据".into());
            }
            return Ok(Some(entry.output.clone()));
        }
        Ok(None)
    }
    #[cfg(test)]
    pub fn transact(
        &self,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
        active: impl FnOnce() -> Result<(), String>,
        effect: impl FnOnce() -> Result<crate::screenshot_output::Output, String>,
    ) -> Result<crate::screenshot_output::Output, String> {
        self.transact_owned(generation, packet, "workspace-main", active, effect)
    }
    pub fn transact_owned(
        &self,
        generation: u64,
        packet: &crate::screenshot_output::Packet,
        owner: &str,
        active: impl FnOnce() -> Result<(), String>,
        effect: impl FnOnce() -> Result<crate::screenshot_output::Output, String>,
    ) -> Result<crate::screenshot_output::Output, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        active()?;
        if let Some(output) = Self::check_locked(&state, generation, packet, owner)? {
            return Ok(output);
        }
        let output = effect()?;
        if output.ok {
            let document = &packet.metadata.document;
            state
                .sessions
                .get_mut(&document.id)
                .ok_or("截图会话已结束")?
                .document = document.clone();
            state
                .completed
                .push_back(crate::screenshot_output::Completed {
                    document_id: document.id.clone(),
                    request_id: packet.metadata.request_id.clone(),
                    digest: packet.digest,
                    output: output.clone(),
                });
            if state.completed.len() > 128 {
                state.completed.pop_front();
            }
        }
        Ok(output)
    }
    pub fn finish_warning(
        &self,
        _generation: u64,
        packet: &crate::screenshot_output::Packet,
        output: &crate::screenshot_output::Output,
    ) {
        if let Ok(mut state) = self.state.lock() {
            if let Some(entry) = state.completed.iter_mut().find(|entry| {
                entry.document_id == packet.metadata.document.id
                    && entry.request_id == packet.metadata.request_id
                    && entry.digest == packet.digest
            }) {
                entry.output = output.clone();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> Decoded {
        encode(DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
            3,
            2,
            image::Rgba([20, 70, 190, 128]),
        )))
        .unwrap()
    }
    #[test]
    fn formats_normalize_to_png_and_preserve_rgba_with_bounded_dimensions_and_bytes() {
        let original = source();
        assert_eq!(decode(&original.png).unwrap().png, original.png);
        let image = image::load_from_memory(&original.png).unwrap();
        for format in [
            ImageFormat::Png,
            ImageFormat::Jpeg,
            ImageFormat::WebP,
            ImageFormat::Bmp,
        ] {
            let mut bytes = Cursor::new(Vec::new());
            let input = if format == ImageFormat::Jpeg {
                DynamicImage::ImageRgb8(image.to_rgb8())
            } else {
                image.clone()
            };
            input.write_to(&mut bytes, format).unwrap();
            let result = decode(bytes.get_ref()).unwrap();
            assert_eq!((result.width, result.height), (3, 2));
            assert_eq!(image::guess_format(&result.png).unwrap(), ImageFormat::Png);
            if format == ImageFormat::Png || format == ImageFormat::WebP {
                assert_eq!(
                    image::load_from_memory(&result.png).unwrap().to_rgba8(),
                    image.to_rgba8()
                );
            }
        }
        for bytes in [
            Vec::new(),
            vec![0; MAX_BYTES + 1],
            b"GIF89a".to_vec(),
            original.png[..20].to_vec(),
        ] {
            assert!(decode(&bytes).is_err());
        }
        let mut huge = Vec::new();
        let encoder = png::Encoder::new(&mut huge, 40001, 1000);
        let writer = encoder.write_header().unwrap();
        drop(writer);
        assert!(decode(&huge).is_err());
    }
    #[test]
    fn document_ownership_cannot_cross_main_or_overlay_sessions() {
        let service = Service::default();
        let main = service.create(0, source(), || Ok(())).unwrap();
        let overlay = service
            .create_owned(0, source(), "screenshot-overlay-exact", || Ok(()))
            .unwrap();
        assert!(service
            .read_owned(&main.id, "screenshot-overlay-exact")
            .is_err());
        assert!(service.read(&overlay.id).is_err());
        assert!(service
            .remove_owned(&overlay.id, Some("workspace-main"))
            .is_err());
        assert!(service
            .read_owned(&overlay.id, "screenshot-overlay-other")
            .is_err());
        assert!(service
            .read_owned(&overlay.id, "screenshot-overlay-exact")
            .is_ok());
        service.cancel_pending();
        assert!(service
            .read_owned(&overlay.id, "screenshot-overlay-exact")
            .is_ok());
        service.remove(&overlay.id).unwrap();
        assert!(service
            .read_owned(&overlay.id, "screenshot-overlay-exact")
            .is_err());
        assert!(service.read(&main.id).is_ok());
    }
    fn editor_packet(document: &Document) -> crate::screenshot_output::Packet {
        let metadata = serde_json::to_vec(&serde_json::json!({"requestId":"editor-transfer","document":document,"action":"openEditor","format":"png","pngLength":0,"jpegLength":0})).unwrap();
        let mut bytes = (metadata.len() as u32).to_le_bytes().to_vec();
        bytes.extend(metadata);
        crate::screenshot_output::Packet::parse(bytes).unwrap()
    }
    #[test]
    fn editor_snapshot_normalizes_region_coordinates_without_flattening_or_transferring_source_authority(
    ) {
        let service = Service::default();
        let mut document = service
            .create_positioned(
                0,
                source(),
                "region",
                Some((
                    1920,
                    1080,
                    Rect {
                        x: 100.0,
                        y: 200.0,
                        width: 3.0,
                        height: 2.0,
                    },
                )),
                || Ok(()),
            )
            .unwrap();
        document.crop = Rect {
            x: 101.0,
            y: 200.0,
            width: 2.0,
            height: 2.0,
        };
        document.revision = 3.0;
        document.next_number = 7.0;
        document.annotations = vec![
            serde_json::json!({"id":"arrow","kind":"arrow","points":[{"x":101.5,"y":200.5},{"x":102.5,"y":201.5}],"style":{"color":"#ff0000","width":2,"fontSize":18,"strength":20,"filled":false,"mode":"rectangle"}}),
        ];
        let packet = editor_packet(&document);
        let staged = service
            .stage_editor(0, &packet, "region", || Ok(()))
            .unwrap();
        assert_ne!(staged.id, document.id);
        assert_ne!(staged.source_asset_id, document.source_asset_id);
        assert_eq!((staged.width, staged.height), (3, 2));
        assert_eq!(
            staged.crop,
            Rect {
                x: 1.0,
                y: 0.0,
                width: 2.0,
                height: 2.0
            }
        );
        assert_eq!(staged.source_rect, None);
        assert_eq!(staged.revision, 0.0);
        assert_eq!(staged.next_number, 7.0);
        assert_eq!(
            staged.annotations[0]["points"],
            serde_json::json!([{"x":1.5,"y":0.5},{"x":2.5,"y":1.5}])
        );
        let (original, bytes) = service.read_owned(&document.id, "region").unwrap();
        let (_, staged_bytes) = service.read(&staged.id).unwrap();
        assert!(Arc::ptr_eq(&bytes, &staged_bytes));
        assert_eq!(original.revision, 0.0);
        assert!(original.annotations.is_empty());
        assert!(service.read(&document.id).is_err());
        assert!(service.read_owned(&staged.id, "region").is_err());
        service.remove(&staged.id).unwrap();
        assert_eq!(service.state.lock().unwrap().bytes, bytes.len());
        assert!(service.read_owned(&document.id, "region").is_ok());
    }
    #[test]
    fn failed_editor_staging_does_not_consume_sessions_or_mutate_original_edits() {
        let service = Service::default();
        let document = service
            .create_positioned(
                0,
                source(),
                "region",
                Some((
                    1920,
                    1080,
                    Rect {
                        x: 100.0,
                        y: 200.0,
                        width: 3.0,
                        height: 2.0,
                    },
                )),
                || Ok(()),
            )
            .unwrap();
        let packet = editor_packet(&document);
        assert!(service
            .stage_editor(0, &packet, "foreign", || Ok(()))
            .is_err());
        assert!(service
            .stage_editor(1, &packet, "region", || Ok(()))
            .is_err());
        assert!(service
            .stage_editor(0, &packet, "region", || Err("取消".into()))
            .is_err());
        let mut outside = document.clone();
        outside.crop.x = 99.0;
        assert!(service
            .stage_editor(0, &editor_packet(&outside), "region", || Ok(()))
            .is_err());
        assert_eq!(service.state.lock().unwrap().sessions.len(), 1);
        assert_eq!(
            service.read_owned(&document.id, "region").unwrap().0.crop,
            document.crop
        );
    }
    #[test]
    fn editor_staging_respects_session_and_byte_budgets_without_evicting_the_overlay() {
        let service = Service::default();
        let document = service
            .create_owned(0, source(), "overlay", || Ok(()))
            .unwrap();
        let packet = editor_packet(&document);
        let mut fillers = Vec::new();
        for _ in 1..MAX_SESSIONS {
            fillers.push(service.create(0, source(), || Ok(())).unwrap().id);
        }
        assert!(service
            .stage_editor(0, &packet, "overlay", || Ok(()))
            .is_err());
        service.remove(&fillers[0]).unwrap();
        let used = service.state.lock().unwrap().bytes;
        service.state.lock().unwrap().bytes = MAX_TOTAL_BYTES;
        assert!(service
            .stage_editor(0, &packet, "overlay", || Ok(()))
            .is_err());
        service.state.lock().unwrap().bytes = used;
        let staged = service
            .stage_editor(0, &packet, "overlay", || Ok(()))
            .unwrap();
        assert!(service.read(&staged.id).is_ok());
        assert!(service.read_owned(&document.id, "overlay").is_ok());
        assert_eq!(service.state.lock().unwrap().sessions.len(), MAX_SESSIONS);
    }
    #[test]
    fn pin_snapshots_survive_main_reload_and_reedit_keeps_independent_source_authority() {
        let service = Service::default();
        let original = service.create(0, source(), || Ok(())).unwrap();
        let packet = editor_packet(&original);
        let pinned = service
            .snapshot_owned(0, &packet, "workspace-main", "screenshot-pin-exact", || {
                Ok(())
            })
            .unwrap();
        assert!(service.read(&pinned.id).is_err());
        let edited = service
            .edit_pin(
                &pinned.id,
                "screenshot-pin-exact",
                "screenshot-overlay-edit",
                "exact",
            )
            .unwrap();
        assert_eq!(edited.target_pin_id.as_deref(), Some("exact"));
        assert_ne!(edited.source_asset_id, pinned.source_asset_id);
        assert!(service
            .edit_pin(&pinned.id, "foreign", "overlay", "exact")
            .is_err());
        service.reset();
        assert!(service.read(&original.id).is_err());
        assert!(service
            .read_owned(&edited.id, "screenshot-overlay-edit")
            .is_err());
        let (retained, bytes) = service
            .read_owned(&pinned.id, "screenshot-pin-exact")
            .unwrap();
        assert_eq!(retained.id, pinned.id);
        assert_eq!(service.state.lock().unwrap().sessions.len(), 1);
        assert_eq!(service.state.lock().unwrap().bytes, bytes.len());
        let next = service
            .edit_pin(&pinned.id, "screenshot-pin-exact", "new-overlay", "exact")
            .unwrap();
        assert_eq!(next.target_pin_id, edited.target_pin_id);
        assert_eq!(next.crop, pinned.crop);
    }
    #[test]
    fn positioned_sources_keep_native_region_pixels_without_allocating_an_entire_screen() {
        let service = Service::default();
        let rect = Rect {
            x: 100.0,
            y: 200.0,
            width: 3.0,
            height: 2.0,
        };
        let document = service
            .create_positioned(
                0,
                source(),
                "region",
                Some((1920, 1080, rect.clone())),
                || Ok(()),
            )
            .unwrap();
        assert_eq!((document.width, document.height), (1920, 1080));
        assert_eq!(document.crop, rect);
        assert_eq!(document.source_rect, Some(rect));
        let (_, bytes) = service.read_owned(&document.id, "region").unwrap();
        assert_eq!(image::load_from_memory(&bytes).unwrap().width(), 3);
        assert_eq!(service.state.lock().unwrap().bytes, bytes.len());
        for region in [
            (
                1920,
                1080,
                Rect {
                    x: 1919.0,
                    y: 0.0,
                    width: 3.0,
                    height: 2.0,
                },
            ),
            (
                1920,
                1080,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 4.0,
                    height: 2.0,
                },
            ),
            (
                10000,
                10000,
                Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 3.0,
                    height: 2.0,
                },
            ),
        ] {
            assert!(service
                .create_positioned(0, source(), "region", Some(region), || Ok(()))
                .is_err());
        }
        assert_eq!(service.state.lock().unwrap().sessions.len(), 1);
    }
    #[test]
    fn native_session_ids_do_not_accept_asset_ids_paths_or_cross_session_sources() {
        let service = Service::default();
        let document = service
            .create(service.generation().unwrap(), source(), || Ok(()))
            .unwrap();
        assert_ne!(document.id, document.source_asset_id);
        let (read, png) = service.read(&document.id).unwrap();
        assert_eq!(read.width, 3);
        assert_eq!(read.crop.height, 2.0);
        assert_eq!(read.revision, 0.0);
        assert_eq!(read.next_number, 1.0);
        assert!(read.annotations.is_empty());
        assert_eq!(&*png, source().png.as_slice());
        for id in [
            &document.source_asset_id,
            "C:\\outside.png",
            "",
            &"a".repeat(129),
        ] {
            assert!(service.read(id).is_err());
        }
        service.remove(&document.id).unwrap();
        service.remove(&document.id).unwrap();
        assert!(service.read(&document.id).is_err());
        assert_eq!(service.state.lock().unwrap().bytes, 0);
    }
    #[test]
    fn lifecycle_cancellation_retains_live_documents_but_reset_revokes_everything_and_old_imports()
    {
        let service = Service::default();
        let generation = service.generation().unwrap();
        let document = service.create(generation, source(), || Ok(())).unwrap();
        service.cancel_pending();
        assert!(service.read(&document.id).is_ok());
        assert!(service.create(generation, source(), || Ok(())).is_err());
        let current = service.generation().unwrap();
        assert!(service
            .create(current, source(), || Err("maintenance".into()))
            .is_err());
        assert_eq!(service.state.lock().unwrap().sessions.len(), 1);
        service.reset();
        assert!(service.read(&document.id).is_err());
        assert!(service.create(current, source(), || Ok(())).is_err());
        assert!(service
            .create(service.generation().unwrap(), source(), || Ok(()))
            .is_ok());
    }
    #[test]
    fn session_capacity_never_silently_evicts_an_edited_source_and_discard_recovers_budget() {
        let service = Service::default();
        let generation = service.generation().unwrap();
        let mut ids = Vec::new();
        for _ in 0..MAX_SESSIONS {
            ids.push(service.create(generation, source(), || Ok(())).unwrap().id);
        }
        assert!(service.create(generation, source(), || Ok(())).is_err());
        assert!(service.read(&ids[0]).is_ok());
        service.remove(&ids[0]).unwrap();
        assert!(service.create(generation, source(), || Ok(())).is_ok());
        service.reset();
        assert_eq!(service.state.lock().unwrap().bytes, 0);
    }
    #[test]
    fn main_reset_retains_independent_overlay_and_pin_pixels_but_full_restore_revokes_overlays() {
        let service = Service::default();
        let generation = service.generation().unwrap();
        let main = service.create(generation, source(), || Ok(())).unwrap();
        let overlay = service
            .create_owned(generation, source(), "screenshot-overlay-native", || Ok(()))
            .unwrap();
        let pin = service
            .create_owned(generation, source(), "screenshot-pin-native", || Ok(()))
            .unwrap();
        let original = service
            .read_owned(&overlay.id, "screenshot-overlay-native")
            .unwrap()
            .1;
        service.reset_main();
        assert!(service.read(&main.id).is_err());
        let retained = service
            .read_owned(&overlay.id, "screenshot-overlay-native")
            .unwrap()
            .1;
        assert!(Arc::ptr_eq(&original, &retained));
        assert!(service.read_owned(&pin.id, "screenshot-pin-native").is_ok());
        assert!(service.create(generation, source(), || Ok(())).is_err());
        assert_eq!(service.state.lock().unwrap().bytes, retained.len() * 2);
        service.reset();
        assert!(service
            .read_owned(&overlay.id, "screenshot-overlay-native")
            .is_err());
        assert!(service.read_owned(&pin.id, "screenshot-pin-native").is_ok());
        assert_eq!(service.state.lock().unwrap().bytes, retained.len());
    }
    #[test]
    fn retained_sources_keep_successful_output_receipts_without_replaying_effects_after_main_reset()
    {
        let service = Service::default();
        let generation = service.generation().unwrap();
        let main = service.create(generation, source(), || Ok(())).unwrap();
        let overlay = service
            .create_owned(generation, source(), "screenshot-overlay-native", || Ok(()))
            .unwrap();
        let pin = service
            .create_owned(generation, source(), "screenshot-pin-native", || Ok(()))
            .unwrap();
        for (document, owner) in [
            (&main, "workspace-main"),
            (&overlay, "screenshot-overlay-native"),
            (&pin, "screenshot-pin-native"),
        ] {
            service
                .transact_owned(
                    generation,
                    &editor_packet(document),
                    owner,
                    || Ok(()),
                    || {
                        Ok(crate::screenshot_output::Output {
                            ok: true,
                            path: Some("saved-once.png".into()),
                            warning: Some("history unavailable".into()),
                            ..Default::default()
                        })
                    },
                )
                .unwrap();
        }
        service.reset_main();
        let next = service.generation().unwrap();
        assert!(service
            .check_finish_owned(
                generation,
                &editor_packet(&overlay),
                "screenshot-overlay-native"
            )
            .is_err());
        assert!(service
            .check_finish_owned(next, &editor_packet(&main), "workspace-main")
            .is_err());
        for (document, owner) in [
            (&overlay, "screenshot-overlay-native"),
            (&pin, "screenshot-pin-native"),
        ] {
            let result = service
                .transact_owned(
                    next,
                    &editor_packet(document),
                    owner,
                    || Ok(()),
                    || panic!("A retained successful output must not run its effect again"),
                )
                .unwrap();
            assert_eq!(result.path.as_deref(), Some("saved-once.png"));
            assert_eq!(result.warning.as_deref(), Some("history unavailable"));
            let mut changed = document.clone();
            changed.revision += 1.0;
            assert!(service
                .check_finish_owned(next, &editor_packet(&changed), owner)
                .is_err());
            assert!(service
                .check_finish_owned(next, &editor_packet(document), "foreign")
                .is_err());
        }
        assert_eq!(service.state.lock().unwrap().completed.len(), 2);
        service.reset();
        let restored = service.generation().unwrap();
        assert!(service
            .check_finish_owned(
                restored,
                &editor_packet(&overlay),
                "screenshot-overlay-native"
            )
            .is_err());
        assert!(service
            .check_finish_owned(restored, &editor_packet(&pin), "screenshot-pin-native")
            .unwrap()
            .is_some());
        assert_eq!(service.state.lock().unwrap().completed.len(), 1);
        service
            .remove_owned(&pin.id, Some("screenshot-pin-native"))
            .unwrap();
        assert!(service.state.lock().unwrap().completed.is_empty());
    }
    #[test]
    fn exact_byte_budget_rejects_growth_without_consuming_ids_or_evicting_sources() {
        let service = Service::default();
        let decoded = source();
        let length = decoded.png.len();
        let generation = service.generation().unwrap();
        service.state.lock().unwrap().bytes = MAX_TOTAL_BYTES - length;
        let document = service.create(generation, decoded, || Ok(())).unwrap();
        assert_eq!(service.state.lock().unwrap().bytes, MAX_TOTAL_BYTES);
        assert!(service.create(generation, source(), || Ok(())).is_err());
        assert!(service.read(&document.id).is_ok());
        service.remove(&document.id).unwrap();
        assert_eq!(
            service.state.lock().unwrap().bytes,
            MAX_TOTAL_BYTES - length
        );
        assert!(service.create(generation, source(), || Ok(())).is_ok());
    }
    #[test]
    fn path_import_validates_a_locked_plain_file_and_exact_source_byte_bounds() {
        use std::fs::{self, OpenOptions};
        let root =
            std::env::temp_dir().join(format!("dustdesk-screenshot-read-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let path = root.join("原图🪶.png");
        let original = source().png;
        fs::write(&path, &original).unwrap();
        assert_eq!(read_file(&path).unwrap().png, original);
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            let held = OpenOptions::new()
                .read(true)
                .share_mode(0)
                .open(&path)
                .unwrap();
            assert!(read_file(&path).is_err());
            drop(held);
            assert_eq!(read_file(&path).unwrap().png, original);
        }
        assert!(read_file(&root).is_err());
        assert!(read_file(&root.join("missing.png")).is_err());
        fs::write(&path, []).unwrap();
        assert!(read_file(&path).is_err());
        fs::write(&path, &original).unwrap();
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_BYTES as u64).unwrap();
        drop(file);
        assert_eq!(read_file(&path).unwrap().png.len(), MAX_BYTES);
        let file = OpenOptions::new().write(true).open(&path).unwrap();
        file.set_len(MAX_BYTES as u64 + 1).unwrap();
        drop(file);
        assert!(read_file(&path).is_err());
        fs::write(&path, b"GIF89a").unwrap();
        assert!(read_file(&path).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
