use std::{
    ffi::c_void,
    fs::File,
    io::Read,
    mem::size_of,
    path::{Path, PathBuf},
    ptr::null_mut,
};
use windows::{
    core::{Interface, PCWSTR},
    Win32::{
        Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES,
        System::Com::{CoCreateInstance, IPersistFile, CLSCTX_INPROC_SERVER, STGM_READ},
        UI::{
            Shell::{
                ExtractIconExW, IShellLinkW, SHGetFileInfoW, ShellLink, SHFILEINFOW, SHGFI_ICON,
                SHGFI_LARGEICON, SLGP_RAWPATH,
            },
            WindowsAndMessaging::HICON,
        },
    },
};
use windows_sys::Win32::{
    Graphics::Gdi::*,
    UI::WindowsAndMessaging::{DestroyIcon, DrawIconEx, GetIconInfo, DI_NORMAL, ICONINFO},
};

#[cfg(test)]
#[path = "icon_tests.rs"]
mod tests;

struct Icon(HICON);
impl Drop for Icon {
    fn drop(&mut self) {
        if !self.0 .0.is_null() {
            unsafe {
                DestroyIcon(self.0 .0);
            }
        }
    }
}
struct IconBitmaps(ICONINFO);
impl Drop for IconBitmaps {
    fn drop(&mut self) {
        unsafe {
            if !self.0.hbmColor.is_null() {
                DeleteObject(self.0.hbmColor);
            }
            if !self.0.hbmMask.is_null() && self.0.hbmMask != self.0.hbmColor {
                DeleteObject(self.0.hbmMask);
            }
        }
    }
}
fn dimensions(icon: &Icon) -> Result<(i32, i32), String> {
    unsafe {
        let mut bitmaps = IconBitmaps(ICONINFO::default());
        if GetIconInfo(icon.0 .0, &mut bitmaps.0) == 0 {
            return Err("无法读取图标尺寸".into());
        }
        let color = !bitmaps.0.hbmColor.is_null();
        let target = if color {
            bitmaps.0.hbmColor
        } else {
            bitmaps.0.hbmMask
        };
        let mut bitmap = BITMAP::default();
        if target.is_null()
            || GetObjectW(
                target,
                size_of::<BITMAP>() as i32,
                (&mut bitmap as *mut BITMAP).cast(),
            ) == 0
        {
            return Err("无法读取图标位图尺寸".into());
        }
        let width = bitmap.bmWidth;
        let height = if color {
            bitmap.bmHeight
        } else {
            bitmap.bmHeight / 2
        };
        if !(1..=1024).contains(&width) || !(1..=1024).contains(&height) {
            return Err("图标尺寸无效或过大".into());
        }
        Ok((width, height))
    }
}
struct Surface {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}
impl Drop for Surface {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() && self.previous != (-1isize) as HGDIOBJ {
                SelectObject(self.dc, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.dc.is_null() {
                DeleteDC(self.dc);
            }
        }
    }
}
fn wide(path: &Path) -> Result<Vec<u16>, String> {
    let text = path.to_str().ok_or("图标路径无效")?;
    crate::system::path_key(text)?;
    Ok(text.encode_utf16().chain(Some(0)).collect())
}
fn png(width: u32, height: u32, pixels: &[u8]) -> Result<Vec<u8>, String> {
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder
            .write_header()
            .map_err(|error| error.to_string())?
            .write_image_data(pixels)
            .map_err(|error| error.to_string())?;
    }
    Ok(output)
}
fn render(icon: &Icon, background: u8, width: i32, height: i32) -> Result<Vec<u8>, String> {
    unsafe {
        let mut surface = Surface {
            dc: CreateCompatibleDC(null_mut()),
            bitmap: null_mut(),
            previous: null_mut(),
        };
        if surface.dc.is_null() {
            return Err("无法创建图标上下文".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels: *mut c_void = null_mut();
        surface.bitmap = CreateDIBSection(
            surface.dc,
            &info,
            DIB_RGB_COLORS,
            &mut pixels,
            null_mut(),
            0,
        );
        if surface.bitmap.is_null() || pixels.is_null() {
            return Err("无法分配图标位图".into());
        }
        surface.previous = SelectObject(surface.dc, surface.bitmap);
        if surface.previous.is_null() || surface.previous == (-1isize) as HGDIOBJ {
            return Err("无法选择图标位图".into());
        }
        let bytes = std::slice::from_raw_parts_mut(
            pixels.cast::<u8>(),
            width as usize * height as usize * 4,
        );
        bytes.fill(background);
        if DrawIconEx(
            surface.dc,
            0,
            0,
            icon.0 .0,
            width,
            height,
            0,
            null_mut(),
            DI_NORMAL,
        ) == 0
        {
            return Err("无法绘制原生图标".into());
        }
        GdiFlush();
        Ok(bytes.to_vec())
    }
}
fn encode(icon: Icon) -> Result<Vec<u8>, String> {
    let (width, height) = dimensions(&icon)?;
    let black = render(&icon, 0, width, height)?;
    let white = render(&icon, 255, width, height)?;
    let mut pixels = Vec::with_capacity(black.len());
    for (dark, light) in black.chunks_exact(4).zip(white.chunks_exact(4)) {
        let difference = (0..3)
            .map(|channel| light[channel].saturating_sub(dark[channel]))
            .max()
            .unwrap();
        let alpha = 255 - difference;
        for channel in [2, 1, 0] {
            pixels.push(if alpha == 0 {
                0
            } else {
                ((u32::from(dark[channel]) * 255 + u32::from(alpha) / 2) / u32::from(alpha))
                    .min(255) as u8
            });
        }
        pixels.push(alpha);
    }
    png(width as u32, height as u32, &pixels)
}
fn shell(path: &Path) -> Result<Vec<u8>, String> {
    let path = wide(path)?;
    let mut info = SHFILEINFOW::default();
    let result = unsafe {
        SHGetFileInfoW(
            PCWSTR(path.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut info),
            size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    let icon = Icon(info.hIcon);
    if result == 0 || icon.0 .0.is_null() {
        return Err("系统图标不可用".into());
    }
    encode(icon)
}
fn extract(path: &Path, index: i32) -> Result<Vec<u8>, String> {
    crate::workspace::checked_path(path)?;
    let path = wide(path)?;
    let mut large = HICON::default();
    let mut small = HICON::default();
    unsafe {
        ExtractIconExW(
            PCWSTR(path.as_ptr()),
            index,
            Some(&mut large),
            Some(&mut small),
            1,
        );
    }
    let large = Icon(large);
    let small = Icon(if large.0 == small {
        HICON::default()
    } else {
        small
    });
    if !large.0 .0.is_null() {
        encode(large)
    } else if !small.0 .0.is_null() {
        encode(small)
    } else {
        Err("图标资源不可用".into())
    }
}
fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase()
}
fn resource(path: &Path, index: i32) -> Result<Vec<u8>, String> {
    if let Ok(bytes) = extract(path, index) {
        return Ok(bytes);
    }
    if index != 0 {
        if let Ok(bytes) = extract(path, 0) {
            return Ok(bytes);
        }
    }
    if !["png", "bmp", "jpg", "jpeg", "gif"].contains(&extension(path).as_str()) {
        return Err("图标资源不可用".into());
    }
    crate::workspace::checked_path(path)?;
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 4 * 1024 * 1024 {
        return Err("图标资源过大".into());
    }
    let mut bytes = Vec::new();
    file.take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("图标资源过大".into());
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| error.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(1024);
    limits.max_image_height = Some(1024);
    limits.max_alloc = Some(8 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader
        .decode()
        .map_err(|error| error.to_string())?
        .into_rgba8();
    crate::workspace::checked_path(path)?;
    png(decoded.width(), decoded.height(), decoded.as_raw())
}
fn append_path(path: &mut String, fragment: &str) -> Result<(), String> {
    if path
        .encode_utf16()
        .count()
        .saturating_add(fragment.encode_utf16().count())
        > 4096
    {
        return Err("图标路径过长".into());
    }
    path.push_str(fragment);
    Ok(())
}
fn resolve(value: &[u16], shortcut: &Path) -> Result<PathBuf, String> {
    let length = value
        .iter()
        .position(|unit| *unit == 0)
        .unwrap_or(value.len());
    let value = String::from_utf16(&value[..length]).map_err(|error| error.to_string())?;
    if value.is_empty() {
        return Err("快捷方式未设置图标或目标".into());
    }
    let mut expanded = String::new();
    let mut rest = value.trim_matches('"');
    while let Some(start) = rest.find('%') {
        append_path(&mut expanded, &rest[..start])?;
        rest = &rest[start..];
        let Some(end) = rest[1..].find('%').map(|index| index + 1) else {
            break;
        };
        let name = &rest[1..end];
        append_path(
            &mut expanded,
            &std::env::var(name).unwrap_or_else(|_| rest[..=end].into()),
        )?;
        rest = &rest[end + 1..];
    }
    append_path(&mut expanded, rest)?;
    let path = PathBuf::from(expanded);
    let path = if path.is_absolute() {
        path
    } else {
        shortcut.parent().ok_or("快捷方式路径无效")?.join(path)
    };
    crate::system::path_key(path.to_str().ok_or("图标路径无效")?)?;
    Ok(path)
}
fn shortcut(path: &Path) -> Result<Vec<u8>, String> {
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|error| error.to_string())?;
        let persist: IPersistFile = link.cast().map_err(|error| error.to_string())?;
        let name = wide(path)?;
        persist
            .Load(PCWSTR(name.as_ptr()), STGM_READ)
            .map_err(|error| error.to_string())?;
        let mut buffer = vec![0u16; 32768];
        let mut index = 0;
        if link.GetIconLocation(&mut buffer, &mut index).is_ok() {
            if let Ok(resource_path) = resolve(&buffer, path) {
                if let Ok(bytes) = resource(&resource_path, index) {
                    return Ok(bytes);
                }
            }
        }
        buffer.fill(0);
        if link
            .GetPath(&mut buffer, null_mut(), SLGP_RAWPATH.0 as u32)
            .is_ok()
        {
            if let Ok(target) = resolve(&buffer, path) {
                crate::workspace::checked_path(&target)?;
                return resource(&target, 0).or_else(|_| shell(&target));
            }
        }
        Err("快捷方式图标不可用".into())
    }
}
pub fn read(path: &Path) -> Result<crate::icons::PathIcon, String> {
    let _apartment = super::shell::apartment()?;
    crate::workspace::checked_path(path)?;
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let directory = metadata.is_dir();
    if !directory && !metadata.is_file() {
        return Err("路径不是普通文件或目录".into());
    }
    let bytes = if directory {
        shell(path)
    } else {
        match extension(path).as_str() {
            "lnk" => shortcut(path).or_else(|_| shell(path)),
            "exe" | "dll" | "ico" | "icl" => resource(path, 0).or_else(|_| shell(path)),
            _ => shell(path),
        }
    };
    crate::workspace::checked_path(path)?;
    use base64::{engine::general_purpose::STANDARD, Engine};
    Ok(crate::icons::PathIcon {
        is_directory: Some(directory),
        data_url: bytes
            .ok()
            .map(|bytes| format!("data:image/png;base64,{}", STANDARD.encode(bytes))),
    })
}
