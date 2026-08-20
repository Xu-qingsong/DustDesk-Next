using System.Text.Json.Serialization;

namespace DustDesk.Next.Models;

public sealed class WorkspaceState
{
    public int SchemaVersion { get; set; } = 2;
    public bool LegacyImportCompleted { get; set; }
    public string QuickNote { get; set; } = string.Empty;
    public AppSettings Settings { get; set; } = new();
    public List<TodoRecord> Todos { get; set; } = new();
    public List<TagPresetRecord> TagPresets { get; set; } = new();
    public List<NoteRecord> Notes { get; set; } = new();
    public List<ProjectRecord> Projects { get; set; } = new();
    public List<LauncherRecord> Launchers { get; set; } = new();
    public List<LinkGroupRecord> LinkGroups { get; set; } = new();
    public List<ClipboardRecord> ClipboardHistory { get; set; } = new();
    public List<DesktopCategoryRecord> DesktopCategories { get; set; } = new();
}

public sealed class AppSettings
{
    public string MainWindowDisplayName { get; set; } = "DustDesk";
    public bool StartHiddenToTray { get; set; }
    public bool StartWithWindows { get; set; }
    public string MainWindowHotKey { get; set; } = "Ctrl+Shift+K";
    public string DesktopWidgetsHotKey { get; set; } = "Ctrl+Shift+D";
    public int WidgetOpacityPercent { get; set; } = 86;
    public int WidgetBackgroundColorArgb { get; set; } = unchecked((int)0xFFFFFFFF);
    public bool SearchDesktopFiles { get; set; } = true;
    public bool SearchAppData { get; set; } = true;
    public bool SearchStartMenuApps { get; set; } = true;
    public bool SearchProjectPaths { get; set; } = true;
    public bool SearchCustomPaths { get; set; } = true;
    public List<string> SearchCustomRoots { get; set; } = new();
    public bool ClipboardMonitoringEnabled { get; set; } = true;
    public List<string> DesktopHotKeyWidgetKeys { get; set; } = new() { "organizer" };
    public bool LauncherWidgetSnapToEdges { get; set; }
    public bool LauncherWidgetShowNames { get; set; } = true;
    public int LauncherWidgetIconSize { get; set; } = 48;
    public bool OrganizerWidgetShowNames { get; set; }
    public int OrganizerWidgetIconSize { get; set; } = 48;
    public bool MonitorShowDownload { get; set; } = true;
    public bool MonitorShowUpload { get; set; } = true;
    public bool MonitorShowMemory { get; set; } = true;
    public bool MonitorShowCpu { get; set; } = true;
    public bool MonitorShowDiskIo { get; set; } = true;
    public bool MonitorShowDiskSpace { get; set; } = true;
    public bool MonitorShowPing { get; set; } = true;
    public bool MonitorShowUptime { get; set; } = true;
    public int WorkdayStartMinutes { get; set; } = 9 * 60;
    public int WorkdayEndMinutes { get; set; } = 18 * 60;
    public decimal MonthlySalary { get; set; }
    public int PaydayDay { get; set; } = 10;
    public string CountdownFestivalName { get; set; } = "国庆节";
    public int CountdownFestivalMonth { get; set; } = 10;
    public int CountdownFestivalDay { get; set; } = 1;
    public Dictionary<string, WidgetPlacementRecord> WidgetPlacements { get; set; } = new(StringComparer.OrdinalIgnoreCase);
    public List<NoteWidgetPlacementRecord> NoteWidgetPlacements { get; set; } = new();
    public List<OrganizerGroupWidgetPlacementRecord> OrganizerGroupWidgetPlacements { get; set; } = new();
    public Dictionary<string, Dictionary<string, WidgetPlacementRecord>> WidgetLayoutPresets { get; set; } = new(StringComparer.OrdinalIgnoreCase);
}

public class WidgetPlacementRecord
{
    public bool Visible { get; set; }
    public bool Locked { get; set; }
    public bool TopMost { get; set; }
    public double X { get; set; }
    public double Y { get; set; }
    public double Width { get; set; }
    public double Height { get; set; }
    public bool AutoCollapseEnabled { get; set; }
    public bool IsCollapsed { get; set; }
    public bool SnapToEdges { get; set; }
    public bool TransparentBackground { get; set; }
    public WidgetDockEdge DockEdge { get; set; }
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WidgetDockEdge
{
    None,
    Top,
    Bottom,
    Left,
    Right
}

public sealed class NoteWidgetPlacementRecord : WidgetPlacementRecord
{
    public string NoteId { get; set; } = string.Empty;
}

public sealed class OrganizerGroupWidgetPlacementRecord : WidgetPlacementRecord
{
    public string GroupId { get; set; } = Guid.NewGuid().ToString("N");
    public List<string> CategoryIds { get; set; } = new();
}

public sealed class TodoRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = string.Empty;
    public string Tag { get; set; } = string.Empty;
    public string Note { get; set; } = string.Empty;
    public bool IsCompleted { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.Now;
    public DateTime? ReminderAt { get; set; }
    public DateTime? ReminderNotifiedAt { get; set; }
    public ReminderRepeat ReminderRepeat { get; set; }
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ReminderRepeat
{
    None,
    Daily,
    Weekdays,
    Weekly
}

public sealed class TagPresetRecord
{
    public string Name { get; set; } = string.Empty;
    public int ColorArgb { get; set; }
}

public sealed class NoteRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = "新便签";
    public string Text { get; set; } = string.Empty;
    public int ColorArgb { get; set; } = unchecked((int)0xFFFFE9A8);
    public int FontColorArgb { get; set; } = unchecked((int)0xFF2C261C);
    public double FontSize { get; set; } = 14;
    public bool FontBold { get; set; }
    public string? BackgroundImagePath { get; set; }
    public string BackgroundImageFileName { get; set; } = string.Empty;
    public bool ImageOnly { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.Now;
    public DateTime UpdatedAt { get; set; } = DateTime.Now;
}

public sealed class ProjectRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string ProjectPath { get; set; } = string.Empty;
    public List<ProjectPhaseRecord> Phases { get; set; } = new();
}

public sealed class ProjectPhaseRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = string.Empty;
    public ProjectStatus Status { get; set; } = ProjectStatus.Todo;
    public DateTime? StartDate { get; set; }
    public DateTime? EndDate { get; set; }
    public int ProgressPercent { get; set; } = -1;
    public string ProjectPath { get; set; } = string.Empty;
    public List<ProjectSubtaskRecord> Subtasks { get; set; } = new();
}

