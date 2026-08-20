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
        _icon = new System.Windows.Forms.NotifyIcon
        {
            Text = "DustDesk",
            Icon = System.Drawing.SystemIcons.Application,
            ContextMenuStrip = menu,
            Visible = true
        };
        _icon.DoubleClick += (_, _) => ShowRequested?.Invoke();
    }
    public event Action? ShowRequested;
    public event Action? ExitRequested;
    public void ShowNotification(string title, string message) => _icon.ShowBalloonTip(4000, title, message, System.Windows.Forms.ToolTipIcon.Info);
    public void Dispose() { _icon.Visible = false; _icon.ContextMenuStrip?.Dispose(); _icon.Dispose(); }
}
