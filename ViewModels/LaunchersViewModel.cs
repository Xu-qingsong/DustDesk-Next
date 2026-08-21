using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class LaunchersViewModel : ObservableObject
{
    private const int MaxLaunchers = 5;
    private readonly IDesktopService _desktop;
    private readonly IShellContextMenuService _shellMenu;

    public LaunchersViewModel(WorkspaceViewModel workspace, IDesktopService desktop, IShellContextMenuService shellMenu)
    {
        Workspace = workspace;
        _desktop = desktop;
        _shellMenu = shellMenu;
        _showNames = workspace.State.Settings.LauncherWidgetShowNames;
        _iconSize = Math.Clamp(workspace.State.Settings.LauncherWidgetIconSize, 34, 64);
        foreach (var record in workspace.State.Launchers) AddWrapped(record);
    }

    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<LauncherItemViewModel> Launchers { get; } = new();
    [ObservableProperty] private string _statusText = string.Empty;
    [ObservableProperty] private bool _showNames;
    [ObservableProperty] private int _iconSize;

    partial void OnShowNamesChanged(bool value) { Workspace.State.Settings.LauncherWidgetShowNames = value; Workspace.MarkChanged(); }
    partial void OnIconSizeChanged(int value) { Workspace.State.Settings.LauncherWidgetIconSize = Math.Clamp(value, 34, 64); Workspace.MarkChanged(); }

    [RelayCommand]
    private void AddLauncher()
    {
        var path = _desktop.PickFile("选择要添加的应用、文件或快捷方式");
        if (path is not null) AddPath(path);
    }

    public void AddPath(string path)
    {
        if (Launchers.Count >= MaxLaunchers) { StatusText = $"快捷启动最多添加 {MaxLaunchers} 项。"; return; }
        if (string.IsNullOrWhiteSpace(path)) return;
        var persistedPath = PersistLauncherPath(path);
        if (Launchers.Any(item => string.Equals(item.Path, path, StringComparison.OrdinalIgnoreCase) || string.Equals(item.Path, persistedPath, StringComparison.OrdinalIgnoreCase))) return;
        var record = new LauncherRecord { Name = Path.GetFileNameWithoutExtension(path), Path = persistedPath };
        Workspace.State.Launchers.Add(record);
        AddWrapped(record);
        StatusText = string.Empty;
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void OpenLauncher(LauncherItemViewModel? item) { if (item is not null) _desktop.Open(item.Path); }

    [RelayCommand]
    private void ShowLauncherMenu(LauncherItemViewModel? item) { if (item is not null) _shellMenu.ShowForPath(item.Path); }

    [RelayCommand]
    private void ChooseLauncherPath(LauncherItemViewModel? item)
    {
        if (item is null) return;
        var selected = _desktop.PickFile("更换快捷启动路径");
        if (selected is null) return;
        var previous = item.Path; var persisted = PersistLauncherPath(selected);
        item.Path = persisted; if (!string.Equals(previous, persisted, StringComparison.OrdinalIgnoreCase)) DeletePersistedLauncher(previous);
    }

    [RelayCommand]
    private void DeleteLauncher(LauncherItemViewModel? item)
    {
        if (item is null) return;
        if (!ConfirmationDialog.ConfirmDelete("这个快捷启动项")) return;
        DeletePersistedLauncher(item.Path);
        item.PropertyChanged -= OnLauncherChanged;
        Launchers.Remove(item);
        Workspace.State.Launchers.Remove(item.Record);
        Workspace.MarkChanged();
    }

    private void AddWrapped(LauncherRecord record)
    {
        var item = new LauncherItemViewModel(record);
        item.PropertyChanged += OnLauncherChanged;
        Launchers.Add(item);
    }

    private void OnLauncherChanged(object? sender, PropertyChangedEventArgs e) => Workspace.MarkChanged();
    private string PersistLauncherPath(string sourcePath)
    {
        if (!File.Exists(sourcePath)) return sourcePath;
        var extension = Path.GetExtension(sourcePath);
        var desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        var organizer = Path.Combine(Path.GetDirectoryName(Workspace.DataFilePath)!, "DesktopOrganizer");
        if (!extension.Equals(".lnk", StringComparison.OrdinalIgnoreCase) && !extension.Equals(".url", StringComparison.OrdinalIgnoreCase) && !IsUnder(sourcePath, desktop) && !IsUnder(sourcePath, organizer)) return sourcePath;
        try
        {
            var directory = Path.Combine(Path.GetDirectoryName(Workspace.DataFilePath)!, "Launchers");
            Directory.CreateDirectory(directory);
            var invalid = Path.GetInvalidFileNameChars().ToHashSet();
            var name = new string(Path.GetFileNameWithoutExtension(sourcePath).Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray());
            var target = Path.Combine(directory, name + extension);
            File.Copy(sourcePath, target, true); return target;
        }
        catch { return sourcePath; }
    }
    private static bool IsUnder(string path, string directory)
    {
        if (string.IsNullOrWhiteSpace(directory)) return false;
        try
        {
            var fullPath = Path.GetFullPath(path);
            var root = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
            return fullPath.StartsWith(root, StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }
    private void DeletePersistedLauncher(string path)
    {
        var directory = Path.Combine(Path.GetDirectoryName(Workspace.DataFilePath)!, "Launchers");
        if (!IsUnder(path, directory) || !File.Exists(path)) return;
        try { File.Delete(path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}
