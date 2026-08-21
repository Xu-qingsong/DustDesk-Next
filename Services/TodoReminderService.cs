using System.Windows.Threading;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Services;

public sealed class TodoReminderService : ITodoReminderService
{
    private readonly WorkspaceViewModel _workspace;
    private readonly ITrayService _tray;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(30) };
    public TodoReminderService(WorkspaceViewModel workspace, ITrayService tray)
    {
        _workspace = workspace; _tray = tray; _timer.Tick += (_, _) => Check();
    }
    public void Start() { Check(); _timer.Start(); }
    public void Dispose() => _timer.Stop();
    private void Check()
    {
        var now = DateTime.Now;
        foreach (var item in _workspace.Todos.Where(item => !item.IsCompleted && item.Record.ReminderAt is not null && item.Record.ReminderAt <= now && item.Record.ReminderNotifiedAt is null))
        {
            _tray.ShowNotification("DustDesk 任务提醒", item.Title);
            item.MarkReminderDelivered(now);
            _workspace.MarkChanged();
        }
    }
}
