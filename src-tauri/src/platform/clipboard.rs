use crate::clipboard::{
    decode_image_limited, encode_png, image_from_dib_limited, ClipboardContent, PreparedContent,
    MAX_IMAGE_BYTES, MAX_PIXELS, MAX_TEXT_UNITS,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    ptr::{null, null_mut},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::{GlobalFree, HWND},
    System::{
        DataExchange::{
            CloseClipboard, EmptyClipboard, EnumClipboardFormats, GetClipboardData,
            IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW, SetClipboardData,
        },
        Memory::{GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock, GMEM_MOVEABLE},
    },
    UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE},
};

const TEXT: u32 = 13;
const DIB: u32 = 8;
const DIBV5: u32 = 17;

fn bitmap_format() -> Result<Option<u32>, String> {
    let mut format = 0;
    for _index in 0..4096 {
        format = unsafe { EnumClipboardFormats(format) };
        match format {
            0 => return Ok(None),
            2 | DIB => return Ok(Some(DIB)),
            DIBV5 => return Ok(Some(DIBV5)),
            _ => {}
        }
    }
    Err("剪贴板格式过多，无法安全读取图片".into())
}

struct Clipboard;
impl Drop for Clipboard {
    fn drop(&mut self) {
        unsafe {
            CloseClipboard();
        }
    }
}

struct Owner(HWND);
impl Drop for Owner {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0);
        }
    }
}

fn owner() -> Result<Owner, String> {
    let class: Vec<u16> = "STATIC".encode_utf16().chain([0]).collect();
    let owner = Owner(unsafe {
        CreateWindowExW(
            0,
            class.as_ptr(),
            null(),
            0,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            null_mut(),
            null_mut(),
            null(),
        )
    });
    if owner.0.is_null() {
        Err("无法创建剪贴板所有者窗口".into())
    } else {
        Ok(owner)
    }
}

struct Memory(*mut core::ffi::c_void);
impl Drop for Memory {
    fn drop(&mut self) {
        if !self.0.is_null() {
            unsafe {
                GlobalFree(self.0);
            }
        }
    }
}

