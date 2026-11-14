use super::CaptureRect;
use std::{ffi::c_void, mem::size_of, ptr::null_mut};
use windows_sys::Win32::{
    Graphics::{Dwm::DwmFlush, Gdi::*},
    UI::{HiDpi::*, WindowsAndMessaging::*},
};

struct CaptureResources {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    dpi: DPI_AWARENESS_CONTEXT,
}

impl Drop for CaptureResources {
    fn drop(&mut self) {
        unsafe {
            if !self.previous.is_null() && !self.memory.is_null() {
                SelectObject(self.memory, self.previous);
            }
            if !self.bitmap.is_null() {
                DeleteObject(self.bitmap);
            }
            if !self.memory.is_null() {
                DeleteDC(self.memory);
            }
            if !self.screen.is_null() {
                ReleaseDC(null_mut(), self.screen);
            }
            if !self.dpi.is_null() {
                SetThreadDpiAwarenessContext(self.dpi);
            }
        }
    }
}

pub fn capture_region(rect: CaptureRect) -> Result<Vec<u8>, String> {
    rect.validate()?;
    unsafe {
        let mut resources = CaptureResources {
            screen: null_mut(),
            memory: null_mut(),
            bitmap: null_mut(),
            previous: null_mut(),
            dpi: SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2),
        };
        let left = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let top = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let right = i64::from(left) + i64::from(GetSystemMetrics(SM_CXVIRTUALSCREEN));
        let bottom = i64::from(top) + i64::from(GetSystemMetrics(SM_CYVIRTUALSCREEN));
        if rect.x < left
            || rect.y < top
            || i64::from(rect.x) + i64::from(rect.width) > right
            || i64::from(rect.y) + i64::from(rect.height) > bottom
        {
            return Err("选区不在当前屏幕范围内".into());
        }
        DwmFlush();
        resources.screen = GetDC(null_mut());
        if resources.screen.is_null() {
            return Err("无法访问桌面画面".into());
        }
        resources.memory = CreateCompatibleDC(resources.screen);
        if resources.memory.is_null() {
            return Err("无法创建截图上下文".into());
        }
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: rect.width as i32,
                biHeight: -(rect.height as i32),
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels: *mut c_void = null_mut();
        resources.bitmap = CreateDIBSection(
            resources.screen,
            &info,
            DIB_RGB_COLORS,
            &mut pixels,
            null_mut(),
            0,
        );
        if resources.bitmap.is_null() || pixels.is_null() {
            return Err("无法分配截图像素".into());
        }
        resources.previous = SelectObject(resources.memory, resources.bitmap);
        if resources.previous.is_null() || resources.previous == (-1isize) as HGDIOBJ {
            return Err("无法选择截图位图".into());
        }
        if BitBlt(
            resources.memory,
            0,
            0,
            rect.width as i32,
            rect.height as i32,
            resources.screen,
            rect.x,
            rect.y,
            SRCCOPY | CAPTUREBLT,
        ) == 0
        {
            return Err("无法捕获选区，请重新选择后重试".into());
        }
        GdiFlush();
        let bgra = std::slice::from_raw_parts(
            pixels as *const u8,
            rect.width as usize * rect.height as usize * 4,
        );
        let mut rgb = Vec::with_capacity(rect.width as usize * rect.height as usize * 3);
        for pixel in bgra.chunks_exact(4) {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
        let mut output = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut output, rect.width, rect.height);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().map_err(|error| error.to_string())?;
            writer
                .write_image_data(&rgb)
                .map_err(|error| error.to_string())?;
        }
        Ok(output)
    }
}

pub fn set_opacity(window: &tauri::WebviewWindow, opacity: u8) -> Result<(), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let previous = GetWindowLongW(handle.0, GWL_EXSTYLE);
        SetWindowLongW(handle.0, GWL_EXSTYLE, previous | WS_EX_LAYERED as i32);
        if SetLayeredWindowAttributes(handle.0, 0, opacity, LWA_ALPHA) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

pub fn window_flags(window: &tauri::WebviewWindow) -> Result<(bool, u8), String> {
    let handle = window.hwnd().map_err(|error| error.to_string())?;
    unsafe {
        let style = GetWindowLongW(handle.0, GWL_EXSTYLE) as u32;
        let mut opacity = 255;
        let mut flags = 0;
        if style & WS_EX_LAYERED != 0
            && (GetLayeredWindowAttributes(handle.0, null_mut(), &mut opacity, &mut flags) == 0
                || flags & LWA_ALPHA == 0)
        {
            opacity = 255;
        }
        Ok((style & WS_EX_TRANSPARENT != 0, opacity))
    }
}
