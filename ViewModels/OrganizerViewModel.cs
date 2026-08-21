using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class OrganizerViewModel : ObservableObject
{
    private readonly IOrganizerService _organizer;
    private readonly IDesktopService _desktop;
    private readonly IWidgetManager _widgets;
    private readonly IShellContextMenuService _shellMenu;
    private readonly Stack<List<(DesktopCategoryViewModel Category, OrganizerEntry Entry)>> _batchHistory = new();
    private List<(DesktopCategoryViewModel Category, OrganizerEntry Entry)> _activeBatch = new();
    public OrganizerViewModel(WorkspaceViewModel workspace, IOrganizerService organizer, IDesktopService desktop, IWidgetManager widgets, IShellContextMenuService shellMenu)
    {
        Workspace = workspace; _organizer = organizer; _desktop = desktop; _widgets = widgets; _shellMenu = shellMenu;
        _showNames = workspace.State.Settings.OrganizerWidgetShowNames;
        _iconSize = Math.Clamp(workspace.State.Settings.OrganizerWidgetIconSize, 34, 64);
        if (_organizer.SynchronizeCategories(workspace.State.DesktopCategories)) workspace.MarkChanged();
        foreach (var record in workspace.State.DesktopCategories) AddWrapped(record);
        foreach (var placement in workspace.State.Settings.OrganizerGroupWidgetPlacements.ToList())
        {
            placement.CategoryIds.RemoveAll(id => Categories.All(category => !string.Equals(category.Record.Id, id, StringComparison.OrdinalIgnoreCase)));
            if (placement.CategoryIds.Count > 0) WidgetGroups.Add(CreateGroupOption(placement));
            else { workspace.State.Settings.OrganizerGroupWidgetPlacements.Remove(placement); workspace.State.Settings.WidgetPlacements.Remove($"organizer-group:{placement.GroupId}"); workspace.MarkChanged(); }
        }
        SelectedCategory = Categories.FirstOrDefault(); RefreshDesktop();
    }
    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<DesktopCategoryViewModel> Categories { get; } = new();
    public ObservableCollection<OrganizerEntry> DesktopEntries { get; } = new();
    public ObservableCollection<OrganizerGroupWidgetOption> WidgetGroups { get; } = new();
    [ObservableProperty] private DesktopCategoryViewModel? _selectedCategory;
    [ObservableProperty] private string _newCategoryName = string.Empty;
    [ObservableProperty] private string _errorText = string.Empty;
    [ObservableProperty] private string _smartOrganizeStatus = string.Empty;
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(SmartOrganizeCommand))]
    private bool _isSmartOrganizing;
    [ObservableProperty] private DesktopCategoryViewModel? _mergeTarget;
    [ObservableProperty] private bool _showNames;
    [ObservableProperty] private int _iconSize;
    partial void OnShowNamesChanged(bool value) { Workspace.State.Settings.OrganizerWidgetShowNames = value; Workspace.MarkChanged(); }
    partial void OnIconSizeChanged(int value) { Workspace.State.Settings.OrganizerWidgetIconSize = Math.Clamp(value, 34, 64); Workspace.MarkChanged(); }
    [RelayCommand] private void RefreshDesktop() => ReplaceDesktopEntries(_organizer.GetDesktopEntries());
    [RelayCommand(CanExecute = nameof(CanSmartOrganize))]
    private async Task SmartOrganizeAsync()
    {
        var desktopEntries = _organizer.GetDesktopEntries();
        ReplaceDesktopEntries(desktopEntries);
        var plan = SmartOrganizerClassifier.CreatePlan(desktopEntries);
        ErrorText = string.Empty;

        if (plan.Moves.Count == 0)
        {
            SmartOrganizeStatus = plan.SkippedApplicationCount > 0
                ? $"无需整理，已保留 {plan.SkippedApplicationCount} 个应用或快捷方式。"
                : "桌面上没有需要智能收纳的项目。";
            return;
        }

        var preview = BuildSmartOrganizeSummary(plan.Moves);
        var skippedText = plan.SkippedApplicationCount > 0
            ? $"\n\n另有 {plan.SkippedApplicationCount} 个应用、安装程序或快捷方式会保留在桌面。"
            : "\n\n应用、安装程序和快捷方式会保留在桌面。";
        if (!ConfirmationDialog.Confirm(
                "智能收纳",
                $"扫描到 {plan.Moves.Count} 个可整理项目：\n{preview}{skippedText}\n\n确定开始整理？")) return;

        IsSmartOrganizing = true;
        SmartOrganizeStatus = "正在整理桌面文件…";
        var movedCount = 0;
        var createdCategoryCount = 0;
        var usedCategories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var errors = new List<string>();
        _activeBatch = new();

        try
        {
            foreach (var move in plan.Moves)
            {
                var category = Categories.FirstOrDefault(item =>
                    string.Equals(item.Name, move.CategoryName, StringComparison.OrdinalIgnoreCase));
                if (category is null)
                {
                    var record = new DesktopCategoryRecord { Name = move.CategoryName };
                    Workspace.State.DesktopCategories.Add(record);
                    category = AddWrapped(record);
                    SelectedCategory ??= category;
                    createdCategoryCount++;
                }

                try
                {
                    var moved = await Task.Run(() => _organizer.MoveIntoCategory(category.Record, move.Entry.Path));
                    var movedEntry = new OrganizerEntry(Path.GetFileName(moved), moved, Directory.Exists(moved));
                    category.Items.Add(movedEntry);
                    _activeBatch.Add((category, movedEntry));
                    usedCategories.Add(category.Name);
                    movedCount++;
                }
                catch (Exception ex)
                {
                    errors.Add($"{move.Entry.Name}：{ex.Message}");
                }
            }

            if (movedCount > 0 || createdCategoryCount > 0) Workspace.MarkChanged();
            if (_activeBatch.Count > 0)
            {
                _batchHistory.Push(_activeBatch);
                if (_batchHistory.Count > 10)
                {
                    var recent = _batchHistory.Take(10).Reverse().ToList();
                    _batchHistory.Clear();
                    foreach (var savedBatch in recent) _batchHistory.Push(savedBatch);
                }
            }
            ReplaceDesktopEntries(_organizer.GetDesktopEntries());
            ErrorText = errors.Count == 0
                ? string.Empty
                : $"智能收纳有 {errors.Count} 个项目未完成：\n{string.Join(Environment.NewLine, errors.Take(3))}";
            SmartOrganizeStatus = errors.Count == 0
                ? $"已收纳 {movedCount} 个项目到 {usedCategories.Count} 个分类，保留 {plan.SkippedApplicationCount} 个应用或快捷方式。"
                : $"已收纳 {movedCount} 个项目，{errors.Count} 个未完成；应用和快捷方式仍保留在桌面。";
        }
        finally
        {
            IsSmartOrganizing = false;
        }
    }

    private bool CanSmartOrganize() => !IsSmartOrganizing;

    [RelayCommand]
    private void UndoLastBatch()
    {
        if (_batchHistory.Count == 0) return;
        var batch = _batchHistory.Pop();
        var failed = 0;
        foreach (var move in batch.AsEnumerable().Reverse().ToList())
        {
            try { _organizer.RestoreToDesktop(move.Category.Record, move.Entry.Path); move.Category.Items.Remove(move.Entry); }
            catch { failed++; }
        }
        RefreshDesktop();
        Workspace.MarkChanged();
        ErrorText = failed == 0 ? string.Empty : $"有 {failed} 个项目撤销失败。";
        SmartOrganizeStatus = failed == 0 ? "已撤销上一次智能整理。" : "上一次智能整理部分撤销失败。";
    }

    private static string BuildSmartOrganizeSummary(IEnumerable<SmartOrganizerMove> moves)
    {
        var counts = moves.GroupBy(move => move.CategoryName, StringComparer.OrdinalIgnoreCase)
            .ToDictionary(group => group.Key, group => group.Count(), StringComparer.OrdinalIgnoreCase);
        return string.Join("、", SmartOrganizerClassifier.CategoryOrder
            .Where(counts.ContainsKey)
            .Select(category => $"{category} {counts[category]}"));
    }

    private void ReplaceDesktopEntries(IEnumerable<OrganizerEntry> entries)
    {
        DesktopEntries.Clear();
        foreach (var entry in entries) DesktopEntries.Add(entry);
    }
    [RelayCommand]
    private void AddCategory()
    {
        if (string.IsNullOrWhiteSpace(NewCategoryName)) return;
        if (Categories.Any(item => string.Equals(item.Name, NewCategoryName.Trim(), StringComparison.OrdinalIgnoreCase))) { ErrorText = "已存在同名分类。"; return; }
        var record = new DesktopCategoryRecord { Name = NewCategoryName.Trim() }; Workspace.State.DesktopCategories.Add(record); SelectedCategory = AddWrapped(record); NewCategoryName = string.Empty; ErrorText = string.Empty; Workspace.MarkChanged();
    }
    [RelayCommand]
    private void DeleteCategory()
    {
        if (SelectedCategory is null) return;
        if (!ConfirmationDialog.Confirm("删除分类", "确定要删除这个分类并将内容恢复到桌面吗？")) return;
        try { var removedId = SelectedCategory.Record.Id; var widgetKey = $"organizer:{removedId}"; _widgets.Hide(widgetKey); Workspace.State.Settings.WidgetPlacements.Remove(widgetKey); _organizer.DeleteCategory(Workspace.State.DesktopCategories, SelectedCategory.Record); Categories.Remove(SelectedCategory); UpdateGroupsForCategory(removedId, null); SelectedCategory = Categories.FirstOrDefault(); ErrorText = string.Empty; RefreshDesktop(); Workspace.MarkChanged(); }
        catch (Exception ex) { ErrorText = ex.Message; }
    }
    [RelayCommand] private void MoveDesktopEntry(OrganizerEntry? entry) { if (SelectedCategory is not null && entry is not null) MovePath(entry.Path); }
    public void MovePath(string path)
    {
        if (SelectedCategory is not null) MovePathToCategory(SelectedCategory, path);
    }
    public void MovePathToCategory(DesktopCategoryViewModel category, string path)
    {
        try
        {
            var moved = _organizer.MoveIntoCategory(category.Record, path);
            var entry = new OrganizerEntry(Path.GetFileName(moved), moved, Directory.Exists(moved));
            category.Items.Add(entry);
            PushBatch(new List<(DesktopCategoryViewModel Category, OrganizerEntry Entry)> { (category, entry) });
            ErrorText = string.Empty; RefreshDesktop(); Workspace.MarkChanged();
        }
        catch (Exception ex) { ErrorText = ex.Message; }
    }
    public void MoveEntryToCategory(DesktopCategoryViewModel target, OrganizerEntry entry)
    {
        var source = Categories.FirstOrDefault(category => category.Items.Contains(entry));
        if (source is null || source == target) return;
        try
        {
            var moved = _organizer.MoveIntoCategory(target.Record, entry.Path);
            source.Items.Remove(entry); source.Record.ItemPaths.RemoveAll(path => string.Equals(path, entry.Path, StringComparison.OrdinalIgnoreCase));
            var movedEntry = new OrganizerEntry(Path.GetFileName(moved), moved, Directory.Exists(moved));
            target.Items.Add(movedEntry);
            PushBatch(new List<(DesktopCategoryViewModel Category, OrganizerEntry Entry)> { (target, movedEntry) });
            ErrorText = string.Empty; Workspace.MarkChanged();
        }
        catch (Exception ex) { ErrorText = ex.Message; }
    }
    [RelayCommand]
    private void RestoreEntry(OrganizerEntry? entry)
    {
        if (SelectedCategory is not null && entry is not null) RestoreFromCategory(SelectedCategory, entry);
    }
    [RelayCommand]
    private void RestoreAnyEntry(OrganizerEntry? entry)
    {
        if (entry is null) return;
        var category = Categories.FirstOrDefault(item => item.Items.Contains(entry) || item.Record.ItemPaths.Contains(entry.Path, StringComparer.OrdinalIgnoreCase));
        if (category is not null) RestoreFromCategory(category, entry);
    }
    private void RestoreFromCategory(DesktopCategoryViewModel category, OrganizerEntry entry)
    {
        try { _organizer.RestoreToDesktop(category.Record, entry.Path); category.Items.Remove(entry); RemoveFromBatchHistory(entry.Path); ErrorText = string.Empty; RefreshDesktop(); Workspace.MarkChanged(); }
        catch (Exception ex) { ErrorText = ex.Message; }
    }

    private void PushBatch(List<(DesktopCategoryViewModel Category, OrganizerEntry Entry)> batch)
    {
        _batchHistory.Push(batch);
        while (_batchHistory.Count > 10)
        {
            var recent = _batchHistory.Take(10).Reverse().ToList();
            _batchHistory.Clear();
            foreach (var savedBatch in recent) _batchHistory.Push(savedBatch);
        }
    }

    private void RemoveFromBatchHistory(string path)
    {
        var batches = _batchHistory.Select(batch => batch.Where(move => !string.Equals(move.Entry.Path, path, StringComparison.OrdinalIgnoreCase)).ToList()).Where(batch => batch.Count > 0).Reverse().ToList();
        _batchHistory.Clear();
        foreach (var batch in batches) _batchHistory.Push(batch);
    }
    public (int Restored, int Failed) RestoreAllEntries()
    {
        var restored = 0; var failed = 0; var errors = new List<string>();
        foreach (var category in Categories)
        {
            foreach (var entry in category.Items.ToList())
            {
                try { _organizer.RestoreToDesktop(category.Record, entry.Path); category.Items.Remove(entry); restored++; }
                catch (Exception ex) { failed++; errors.Add($"{entry.Name}：{ex.Message}"); }
            }
        }
        ErrorText = errors.Count == 0 ? string.Empty : string.Join(Environment.NewLine, errors.Take(3));
        _batchHistory.Clear();
        RefreshDesktop(); Workspace.MarkChanged();
        return (restored, failed);
    }
    [RelayCommand] private void OpenEntry(OrganizerEntry? entry) { if (entry is not null) _desktop.Open(entry.Path); }
    [RelayCommand] private void PinSelectedCategory() { if (SelectedCategory is not null) _widgets.Show($"organizer:{SelectedCategory.Record.Id}"); }
    [RelayCommand]
    private void PinCategoryGroup()
    {
        var selected = Categories.Where(item => item.IsSelectedForWidget).ToList();
        if (selected.Count == 0 && SelectedCategory is not null) selected.Add(SelectedCategory);
        if (selected.Count == 0) return;
        var placement = new OrganizerGroupWidgetPlacementRecord { Width = 620, Height = 520, Visible = true, CategoryIds = selected.Select(item => item.Record.Id).ToList() };
        Workspace.State.Settings.OrganizerGroupWidgetPlacements.Add(placement);
        Workspace.State.Settings.WidgetPlacements[$"organizer-group:{placement.GroupId}"] = placement;
        var option = CreateGroupOption(placement); WidgetGroups.Add(option);
        foreach (var category in selected) category.IsSelectedForWidget = false;
        _widgets.Show(option.Key); Workspace.MarkChanged();
    }
    [RelayCommand]
    private void DeleteWidgetGroup(OrganizerGroupWidgetOption? option)
    {
        if (option is null) return;
        if (!ConfirmationDialog.ConfirmDelete("这个组合组件配置")) return;
        _widgets.Hide(option.Key); WidgetGroups.Remove(option);
        Workspace.State.Settings.OrganizerGroupWidgetPlacements.Remove(option.Record);
        Workspace.State.Settings.WidgetPlacements.Remove(option.Key); Workspace.MarkChanged();
    }
    [RelayCommand] private void ShowWidgetGroup(OrganizerGroupWidgetOption? option) { if (option is not null) _widgets.Show(option.Key); }
    [RelayCommand] private void ShowEntryMenu(OrganizerEntry? entry) { if (entry is not null) _shellMenu.ShowForPath(entry.Path); }
    [RelayCommand] private void ShowDesktopMenu() => _shellMenu.ShowDesktopBackground();
    [RelayCommand] private void MoveCategoryUp() => MoveSelectedCategory(-1);
    [RelayCommand] private void MoveCategoryDown() => MoveSelectedCategory(1);
    [RelayCommand] private static void ToggleCategoryCollapse(DesktopCategoryViewModel? category)
    {
        if (category is not null) category.IsCollapsed = !category.IsCollapsed;
    }
    [RelayCommand] private void MoveEntryUp(OrganizerEntry? entry) => MoveEntry(entry, -1);
    [RelayCommand] private void MoveEntryDown(OrganizerEntry? entry) => MoveEntry(entry, 1);
    [RelayCommand]
    private void MergeSelectedCategory()
    {
        if (SelectedCategory is null || MergeTarget is null || SelectedCategory == MergeTarget) return;
        try
        {
            foreach (var entry in SelectedCategory.Items.ToList())
            {
                var moved = _organizer.MoveIntoCategory(MergeTarget.Record, entry.Path);
                SelectedCategory.Record.ItemPaths.RemoveAll(path => string.Equals(Path.GetFullPath(path), Path.GetFullPath(entry.Path), StringComparison.OrdinalIgnoreCase));
                SelectedCategory.Items.Remove(entry);
                MergeTarget.Items.Add(new OrganizerEntry(Path.GetFileName(moved), moved, Directory.Exists(moved)));
            }
            var removedId = SelectedCategory.Record.Id;
            _organizer.DeleteCategory(Workspace.State.DesktopCategories, SelectedCategory.Record);
            Categories.Remove(SelectedCategory); SelectedCategory = MergeTarget; ErrorText = string.Empty; Workspace.MarkChanged();
            UpdateGroupsForCategory(removedId, MergeTarget.Record.Id);
        }
        catch (Exception ex) { ErrorText = ex.Message; }
    }
    private void MoveSelectedCategory(int offset)
    {
        if (SelectedCategory is null) return;
        var index = Categories.IndexOf(SelectedCategory); var target = index + offset;
        if (target < 0 || target >= Categories.Count) return;
        Categories.Move(index, target);
        Workspace.State.DesktopCategories.Remove(SelectedCategory.Record); Workspace.State.DesktopCategories.Insert(target, SelectedCategory.Record); Workspace.MarkChanged();
    }
    private void MoveEntry(OrganizerEntry? entry, int offset)
    {
        if (entry is null) return;
        var category = Categories.FirstOrDefault(item => item.Items.Contains(entry)); if (category is null) return;
        var index = category.Items.IndexOf(entry); var target = index + offset; if (target < 0 || target >= category.Items.Count) return;
        category.Items.Move(index, target);
        var pathIndex = category.Record.ItemPaths.FindIndex(path => string.Equals(path, entry.Path, StringComparison.OrdinalIgnoreCase));
        if (pathIndex >= 0) { var path = category.Record.ItemPaths[pathIndex]; category.Record.ItemPaths.RemoveAt(pathIndex); category.Record.ItemPaths.Insert(target, path); }
        Workspace.MarkChanged();
    }
    private DesktopCategoryViewModel AddWrapped(DesktopCategoryRecord record) { var item = new DesktopCategoryViewModel(record); item.PropertyChanged += OnChanged; Categories.Add(item); return item; }
    private void OnChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (sender is DesktopCategoryViewModel category && e.PropertyName == nameof(DesktopCategoryViewModel.Name))
        {
            try { _organizer.RenameCategory(category.Record, category.Name); ErrorText = string.Empty; RefreshGroupOptions(); }
            catch (Exception ex) { ErrorText = ex.Message; category.Name = category.Record.Name; return; }
        }
        Workspace.MarkChanged();
    }
    private OrganizerGroupWidgetOption CreateGroupOption(OrganizerGroupWidgetPlacementRecord placement) => new(placement, string.Join("、", Categories.Where(item => placement.CategoryIds.Contains(item.Record.Id, StringComparer.OrdinalIgnoreCase)).Select(item => item.Name)));
    private void RefreshGroupOptions()
    {
        for (var index = 0; index < WidgetGroups.Count; index++) WidgetGroups[index] = CreateGroupOption(WidgetGroups[index].Record);
    }
    private void UpdateGroupsForCategory(string removedId, string? replacementId)
    {
        foreach (var option in WidgetGroups.ToList())
        {
            option.Record.CategoryIds.RemoveAll(id => string.Equals(id, removedId, StringComparison.OrdinalIgnoreCase));
            if (replacementId is not null && !option.Record.CategoryIds.Contains(replacementId, StringComparer.OrdinalIgnoreCase)) option.Record.CategoryIds.Add(replacementId);
            if (option.Record.CategoryIds.Count > 0) continue;
            _widgets.Hide(option.Key); WidgetGroups.Remove(option); Workspace.State.Settings.OrganizerGroupWidgetPlacements.Remove(option.Record); Workspace.State.Settings.WidgetPlacements.Remove(option.Key);
        }
    }
}

public sealed record OrganizerGroupWidgetOption(OrganizerGroupWidgetPlacementRecord Record, string Title)
{
    public string Key => $"organizer-group:{Record.GroupId}";
}
