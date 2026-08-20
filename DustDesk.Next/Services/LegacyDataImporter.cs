using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public sealed class LegacyDataImporter : ILegacyDataImporter
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        Converters = { new JsonStringEnumConverter() }
    };

    public async Task<bool> ImportAsync(WorkspaceState target, CancellationToken cancellationToken = default)
    {
        if (target.LegacyImportCompleted)
        {
            return false;
        }

        var directory = ResolveLegacyDataDirectory();
        target.LegacyImportCompleted = true;
        target.SchemaVersion = Math.Max(target.SchemaVersion, 2);
        if (directory is null)
        {
            EnsureDefaults(target);
            return true;
        }

        var config = await ReadAsync<LegacyConfig>(Path.Combine(directory, "config.json"), cancellationToken);
        var todos = await ReadAsync<LegacyTodoData>(Path.Combine(directory, "todo.json"), cancellationToken);
        var notes = await ReadAsync<LegacyNoteData>(Path.Combine(directory, "note.json"), cancellationToken);
        var projects = await ReadAsync<LegacyProjectData>(Path.Combine(directory, "project.json"), cancellationToken);
        var launchers = await ReadAsync<LegacyLaunchData>(Path.Combine(directory, "launch.json"), cancellationToken);
        var clipboard = await ReadAsync<LegacyClipboardData>(Path.Combine(directory, "clipboard.json"), cancellationToken);

        MergeConfig(target, config);
        MergeTodos(target, todos);
        MergeNotes(target, notes);
        MergeProjects(target, projects);
        MergeLaunchers(target, launchers);
        MergeClipboard(target, clipboard);
        EnsureDefaults(target);
        return true;
    }

    private static string? ResolveLegacyDataDirectory()
    {
        var appDataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "DustDesk");
        var settingPath = Path.Combine(appDataRoot, "data-path.txt");
        if (File.Exists(settingPath))
        {
            var configured = File.ReadAllText(settingPath).Trim();
            if (Directory.Exists(configured))
            {
                return configured;
            }
        }

        var defaultDirectory = Path.Combine(appDataRoot, "Data");
        return Directory.Exists(defaultDirectory) ? defaultDirectory : null;
    }

    private static async Task<T?> ReadAsync<T>(string path, CancellationToken cancellationToken) where T : class
    {
        if (!File.Exists(path))
        {
            return null;
        }

        try
        {
            await using var stream = File.OpenRead(path);
            return await JsonSerializer.DeserializeAsync<T>(stream, JsonOptions, cancellationToken).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static void MergeConfig(WorkspaceState target, LegacyConfig? source)
    {
        if (source is null)
        {
            return;
        }

        target.Settings.StartHiddenToTray = source.StartHiddenToTray;
        target.Settings.MainWindowDisplayName = EmptyFallback(source.MainWindowDisplayName, "DustDesk");
        target.Settings.MainWindowHotKey = EmptyFallback(source.MainWindowHotKey, "Ctrl+Shift+K");
        target.Settings.DesktopWidgetsHotKey = EmptyFallback(source.DesktopOrganizerHotKey, "Ctrl+Shift+D");
        target.Settings.WidgetOpacityPercent = Math.Clamp(source.DesktopWidgetOpacity, 20, 100);
        target.Settings.SearchDesktopFiles = source.SearchDesktopFiles ?? true;
        target.Settings.SearchAppData = source.SearchAppData ?? true;
        target.Settings.SearchStartMenuApps = source.SearchStartMenuApps ?? true;
        target.Settings.SearchProjectPaths = source.SearchProjectPaths ?? true;
        target.Settings.SearchCustomPaths = source.SearchCustomPaths ?? true;
        target.Settings.SearchCustomRoots = source.SearchCustomRoots ?? new();
        target.Settings.LauncherWidgetSnapToEdges = source.DesktopLauncherWidgetSnap;
        target.Settings.LauncherWidgetShowNames = source.DesktopLauncherWidgetShowNames;
        target.Settings.LauncherWidgetIconSize = Math.Clamp(source.DesktopLauncherWidgetIconSize, 34, 64);
        target.Settings.OrganizerWidgetShowNames = source.DesktopOrganizerShowNames;
        target.Settings.OrganizerWidgetIconSize = Math.Clamp(source.DesktopOrganizerIconSize, 34, 64);
        target.Settings.MonitorShowDownload = source.DesktopSystemMonitorShowDownload;
        target.Settings.MonitorShowUpload = source.DesktopSystemMonitorShowUpload;
        target.Settings.MonitorShowMemory = source.DesktopSystemMonitorShowMemory;
        target.Settings.MonitorShowCpu = source.DesktopSystemMonitorShowCpu;
        target.Settings.MonitorShowDiskIo = source.DesktopSystemMonitorShowDiskIo;
        target.Settings.MonitorShowDiskSpace = source.DesktopSystemMonitorShowDiskSpace;
        target.Settings.MonitorShowPing = source.DesktopSystemMonitorShowPing;
        target.Settings.MonitorShowUptime = source.DesktopSystemMonitorShowUptime;
        target.Settings.DesktopHotKeyWidgetKeys = new List<string>();
        AddHotKeyTarget(target, "search", source.DesktopHotKeyToggleSearch);
        AddHotKeyTarget(target, "organizer", source.DesktopHotKeyToggleOrganizer);
        AddHotKeyTarget(target, "todo", source.DesktopHotKeyToggleTodo);
        AddHotKeyTarget(target, "note", source.DesktopHotKeyToggleNote);
        AddHotKeyTarget(target, "project", source.DesktopHotKeyToggleProject);
        AddHotKeyTarget(target, "launcher", source.DesktopHotKeyToggleLauncher);
        AddHotKeyTarget(target, "monitor", source.DesktopHotKeyToggleSystemMonitor);
        AddHotKeyTarget(target, "clipboard", source.DesktopHotKeyToggleClipboard);
        if (target.Settings.DesktopHotKeyWidgetKeys.Count == 0) target.Settings.DesktopHotKeyWidgetKeys.Add("organizer");

        foreach (var category in source.DesktopCategories ?? new())
        {
            if (target.DesktopCategories.All(item => !string.Equals(item.Name, category.Name, StringComparison.OrdinalIgnoreCase)))
            {
                target.DesktopCategories.Add(new DesktopCategoryRecord
                {
                    Name = category.Name,
                    IsCollapsed = category.IsCollapsed,
                    ItemPaths = category.ItemPaths ?? new()
                });
            }
        }

        AddPlacement(target, "organizer", source.DesktopOrganizerWidget);
        AddPlacement(target, "todo", source.DesktopTodoWidget);
        AddPlacement(target, "project", source.DesktopProjectWidget);
        AddPlacement(target, "launcher", source.DesktopLauncherWidget);
        if (target.Settings.WidgetPlacements.TryGetValue("launcher", out var launcherPlacement)) launcherPlacement.SnapToEdges = source.DesktopLauncherWidgetSnap;
        AddPlacement(target, "monitor", source.DesktopSystemMonitorWidget);
        AddPlacement(target, "search", source.DesktopSearchWidget);
        AddPlacement(target, "clipboard", source.DesktopClipboardWidget);
        SetTransparent(target, "organizer", source.DesktopWidgetTransparent);
        SetTransparent(target, "todo", source.DesktopTodoWidgetTransparent);
        SetTransparent(target, "project", source.DesktopProjectWidgetTransparent);
        SetTransparent(target, "launcher", source.DesktopLauncherWidgetTransparent);
        SetTransparent(target, "monitor", source.DesktopSystemMonitorWidgetTransparent);
        SetTransparent(target, "search", source.DesktopSearchWidgetTransparent);
        SetTransparent(target, "clipboard", source.DesktopClipboardWidgetTransparent);
        foreach (var split in source.DesktopOrganizerSplitWidgets ?? new())
        {
            var categoryIds = target.DesktopCategories.Where(category => split.CategoryNames.Contains(category.Name, StringComparer.Ordinal)).Select(category => category.Id).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (categoryIds.Count == 0) continue;
            var converted = new OrganizerGroupWidgetPlacementRecord { CategoryIds = categoryIds, Visible = split.Visible, Locked = split.Locked, TopMost = split.TopMost, X = split.X, Y = split.Y, Width = split.Width, Height = split.Height, AutoCollapseEnabled = split.AutoCollapseEnabled, IsCollapsed = split.IsCollapsed, TransparentBackground = source.DesktopWidgetTransparent };
            target.Settings.OrganizerGroupWidgetPlacements.Add(converted);
            target.Settings.WidgetPlacements[$"organizer-group:{converted.GroupId}"] = converted;
        }
        foreach (var placement in source.DesktopNoteWidgets ?? new())
        {
            var converted = new NoteWidgetPlacementRecord
            {
                NoteId = placement.NoteId,
                Visible = placement.Visible,
                Locked = placement.Locked,
                TopMost = placement.TopMost,
                X = placement.X,
                Y = placement.Y,
                Width = placement.Width,
                Height = placement.Height,
                AutoCollapseEnabled = placement.AutoCollapseEnabled,
                IsCollapsed = placement.IsCollapsed,
                TransparentBackground = source.DesktopWidgetTransparent
            };
            target.Settings.NoteWidgetPlacements.Add(converted);
            target.Settings.WidgetPlacements[$"note:{placement.NoteId}"] = converted;
        }
    }

    private static void MergeTodos(WorkspaceState target, LegacyTodoData? source)
    {
        if (source?.Items is null)
        {
            return;
        }

        RemoveStarterTodos(target);
        foreach (var item in source.Items)
        {
            if (target.Todos.Any(existing => existing.Title == item.Text && existing.CreatedAt == item.CreatedAt))
            {
                continue;
            }

            target.Todos.Add(new TodoRecord
            {
                Title = item.Text,
                Tag = item.Tag,
                Note = item.Note,
                IsCompleted = item.Done,
                CreatedAt = item.CreatedAt,
                ReminderAt = item.ReminderAt,
                ReminderNotifiedAt = item.ReminderNotifiedAt
            });
        }

        foreach (var tag in source.TagPresets ?? new())
        {
            if (target.TagPresets.All(existing => !string.Equals(existing.Name, tag.Name, StringComparison.OrdinalIgnoreCase)))
            {
                target.TagPresets.Add(new TagPresetRecord { Name = tag.Name, ColorArgb = tag.ColorArgb });
            }
        }
    }

    private static void MergeNotes(WorkspaceState target, LegacyNoteData? source)
    {
        foreach (var item in source?.Items ?? new())
        {
            if (target.Notes.Any(existing => existing.Id == item.Id))
            {
                continue;
            }

            target.Notes.Add(new NoteRecord
            {
                Id = item.Id,
                Title = item.Title,
                Text = item.Text,
                ColorArgb = item.ColorArgb,
                FontColorArgb = item.FontColorArgb,
                FontSize = item.FontSize,
                FontBold = item.FontBold,
                BackgroundImagePath = item.BackgroundImagePath,
                ImageOnly = item.ImageOnly,
                CreatedAt = item.CreatedAt,
                UpdatedAt = item.UpdatedAt
            });
        }

        if (string.IsNullOrWhiteSpace(target.QuickNote) && target.Notes.Count > 0)
        {
            target.QuickNote = target.Notes[0].Text;
        }
    }

    private static void MergeProjects(WorkspaceState target, LegacyProjectData? source)
    {
        foreach (var project in source?.Projects ?? new())
        {
            if (target.Projects.Any(existing => existing.Id == project.Id))
            {
                continue;
            }

            target.Projects.Add(new ProjectRecord
            {
                Id = project.Id,
                Name = project.Name,
                ProjectPath = project.ProjectPath,
                Phases = (project.Items ?? new()).Select(item => new ProjectPhaseRecord
                {
                    Title = item.Title,
                    Status = item.Status,
                    StartDate = item.StartDate,
                    EndDate = item.EndDate,
                    ProgressPercent = item.ProgressPercent,
                    ProjectPath = item.ProjectPath,
                    Subtasks = (item.SubItems ?? new()).Select(subItem => new ProjectSubtaskRecord
                    {
                        Title = subItem.Title,
                        IsCompleted = subItem.Done,
                        FilePath = subItem.FilePath
                    }).ToList()
                }).ToList()
            });
        }
    }

    private static void MergeLaunchers(WorkspaceState target, LegacyLaunchData? source)
    {
        foreach (var item in source?.Items ?? new())
        {
            if (target.Launchers.All(existing => !string.Equals(existing.Path, item.Path, StringComparison.OrdinalIgnoreCase)))
            {
                target.Launchers.Add(new LauncherRecord { Name = item.Name, Path = item.Path });
            }
        }
    }

    private static void MergeClipboard(WorkspaceState target, LegacyClipboardData? source)
    {
        foreach (var item in source?.Items ?? new())
        {
            if (target.ClipboardHistory.Any(existing => existing.Id == item.Id))
            {
                continue;
            }

            target.ClipboardHistory.Add(new ClipboardRecord
            {
                Id = item.Id,
                Kind = item.Kind,
                Text = item.Text,
                ImagePngBase64 = item.ImagePngBase64,
                CreatedAt = item.CreatedAt,
                IsLocked = item.IsLocked,
                IsPinned = item.IsPinned
            });
        }
    }

    private static void EnsureDefaults(WorkspaceState target)
    {
        WorkspaceDefaults.Ensure(target);
    }

    private static void RemoveStarterTodos(WorkspaceState target)
    {
        var starterTitles = new[] { "梳理今天最重要的一件事", "把临时想法记到快速记录" };
        if (target.Todos.Count == 2 && target.Todos.All(item => starterTitles.Contains(item.Title, StringComparer.Ordinal)))
        {
            target.Todos.Clear();
        }
    }

    private static void AddPlacement(WorkspaceState target, string key, LegacyPlacement? source)
    {
        if (source is null)
        {
            return;
        }

        target.Settings.WidgetPlacements[key] = new WidgetPlacementRecord
        {
            Visible = source.Visible,
            Locked = source.Locked,
            TopMost = source.TopMost,
            X = source.X,
            Y = source.Y,
            Width = source.Width,
            Height = source.Height,
            AutoCollapseEnabled = source.AutoCollapseEnabled,
            IsCollapsed = source.IsCollapsed
        };
    }

    private static string EmptyFallback(string? value, string fallback) => string.IsNullOrWhiteSpace(value) ? fallback : value;
    private static void AddHotKeyTarget(WorkspaceState target, string key, bool selected) { if (selected) target.Settings.DesktopHotKeyWidgetKeys.Add(key); }
    private static void SetTransparent(WorkspaceState target, string key, bool transparent) { if (target.Settings.WidgetPlacements.TryGetValue(key, out var placement)) placement.TransparentBackground = transparent; }

    private sealed class LegacyConfig
    {
        public int DesktopWidgetOpacity { get; set; } = 86;
        public string MainWindowDisplayName { get; set; } = string.Empty;
        public bool DesktopWidgetTransparent { get; set; } = true;
        public bool DesktopTodoWidgetTransparent { get; set; } = true;
        public bool DesktopProjectWidgetTransparent { get; set; } = true;
        public bool DesktopLauncherWidgetTransparent { get; set; } = true;
        public bool DesktopSystemMonitorWidgetTransparent { get; set; } = true;
        public bool DesktopSearchWidgetTransparent { get; set; } = true;
        public bool DesktopClipboardWidgetTransparent { get; set; } = true;
        public bool StartHiddenToTray { get; set; }
        public string MainWindowHotKey { get; set; } = string.Empty;
        public string DesktopOrganizerHotKey { get; set; } = string.Empty;
        public bool? SearchDesktopFiles { get; set; }
        public bool? SearchAppData { get; set; }
        public bool? SearchStartMenuApps { get; set; }
        public bool? SearchProjectPaths { get; set; }
        public bool? SearchCustomPaths { get; set; }
        public List<string>? SearchCustomRoots { get; set; }
        public bool DesktopOrganizerShowNames { get; set; }
        public int DesktopOrganizerIconSize { get; set; } = 48;
        public bool DesktopLauncherWidgetSnap { get; set; }
        public bool DesktopLauncherWidgetShowNames { get; set; } = true;
        public int DesktopLauncherWidgetIconSize { get; set; } = 48;
        public bool DesktopSystemMonitorShowDownload { get; set; } = true;
        public bool DesktopSystemMonitorShowUpload { get; set; } = true;
        public bool DesktopSystemMonitorShowMemory { get; set; } = true;
        public bool DesktopSystemMonitorShowCpu { get; set; } = true;
        public bool DesktopSystemMonitorShowDiskIo { get; set; } = true;
        public bool DesktopSystemMonitorShowDiskSpace { get; set; } = true;
        public bool DesktopSystemMonitorShowPing { get; set; } = true;
        public bool DesktopSystemMonitorShowUptime { get; set; } = true;
        public bool DesktopHotKeyToggleSearch { get; set; }
        public bool DesktopHotKeyToggleOrganizer { get; set; } = true;
        public bool DesktopHotKeyToggleTodo { get; set; }
        public bool DesktopHotKeyToggleNote { get; set; }
        public bool DesktopHotKeyToggleProject { get; set; }
        public bool DesktopHotKeyToggleLauncher { get; set; }
        public bool DesktopHotKeyToggleSystemMonitor { get; set; }
        public bool DesktopHotKeyToggleClipboard { get; set; }
        public List<LegacyCategory>? DesktopCategories { get; set; }
        public LegacyPlacement? DesktopOrganizerWidget { get; set; }
        public LegacyPlacement? DesktopTodoWidget { get; set; }
        public LegacyPlacement? DesktopProjectWidget { get; set; }
        public LegacyPlacement? DesktopLauncherWidget { get; set; }
        public LegacyPlacement? DesktopSystemMonitorWidget { get; set; }
        public LegacyPlacement? DesktopSearchWidget { get; set; }
        public LegacyPlacement? DesktopClipboardWidget { get; set; }
        public List<LegacyNotePlacement>? DesktopNoteWidgets { get; set; }
        public List<LegacyOrganizerSplitPlacement>? DesktopOrganizerSplitWidgets { get; set; }
    }

    private class LegacyPlacement
    {
        public bool Visible { get; set; }
        public bool Locked { get; set; }
        public bool TopMost { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public bool AutoCollapseEnabled { get; set; }
        public bool IsCollapsed { get; set; }
    }

    private sealed class LegacyNotePlacement : LegacyPlacement
    {
        public string NoteId { get; set; } = string.Empty;
    }

    private sealed class LegacyOrganizerSplitPlacement : LegacyPlacement
    {
        public List<string> CategoryNames { get; set; } = new();
    }

    private sealed class LegacyCategory
    {
        public string Name { get; set; } = string.Empty;
        public bool IsCollapsed { get; set; }
        public List<string>? ItemPaths { get; set; }
    }

    private sealed class LegacyTodoData
    {
        public List<LegacyTodo>? Items { get; set; }
        public List<TagPresetRecord>? TagPresets { get; set; }
    }

    private sealed class LegacyTodo
    {
        public string Text { get; set; } = string.Empty;
        public string Tag { get; set; } = string.Empty;
        public string Note { get; set; } = string.Empty;
        public bool Done { get; set; }
        public DateTime CreatedAt { get; set; }
        public DateTime? ReminderAt { get; set; }
        public DateTime? ReminderNotifiedAt { get; set; }
    }

    private sealed class LegacyNoteData { public List<NoteRecord>? Items { get; set; } }
    private sealed class LegacyProjectData { public List<LegacyProject>? Projects { get; set; } }
    private sealed class LegacyProject
    {
        public string Id { get; set; } = string.Empty;
        public string Name { get; set; } = string.Empty;
        public string ProjectPath { get; set; } = string.Empty;
        public List<LegacyPhase>? Items { get; set; }
    }

    private sealed class LegacyPhase
    {
        public string Title { get; set; } = string.Empty;
        public ProjectStatus Status { get; set; }
        public DateTime? StartDate { get; set; }
        public DateTime? EndDate { get; set; }
        public int ProgressPercent { get; set; } = -1;
        public string ProjectPath { get; set; } = string.Empty;
        public List<LegacySubtask>? SubItems { get; set; }
    }

    private sealed class LegacySubtask
    {
        public string Title { get; set; } = string.Empty;
        public bool Done { get; set; }
        public string FilePath { get; set; } = string.Empty;
    }

    private sealed class LegacyLaunchData { public List<LauncherRecord>? Items { get; set; } }
    private sealed class LegacyClipboardData { public List<LegacyClipboard>? Items { get; set; } }
    private sealed class LegacyClipboard
    {
        public string Id { get; set; } = string.Empty;
        public ClipboardContentKind Kind { get; set; }
        public string Text { get; set; } = string.Empty;
        public string ImagePngBase64 { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; }
        public bool IsLocked { get; set; }
        public bool IsPinned { get; set; }
    }
}
