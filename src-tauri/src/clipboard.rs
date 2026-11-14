use crate::{
    lifecycle::QuitState,
    platform,
    workspace::{api::require_workspace, commands::operation},
};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::{DynamicImage, ImageFormat};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{borrow::Cow, io::Cursor, sync::Arc};
use tauri::{Manager, WebviewWindow};
use tokio::sync::Semaphore;

pub const MAX_IMAGE_BYTES: usize = 12 * 1024 * 1024;
pub const MAX_PIXELS: u64 = 40_000_000;
pub const MAX_TEXT_UNITS: usize = 5_000_000;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardContent {
    pub text: String,
    pub image_png_base64: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WriteContent {
    #[serde(default, deserialize_with = "supplied_text")]
    pub text: Option<String>,
    #[serde(default, deserialize_with = "supplied_text")]
    pub image_png_base64: Option<String>,
    #[serde(default, deserialize_with = "supplied_text")]
    pub record_id: Option<String>,
}

fn supplied_text<'de, Deserializer: serde::Deserializer<'de>>(
    deserializer: Deserializer,
) -> Result<Option<String>, Deserializer::Error> {
    String::deserialize(deserializer).map(Some)
}

pub enum PreparedContent {
    Text(String),
    Image { png: Vec<u8>, dib: Vec<u8> },
}

pub struct ClipboardService {
    pub(crate) slot: Arc<Semaphore>,
}

impl Default for ClipboardService {
    fn default() -> Self {
        Self {
            slot: Arc::new(Semaphore::new(1)),
        }
    }
}

fn valid_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.encode_utf16().count() > 128 || id.contains('\0') {
        return Err("剪贴板图片请求无效".into());
    }
    Ok(())
}

pub fn decode_base64(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty() || value.len() > MAX_IMAGE_BYTES.div_ceil(3) * 4 {
        return Err("剪贴板图片无效或过大".into());
    }
    let bytes = STANDARD.decode(value).map_err(|_| "剪贴板图片编码无效")?;
    if bytes.len() > MAX_IMAGE_BYTES || STANDARD.encode(&bytes) != value {
        return Err("剪贴板图片编码无效或过大".into());
    }
    Ok(bytes)
}

pub fn decode_image(bytes: &[u8]) -> Result<DynamicImage, String> {
    decode_image_limited(bytes, MAX_PIXELS)
}

pub fn decode_image_limited(bytes: &[u8], max_pixels: u64) -> Result<DynamicImage, String> {
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_PIXELS as u32);
    limits.max_image_height = Some(MAX_PIXELS as u32);
    limits.max_alloc = Some(max_pixels * 4 + 16 * 1024 * 1024);
    reader.limits(limits);
    let dimensions = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?
        .into_dimensions()
        .map_err(|error| error.to_string())?;
    if dimensions.0 == 0
        || dimensions.1 == 0
        || u64::from(dimensions.0) * u64::from(dimensions.1) > max_pixels
    {
        return Err("图片无效或尺寸过大，无法预览".into());
    }
    reader
        .decode()
        .map_err(|error| format!("剪贴板图片无法解码：{error}"))
}

pub fn encode_png(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Cursor::new(Vec::new());
    image
        .write_to(&mut bytes, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    let bytes = bytes.into_inner();
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("剪贴板图片无效或过大".into());
    }
    Ok(bytes)
}

pub(crate) fn dib(image: &DynamicImage) -> Vec<u8> {
    let rgba = image
        .as_rgba8()
        .map(Cow::Borrowed)
        .unwrap_or_else(|| Cow::Owned(image.to_rgba8()));
    let mut bytes = vec![0; 124];
    for (offset, value) in [
        (0, 124u32),
        (4, rgba.width()),
        (8, (-(rgba.height() as i32)) as u32),
        (16, 3),
        (20, rgba.as_raw().len() as u32),
        (40, 0x00ff0000),
        (44, 0x0000ff00),
        (48, 0x000000ff),
        (52, 0xff000000),
        (56, 0x73524742),
    ] {
        bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes[12..14].copy_from_slice(&1u16.to_le_bytes());
    bytes[14..16].copy_from_slice(&32u16.to_le_bytes());
    bytes.reserve(rgba.as_raw().len());
    for pixel in rgba.pixels() {
        bytes.extend_from_slice(&[pixel[2], pixel[1], pixel[0], pixel[3]]);
    }
    bytes
}

#[cfg(test)]
pub fn image_from_dib(bytes: &[u8]) -> Result<DynamicImage, String> {
    image_from_dib_limited(bytes, MAX_PIXELS)
}

pub fn image_from_dib_limited(bytes: &[u8], max_pixels: u64) -> Result<DynamicImage, String> {
    if bytes.len() < 40 {
        return Err("剪贴板位图头无效".into());
    }
    let number = |offset| u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap());
    let header = number(0) as usize;
    let width = number(4) as i32;
    let height = (number(8) as i32)
        .checked_abs()
        .ok_or("剪贴板位图高度无效")?;
    let bits = u16::from_le_bytes([bytes[14], bytes[15]]);
    let compression = number(16);
    if ![40, 52, 56, 108, 124].contains(&header)
        || width <= 0
        || height == 0
        || (width as u64) * (height as u64) > max_pixels
        || header > bytes.len()
        || ![1, 4, 8, 16, 24, 32].contains(&bits)
        || ![0, 3, 6].contains(&compression)
        || u16::from_le_bytes([bytes[12], bytes[13]]) != 1
    {
        return Err("剪贴板位图格式或尺寸不受支持".into());
    }
    let palette = if bits <= 8 {
        let colors = if number(32) == 0 {
            1usize << bits
        } else {
            number(32) as usize
        };
        if colors > (1usize << bits) {
            return Err("剪贴板位图调色板无效".into());
        }
        colors * 4
    } else {
        (number(32) as usize)
            .checked_mul(4)
            .ok_or("剪贴板位图调色板过大")?
    };
    let masks = if header == 40 && compression == 3 {
        12
    } else if header == 40 && compression == 6 {
        16
    } else {
        0
    };
    let offset = header
        .checked_add(palette)
        .and_then(|value| value.checked_add(masks))
        .ok_or("剪贴板位图偏移无效")?;
    if offset > bytes.len() || bytes.len() > (MAX_PIXELS as usize) * 4 + 4096 {
        return Err("剪贴板位图数据无效或过大".into());
    }
    let mut bitmap = Vec::with_capacity(bytes.len() + 14);
    bitmap.extend_from_slice(b"BM");
    bitmap.extend_from_slice(&((bytes.len() + 14) as u32).to_le_bytes());
    bitmap.extend_from_slice(&[0; 4]);
    bitmap.extend_from_slice(&((offset + 14) as u32).to_le_bytes());
    bitmap.extend_from_slice(bytes);
    decode_image_limited(&bitmap, max_pixels)
}

