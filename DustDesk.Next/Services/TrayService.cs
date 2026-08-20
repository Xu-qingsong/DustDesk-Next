namespace DustDesk.Next.Services;

public sealed class TrayService : ITrayService
{
    private readonly System.Windows.Forms.NotifyIcon _icon;
    public TrayService()
    {
        var menu = new System.Windows.Forms.ContextMenuStrip();
        menu.Items.Add("显示 DustDesk", null, (_, _) => ShowRequested?.Invoke());
        menu.Items.Add(new System.Windows.Forms.ToolStripSeparator());
        menu.Items.Add("退出", null, (_, _) => ExitRequested?.Invoke());
        var appIcon = TryGetApplicationIcon();
        _icon = new System.Windows.Forms.NotifyIcon
        {
            Text = "DustDesk",
            Icon = appIcon,
            ContextMenuStrip = menu,
            Visible = true
        };
        _icon.DoubleClick += (_, _) => ShowRequested?.Invoke();
    }
    private static System.Drawing.Icon TryGetApplicationIcon()
    {
        try
        {
            var path = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(path))
            {
                var icon = System.Drawing.Icon.ExtractAssociatedIcon(path);
                if (icon is not null) return icon;
            }
        }
        catch { }
        return System.Drawing.SystemIcons.Application;
    }
    public event Action? ShowRequested;
    public event Action? ExitRequested;
    public void ShowNotification(string title, string message) => _icon.ShowBalloonTip(4000, title, message, System.Windows.Forms.ToolTipIcon.Info);
    public void Dispose() { _icon.Visible = false; _icon.ContextMenuStrip?.Dispose(); _icon.Dispose(); }
}
