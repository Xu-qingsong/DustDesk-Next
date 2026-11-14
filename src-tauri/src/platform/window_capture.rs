use std::{
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::{factory, Interface},
    Graphics::{
        Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
    },
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{Direct3D::D3D_DRIVER_TYPE_HARDWARE, Direct3D11::*, Dxgi::IDXGIDevice},
        System::WinRT::{
            Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
            Graphics::Capture::IGraphicsCaptureItemInterop,
            RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED,
        },
    },
};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            RoUninitialize();
        }
    }
}

struct CaptureSession {
    session: GraphicsCaptureSession,
    pool: Direct3D11CaptureFramePool,
}
impl Drop for CaptureSession {
    fn drop(&mut self) {
        let _ = self.session.Close();
        let _ = self.pool.Close();
    }
}

pub fn capture_window(handle: isize) -> Result<Vec<u8>, String> {
    capture_checked(handle, &|| false)
}

pub fn capture_checked(handle: isize, cancelled: &impl Fn() -> bool) -> Result<Vec<u8>, String> {
    capture_initialized(
        handle,
        false,
        Instant::now() + Duration::from_secs(5),
        cancelled,
    )
}

pub fn capture_preview(
    handle: isize,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    capture_initialized(handle, true, deadline, cancelled)
}

fn capture_initialized(
    handle: isize,
    preview: bool,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> Result<Vec<u8>, String> {
    if cancelled() || Instant::now() >= deadline {
        return Err("截图操作已取消或超时".into());
    }
    unsafe {
        RoInitialize(RO_INIT_MULTITHREADED).map_err(|error| error.to_string())?;
    }
    let _apartment = Apartment;
    capture(handle, preview, deadline, cancelled).map_err(|error| format!("无法捕获窗口：{error}"))
}

fn capture(
    handle: isize,
    preview: bool,
    deadline: Instant,
    cancelled: &impl Fn() -> bool,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    if !GraphicsCaptureSession::IsSupported()? {
        return Err("系统不支持 Windows Graphics Capture".into());
    }
    let mut device = None;
    let mut context = None;
    unsafe {
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            None,
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )?;
    }
    let device = device.ok_or("无法初始化 Direct3D 设备")?;
    let context = context.ok_or("无法初始化 Direct3D 上下文")?;
    let dxgi: IDXGIDevice = device.cast()?;
    let direct_device: IDirect3DDevice =
        unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi)? }.cast()?;
    let interop: IGraphicsCaptureItemInterop =
        factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>()?;
    let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(HWND(handle as *mut _))? };
    let size = item.Size()?;
    if size.Width <= 0
        || size.Height <= 0
        || i64::from(size.Width) * i64::from(size.Height) > 40_000_000
    {
        return Err("窗口尺寸无效或超过截图限制".into());
    }
    let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
        &direct_device,
        DirectXPixelFormat::B8G8R8A8UIntNormalized,
        2,
        size,
    )?;
    let session = pool.CreateCaptureSession(&item)?;
    let resources = CaptureSession { session, pool };
    let _ = resources.session.SetIsCursorCaptureEnabled(false);
    resources.session.StartCapture()?;
    let frame = loop {
        if cancelled() {
            return Err("截图操作已取消".into());
        }
        if Instant::now() >= deadline {
            return Err("等待窗口画面超时，窗口可能已关闭或无法捕获".into());
        }
        if let Ok(frame) = resources.pool.TryGetNextFrame() {
            break frame;
        }
        thread::sleep(Duration::from_millis(10));
    };
    let content = frame.ContentSize()?;
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
    let mut descriptor = D3D11_TEXTURE2D_DESC::default();
    unsafe {
        texture.GetDesc(&mut descriptor);
    }
    let width = descriptor.Width.min(content.Width.max(0) as u32);
    let height = descriptor.Height.min(content.Height.max(0) as u32);
    if width == 0 || height == 0 || u64::from(width) * u64::from(height) > 40_000_000 {
        return Err("捕获帧尺寸无效".into());
    }
    descriptor.Usage = D3D11_USAGE_STAGING;
    descriptor.BindFlags = 0;
    descriptor.MiscFlags = 0;
    descriptor.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
    let mut staging = None;
    unsafe {
        device.CreateTexture2D(&descriptor, None, Some(&mut staging))?;
    }
    let staging = staging.ok_or("无法创建窗口截图缓冲区")?;
    unsafe {
        context.CopyResource(&staging, &texture);
    }
    let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
    unsafe {
        context.Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))?;
    }
    let mut rgb = Vec::with_capacity(width as usize * height as usize * 3);
    if mapped.pData.is_null() || mapped.RowPitch < width * 4 {
        unsafe {
            context.Unmap(&staging, 0);
        }
        return Err("窗口截图像素不可用".into());
    }
    for row in 0..height as usize {
        let source = unsafe {
            std::slice::from_raw_parts(
                (mapped.pData as *const u8).add(row * mapped.RowPitch as usize),
                width as usize * 4,
            )
        };
        for pixel in source.chunks_exact(4) {
            rgb.extend_from_slice(&[pixel[2], pixel[1], pixel[0]]);
        }
    }
    unsafe {
        context.Unmap(&staging, 0);
    }
    frame.Close()?;
    if cancelled() {
        return Err("截图操作已取消".into());
    }
    let (rgb, width, height) = if preview {
        let image = image::RgbImage::from_raw(width, height, rgb).ok_or("窗口截图像素无效")?;
        let thumbnail = image::DynamicImage::ImageRgb8(image)
            .thumbnail(320, 180)
            .into_rgb8();
        let dimensions = thumbnail.dimensions();
        (thumbnail.into_raw(), dimensions.0, dimensions.1)
    } else {
        (rgb, width, height)
    };
    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header()?;
        writer.write_image_data(&rgb)?;
    }
    Ok(output)
}
