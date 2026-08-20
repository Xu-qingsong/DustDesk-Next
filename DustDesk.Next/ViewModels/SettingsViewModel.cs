using System.IO;
using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class SettingsViewModel : ObservableObject
{
    private readonly IStartupService _startup;
    private readonly IDesktopService _desktop;
    private readonly IWidgetManager _widgets;
    private readonly IDataMaintenanceService _maintenance;
    private readonly IProjectExportService _projectExport;
    private readonly IUpdateService _updates;
    private readonly IGlobalHotKeyService _hotKeys;
    private readonly IClipboardMonitorService _clipboardMonitor;
    public SettingsViewModel(WorkspaceViewModel workspace, IStartupService startup, IDesktopService desktop, IWidgetManager widgets, IDataMaintenanceService maintenance, IProjectExportService projectExport, IUpdateService updates, IGlobalHotKeyService hotKeys, IClipboardMonitorService clipboardMonitor, LaunchersViewModel launchers, OrganizerViewModel organizer, SystemMonitorViewModel monitor, WorkdayCountdownViewModel countdown)
    {
        Workspace = workspace; _startup = startup; _desktop = desktop; _widgets = widgets; _maintenance = maintenance; _projectExport = projectExport; _updates = updates; _hotKeys = hotKeys; _clipboardMonitor = clipboardMonitor;
        _startWithWindows = startup.IsEnabled;
        _startHiddenToTray = workspace.State.Settings.StartHiddenToTray;
        _mainWindowHotKey = workspace.State.Settings.MainWindowHotKey;
        _desktopWidgetsHotKey = workspace.State.Settings.DesktopWidgetsHotKey;
        _widgetOpacityPercent = workspace.State.Settings.WidgetOpacityPercent;
        _widgetBackgroundColorArgb = workspace.State.Settings.WidgetBackgroundColorArgb;
        _clipboardMonitoringEnabled = workspace.State.Settings.ClipboardMonitoringEnabled;
        _searchDesktopFiles = workspace.State.Settings.SearchDesktopFiles;
        _searchStartMenuApps = workspace.State.Settings.SearchStartMenuApps;
        _searchAppData = workspace.State.Settings.SearchAppData;
        _searchProjectPaths = workspace.State.Settings.SearchProjectPaths;
        _searchCustomPaths = workspace.State.Settings.SearchCustomPaths;
        _launcherSnapToEdges = workspace.State.Settings.LauncherWidgetSnapToEdges;
        Launchers = launchers; Organizer = organizer; Monitor = monitor; Countdown = countdown;
        WidgetOptions = new[]
        {
            new WidgetOptionViewModel("organizer", "桌面收纳", IsHotKeyTarget("organizer"), SetHotKeyTarget),
            new WidgetOptionViewModel("todo", "工作记录", IsHotKeyTarget("todo"), SetHotKeyTarget),
            new WidgetOptionViewModel("note", "便签", IsHotKeyTarget("note"), SetHotKeyTarget),
            new WidgetOptionViewModel("project", "项目", IsHotKeyTarget("project"), SetHotKeyTarget),
            new WidgetOptionViewModel("launcher", "快捷启动", IsHotKeyTarget("launcher"), SetHotKeyTarget),
            new WidgetOptionViewModel("links", "超链接", IsHotKeyTarget("links"), SetHotKeyTarget),
            new WidgetOptionViewModel("search", "搜索", IsHotKeyTarget("search"), SetHotKeyTarget),
            new WidgetOptionViewModel("clipboard", "剪贴板", IsHotKeyTarget("clipboard"), SetHotKeyTarget),
            new WidgetOptionViewModel("monitor", "系统检测", IsHotKeyTarget("monitor"), SetHotKeyTarget),
            new WidgetOptionViewModel("countdown", "下班倒计时", IsHotKeyTarget("countdown"), SetHotKeyTarget)
        };
        _updateStatus = $"当前版本 {_updates.CurrentVersion}";
        LoadRecoveryPoints();
    }
    public WorkspaceViewModel Workspace { get; }
    public LaunchersViewModel Launchers { get; }
    public OrganizerViewModel Organizer { get; }
    public SystemMonitorViewModel Monitor { get; }
    public WorkdayCountdownViewModel Countdown { get; }
    public string DataFilePath => Workspace.DataFilePath;
    public IReadOnlyList<string> CustomSearchRoots => Workspace.State.Settings.SearchCustomRoots;
    public IReadOnlyList<WidgetOptionViewModel> WidgetOptions { get; }
    public IReadOnlyList<string> LayoutPresetNames => _widgets.GetLayoutPresetNames();
    [ObservableProperty] private string _layoutPresetName = string.Empty;
    public ObservableCollection<RecoveryPointItemViewModel> RecoveryPoints { get; } = new();
    [ObservableProperty] private bool _startWithWindows;
    [ObservableProperty] private bool _startHiddenToTray;
    [ObservableProperty] private string _mainWindowHotKey;
    [ObservableProperty] private string _desktopWidgetsHotKey;
    [ObservableProperty] private int _widgetOpacityPercent;
    [ObservableProperty] private int _widgetBackgroundColorArgb;
    [ObservableProperty] private bool _clipboardMonitoringEnabled;
    [ObservableProperty] private string _updateStatus;
    [ObservableProperty]
    [NotifyCanExecuteChangedFor(nameof(RestoreRecoveryPointCommand))]
    [NotifyCanExecuteChangedFor(nameof(RefreshRecoveryPointsCommand))]
    [NotifyCanExecuteChangedFor(nameof(BackupCommand))]
    [NotifyCanExecuteChangedFor(nameof(RestoreCommand))]
    [NotifyCanExecuteChangedFor(nameof(ResetCommand))]
    [NotifyCanExecuteChangedFor(nameof(CheckUpdateCommand))]
    private bool _isBusy;
    [ObservableProperty] private string _recoveryStatus = "每天自动创建恢复点，保留最近 7 个日备份和 4 个周备份。";
    [ObservableProperty] private RecoveryPointItemViewModel? _selectedRecoveryPoint;
    [ObservableProperty] private bool _searchDesktopFiles;
    [ObservableProperty] private bool _searchStartMenuApps;
    [ObservableProperty] private bool _searchAppData;
    [ObservableProperty] private bool _searchProjectPaths;
    [ObservableProperty] private bool _searchCustomPaths;
    [ObservableProperty] private bool _launcherSnapToEdges;
    partial void OnStartWithWindowsChanged(bool value) { _startup.SetEnabled(value); Workspace.State.Settings.StartWithWindows = value; Workspace.MarkChanged(); }
    partial void OnStartHiddenToTrayChanged(bool value) { Workspace.State.Settings.StartHiddenToTray = value; Workspace.MarkChanged(); }
    partial void OnMainWindowHotKeyChanged(string? oldValue, string newValue)
    {
        var previous = oldValue ?? Workspace.State.Settings.MainWindowHotKey;
        if (System.Windows.Application.Current.MainWindow is { } window && !_hotKeys.Register(window, 0x4444, newValue))
        {
            _mainWindowHotKey = previous; OnPropertyChanged(nameof(MainWindowHotKey)); _hotKeys.Register(window, 0x4444, previous); UpdateStatus = "主窗口快捷键无效或已被占用"; return;
        }
        Workspace.State.Settings.MainWindowHotKey = newValue; Workspace.MarkChanged();
    }
    partial void OnDesktopWidgetsHotKeyChanged(string? oldValue, string newValue)
    {
        var previous = oldValue ?? Workspace.State.Settings.DesktopWidgetsHotKey;
        if (System.Windows.Application.Current.MainWindow is { } window && !_hotKeys.Register(window, 0x4445, newValue))
        {
            _desktopWidgetsHotKey = previous; OnPropertyChanged(nameof(DesktopWidgetsHotKey)); _hotKeys.Register(window, 0x4445, previous); UpdateStatus = "桌面组件快捷键无效或已被占用"; return;
        }
        Workspace.State.Settings.DesktopWidgetsHotKey = newValue; Workspace.MarkChanged();
    }
    partial void OnWidgetOpacityPercentChanged(int value) { Workspace.State.Settings.WidgetOpacityPercent = Math.Clamp(value, 20, 100); _widgets.RefreshAppearance(); Workspace.MarkChanged(); }
    partial void OnWidgetBackgroundColorArgbChanged(int value) { Workspace.State.Settings.WidgetBackgroundColorArgb = value; _widgets.RefreshAppearance(); Workspace.MarkChanged(); }
    partial void OnClipboardMonitoringEnabledChanged(bool value) { Workspace.State.Settings.ClipboardMonitoringEnabled = value; if (value && System.Windows.Application.Current.MainWindow is { } window) _clipboardMonitor.Start(window); else if (!value) _clipboardMonitor.Stop(); Workspace.MarkChanged(); }
    partial void OnSearchDesktopFilesChanged(bool value) { Workspace.State.Settings.SearchDesktopFiles = value; Workspace.MarkChanged(); }
    partial void OnSearchStartMenuAppsChanged(bool value) { Workspace.State.Settings.SearchStartMenuApps = value; Workspace.MarkChanged(); }
    partial void OnSearchAppDataChanged(bool value) { Workspace.State.Settings.SearchAppData = value; Workspace.MarkChanged(); }
    partial void OnSearchProjectPathsChanged(bool value) { Workspace.State.Settings.SearchProjectPaths = value; Workspace.MarkChanged(); }
    partial void OnSearchCustomPathsChanged(bool value) { Workspace.State.Settings.SearchCustomPaths = value; Workspace.MarkChanged(); }
    partial void OnLauncherSnapToEdgesChanged(bool value)
    {
        Workspace.State.Settings.LauncherWidgetSnapToEdges = value;
        if (Workspace.State.Settings.WidgetPlacements.TryGetValue("launcher", out var placement)) placement.SnapToEdges = value;
        Workspace.MarkChanged();
    }
    private bool IsHotKeyTarget(string key) => Workspace.State.Settings.DesktopHotKeyWidgetKeys.Contains(key, StringComparer.OrdinalIgnoreCase);
    private void SetHotKeyTarget(string key, bool enabled)
    {
        var keys = Workspace.State.Settings.DesktopHotKeyWidgetKeys;
        keys.RemoveAll(item => string.Equals(item, key, StringComparison.OrdinalIgnoreCase));
        if (enabled) keys.Add(key);
        Workspace.MarkChanged();
    }
    [RelayCommand] private void OpenDataLocation() => _desktop.Open(Path.GetDirectoryName(DataFilePath) ?? DataFilePath);
    [RelayCommand] private void AddSearchRoot() { var path = _desktop.PickFolder("添加搜索目录"); if (path is null || Workspace.State.Settings.SearchCustomRoots.Contains(path, StringComparer.OrdinalIgnoreCase)) return; Workspace.State.Settings.SearchCustomRoots.Add(path); OnPropertyChanged(nameof(CustomSearchRoots)); Workspace.MarkChanged(); }
    [RelayCommand] private void RemoveSearchRoot(string? path) { if (path is null) return; Workspace.State.Settings.SearchCustomRoots.Remove(path); OnPropertyChanged(nameof(CustomSearchRoots)); Workspace.MarkChanged(); }
    [RelayCommand] private void ClearSearchRoots() { if (Workspace.State.Settings.SearchCustomRoots.Count == 0 || !ConfirmationDialog.Confirm("清空搜索目录", "确定要清空全部自定义搜索目录吗？")) return; Workspace.State.Settings.SearchCustomRoots.Clear(); OnPropertyChanged(nameof(CustomSearchRoots)); Workspace.MarkChanged(); }
    [RelayCommand] private void ToggleWidget(string? key) { if (key is not null) _widgets.Toggle(key); }
    [RelayCommand]
    private void SaveLayoutPreset()
    {
        if (string.IsNullOrWhiteSpace(LayoutPresetName)) return;
        _widgets.SaveLayoutPreset(LayoutPresetName);
        OnPropertyChanged(nameof(LayoutPresetNames));
    }
    [RelayCommand]
    private void ApplyLayoutPreset(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || !_widgets.ApplyLayoutPreset(name)) return;
        LayoutPresetName = name;
        OnPropertyChanged(nameof(LayoutPresetNames));
    }
    [RelayCommand]
    private void DeleteLayoutPreset(string? name)
    {
        if (string.IsNullOrWhiteSpace(name) || !_widgets.DeleteLayoutPreset(name)) return;
        if (string.Equals(LayoutPresetName, name, StringComparison.OrdinalIgnoreCase)) LayoutPresetName = string.Empty;
        OnPropertyChanged(nameof(LayoutPresetNames));
    }
    [RelayCommand]
    private void SetWidgetBackgroundColor(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        WidgetBackgroundColorArgb = unchecked((int)Convert.ToUInt32(value, 16));
    }
    [RelayCommand]
    private void ChooseWidgetBackgroundColor()
    {
        var value = unchecked((uint)WidgetBackgroundColorArgb);
        using var dialog = new System.Windows.Forms.ColorDialog
        {
            FullOpen = true,
            Color = System.Drawing.Color.FromArgb((byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value)
        };
        if (dialog.ShowDialog() != System.Windows.Forms.DialogResult.OK) return;
        WidgetBackgroundColorArgb = dialog.Color.ToArgb();
    }
    public async Task EnsureAutomaticBackupAsync()
    {
        try
        {
            var created = await _maintenance.CreateAutomaticBackupAsync();
            LoadRecoveryPoints();
            RecoveryStatus = created ? "已创建今天的自动恢复点。" : "今天的自动恢复点已经存在。";
        }
        catch (Exception ex)
        {
            RecoveryStatus = $"自动备份失败：{ex.Message}";
        }
    }

    [RelayCommand(CanExecute = nameof(CanRunMaintenance))]
    private void RefreshRecoveryPoints()
    {
        LoadRecoveryPoints();
        RecoveryStatus = RecoveryPoints.Count == 0 ? "暂时没有可用恢复点。" : $"已找到 {RecoveryPoints.Count} 个恢复点。";
    }

    [RelayCommand(CanExecute = nameof(CanRestoreRecoveryPoint))]
    private async Task RestoreRecoveryPointAsync(RecoveryPointItemViewModel? recoveryPoint)
    {
        if (recoveryPoint is null) return;
        SelectedRecoveryPoint = recoveryPoint;
        IsBusy = true;
        try
        {
            if (!File.Exists(recoveryPoint.Info.FilePath))
            {
                LoadRecoveryPoints();
                RecoveryStatus = "所选恢复点已被移除，请刷新后重试。";
                return;
            }
            RecoveryStatus = "正在验证并恢复所选恢复点...";
            if (!await _maintenance.RestoreRecoveryPointAsync(recoveryPoint.Info))
            {
                RecoveryStatus = File.Exists(recoveryPoint.Info.FilePath) ? "已取消恢复。" : "所选恢复点已被移除，请刷新后重试。";
            }
        }
        catch (Exception ex)
        {
            RecoveryStatus = $"恢复失败：{ex.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private bool CanRestoreRecoveryPoint(RecoveryPointItemViewModel? recoveryPoint) => recoveryPoint is not null && !IsBusy;
    private bool CanRunMaintenance() => !IsBusy;

    private void LoadRecoveryPoints()
    {
        var selectedPath = SelectedRecoveryPoint?.Info.FilePath;
        RecoveryPoints.Clear();
        foreach (var point in _maintenance.GetRecoveryPoints()) RecoveryPoints.Add(new RecoveryPointItemViewModel(point));
        SelectedRecoveryPoint = RecoveryPoints.FirstOrDefault(item => string.Equals(item.Info.FilePath, selectedPath, StringComparison.OrdinalIgnoreCase))
            ?? RecoveryPoints.FirstOrDefault();
    }

    [RelayCommand(CanExecute = nameof(CanRunMaintenance))]
    private async Task BackupAsync()
    {
        if (IsBusy) return;
        IsBusy = true;
        try
        {
            var path = await _maintenance.BackupAsync();
            if (path is not null) RecoveryStatus = $"手动备份已保存：{path}";
        }
        catch (Exception ex)
        {
            RecoveryStatus = $"备份失败：{ex.Message}";
        }
        finally { IsBusy = false; }
    }

    [RelayCommand(CanExecute = nameof(CanRunMaintenance))]
    private async Task RestoreAsync()
    {
        if (IsBusy) return;
        IsBusy = true;
        try { await _maintenance.RestoreAsync(); }
        catch (Exception ex) { RecoveryStatus = $"恢复失败：{ex.Message}"; }
        finally { IsBusy = false; }
    }

    [RelayCommand(CanExecute = nameof(CanRunMaintenance))]
    private async Task ResetAsync()
    {
        if (IsBusy) return;
        IsBusy = true;
        try { await _maintenance.ResetAsync(); }
        catch (Exception ex) { RecoveryStatus = $"重置失败：{ex.Message}"; }
        finally { IsBusy = false; }
    }
    [RelayCommand]
    private void RestoreDesktopItems()
    {
        if (!ConfirmationDialog.Confirm("恢复桌面收纳", "确定要将全部收纳项目移回系统桌面吗？")) return;
        var result = Organizer.RestoreAllEntries();
        UpdateStatus = result.Failed == 0 ? $"已恢复 {result.Restored} 个桌面项目" : $"已恢复 {result.Restored} 个，{result.Failed} 个因同名或占用未恢复";
    }
    [RelayCommand] private void ExportProjects() { var path = _projectExport.Export(Workspace.State.Projects); UpdateStatus = path is null ? "没有导出项目" : $"项目已导出：{path}"; }
    [RelayCommand] private static void ShowHelp() => System.Windows.MessageBox.Show("1. 桌面收纳：创建分类，把桌面文件拖入分类；分类中的项目可以恢复到桌面。\n2. 工作记录、便签、项目和快捷启动都可以固定为桌面组件。\n3. 使用顶部搜索或 Ctrl+K 快速查找文件、应用、项目和记录。\n4. Ctrl+Shift+K 唤起主窗口，Ctrl+Shift+D 显示或隐藏桌面组件。", "操作简介", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Information);
    [RelayCommand] private void OpenAbout() => _desktop.Open("https://www.douyin.com/search/Aby081298");
    [RelayCommand(CanExecute = nameof(CanRunMaintenance))]
    private async Task CheckUpdateAsync()
    {
        IsBusy = true; UpdateStatus = "正在检查更新…";
        try
        {
            var update = await _updates.CheckAsync();
            if (update is null) { UpdateStatus = $"当前已是最新版本 {_updates.CurrentVersion}"; return; }
            UpdateStatus = $"发现新版本 {update.Version}";
            if (update.DownloadUrl is null || update.ChecksumUrl is null)
            {
                UpdateStatus = $"发现新版本 {update.Version}，但没有可验证的自动安装包";
                if (System.Windows.MessageBox.Show("该版本没有带 SHA-256 校验的 Windows x64 安装包，是否打开发布页面手动下载？", "DustDesk 更新", System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Information) == System.Windows.MessageBoxResult.Yes) _desktop.Open(update.ReleaseUrl);
                return;
            }
            if (System.Windows.MessageBox.Show($"发现新版本 {update.Version}，现在下载并安装？", "DustDesk 更新", System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Information) == System.Windows.MessageBoxResult.Yes)
            {
                RecoveryStatus = "正在创建更新前恢复点...";
                await _maintenance.CreateSafetyBackupAsync(RecoveryPointKind.BeforeUpdate);
                LoadRecoveryPoints();
                RecoveryStatus = "更新前恢复点已创建。";
                var progress = new Progress<int>(value => UpdateStatus = $"正在下载更新 {value}%");
                await _updates.InstallAsync(update, progress);
            }
        }
        catch (Exception ex) { UpdateStatus = $"检查更新失败：{ex.Message}"; }
        finally { IsBusy = false; }
    }
}

public sealed class RecoveryPointItemViewModel
{
    public RecoveryPointItemViewModel(RecoveryPointInfo info) => Info = info;
    public RecoveryPointInfo Info { get; }
    public string Title => Info.Kind switch
    {
        RecoveryPointKind.Automatic => "自动备份",
        RecoveryPointKind.BeforeRestore => "恢复操作前",
        RecoveryPointKind.BeforeReset => "重置操作前",
        RecoveryPointKind.BeforeUpdate => "更新安装前",
        _ => "恢复点"
    };
    public string Detail => $"{Info.CreatedAt:yyyy-MM-dd HH:mm} · {FormatSize(Info.SizeBytes)}";
    public string FilePath => Info.FilePath;

    private static string FormatSize(long bytes) => bytes switch
    {
        < 1024 => $"{bytes} B",
        < 1024 * 1024 => $"{bytes / 1024d:0.0} KB",
        < 1024L * 1024 * 1024 => $"{bytes / 1024d / 1024d:0.0} MB",
        _ => $"{bytes / 1024d / 1024d / 1024d:0.0} GB"
    };
}

public sealed class WidgetOptionViewModel : ObservableObject
{
    private readonly Action<string, bool> _changed;
    private bool _isHotKeyTarget;
    public WidgetOptionViewModel(string key, string label, bool isHotKeyTarget, Action<string, bool> changed) { Key = key; Label = label; _isHotKeyTarget = isHotKeyTarget; _changed = changed; }
    public string Key { get; }
    public string Label { get; }
    public bool IsHotKeyTarget { get => _isHotKeyTarget; set { if (SetProperty(ref _isHotKeyTarget, value)) _changed(Key, value); } }
}
