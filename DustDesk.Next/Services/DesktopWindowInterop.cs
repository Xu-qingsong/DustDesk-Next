using System.Runtime.InteropServices;

namespace DustDesk.Next.Services;

internal static class DesktopWindowInterop
{
    private const int WmSpawnWorker = 0x052C;
    private const int GwlStyle = -16;
    private const int GwlExStyle = -20;
    private const long WsPopup = 0x80000000L;
    private const long WsChild = 0x40000000L;
    private const long WsVisible = 0x10000000L;
    private const long WsExToolWindow = 0x00000080L;
    private const long WsExAppWindow = 0x00040000L;
    private const int SwpFrameChanged = 0x0020;
    private const int SwpShowWindow = 0x0040;
    private const int SwpNoActivate = 0x0010;

    public static bool AttachToDesktop(IntPtr handle)
    {
        var host = FindDesktopHost();
        if (host == IntPtr.Zero) return false;
        GetWindowRect(handle, out var rect);
        SetParent(handle, host);
        var style = GetWindowLongPtr(handle, GwlStyle).ToInt64();
        style = (style & ~WsPopup) | WsChild | WsVisible;
        SetWindowLongPtr(handle, GwlStyle, new IntPtr(style));
        var exStyle = GetWindowLongPtr(handle, GwlExStyle).ToInt64();
        exStyle = (exStyle | WsExToolWindow) & ~WsExAppWindow;
        SetWindowLongPtr(handle, GwlExStyle, new IntPtr(exStyle));
        var point = new NativePoint { X = rect.Left, Y = rect.Top };
        ScreenToClient(host, ref point);
        SetWindowPos(handle, IntPtr.Zero, point.X, point.Y, Math.Max(1, rect.Right - rect.Left), Math.Max(1, rect.Bottom - rect.Top), SwpFrameChanged | SwpShowWindow | SwpNoActivate);
        return true;
    }

    private static IntPtr FindDesktopHost()
    {
        var progman = FindWindow("Progman", null);
        if (progman != IntPtr.Zero) SendMessageTimeout(progman, WmSpawnWorker, IntPtr.Zero, IntPtr.Zero, 0, 1000, out _);
        var result = IntPtr.Zero;
        EnumWindows((window, _) =>
        {
            var view = FindWindowEx(window, IntPtr.Zero, "SHELLDLL_DefView", null);
            if (view == IntPtr.Zero) return true;
            result = view; return false;
        }, IntPtr.Zero);
        return result != IntPtr.Zero ? result : progman;
    }

    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct NativePoint { public int X; public int Y; }
    private delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SetParent(IntPtr child, IntPtr parent);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)] private static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtr", SetLastError = true)] private static extern IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr value);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int width, int height, int flags);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetWindowRect(IntPtr hwnd, out NativeRect rect);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool ScreenToClient(IntPtr hwnd, ref NativePoint point);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern IntPtr FindWindow(string className, string? title);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string? title);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, int flags, int timeout, out IntPtr result);
}