public sealed class ProjectSubtaskRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Title { get; set; } = string.Empty;
    public bool IsCompleted { get; set; }
    public string FilePath { get; set; } = string.Empty;
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ProjectStatus
{
    Todo,
    Doing,
    Done
}

public sealed class LauncherRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
}

public sealed class LinkGroupRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public List<LinkRecord> Links { get; set; } = new();
}

public sealed class LinkRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public string Url { get; set; } = string.Empty;
    public string Note { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.Now;
    public DateTime UpdatedAt { get; set; } = DateTime.Now;
}

public sealed class ClipboardRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public ClipboardContentKind Kind { get; set; }
    public string Text { get; set; } = string.Empty;
    public string ImagePngBase64 { get; set; } = string.Empty;
    public string ImageFileName { get; set; } = string.Empty;
    public string ImageSha256 { get; set; } = string.Empty;
    public DateTime CreatedAt { get; set; } = DateTime.Now;
    public bool IsLocked { get; set; }
    public bool IsPinned { get; set; }
}

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ClipboardContentKind
{
    Text,
    Image
}

public sealed class DesktopCategoryRecord
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = string.Empty;
    public bool IsCollapsed { get; set; }
    public List<string> ItemPaths { get; set; } = new();
}

public static class WorkspaceDefaults
{
    public static WorkspaceState Create(bool includeStarterTodos, bool legacyImportCompleted = false)
    {
        var state = new WorkspaceState { LegacyImportCompleted = legacyImportCompleted };
        Ensure(state);
        if (includeStarterTodos)
        {
            state.Todos.Add(new TodoRecord { Title = "梳理今天最重要的一件事" });
            state.Todos.Add(new TodoRecord { Title = "把临时想法记到快速记录" });
        }
        return state;
    }

    public static void Ensure(WorkspaceState state)
    {
        state.Settings ??= new AppSettings();
        state.Settings.WidgetPlacements ??= new Dictionary<string, WidgetPlacementRecord>(StringComparer.OrdinalIgnoreCase);
        state.Settings.WidgetLayoutPresets ??= new Dictionary<string, Dictionary<string, WidgetPlacementRecord>>(StringComparer.OrdinalIgnoreCase);
        state.Settings.NoteWidgetPlacements ??= new();
        state.Settings.OrganizerGroupWidgetPlacements ??= new();
        var noteIds = state.Notes.Select(note => note.Id).Where(id => !string.IsNullOrWhiteSpace(id)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        state.Settings.NoteWidgetPlacements.RemoveAll(placement => !noteIds.Contains(placement.NoteId));
        foreach (var key in state.Settings.WidgetPlacements.Keys
                     .Where(key => key.StartsWith("note:", StringComparison.OrdinalIgnoreCase))
                     .Where(key => !noteIds.Contains(key[5..]))
                     .ToList())
            state.Settings.WidgetPlacements.Remove(key);
        if (state.Notes.Count == 0) state.Notes.Add(new NoteRecord { Title = "快速便签", Text = state.QuickNote });
        if (state.LinkGroups.Count == 0) state.LinkGroups.Add(new LinkGroupRecord { Name = "常用" });
        if (state.DesktopCategories.Count == 0)
        {
            state.DesktopCategories.AddRange(new[]
            {
                new DesktopCategoryRecord { Name = "工作" }, new DesktopCategoryRecord { Name = "开发" },
                new DesktopCategoryRecord { Name = "工具" }, new DesktopCategoryRecord { Name = "文件" }
            });
        }
        if (state.TagPresets.Count == 0)
        {
            state.TagPresets.AddRange(new[]
            {
                new TagPresetRecord { Name = "工作", ColorArgb = unchecked((int)0xFF0F8A72) },
                new TagPresetRecord { Name = "生活", ColorArgb = unchecked((int)0xFF2563EB) },
                new TagPresetRecord { Name = "重要", ColorArgb = unchecked((int)0xFFC2414B) }
            });
        }
    }
}
