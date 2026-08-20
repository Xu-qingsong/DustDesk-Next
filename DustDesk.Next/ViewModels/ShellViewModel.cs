using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class ShellViewModel : ObservableObject
{
    private readonly DashboardViewModel _dashboard;
    private readonly TasksViewModel _tasks;
    private readonly NotesViewModel _notes;
    private readonly ProjectsViewModel _projects;
    private readonly LaunchersViewModel _launchers;
    private readonly LinksViewModel _links;
    private readonly SearchViewModel _search;
    private readonly ClipboardViewModel _clipboard;
    private readonly SystemMonitorViewModel _monitor;
    private readonly SettingsViewModel _settings;
    private readonly OrganizerViewModel _organizer;
    private readonly StatsViewModel _stats;

    public ShellViewModel(DashboardViewModel dashboard, TasksViewModel tasks, NotesViewModel notes, ProjectsViewModel projects, LaunchersViewModel launchers, LinksViewModel links, SearchViewModel search, ClipboardViewModel clipboard, SystemMonitorViewModel monitor, SettingsViewModel settings, OrganizerViewModel organizer, StatsViewModel stats, WorkspaceViewModel workspace)
    {
        _dashboard = dashboard;
        _tasks = tasks;
        _notes = notes;
        _projects = projects;
        _launchers = launchers;
        _links = links;
        _search = search;
        _clipboard = clipboard;
        _monitor = monitor;
        _settings = settings;
        _organizer = organizer;
        _stats = stats;
        _search.NavigateRequested += NavigateTo;
        Workspace = workspace;
        NavigationItems = new ObservableCollection<NavigationItemViewModel>
        {
            new() { Key = "home", Label = "概览", Glyph = "\uE80F", IsSelected = true },
            new() { Key = "tasks", Label = "任务", Glyph = "\uE9D5" },
            new() { Key = "organizer", Label = "桌面收纳", Glyph = "\uE8B7" },
            new() { Key = "notes", Label = "便签", Glyph = "\uE70B" },
            new() { Key = "links", Label = "超链接", Glyph = "\uE71B" },
            new() { Key = "launcher", Label = "快捷启动", Glyph = "\uE945" },
            new() { Key = "projects", Label = "项目", Glyph = "\uE821" },
            new() { Key = "stats", Label = "统计分析", Glyph = "\uE9D2" },
            new() { Key = "search", Label = "搜索", Glyph = "\uE721" },
            new() { Key = "clipboard", Label = "剪贴板", Glyph = "\uE8C8" },
            new() { Key = "monitor", Label = "系统检测", Glyph = "\uE9D9" },
            new() { Key = "settings", Label = "设置", Glyph = "\uE713" }
        };
        PrimaryNavigationItems = NavigationItems
            .Where(item => item.Key is "home" or "tasks" or "organizer" or "notes" or "links" or "launcher")
            .ToArray();
        SecondaryNavigationItems = NavigationItems
            .Where(item => item.Key is "projects" or "stats" or "search" or "clipboard" or "monitor" or "settings")
            .ToArray();
        CurrentPage = _dashboard;
    }

    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<NavigationItemViewModel> NavigationItems { get; }
    public IReadOnlyList<NavigationItemViewModel> PrimaryNavigationItems { get; }
    public IReadOnlyList<NavigationItemViewModel> SecondaryNavigationItems { get; }
    public bool IsSecondaryNavigationSelected => SecondaryNavigationItems.Any(item => item.IsSelected);

    [ObservableProperty]
    private object _currentPage;

    [ObservableProperty]
    private string _pageTitle = "概览";

    [RelayCommand]
    private void Navigate(NavigationItemViewModel? item)
    {
        if (item is null || !item.IsEnabled)
        {
            return;
        }

        foreach (var navigationItem in NavigationItems)
        {
            navigationItem.IsSelected = navigationItem == item;
        }
        OnPropertyChanged(nameof(IsSecondaryNavigationSelected));

        PageTitle = item.Label;
        if (item.Key == "stats") _stats.RefreshCommand.Execute(null);
        CurrentPage = item.Key switch
        {
            "tasks" => _tasks,
            "notes" => _notes,
            "projects" => _projects,
            "launcher" => _launchers,
            "links" => _links,
            "search" => _search,
            "clipboard" => _clipboard,
            "monitor" => _monitor,
            "settings" => _settings,
            "organizer" => _organizer,
            "stats" => _stats,
            _ => _dashboard
        };
    }

    private void NavigateTo(SearchResult result)
    {
        var item = NavigationItems.FirstOrDefault(candidate => string.Equals(candidate.Key, result.PageKey, StringComparison.OrdinalIgnoreCase));
        if (item is null) return;
        Navigate(item);
        if (string.IsNullOrWhiteSpace(result.ItemId)) return;
        if (result.PageKey == "tasks" && Workspace.Todos.FirstOrDefault(todo => todo.Id == result.ItemId) is { } todo)
        {
            _tasks.SelectedDate = todo.CreatedAt.Date; _tasks.SelectedTodo = todo;
        }
        else if (result.PageKey == "notes" && _notes.Notes.FirstOrDefault(note => note.Id == result.ItemId) is { } note) _notes.SelectedNote = note;
        else if (result.PageKey == "links") _links.SelectLink(result.ItemId);
        else if (result.PageKey == "projects") _projects.SelectItem(result.ItemId);
    }
}