fn open(owner: HWND) -> Result<Clipboard, String> {
    for _attempt in 0..20 {
        if unsafe { OpenClipboard(owner) } != 0 {
            return Ok(Clipboard);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    Err("系统剪贴板正被其他程序占用，请稍后重试".into())
}

fn png_format() -> Result<u32, String> {
    let name: Vec<u16> = "PNG".encode_utf16().chain([0]).collect();
    let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
    if format == 0 {
        Err("无法注册剪贴板图片格式".into())
    } else {
        Ok(format)
    }
}

fn bytes(format: u32, limit: usize) -> Result<Vec<u8>, String> {
    let handle = unsafe { GetClipboardData(format) };
    if handle.is_null() {
        return Err("无法读取剪贴板内容，请稍后重试".into());
    }
    let size = unsafe { GlobalSize(handle) };
    if size == 0 || size > limit {
        return Err("剪贴板内容无效或过大".into());
    }
    let address = unsafe { GlobalLock(handle) };
    if address.is_null() {
        return Err("无法锁定剪贴板内容，请稍后重试".into());
    }
    let bytes = unsafe { std::slice::from_raw_parts(address.cast::<u8>(), size) }.to_vec();
    unsafe {
        GlobalUnlock(handle);
    }
    Ok(bytes)
}

fn text(bytes: &[u8]) -> Result<String, String> {
    if !bytes.len().is_multiple_of(2) {
        return Err("剪贴板文本编码无效".into());
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect::<Vec<_>>();
    let length = units
        .iter()
        .position(|value| *value == 0)
        .ok_or("剪贴板文本缺少结束标记")?;
    if length > MAX_TEXT_UNITS {
        return Err("剪贴板文本过大".into());
    }
    String::from_utf16(&units[..length]).map_err(|_| "剪贴板文本编码无效".into())
}

pub fn read() -> Result<ClipboardContent, String> {
    read_limited(MAX_PIXELS)
}

pub fn read_monitored() -> Result<ClipboardContent, String> {
    read_limited(16_000_000)
}

pub fn read_image() -> Result<Option<crate::screenshot::Decoded>, String> {
    let png = png_format()?;
    let image = {
        let owner = owner()?;
        let _clipboard = open(owner.0)?;
        if unsafe { IsClipboardFormatAvailable(png) } != 0 {
            Some((bytes(png, crate::screenshot::MAX_BYTES)?, false))
        } else if let Some(format) = bitmap_format()? {
            Some((bytes(format, (MAX_PIXELS as usize) * 4 + 4096)?, true))
        } else {
            None
        }
    };
    image
        .map(|(bytes, dib)| {
            if dib {
                crate::screenshot::encode(image_from_dib_limited(&bytes, MAX_PIXELS)?)
            } else {
                crate::screenshot::decode(&bytes)
            }
        })
        .transpose()
}

fn read_limited(max_pixels: u64) -> Result<ClipboardContent, String> {
    let png = png_format()?;
    let (text, image) = {
        let owner = owner()?;
        let _clipboard = open(owner.0)?;
        let text = if unsafe { IsClipboardFormatAvailable(TEXT) } != 0 {
            text(&bytes(TEXT, (MAX_TEXT_UNITS + 2048) * 2)?)?
        } else {
            String::new()
        };
        let image = if unsafe { IsClipboardFormatAvailable(png) } != 0 {
            Some((bytes(png, MAX_IMAGE_BYTES)?, false))
        } else if let Some(format) = bitmap_format()? {
            Some((bytes(format, (max_pixels as usize) * 4 + 4096)?, true))
        } else {
            None
        };
        (text, image)
    };
    let image_png_base64 = match image {
        Some((bytes, dib)) => {
            let image = if dib {
                image_from_dib_limited(&bytes, max_pixels)?
            } else {
                decode_image_limited(&bytes, max_pixels)?
            };
            STANDARD.encode(encode_png(&image)?)
        }
        None => String::new(),
    };
    Ok(ClipboardContent {
        text,
        image_png_base64,
    })
}

fn allocate(bytes: &[u8]) -> Result<Memory, String> {
    let memory = Memory(unsafe { GlobalAlloc(GMEM_MOVEABLE, bytes.len()) });
    if memory.0.is_null() {
        return Err("无法分配剪贴板内容".into());
    }
    let destination = unsafe { GlobalLock(memory.0) };
    if destination.is_null() {
        return Err("无法锁定待复制内容".into());
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), destination.cast(), bytes.len());
        GlobalUnlock(memory.0);
    }
    Ok(memory)
}

pub fn write(content: &PreparedContent) -> Result<(), String> {
    write_inner(content, None::<fn(u32)>)
}
pub fn write_observed(content: &PreparedContent, observed: impl FnOnce(u32)) -> Result<(), String> {
    write_inner(content, Some(observed))
}
fn write_inner(
    content: &PreparedContent,
    observed: Option<impl FnOnce(u32)>,
) -> Result<(), String> {
    let mut formats = match content {
        PreparedContent::Text(text) => {
            let bytes = text
                .encode_utf16()
                .chain([0])
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>();
            vec![(TEXT, allocate(&bytes)?)]
        }
        PreparedContent::Image { png, dib } => {
            vec![(png_format()?, allocate(png)?), (DIBV5, allocate(dib)?)]
        }
    };
    let marker = if observed.is_some() {
        let name: Vec<u16> = "DustDesk.Screenshot.Output"
            .encode_utf16()
            .chain([0])
            .collect();
        let format = unsafe { RegisterClipboardFormatW(name.as_ptr()) };
        if format == 0 {
            return Err("无法注册截图输出标记".into());
        }
        let marker = uuid::Uuid::new_v4().as_bytes().to_vec();
        formats.push((format, allocate(&marker)?));
        Some((format, marker))
    } else {
        None
    };
    let clipboard_owner = owner()?;
    let clipboard = open(clipboard_owner.0)?;
    if unsafe { EmptyClipboard() } == 0 {
        return Err("无法更新系统剪贴板，请重试".into());
    }
    for (format, memory) in &mut formats {
        if unsafe { SetClipboardData(*format, memory.0) }.is_null() {
            return Err("写入剪贴板失败，请重试".into());
        }
        memory.0 = null_mut();
    }
    drop(clipboard);
    drop(clipboard_owner);
    if let (Some(observed), Some((format, marker))) = (observed, marker) {
        if let Ok(read_owner) = owner() {
            if let Ok(_clipboard) = open(read_owner.0) {
                if bytes(format, 16).is_ok_and(|current| current == marker) {
                    observed(super::clipboard_listener::sequence());
                }
            }
        }
    }
    Ok(())
}
