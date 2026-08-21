using DustDesk.Next.Models;
using DustDesk.Next.ViewModels;
using DustDesk.Next.Widgets;
using Microsoft.Extensions.DependencyInjection;

namespace DustDesk.Next.Services;

public sealed class WidgetManager : IWidgetManager
{
    private readonly IServiceProvider _services;
    private readonly WorkspaceViewModel _workspace;
    private readonly Dictionary<string, DesktopWidgetWindow> _windows = new(StringComparer.OrdinalIgnoreCase);
    private bool _preserveVisibility;

    public WidgetManager(IServiceProvider services, WorkspaceViewModel workspace) { _services = services; _workspace = workspace; }
    public bool IsVisible(string key) => _windows.TryGetValue(key, out var window) && window.IsVisible;
    public void Show(string key)
    {
        if (_windows.TryGetValue(key, out var existing)) { existing.Show(); existing.Activate(); return; }
        var placement = GetPlacement(key);
        placement.Visible = true;
        var content = CreateContent(key);
        if (content is null) { placement.Visible = false; _workspace.MarkChanged(); return; }
        var window = new DesktopWidgetWindow(GetTitle(key), content, placement, _workspace.MarkChanged, _workspace.State.Settings.WidgetBackgroundColorArgb);
        window.SetAppearance(Math.Clamp(_workspace.State.Settings.WidgetOpacityPercent / 100d, 0.2, 1), _workspace.State.Settings.WidgetBackgroundColorArgb);
        window.Closed += (_, _) => { _windows.Remove(key); if (!_preserveVisibility) { placement.Visible = false; _workspace.MarkChanged(); } };
        _windows[key] = window; window.Show(); _workspace.MarkChanged();
    }
    public void Hide(string key) { if (_windows.TryGetValue(key, out var window)) window.Close(); else GetPlacement(key).Visible = false; _workspace.MarkChanged(); }
    public void Toggle(string key) { if (IsVisible(key)) Hide(key); else Show(key); }
    public void ToggleConfigured()
    {
        var targets = _workspace.State.Settings.DesktopHotKeyWidgetKeys.Count > 0 ? _workspace.State.Settings.DesktopHotKeyWidgetKeys : new List<string> { "organizer" };
        var keys = targets.SelectMany(ExpandHotKeyTarget).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        var anyVisible = keys.Any(IsVisible);
        foreach (var key in keys) { if (anyVisible) { if (IsVisible(key)) _windows[key].Hide(); } else Show(key); }
    }
    public void RestoreConfigured() { foreach (var item in _workspace.State.Settings.WidgetPlacements.Where(item => item.Value.Visible)) Show(item.Key); }
    public void CloseAll(bool preserveVisibility) { _preserveVisibility = preserveVisibility; foreach (var window in _windows.Values.ToArray()) window.Close(); _windows.Clear(); _preserveVisibility = false; }
    public void RefreshAppearance()
    {
        var opacity = Math.Clamp(_workspace.State.Settings.WidgetOpacityPercent / 100d, 0.2, 1);
        foreach (var window in _windows.Values) window.SetAppearance(opacity, _workspace.State.Settings.WidgetBackgroundColorArgb);
    }

    public IReadOnlyList<string> GetLayoutPresetNames() => _workspace.State.Settings.WidgetLayoutPresets.Keys.OrderBy(name => name, StringComparer.CurrentCultureIgnoreCase).ToList();

    public void SaveLayoutPreset(string name)
    {
        name = name.Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new ArgumentException("布局方案名称不能为空。", nameof(name));
        _workspace.State.Settings.WidgetLayoutPresets[name] = _workspace.State.Settings.WidgetPlacements.ToDictionary(
            item => item.Key,
            item => ClonePlacement(item.Value),
            StringComparer.OrdinalIgnoreCase);
        _workspace.MarkChanged();
    }

