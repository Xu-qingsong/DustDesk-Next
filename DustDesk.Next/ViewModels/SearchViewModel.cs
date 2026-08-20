using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class SearchViewModel : ObservableObject
{
    private readonly ISearchService _search;
    private readonly IDesktopService _desktop;
    private readonly IShellContextMenuService _shellMenu;
    private readonly TasksViewModel? _tasks;
    private readonly NotesViewModel? _notes;
    private CancellationTokenSource? _searchCancellation;

    public SearchViewModel(WorkspaceViewModel workspace, ISearchService search, IDesktopService desktop, IShellContextMenuService shellMenu, TasksViewModel? tasks = null, NotesViewModel? notes = null)
    {
        Workspace = workspace; _search = search; _desktop = desktop; _shellMenu = shellMenu; _tasks = tasks; _notes = notes;
    }
    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<SearchResult> Results { get; } = new();
    public event Action<SearchResult>? NavigateRequested;
    [ObservableProperty]
    [NotifyPropertyChangedFor(nameof(HasActiveQuery))]
    private string _query = string.Empty;
    [ObservableProperty] private bool _isSearching;
    [ObservableProperty] private string _statusText = "输入名称开始搜索";
    public bool HasActiveQuery => !string.IsNullOrWhiteSpace(Query);
    partial void OnQueryChanged(string value) => _ = SearchAfterDelayAsync(value);

    [RelayCommand]
    private void OpenResult(SearchResult? result)
    {
        if (result is null) return;
        if (!string.IsNullOrWhiteSpace(result.PageKey)) NavigateRequested?.Invoke(result);
        else _desktop.Open(result.Path);
    }

    [RelayCommand]
    private void ShowResultMenu(SearchResult? result) { if (result is not null && string.IsNullOrWhiteSpace(result.PageKey)) _shellMenu.ShowForPath(result.Path); }

    [RelayCommand]
    private void OpenFirst()
    {
        var command = Query.Trim();
        if (command.StartsWith("clip", StringComparison.OrdinalIgnoreCase))
        {
            NavigateRequested?.Invoke(new SearchResult("剪贴板", string.Empty, "剪贴板", "clipboard"));
            return;
        }
        if (command.StartsWith("open ", StringComparison.OrdinalIgnoreCase))
        {
            var path = command[5..].Trim().Trim('"');
            if (!string.IsNullOrWhiteSpace(path)) _desktop.Open(path);
            return;
        }
        var taskPrefix = command.StartsWith("todo ", StringComparison.OrdinalIgnoreCase) ? 5 : command.StartsWith("task ", StringComparison.OrdinalIgnoreCase) ? 5 : -1;
        if (taskPrefix >= 0 && !string.IsNullOrWhiteSpace(command[taskPrefix..]))
        {
            _tasks?.CreateFromText(command[taskPrefix..]);
            NavigateRequested?.Invoke(new SearchResult("任务", string.Empty, "工作记录", "tasks"));
            return;
        }
        if (command.StartsWith("note ", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(command[5..]))
        {
            _notes?.CreateFromText(command[5..]);
            NavigateRequested?.Invoke(new SearchResult("便签", string.Empty, "便签", "notes"));
            return;
        }
        if (Results.FirstOrDefault() is { } result) OpenResult(result);
    }

    private async Task SearchAfterDelayAsync(string query)
    {
        _searchCancellation?.Cancel();
        _searchCancellation = new CancellationTokenSource();
        var token = _searchCancellation.Token;
        Results.Clear();
        if (string.IsNullOrWhiteSpace(query)) { StatusText = "输入名称开始搜索"; return; }
        try
        {
            await Task.Delay(250, token);
            IsSearching = true; StatusText = "正在搜索…";
            var projectPaths = Workspace.State.Projects.SelectMany(project => new[] { project.ProjectPath }.Concat(project.Phases.Select(phase => phase.ProjectPath))).Where(path => !string.IsNullOrWhiteSpace(path));
            var fileResults = await _search.SearchAsync(query, projectPaths, Workspace.State.Settings, token);
            var results = SearchWorkspace(query).Concat(fileResults)
                .GroupBy(item => $"{item.Kind}\0{item.Name}\0{item.Path}", StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .Take(120);
            foreach (var result in results) Results.Add(result);
            StatusText = Results.Count == 0 ? "没有找到匹配内容" : $"找到 {Results.Count} 项";
        }
        catch (OperationCanceledException) { }
        finally { IsSearching = false; }
    }

    private IEnumerable<SearchResult> SearchWorkspace(string query)
    {
        bool Match(params string?[] values) => values.Any(value => value?.Contains(query, StringComparison.CurrentCultureIgnoreCase) == true);
        if (Workspace.State.Settings.SearchAppData)
        {
            foreach (var launcher in Workspace.State.Launchers.Where(item => Match(item.Name, item.Path)))
                yield return new SearchResult(launcher.Name, launcher.Path, "快捷启动");
            foreach (var group in Workspace.State.LinkGroups)
                foreach (var link in group.Links.Where(item => Match(item.Name, item.Url, item.Note, group.Name)))
                    yield return new SearchResult(link.Name, link.Url, "超链接", "links", link.Id);
            foreach (var category in Workspace.State.DesktopCategories.Where(item => Match(item.Name)))
                yield return new SearchResult(category.Name, $"{category.ItemPaths.Count} 项", "桌面分类", "organizer");
            foreach (var todo in Workspace.Todos.Where(item => Match(item.Title, item.Tag, item.Note)))
                yield return new SearchResult(todo.Title, string.IsNullOrWhiteSpace(todo.Note) ? todo.Tag : todo.Note, "工作记录", "tasks", todo.Id);
            foreach (var note in Workspace.State.Notes.Where(item => Match(item.Title, item.Text)))
                yield return new SearchResult(note.Title, FirstLine(note.Text), "便签", "notes", note.Id);
            foreach (var project in Workspace.State.Projects)
            {
                if (Match(project.Name, project.ProjectPath))
                    yield return new SearchResult(project.Name, project.ProjectPath, "项目", Directory.Exists(project.ProjectPath) ? null : "projects", project.Id);
                foreach (var phase in project.Phases.Where(item => Match(item.Title, item.ProjectPath)))
                    yield return new SearchResult(phase.Title, phase.ProjectPath, "项目阶段", File.Exists(phase.ProjectPath) || Directory.Exists(phase.ProjectPath) ? null : "projects", phase.Id);
                foreach (var subtask in project.Phases.SelectMany(item => item.Subtasks).Where(item => Match(item.Title, item.FilePath)))
                    yield return new SearchResult(subtask.Title, subtask.FilePath, "项目子事项", File.Exists(subtask.FilePath) || Directory.Exists(subtask.FilePath) ? null : "projects", subtask.Id);
            }
        }
        if (Workspace.State.Settings.SearchDesktopFiles)
        {
            foreach (var path in Workspace.State.DesktopCategories.SelectMany(item => item.ItemPaths).Where(path => Match(System.IO.Path.GetFileName(path), path)))
                yield return new SearchResult(System.IO.Path.GetFileName(path), path, Directory.Exists(path) ? "收纳文件夹" : "收纳文件");
        }
    }

    private static string FirstLine(string text) => text.Replace('\r', ' ').Replace('\n', ' ').Trim() is { Length: > 80 } value ? value[..80] : text.Replace('\r', ' ').Replace('\n', ' ').Trim();
}
