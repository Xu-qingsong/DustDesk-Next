using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public sealed class ClipboardMonitorService : IClipboardMonitorService
{
    private const int WmClipboardUpdate = 0x031D;
    private HwndSource? _source;

    public event Action<ClipboardRecord>? Captured;

    public void Start(Window window)
    {
        if (_source is not null) return;
        var helper = new WindowInteropHelper(window);
        _source = HwndSource.FromHwnd(helper.Handle);
        _source?.AddHook(WndProc);
        if (helper.Handle != IntPtr.Zero) AddClipboardFormatListener(helper.Handle);
    }

    public void Stop()
    {
        if (_source is null) return;
        RemoveClipboardFormatListener(_source.Handle);
        _source.RemoveHook(WndProc);
        _source = null;
    }

    public void Dispose() => Stop();

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WmClipboardUpdate) Capture();
        return IntPtr.Zero;
    }

    private void Capture()
    {
        try
        {
            if (Clipboard.ContainsText())
            {
                var text = Clipboard.GetText();
                if (!string.IsNullOrWhiteSpace(text)) Captured?.Invoke(new ClipboardRecord { Kind = ClipboardContentKind.Text, Text = text });
                return;
            }
            if (!Clipboard.ContainsImage()) return;
            var bitmap = Clipboard.GetImage();
            if (bitmap is null) return;
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(bitmap));
            using var stream = new MemoryStream();
            encoder.Save(stream);
            Captured?.Invoke(new ClipboardRecord { Kind = ClipboardContentKind.Image, ImagePngBase64 = Convert.ToBase64String(stream.ToArray()) });
        }
        catch (COMException) { }
    }

    [DllImport("user32.dll", SetLastError = true)] private static extern bool AddClipboardFormatListener(IntPtr hwnd);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RemoveClipboardFormatListener(IntPtr hwnd);
}
