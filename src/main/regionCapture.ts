import { execFile } from 'node:child_process'
import type { ScreenshotRect } from '../shared/screenshotDocument'

export function captureWindowsRegion(rect: ScreenshotRect, signal?: AbortSignal): Promise<Uint8Array> {
  if (![rect.x, rect.y, rect.width, rect.height].every(Number.isInteger) || rect.width < 1 || rect.height < 1 || rect.width * rect.height > 40_000_000 || Math.abs(rect.x) > 65536 || Math.abs(rect.y) > 65536) return Promise.reject(Error('选区尺寸无效'))
  // Copy only the confirmed physical-pixel rectangle. No full-screen bitmap,
  // clipboard operation or intermediate file is created by this native helper.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class DustDeskRegionCapture {
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] static extern int DwmFlush();
  public static string Capture(int x, int y, int width, int height) {
    var previous = SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      DwmFlush();
      using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
      using (var graphics = Graphics.FromImage(bitmap))
      using (var output = new MemoryStream()) {
        graphics.CopyFromScreen(x, y, 0, 0, new Size(width, height), CopyPixelOperation.SourceCopy);
        bitmap.Save(output, ImageFormat.Png);
        return Convert.ToBase64String(output.ToArray());
      }
    } finally { if (previous != IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
'@
[Console]::Write([DustDeskRegionCapture]::Capture(${rect.x}, ${rect.y}, ${rect.width}, ${rect.height}))
`
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 12_000, maxBuffer: 48 * 1024 * 1024, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) { reject(signal?.aborted ? Error('截图已取消') : Error('无法捕获选区，请重新选择后重试')); return }
      const text = stdout.trim()
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) { reject(Error('无法读取选区图像')); return }
      const png = new Uint8Array(Buffer.from(text, 'base64'))
      if (!png.length || png.length > 32 * 1024 * 1024) { reject(Error('选区图像过大，请缩小选区')); return }
      resolve(png)
    })
  })
}
