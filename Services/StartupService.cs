using Microsoft.Win32;

namespace DustDesk.Next.Services;

public sealed class StartupService : IStartupService
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "DustDesk.Next";
    public bool IsEnabled { get { using var key = Registry.CurrentUser.OpenSubKey(RunKey); return key?.GetValue(ValueName) is string; } }
    public void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled) key.SetValue(ValueName, $"\"{Environment.ProcessPath}\""); else key.DeleteValue(ValueName, false);
    }
}
