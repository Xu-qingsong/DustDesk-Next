using System.Collections.ObjectModel;
using System.Collections.Specialized;
using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class WorkspaceViewModel : ObservableObject
{
    private readonly IAppStateStore _store;
    private readonly ILegacyDataImporter _legacyImporter;
    private CancellationTokenSource? _saveDebounce;
    private bool _initialized;

    public WorkspaceViewModel(IAppStateStore store, ILegacyDataImporter legacyImporter)
    {
        _store = store;
        _legacyImporter = legacyImporter;
        Todos.CollectionChanged += OnTodosChanged;
    }

    public ObservableCollection<TodoItemViewModel> Todos { get; } = new();
    public WorkspaceState State { get; private set; } = new();
    public string DataFilePath => _store.DataFilePath;
    public string DataDirectory => _store.DataDirectory;
    public int TotalCount => Todos.Count;
    public int CompletedCount => Todos.Count(item => item.IsCompleted);
    public int OpenCount => TotalCount - CompletedCount;

    [ObservableProperty]
    private string _quickNote = string.Empty;

    [ObservableProperty]
    private string _displayName = "DustDesk";

    [ObservableProperty] private bool _isSaving;
    [ObservableProperty] private string _saveErrorText = string.Empty;
    [ObservableProperty] private DateTime? _lastSavedAt;

    public async Task InitializeAsync()
    {
        State = await _store.LoadAsync();
        var imported = await _legacyImporter.ImportAsync(State);
        NormalizeSpecialWidgetPlacements();
        QuickNote = State.QuickNote;
        DisplayName = string.IsNullOrWhiteSpace(State.Settings.MainWindowDisplayName) ? "DustDesk" : State.Settings.MainWindowDisplayName.Trim();

        foreach (var record in State.Todos)
        {
            Todos.Add(TodoItemViewModel.FromRecord(record));
        }

        _initialized = true;
        NotifySummaryChanged();
        if (imported)
        {
            await SaveAsync();
        }
    }

    public TodoItemViewModel AddTodo(string title)
    {
        return AddTodo(new TodoRecord { Title = title.Trim() });
    }

    public TodoItemViewModel AddTodo(TodoRecord record)
    {
        var item = TodoItemViewModel.FromRecord(record);
        Todos.Insert(0, item);
        return item;
    }

    public void RemoveTodo(TodoItemViewModel item)
    {
        Todos.Remove(item);
    }

    public void MarkChanged() => QueueSave();

    public async Task FlushAsync()
    {
        _saveDebounce?.Cancel();
        await SaveWithStatusAsync();
    }

    [RelayCommand]
    private async Task RetrySaveAsync() => await FlushAsync();

    partial void OnQuickNoteChanged(string value)
    {
        QueueSave();
    }

    partial void OnDisplayNameChanged(string value)
    {
        if (_initialized) State.Settings.MainWindowDisplayName = string.IsNullOrWhiteSpace(value) ? "DustDesk" : value.Trim();
        QueueSave();
    }

    private void OnTodosChanged(object? sender, NotifyCollectionChangedEventArgs e)
    {
        if (e.OldItems is not null)
        {
            foreach (TodoItemViewModel item in e.OldItems)
            {
                item.PropertyChanged -= OnTodoPropertyChanged;
            }
        }

        if (e.NewItems is not null)
        {
            foreach (TodoItemViewModel item in e.NewItems)
            {
                item.PropertyChanged += OnTodoPropertyChanged;
            }
        }

        NotifySummaryChanged();
        QueueSave();
    }

    private void OnTodoPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName == nameof(TodoItemViewModel.IsCompleted))
        {
            NotifySummaryChanged();
        }
        QueueSave();
    }

    private void NotifySummaryChanged()
    {
        OnPropertyChanged(nameof(TotalCount));
        OnPropertyChanged(nameof(CompletedCount));
        OnPropertyChanged(nameof(OpenCount));
    }

    private void QueueSave()
    {
        if (!_initialized)
        {
            return;
        }

        _saveDebounce?.Cancel();
        _saveDebounce = new CancellationTokenSource();
        _ = SaveAfterDelayAsync(_saveDebounce.Token);
    }

    private async Task SaveAfterDelayAsync(CancellationToken cancellationToken)
    {
        try
        {
            await Task.Delay(450, cancellationToken);
            await SaveWithStatusAsync(cancellationToken);
        }
        catch (OperationCanceledException)
        {
        }
        catch (Exception ex)
        {
            SaveErrorText = $"本地数据保存失败：{ex.Message}";
        }
    }

    private async Task SaveWithStatusAsync(CancellationToken cancellationToken = default)
    {
        IsSaving = true;
        try
        {
            await SaveAsync(cancellationToken);
            LastSavedAt = DateTime.Now;
            SaveErrorText = string.Empty;
        }
        catch (Exception ex)
        {
            SaveErrorText = $"本地数据保存失败：{ex.Message}";
            throw;
        }
        finally { IsSaving = false; }
    }

    private Task SaveAsync(CancellationToken cancellationToken = default)
    {
        State.Settings.MainWindowDisplayName = string.IsNullOrWhiteSpace(DisplayName) ? "DustDesk" : DisplayName.Trim();
        var state = new WorkspaceState
        {
            SchemaVersion = 2,
            LegacyImportCompleted = State.LegacyImportCompleted,
            QuickNote = QuickNote,
            Settings = State.Settings,
            Todos = Todos.Select(item => item.Record).ToList(),
            TagPresets = State.TagPresets,
            Notes = State.Notes,
            Projects = State.Projects,
            Launchers = State.Launchers,
            LinkGroups = State.LinkGroups,
            ClipboardHistory = State.ClipboardHistory,
            DesktopCategories = State.DesktopCategories
        };
        State = state;
        return _store.SaveAsync(state, cancellationToken);
    }

    private void NormalizeSpecialWidgetPlacements()
    {
        foreach (var note in State.Settings.NoteWidgetPlacements)
        {
            var key = $"note:{note.NoteId}";
            if (State.Settings.WidgetPlacements.TryGetValue(key, out var saved)) CopyPlacement(saved, note);
            State.Settings.WidgetPlacements[key] = note;
        }
        foreach (var item in State.Settings.WidgetPlacements.Where(item => item.Key.StartsWith("note:", StringComparison.OrdinalIgnoreCase)).ToList())
        {
            var id = item.Key[5..];
            if (State.Settings.NoteWidgetPlacements.Any(note => string.Equals(note.NoteId, id, StringComparison.OrdinalIgnoreCase))) continue;
            var note = new NoteWidgetPlacementRecord { NoteId = id }; CopyPlacement(item.Value, note);
            State.Settings.NoteWidgetPlacements.Add(note); State.Settings.WidgetPlacements[item.Key] = note;
        }
        foreach (var group in State.Settings.OrganizerGroupWidgetPlacements)
        {
            var key = $"organizer-group:{group.GroupId}";
            if (State.Settings.WidgetPlacements.TryGetValue(key, out var saved)) CopyPlacement(saved, group);
            State.Settings.WidgetPlacements[key] = group;
        }
    }

    private static void CopyPlacement(WidgetPlacementRecord source, WidgetPlacementRecord target)
    {
        target.Visible = source.Visible; target.Locked = source.Locked; target.TopMost = source.TopMost;
        target.X = source.X; target.Y = source.Y; target.Width = source.Width; target.Height = source.Height;
        target.AutoCollapseEnabled = source.AutoCollapseEnabled; target.IsCollapsed = source.IsCollapsed;
        target.SnapToEdges = source.SnapToEdges; target.TransparentBackground = source.TransparentBackground;
        target.DockEdge = source.DockEdge;
    }
}
