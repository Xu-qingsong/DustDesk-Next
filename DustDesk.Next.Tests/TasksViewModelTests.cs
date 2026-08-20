using DustDesk.Next.Models;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class TasksViewModelTests
{
    [Fact]
    public async Task DialogValuesCreateAndUpdateTheWholeTask()
    {
        var store = new MemoryStore(WorkspaceDefaults.Create(includeStarterTodos: false, legacyImportCompleted: true));
        var workspace = new WorkspaceViewModel(store, new NoopLegacyImporter());
        await workspace.InitializeAsync();
        var viewModel = new TasksViewModel(workspace) { SelectedDate = new DateTime(2026, 8, 3) };
        var reminder = new DateTime(2026, 8, 3, 19, 30, 0);

        var item = viewModel.CreateTodo("提交周报", "工作", "附上项目进度", reminder, ReminderRepeat.Weekdays);

        Assert.Equal("提交周报", item.Title);
        Assert.Equal("工作", item.Tag);
        Assert.Equal("附上项目进度", item.Note);
        Assert.Equal(new DateTime(2026, 8, 3), item.CreatedAt.Date);
        Assert.Equal(reminder, item.Record.ReminderAt);
        Assert.Equal(ReminderRepeat.Weekdays, item.ReminderRepeat);

        viewModel.UpdateTodo(item, "提交月报", "重要", "检查全部数字", null, ReminderRepeat.Daily);

        Assert.Equal("提交月报", item.Title);
        Assert.Equal("重要", item.Tag);
        Assert.Equal("检查全部数字", item.Note);
        Assert.Null(item.Record.ReminderAt);
        Assert.Equal(ReminderRepeat.None, item.ReminderRepeat);
    }

    private sealed class MemoryStore(WorkspaceState state) : IAppStateStore
    {
        public string DataFilePath => "memory.json";
        public string DataDirectory => ".";
        public Task<WorkspaceState> LoadAsync(CancellationToken cancellationToken = default) => Task.FromResult(state);
        public Task SaveAsync(WorkspaceState value, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class NoopLegacyImporter : ILegacyDataImporter
    {
        public Task<bool> ImportAsync(WorkspaceState target, CancellationToken cancellationToken = default) => Task.FromResult(false);
    }
}