    public bool ApplyLayoutPreset(string name)
    {
        if (!_workspace.State.Settings.WidgetLayoutPresets.TryGetValue(name, out var preset)) return false;
        CloseAll(true);
        _workspace.State.Settings.WidgetPlacements = preset.ToDictionary(item => item.Key, item => ClonePlacement(item.Value), StringComparer.OrdinalIgnoreCase);
        _workspace.MarkChanged();
        RestoreConfigured();
        return true;
    }

    public bool DeleteLayoutPreset(string name)
    {
        var removed = _workspace.State.Settings.WidgetLayoutPresets.Remove(name);
        if (removed) _workspace.MarkChanged();
        return removed;
    }

    private static WidgetPlacementRecord ClonePlacement(WidgetPlacementRecord source) => new()
    {
        Visible = source.Visible, Locked = source.Locked, TopMost = source.TopMost,
        X = source.X, Y = source.Y, Width = source.Width, Height = source.Height,
        AutoCollapseEnabled = source.AutoCollapseEnabled, IsCollapsed = source.IsCollapsed,
        SnapToEdges = source.SnapToEdges, TransparentBackground = source.TransparentBackground,
        DockEdge = source.DockEdge
    };
    private WidgetPlacementRecord GetPlacement(string key)
    {
        if (_workspace.State.Settings.WidgetPlacements.TryGetValue(key, out var placement))
        {
            if (key.Equals("launcher", StringComparison.OrdinalIgnoreCase)) placement.SnapToEdges = _workspace.State.Settings.LauncherWidgetSnapToEdges;
            if (key.Equals("search", StringComparison.OrdinalIgnoreCase)) placement.SnapToEdges = true;
            return placement;
        }
        placement = key.StartsWith("note:", StringComparison.OrdinalIgnoreCase)
            ? new NoteWidgetPlacementRecord { NoteId = key[5..], Width = 390, Height = 320 }
            : new WidgetPlacementRecord
            {
                Width = key is "search" ? 520 : key is "countdown" ? 540 : 390,
                Height = key is "launcher" ? 240 : key is "links" ? 360 : key is "countdown" ? 254 : 320
            };
        if (placement is NoteWidgetPlacementRecord notePlacement) _workspace.State.Settings.NoteWidgetPlacements.Add(notePlacement);
        if (key.Equals("launcher", StringComparison.OrdinalIgnoreCase)) placement.SnapToEdges = _workspace.State.Settings.LauncherWidgetSnapToEdges;
        if (key.Equals("search", StringComparison.OrdinalIgnoreCase)) placement.SnapToEdges = true;
        _workspace.State.Settings.WidgetPlacements[key] = placement; return placement;
    }
    private object? CreateContent(string key) => key.ToLowerInvariant() switch
    {
        "todo" => new TodoWidgetView { DataContext = _services.GetRequiredService<TasksViewModel>() },
        "project" => new ProjectWidgetView { DataContext = _services.GetRequiredService<ProjectsViewModel>() },
        "launcher" => new LauncherWidgetView { DataContext = _services.GetRequiredService<LaunchersViewModel>() },
        "links" => new LinksWidgetView { DataContext = _services.GetRequiredService<LinksViewModel>() },
        "monitor" => new MonitorWidgetView { DataContext = _services.GetRequiredService<SystemMonitorViewModel>() },
        "countdown" => new WorkdayCountdownWidgetView { DataContext = _services.GetRequiredService<WorkdayCountdownViewModel>() },
        "search" => new SearchWidgetView { DataContext = _services.GetRequiredService<SearchViewModel>() },
        "clipboard" => new ClipboardWidgetView { DataContext = _services.GetRequiredService<ClipboardViewModel>() },
        "organizer" => new OrganizerWidgetView { DataContext = _services.GetRequiredService<OrganizerViewModel>() },
        _ when key.StartsWith("organizer-group:", StringComparison.OrdinalIgnoreCase) => CreateOrganizerGroup(key[16..]),
        _ when key.StartsWith("organizer:", StringComparison.OrdinalIgnoreCase) => CreateOrganizerCategory(key[10..]),
        _ when key.StartsWith("project:", StringComparison.OrdinalIgnoreCase) => CreateProject(key[8..]),
        _ when key.StartsWith("note:", StringComparison.OrdinalIgnoreCase) => CreateNote(key[5..]),
        _ => null
    };
    private object? CreateNote(string id)
    {
        var note = _services.GetRequiredService<NotesViewModel>().Notes.FirstOrDefault(item => item.Id == id);
        return note is null ? null : new NoteWidgetView { DataContext = note };
    }
    private object? CreateOrganizerCategory(string id)
    {
        var owner = _services.GetRequiredService<OrganizerViewModel>();
        var category = owner.Categories.FirstOrDefault(item => item.Record.Id == id);
        return category is null ? null : new OrganizerCategoryWidgetView { DataContext = new OrganizerCategoryWidgetContext(category, owner) };
    }
    private object? CreateOrganizerGroup(string id)
    {
        var placement = _workspace.State.Settings.OrganizerGroupWidgetPlacements.FirstOrDefault(item => item.GroupId == id);
        if (placement is null) return null;
        var owner = _services.GetRequiredService<OrganizerViewModel>();
        var categories = owner.Categories.Where(item => placement.CategoryIds.Contains(item.Record.Id, StringComparer.OrdinalIgnoreCase)).ToList();
        return categories.Count == 0 ? null : new OrganizerGroupWidgetView { DataContext = new OrganizerGroupWidgetContext(categories, owner) };
    }
    private object? CreateProject(string id)
    {
        var project = _services.GetRequiredService<ProjectsViewModel>().Projects.FirstOrDefault(item => item.Record.Id == id);
        return project is null ? null : new SingleProjectWidgetView { DataContext = project };
    }
    private string GetTitle(string key)
    {
        if (key.StartsWith("organizer:", StringComparison.OrdinalIgnoreCase)) return _services.GetRequiredService<OrganizerViewModel>().Categories.FirstOrDefault(item => item.Record.Id == key[10..])?.Name ?? "桌面分类";
        if (key.StartsWith("organizer-group:", StringComparison.OrdinalIgnoreCase))
        {
            var group = _workspace.State.Settings.OrganizerGroupWidgetPlacements.FirstOrDefault(item => item.GroupId == key[16..]);
            var categories = _services.GetRequiredService<OrganizerViewModel>().Categories.Where(item => group?.CategoryIds.Contains(item.Record.Id, StringComparer.OrdinalIgnoreCase) == true).Select(item => item.Name);
            return string.Join("、", categories) is { Length: > 0 } title ? title : "桌面分类组";
        }
        if (key.StartsWith("note:", StringComparison.OrdinalIgnoreCase)) return _services.GetRequiredService<NotesViewModel>().Notes.FirstOrDefault(item => item.Id == key[5..])?.Title ?? "便签";
        if (key.StartsWith("project:", StringComparison.OrdinalIgnoreCase)) return _services.GetRequiredService<ProjectsViewModel>().Projects.FirstOrDefault(item => item.Record.Id == key[8..])?.Name ?? "项目";
        return key.Split(':')[0].ToLowerInvariant() switch { "todo" => "工作记录", "project" => "项目", "launcher" => "快捷启动", "links" => "超链接", "monitor" => "系统检测", "countdown" => "下班倒计时", "search" => "搜索", "clipboard" => "剪贴板", "organizer" => "桌面收纳", "note" => "便签", _ => "DustDesk" };
    }
    private IEnumerable<string> ExpandHotKeyTarget(string key)
    {
        if (!key.Equals("note", StringComparison.OrdinalIgnoreCase)) { yield return key; yield break; }
        foreach (var note in _workspace.State.Notes) yield return $"note:{note.Id}";
    }
}