fn prepare(content: WriteContent) -> Result<PreparedContent, String> {
    if content.record_id.is_some() {
        return Err("剪贴板记录未解析".into());
    }
    if let Some(text) = &content.text {
        if text.encode_utf16().count() > MAX_TEXT_UNITS || text.contains('\0') {
            return Err("剪贴板文本过大或包含空字符".into());
        }
    }
    if let Some(encoded) = content.image_png_base64.filter(|value| !value.is_empty()) {
        let bytes = decode_base64(&encoded)?;
        let image = decode_image(&bytes)?;
        return Ok(PreparedContent::Image {
            png: encode_png(&image)?,
            dib: dib(&image),
        });
    }
    content
        .text
        .map(PreparedContent::Text)
        .ok_or("剪贴板内容为空".into())
}

fn preview(bytes: &[u8], thumbnail: bool) -> Result<Value, String> {
    let image = decode_image(bytes)?;
    let width = image.width();
    let height = image.height();
    let scale = if thumbnail {
        (160.0 / f64::from(width))
            .min(120.0 / f64::from(height))
            .min(1.0)
    } else {
        1.0
    };
    let image = if scale < 1.0 {
        image.resize_exact(
            (f64::from(width) * scale).round().max(1.0) as u32,
            (f64::from(height) * scale).round().max(1.0) as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    let encoded = STANDARD.encode(encode_png(&image)?);
    Ok(
        json!({"ok":true,"image":{"dataUrl":format!("data:image/png;base64,{encoded}"),"width":width,"height":height}}),
    )
}

#[tauri::command]
pub async fn clipboard_read(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<ClipboardContent, String> {
    require_workspace(&window)?;
    app.state::<QuitState>().require_interactive()?;
    let slot = app
        .state::<ClipboardService>()
        .slot
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        app.state::<QuitState>().require_interactive()?;
        platform::clipboard::read()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clipboard_write(
    app: tauri::AppHandle,
    window: WebviewWindow,
    content: WriteContent,
) -> Result<(), String> {
    let widget = crate::widgets::business(&app, &window, &["clipboard"])?;
    if widget.is_some()
        && (content.record_id.is_none()
            || content.text.is_some()
            || content.image_png_base64.is_some())
    {
        return Err("剪贴板组件只允许复制已保存的历史记录".into());
    }
    app.state::<QuitState>().require_interactive()?;
    let slot = app
        .state::<ClipboardService>()
        .slot
        .clone()
        .acquire_owned()
        .await
        .map_err(|error| error.to_string())?;
    let content = if let Some(id) = content.record_id {
        valid_id(&id)?;
        operation(app.clone(), move |store| store.clipboard_content(&id)).await?
    } else {
        content
    };
    tauri::async_runtime::spawn_blocking(move || {
        let _slot = slot;
        let content = prepare(content)?;
        app.state::<QuitState>().require_interactive()?;
        platform::clipboard::write(&content)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn clipboard_preview(
    app: tauri::AppHandle,
    window: WebviewWindow,
    record_id: String,
    thumbnail: Option<bool>,
) -> Result<Value, String> {
    crate::widgets::business(&app, &window, &["clipboard"])?;
    app.state::<QuitState>().require_interactive()?;
    let outcome = async {
        valid_id(&record_id)?;
        let slot = app
            .state::<ClipboardService>()
            .slot
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        let bytes = operation(app.clone(), move |store| store.image(&record_id)).await?;
        tauri::async_runtime::spawn_blocking(move || {
            let _slot = slot;
            app.state::<QuitState>().require_interactive()?;
            preview(&bytes, thumbnail.unwrap_or(true))
        })
        .await
        .map_err(|error| error.to_string())?
    }
    .await;
    Ok(outcome.unwrap_or_else(|error: String| json!({"ok":false,"error":error})))
}

#[cfg(test)]
#[path = "clipboard_tests.rs"]
mod tests;
