using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;

namespace DustDesk.Next.Services;

public sealed class GlobalHotKeyService : IGlobalHotKeyService
{
    private const int WmHotKey = 0x0312;
    private HwndSource? _source;
    private IntPtr _handle;
    private readonly HashSet<int> _ids = new();
    public event Action<int>? Pressed;
    public bool Register(Window window, int id, string shortcut)
    {
        EnsureSource(window);
        Unregister(id);
        if (!TryParse(shortcut, out var modifiers, out var key)) return false;
        if (!RegisterHotKey(_handle, id, modifiers, key)) return false;
        _ids.Add(id); return true;
    }
    public void Unregister(int id) { if (_handle != IntPtr.Zero && _ids.Remove(id)) UnregisterHotKey(_handle, id); }
    public void Dispose() { foreach (var id in _ids.ToArray()) Unregister(id); _source?.RemoveHook(WndProc); _source = null; }
    private void EnsureSource(Window window) { if (_source is not null) return; _handle = new WindowInteropHelper(window).Handle; _source = HwndSource.FromHwnd(_handle); _source?.AddHook(WndProc); }
    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled) { if (msg == WmHotKey) { handled = true; Pressed?.Invoke(wParam.ToInt32()); } return IntPtr.Zero; }
    private static bool TryParse(string shortcut, out uint modifiers, out uint key)
    {
        modifiers = 0; key = 0;
        try
        {
            var parts = shortcut.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            foreach (var part in parts)
            {
                switch (part.ToUpperInvariant())
                {
                    case "CTRL": case "CONTROL": modifiers |= 0x0002; break;
                    case "ALT": modifiers |= 0x0001; break;
                    case "SHIFT": modifiers |= 0x0004; break;
                    case "WIN": modifiers |= 0x0008; break;
                    default:
                        var converted = KeyInterop.VirtualKeyFromKey((Key)new KeyConverter().ConvertFromInvariantString(part)!);
                        if (converted == 0) return false; key = (uint)converted; break;
                }
            }
            return key != 0;
        }
        catch { return false; }
    }
    [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint virtualKey);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool UnregisterHotKey(IntPtr hwnd, int id);
}
