using System.ComponentModel;
using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.Globalization;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class TasksViewModel : ObservableObject, IDisposable
{
    private readonly DispatcherTimer _viewRefreshTimer;
    private readonly EventHandler _viewRefreshHandler;
    public TasksViewModel(WorkspaceViewModel workspace)
    {
        Workspace = workspace;
        foreach (var tag in workspace.Todos.Select(item => item.Tag).Where(tag => !string.IsNullOrWhiteSpace(tag)).Distinct(StringComparer.OrdinalIgnoreCase)) EnsureTagPreset(tag);
        workspace.Todos.CollectionChanged += OnTodosCollectionChanged;
        foreach (var item in workspace.Todos) ObserveTodo(item);
        RefreshFilteredTodos();
        SelectedTodo = FilteredTodos.FirstOrDefault();
        _viewRefreshTimer = new DispatcherTimer { Interval = TimeSpan.FromMinutes(1) };
        _viewRefreshHandler = (_, _) => { if (ListMode == TaskListMode.Overdue) RefreshFilteredTodos(); };
        _viewRefreshTimer.Tick += _viewRefreshHandler;
        _viewRefreshTimer.Start();
    }

    public WorkspaceViewModel Workspace { get; }
    public IEnumerable<string> AvailableTags => Workspace.State.TagPresets.Select(item => item.Name);
    public ObservableCollection<TodoItemViewModel> FilteredTodos { get; } = new();
    public ObservableCollection<TodoItemViewModel> TodayTodos { get; } = new();
    public IReadOnlyList<string> ReminderTimes { get; } = Enumerable.Range(0, 48).Select(index => TimeSpan.FromMinutes(index * 30).ToString(@"hh\:mm")).ToList();
    public IReadOnlyList<ReminderRepeatOption> ReminderRepeatOptions { get; } = new[]
    {
        new ReminderRepeatOption(ReminderRepeat.None, "不重复"), new ReminderRepeatOption(ReminderRepeat.Daily, "每天"),
        new ReminderRepeatOption(ReminderRepeat.Weekdays, "工作日"), new ReminderRepeatOption(ReminderRepeat.Weekly, "每周")
    };
    public int TodayOpenCount => TodayTodos.Count(item => !item.IsCompleted);
    public int SelectedOpenCount => FilteredTodos.Count(item => !item.IsCompleted);
    public string TodayDateText => $"{DateTime.Today:yyyy年M月d日 dddd} · {LunarText(DateTime.Today)}";

    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(AddTodoCommand))]
    private string _newTodoTitle = string.Empty;

    [ObservableProperty]
    private TodoItemViewModel? _selectedTodo;

    [ObservableProperty]
    private DateTime? _selectedDate = DateTime.Today;
    [ObservableProperty]
    private TaskListMode _listMode = TaskListMode.SelectedDate;

    public string SelectedDateText => SelectedDate?.Date == DateTime.Today ? $"{DateTime.Today:yyyy-MM-dd}  今天" : SelectedDate?.ToString("yyyy-MM-dd") ?? string.Empty;

    partial void OnSelectedDateChanged(DateTime? value)
    {
        OnPropertyChanged(nameof(SelectedDateText));
        RefreshFilteredTodos();
    }

    partial void OnListModeChanged(TaskListMode value) => RefreshFilteredTodos();

    partial void OnSelectedTodoChanged(TodoItemViewModel? oldValue, TodoItemViewModel? newValue)
    {
        if (oldValue is not null) oldValue.PropertyChanged -= OnSelectedTodoPropertyChanged;
        if (newValue is not null) newValue.PropertyChanged += OnSelectedTodoPropertyChanged;
    }

    [RelayCommand(CanExecute = nameof(CanAddTodo))]
    private void AddTodo()
    {
        SelectedTodo = Workspace.AddTodo(NewTodoTitle);
        SelectedDate = SelectedTodo.CreatedAt.Date;
        NewTodoTitle = string.Empty;
    }

    public TodoItemViewModel CreateTodo(string title, string tag, string note, DateTime? reminderAt, ReminderRepeat reminderRepeat)
    {
        EnsureTagPreset(tag);
        var createdAt = (SelectedDate ?? DateTime.Today).Date + DateTime.Now.TimeOfDay;
        var item = Workspace.AddTodo(new TodoRecord
        {
            Title = title.Trim(),
            Tag = tag.Trim(),
            Note = note.Trim(),
            CreatedAt = createdAt,
            ReminderAt = reminderAt,
            ReminderRepeat = reminderAt is null ? ReminderRepeat.None : reminderRepeat
        });
        SelectedTodo = item;
        return item;
    }

    public TodoItemViewModel CreateFromText(string text)
    {
        var title = text.ReplaceLineEndings(" ").Trim();
        if (title.Length > 120) title = title[..120];
        return CreateTodo(title, string.Empty, text.Trim(), null, ReminderRepeat.None);
    }

    public void UpdateTodo(TodoItemViewModel item, string title, string tag, string note, DateTime? reminderAt, ReminderRepeat reminderRepeat)
    {
        item.Title = title;
        item.Tag = tag;
        item.Note = note;
        if (reminderAt is { } reminder)
        {
            item.SetReminder(reminder);
            item.ReminderRepeat = reminderRepeat;
        }
        else
        {
            item.ClearReminder();
            item.ReminderRepeat = ReminderRepeat.None;
        }

        EnsureTagPreset(item.Tag);
        UpdateTagColor(item);
        SelectedTodo = item;
        Workspace.MarkChanged();
    }

    [RelayCommand] private void PreviousDay() => SelectedDate = (SelectedDate ?? DateTime.Today).AddDays(-1);
    [RelayCommand] private void Today() => SelectedDate = DateTime.Today;
    [RelayCommand] private void NextDay() => SelectedDate = (SelectedDate ?? DateTime.Today).AddDays(1);

    [RelayCommand]
    private void DeleteTodo(TodoItemViewModel? item)
    {
        if (item is null)
        {
            return;
        }
        if (!ConfirmationDialog.ConfirmDelete("这个任务")) return;

        Workspace.RemoveTodo(item);
        if (SelectedTodo == item)
        {
            SelectedTodo = Workspace.Todos.FirstOrDefault();
        }
    }

    [RelayCommand]
    private void ClearReminder()
    {
        SelectedTodo?.ClearReminder();
    }

    [RelayCommand]
    private void SnoozeReminder(string? minutes)
    {
        if (SelectedTodo is null || !int.TryParse(minutes, out var value)) return;
        SelectedTodo.SetReminder(DateTime.Now.AddMinutes(value));
    }

    private bool CanAddTodo() => !string.IsNullOrWhiteSpace(NewTodoTitle);
    public void Dispose()
    {
        _viewRefreshTimer.Stop();
        _viewRefreshTimer.Tick -= _viewRefreshHandler;
    }
    private void OnSelectedTodoPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (sender is TodoItemViewModel item && e.PropertyName == nameof(TodoItemViewModel.Tag)) { EnsureTagPreset(item.Tag); UpdateTagColor(item); }
    }
    private void EnsureTagPreset(string tag)
    {
        tag = tag.Trim();
        if (string.IsNullOrWhiteSpace(tag) || Workspace.State.TagPresets.Any(item => string.Equals(item.Name, tag, StringComparison.OrdinalIgnoreCase))) return;
        var colors = new[] { unchecked((int)0xFF0F8A72), unchecked((int)0xFF2563EB), unchecked((int)0xFFC2414B), unchecked((int)0xFF7C3AED), unchecked((int)0xFFD97706) };
        Workspace.State.TagPresets.Add(new TagPresetRecord { Name = tag, ColorArgb = colors[Workspace.State.TagPresets.Count % colors.Length] });
        OnPropertyChanged(nameof(AvailableTags)); Workspace.MarkChanged();
    }

    private void OnTodosCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.OldItems is not null) foreach (TodoItemViewModel item in e.OldItems) item.PropertyChanged -= OnTodoChanged;
        if (e.NewItems is not null) foreach (TodoItemViewModel item in e.NewItems) ObserveTodo(item);
        RefreshFilteredTodos();
    }

    private void ObserveTodo(TodoItemViewModel item)
    {
        item.PropertyChanged += OnTodoChanged;
        UpdateTagColor(item);
    }

    private void OnTodoChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (sender is TodoItemViewModel item && e.PropertyName == nameof(TodoItemViewModel.Tag)) UpdateTagColor(item);
        if (e.PropertyName == nameof(TodoItemViewModel.IsCompleted)) OnPropertyChanged(nameof(TodayOpenCount));
        if (e.PropertyName == nameof(TodoItemViewModel.IsCompleted)) OnPropertyChanged(nameof(SelectedOpenCount));
    }

    private void UpdateTagColor(TodoItemViewModel item)
    {
        var preset = Workspace.State.TagPresets.FirstOrDefault(value => string.Equals(value.Name, item.Tag, StringComparison.OrdinalIgnoreCase));
        item.TagColorArgb = preset?.ColorArgb ?? unchecked((int)0xFF64748B);
    }

    private void RefreshFilteredTodos()
    {
        var selected = (SelectedDate ?? DateTime.Today).Date;
        var source = ListMode switch
        {
            TaskListMode.All => Workspace.Todos,
            TaskListMode.Open => Workspace.Todos.Where(item => !item.IsCompleted),
            TaskListMode.Overdue => Workspace.Todos.Where(item => !item.IsCompleted && item.Record.ReminderAt is { } reminder && reminder < DateTime.Now && (item.Record.ReminderRepeat != ReminderRepeat.None || item.Record.ReminderNotifiedAt is null)),
            _ => Workspace.Todos.Where(item => item.CreatedAt.Date == selected)
        };
        Replace(FilteredTodos, source);
        Replace(TodayTodos, Workspace.Todos.Where(item => item.CreatedAt.Date == DateTime.Today));
        if (SelectedTodo is null || !FilteredTodos.Contains(SelectedTodo)) SelectedTodo = FilteredTodos.FirstOrDefault();
        OnPropertyChanged(nameof(TodayOpenCount));
        OnPropertyChanged(nameof(SelectedOpenCount));
    }

    private static void Replace(ObservableCollection<TodoItemViewModel> target, IEnumerable<TodoItemViewModel> source)
    {
        target.Clear();
        foreach (var item in source) target.Add(item);
    }

    private static string LunarText(DateTime date)
    {
        var calendar = new ChineseLunisolarCalendar();
        var year = calendar.GetYear(date); var month = calendar.GetMonth(date); var day = calendar.GetDayOfMonth(date); var leapMonth = calendar.GetLeapMonth(year);
        var isLeap = leapMonth > 0 && month == leapMonth;
        if (leapMonth > 0 && month >= leapMonth) month--;
        var months = new[] { "正月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "冬月", "腊月" };
        var prefixes = new[] { "初", "十", "廿", "三" }; var digits = new[] { "", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十" };
        var monthText = month >= 1 && month <= months.Length ? months[month - 1] : $"{month}月";
        var dayText = day switch { 10 => "初十", 20 => "二十", 30 => "三十", _ => $"{prefixes[(day - 1) / 10]}{digits[day % 10]}" };
        return $"农历{(isLeap ? "闰" : string.Empty)}{monthText}{dayText}";
    }
}

public sealed record ReminderRepeatOption(ReminderRepeat Value, string Label);

public enum TaskListMode
{
    SelectedDate,
    All,
    Open,
    Overdue
}
