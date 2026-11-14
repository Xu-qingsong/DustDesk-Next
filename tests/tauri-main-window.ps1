param([int]$ProcessId, [string]$Action = 'snapshot', [string]$WindowTitle = 'DustDesk')
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DustDeskMainWindow {
    public delegate bool EnumCallback(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr handle, StringBuilder title, int maximum);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr handle, out Rect rectangle);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr handle, IntPtr after, int horizontal, int vertical, int width, int height, uint flags);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] public static extern IntPtr GetMenu(IntPtr handle);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr handle, uint message, IntPtr first, IntPtr second);
    public struct Rect { public int Left; public int Top; public int Right; public int Bottom; }
    public static IntPtr Find(int expected, string expectedTitle) {
        var matches = new List<IntPtr>();
        EnumWindows((handle, parameter) => {
            uint processId;
            GetWindowThreadProcessId(handle, out processId);
            if (processId != expected) return true;
            var title = new StringBuilder(512);
            GetWindowText(handle, title, title.Capacity);
            if (title.ToString() == expectedTitle) matches.Add(handle);
            return true;
        }, IntPtr.Zero);
        if (matches.Count != 1) throw new InvalidOperationException("Expected exactly one isolated workspace window");
        return matches[0];
    }
}
'@
$handle = [DustDeskMainWindow]::Find($ProcessId, $WindowTitle)
switch ($Action) {
    'move' { if (-not [DustDeskMainWindow]::SetWindowPos($handle, [IntPtr]::Zero, 140, 110, 1120, 780, 0x14)) { throw 'Move failed' } }
    'minimize' { [void][DustDeskMainWindow]::ShowWindow($handle, 6) }
    'maximize' { [void][DustDeskMainWindow]::ShowWindow($handle, 3) }
    'restore' { [void][DustDeskMainWindow]::ShowWindow($handle, 9) }
    'close' { if (-not [DustDeskMainWindow]::PostMessage($handle, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)) { throw 'Close request failed' } }
    'snapshot' { }
    default { throw 'Unknown workspace action' }
}
$rectangle = New-Object DustDeskMainWindow+Rect
if (-not [DustDeskMainWindow]::GetWindowRect($handle, [ref]$rectangle)) { throw 'Bounds unavailable' }
@{ x = $rectangle.Left; y = $rectangle.Top; width = $rectangle.Right - $rectangle.Left; height = $rectangle.Bottom - $rectangle.Top; minimized = [DustDeskMainWindow]::IsIconic($handle); maximized = [DustDeskMainWindow]::IsZoomed($handle); visible = [DustDeskMainWindow]::IsWindowVisible($handle); hasMenu = [DustDeskMainWindow]::GetMenu($handle) -ne [IntPtr]::Zero } | ConvertTo-Json -Compress
