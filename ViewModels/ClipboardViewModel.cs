using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using System.Windows;
using System.Windows.Media.Imaging;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class ClipboardViewModel : ObservableObject
{
    private const int MaxItems = 100;
    private const long MaxSingleImageBytes = 20L * 1024 * 1024;
    private const long MaxImageStorageBytes = 200L * 1024 * 1024;
    private readonly string _imageDirectory;
    private readonly TasksViewModel _tasks;
    private readonly NotesViewModel _notes;

    public ClipboardViewModel(WorkspaceViewModel workspace, TasksViewModel tasks, NotesViewModel notes)
    {
        Workspace = workspace;
        _tasks = tasks;
        _notes = notes;
        _imageDirectory = Path.Combine(workspace.DataDirectory, "ClipboardImages");
        Directory.CreateDirectory(_imageDirectory);
        var changed = false;
        foreach (var record in workspace.State.ClipboardHistory.OrderByDescending(item => item.IsPinned).ThenByDescending(item => item.CreatedAt).ToList())
        {
            var requiresMigrationSave = record.Kind == ClipboardContentKind.Image && (!string.IsNullOrWhiteSpace(record.ImagePngBase64) || string.IsNullOrWhiteSpace(record.ImageSha256));
            if (!PrepareImage(record)) { workspace.State.ClipboardHistory.Remove(record); changed = true; continue; }
            if (requiresMigrationSave) changed = true;
            AddWrapped(record);
        }
        CleanupOrphanImages();
        var originalCount = Items.Count;
        EnforceLimits();
        if (changed || Items.Count != originalCount) Workspace.MarkChanged();
        RefreshFilteredItems();
    }

    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<ClipboardItemViewModel> Items { get; } = new();
    public ObservableCollection<ClipboardItemViewModel> FilteredItems { get; } = new();
    [ObservableProperty] private ClipboardItemViewModel? _selectedItem;
    [ObservableProperty] private string _storageStatusText = string.Empty;
    [ObservableProperty] private string _searchQuery = string.Empty;
    [ObservableProperty] private string _actionStatusText = string.Empty;
    [ObservableProperty] private ClipboardContentKind? _filterKind;

    partial void OnSearchQueryChanged(string value) => RefreshFilteredItems();
    partial void OnFilterKindChanged(ClipboardContentKind? value) => RefreshFilteredItems();

    [RelayCommand]
    private void CreateTaskFromSelected(ClipboardItemViewModel? item = null)
    {
        item ??= SelectedItem;
        if (item is null || item.Kind != ClipboardContentKind.Text || string.IsNullOrWhiteSpace(item.Text)) return;
        _tasks.CreateFromText(item.Text);
        ActionStatusText = "已从剪贴板创建任务。";
    }

    [RelayCommand]
    private void CreateNoteFromSelected(ClipboardItemViewModel? item = null)
    {
        item ??= SelectedItem;
        if (item is null || item.Kind != ClipboardContentKind.Text || string.IsNullOrWhiteSpace(item.Text)) return;
        _notes.CreateFromText(item.Text);
        ActionStatusText = "已从剪贴板创建便签。";
    }

    public void Capture(ClipboardRecord record)
    {
        if (record.Kind == ClipboardContentKind.Text && record.Text.Length > 1_000_000)
        {
            StorageStatusText = "文本超过 100 万字符，未加入剪贴板历史。";
            return;
        }
        if (!PrepareImage(record)) return;
        var duplicate = record.Kind == ClipboardContentKind.Text
            ? Items.FirstOrDefault(item => item.Kind == record.Kind && item.Text == record.Text)
            : Items.FirstOrDefault(item => item.Kind == record.Kind && !string.IsNullOrWhiteSpace(record.ImageSha256) && item.Record.ImageSha256 == record.ImageSha256);

        if (duplicate is null && Items.Count >= MaxItems && Items.All(item => item.IsLocked || item.IsPinned))
        {
            DeleteImage(record);
            StorageStatusText = $"剪贴板已达到 {MaxItems} 条，全部记录均已固定或锁定。";
            return;
        }

        if (duplicate is not null)
        {
            record.IsPinned = duplicate.IsPinned;
            record.IsLocked = duplicate.IsLocked;
            RemoveItem(duplicate);
        }
        Workspace.State.ClipboardHistory.Insert(0, record);
        var wrapped = AddWrapped(record, insertFirst: true);
        SelectedItem = wrapped;
        EnforceLimits();
        Workspace.MarkChanged();
        RefreshFilteredItems();
    }

    [RelayCommand]
    private void Copy(ClipboardItemViewModel? item)
    {
        if (item is null) return;
        if (item.Kind == ClipboardContentKind.Text) Clipboard.SetText(item.Text);
        else if (File.Exists(item.ImagePath))
        {
            using var stream = File.OpenRead(item.ImagePath);
            var image = BitmapFrame.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad);
            Clipboard.SetImage(image);
        }
    }

    [RelayCommand]
    private void Delete(ClipboardItemViewModel? item)
    {
        if (item is null || item.IsLocked || !Services.ConfirmationDialog.ConfirmDelete("这条剪贴板历史")) return;
        RemoveItem(item);
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void Clear()
    {
        if (!Items.Any(item => !item.IsLocked && !item.IsPinned) || !Services.ConfirmationDialog.Confirm("清空确认", "确定要清空全部未锁定且未固定的剪贴板历史吗？")) return;
        foreach (var item in Items.Where(item => !item.IsLocked && !item.IsPinned).ToList()) RemoveItem(item);
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void CaptureCurrent()
    {
        try
        {
            if (Clipboard.ContainsText()) { var text = Clipboard.GetText(); if (!string.IsNullOrWhiteSpace(text)) Capture(new ClipboardRecord { Kind = ClipboardContentKind.Text, Text = text }); return; }
            if (!Clipboard.ContainsImage()) return;
            var image = Clipboard.GetImage();
            if (image is null) return;
            var encoder = new PngBitmapEncoder();
            encoder.Frames.Add(BitmapFrame.Create(image));
            using var stream = new MemoryStream();
            encoder.Save(stream);
            Capture(new ClipboardRecord { Kind = ClipboardContentKind.Image, ImagePngBase64 = Convert.ToBase64String(stream.ToArray()) });
        }
        catch (System.Runtime.InteropServices.COMException) { StorageStatusText = "剪贴板暂时被其他程序占用。"; }
    }

    private bool PrepareImage(ClipboardRecord record)
    {
        if (record.Kind != ClipboardContentKind.Image) return true;
        if (!string.IsNullOrWhiteSpace(record.ImageFileName))
        {
            var existing = Path.Combine(_imageDirectory, Path.GetFileName(record.ImageFileName));
            if (!File.Exists(existing)) { StorageStatusText = "部分剪贴板图片文件已丢失。"; return false; }
            if (new FileInfo(existing).Length > MaxSingleImageBytes) { StorageStatusText = "图片超过 20 MB，已从历史中移除。"; return false; }
            if (string.IsNullOrWhiteSpace(record.ImageSha256))
            {
                using var imageStream = File.OpenRead(existing);
                record.ImageSha256 = Convert.ToHexString(SHA256.HashData(imageStream));
            }
            record.ImageFileName = Path.GetFileName(record.ImageFileName);
            record.ImagePngBase64 = string.Empty;
            return true;
        }
        if (string.IsNullOrWhiteSpace(record.ImagePngBase64)) return false;
        byte[] bytes;
        try { bytes = Convert.FromBase64String(record.ImagePngBase64); }
        catch (FormatException) { StorageStatusText = "剪贴板图片数据无效，已跳过。"; return false; }
        if (bytes.LongLength > MaxSingleImageBytes) { StorageStatusText = "图片超过 20 MB，未加入剪贴板历史。"; return false; }
        record.ImageSha256 = Convert.ToHexString(SHA256.HashData(bytes));
        record.ImageFileName = $"{record.Id}.png";
        try { File.WriteAllBytes(Path.Combine(_imageDirectory, record.ImageFileName), bytes); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            StorageStatusText = $"剪贴板图片保存失败：{ex.Message}";
            record.ImageFileName = string.Empty;
            return false;
        }
        record.ImagePngBase64 = string.Empty;
        return true;
    }

    private ClipboardItemViewModel AddWrapped(ClipboardRecord record, bool insertFirst = false)
    {
        var path = record.Kind == ClipboardContentKind.Image ? Path.Combine(_imageDirectory, record.ImageFileName) : string.Empty;
        var item = new ClipboardItemViewModel(record, path);
        item.PropertyChanged += OnChanged;
        if (insertFirst) Items.Insert(0, item); else Items.Add(item);
        return item;
    }

    private void EnforceLimits()
    {
        while (Items.Count > MaxItems || ImageStorageBytes() > MaxImageStorageBytes)
        {
            var removable = Items.LastOrDefault(item => !item.IsLocked && !item.IsPinned);
            if (removable is null)
            {
                StorageStatusText = "固定或锁定的剪贴板内容已超过存储配额，请清理后再继续。";
                break;
            }
            RemoveItem(removable);
        }
    }

    private long ImageStorageBytes() => Items.Where(item => item.Kind == ClipboardContentKind.Image && File.Exists(item.ImagePath)).Sum(item => new FileInfo(item.ImagePath).Length);

    private void RemoveItem(ClipboardItemViewModel item)
    {
        item.PropertyChanged -= OnChanged;
        Items.Remove(item);
        Workspace.State.ClipboardHistory.Remove(item.Record);
        DeleteImage(item.Record);
        RefreshFilteredItems();
    }

    private void RefreshFilteredItems()
    {
        var query = SearchQuery.Trim();
        FilteredItems.Clear();
        foreach (var item in Items.Where(item => (!FilterKind.HasValue || item.Kind == FilterKind.Value) && (string.IsNullOrWhiteSpace(query) || item.Summary.Contains(query, StringComparison.CurrentCultureIgnoreCase))))
            FilteredItems.Add(item);
        if (SelectedItem is not null && !FilteredItems.Contains(SelectedItem)) SelectedItem = FilteredItems.FirstOrDefault();
    }

    private void DeleteImage(ClipboardRecord record)
    {
        if (string.IsNullOrWhiteSpace(record.ImageFileName)) return;
        try { File.Delete(Path.Combine(_imageDirectory, Path.GetFileName(record.ImageFileName))); } catch (IOException) { }
    }

    private void CleanupOrphanImages()
    {
        var used = Workspace.State.ClipboardHistory.Where(item => !string.IsNullOrWhiteSpace(item.ImageFileName)).Select(item => Path.GetFileName(item.ImageFileName)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var file in Directory.EnumerateFiles(_imageDirectory, "*.png")) if (!used.Contains(Path.GetFileName(file))) try { File.Delete(file); } catch (IOException) { }
    }

    private void OnChanged(object? sender, PropertyChangedEventArgs e) { EnforceLimits(); Workspace.MarkChanged(); }
}
