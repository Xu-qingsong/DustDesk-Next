using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class NotesViewModel : ObservableObject
{
    private readonly IDesktopService _desktop;
    private readonly IWidgetManager _widgets;
    private readonly TasksViewModel _tasks;
    private readonly string _backgroundDirectory;

    public NotesViewModel(WorkspaceViewModel workspace, IDesktopService desktop, IWidgetManager widgets, TasksViewModel tasks)
    {
        Workspace = workspace; _tasks = tasks;
        _desktop = desktop;
        _widgets = widgets;
        _backgroundDirectory = Path.Combine(workspace.DataDirectory, "NoteBackgrounds");
        Directory.CreateDirectory(_backgroundDirectory);
        foreach (var record in workspace.State.Notes)
        {
            ResolveManagedBackground(record);
            AddWrapped(record);
        }
        CleanupOrphanBackgrounds();
        RefreshFilteredNotes();
        SelectedNote = Notes.FirstOrDefault();
    }

    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<NoteItemViewModel> Notes { get; } = new();
    public ObservableCollection<NoteItemViewModel> FilteredNotes { get; } = new();
    [ObservableProperty] private string _searchQuery = string.Empty;
    partial void OnSearchQueryChanged(string value) => RefreshFilteredNotes();

    [RelayCommand]
    private void CreateTaskFromSelected()
    {
        if (SelectedNote is null || string.IsNullOrWhiteSpace(SelectedNote.Text)) return;
        _tasks.CreateFromText(SelectedNote.Text);
    }

    public NoteItemViewModel CreateFromText(string text)
    {
        var title = text.ReplaceLineEndings(" ").Trim();
        if (title.Length > 80) title = title[..80];
        var record = new NoteRecord { Title = string.IsNullOrWhiteSpace(title) ? "新便签" : title, Text = text.Trim() };
        Workspace.State.Notes.Add(record);
        var item = AddWrapped(record);
        SelectedNote = item;
        RefreshFilteredNotes();
        Workspace.MarkChanged();
        return item;
    }

    [ObservableProperty] private NoteItemViewModel? _selectedNote;
    [ObservableProperty] private string _backgroundStatusText = string.Empty;

    [RelayCommand]
    private void AddNote()
    {
        var record = new NoteRecord { Title = $"便签 {Notes.Count + 1}" };
        Workspace.State.Notes.Add(record);
        SelectedNote = AddWrapped(record);
        RefreshFilteredNotes();
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void DeleteNote(NoteItemViewModel? item)
    {
        if (item is null || Notes.Count <= 1)
        {
            return;
        }
        if (!ConfirmationDialog.ConfirmDelete("这条便签")) return;

        var index = Notes.IndexOf(item);
        var widgetKey = $"note:{item.Id}";
        _widgets.Hide(widgetKey);
        Workspace.State.Settings.WidgetPlacements.Remove(widgetKey);
        Workspace.State.Settings.NoteWidgetPlacements.RemoveAll(placement => string.Equals(placement.NoteId, item.Id, StringComparison.OrdinalIgnoreCase));
        item.PropertyChanged -= OnNoteChanged;
        Notes.Remove(item);
        Workspace.State.Notes.Remove(item.Record);
        DeleteManagedBackground(item.Record);
        SelectedNote = Notes[Math.Clamp(index, 0, Notes.Count - 1)];
        RefreshFilteredNotes();
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void ChooseBackground()
    {
        if (SelectedNote is null)
        {
            return;
        }

        var path = _desktop.PickFile("选择便签背景", "图片文件|*.png;*.jpg;*.jpeg;*.webp;*.bmp|所有文件|*.*");
        if (path is not null)
        {
            try
            {
                var info = new FileInfo(path);
                if (info.Length > 50L * 1024 * 1024) { BackgroundStatusText = "便签背景图片不能超过 50 MB。"; return; }
                var extension = Path.GetExtension(path).ToLowerInvariant();
                var fileName = $"{SelectedNote.Id}-{Guid.NewGuid():N}{extension}";
                var target = Path.Combine(_backgroundDirectory, fileName);
                File.Copy(path, target, overwrite: false);
                DeleteManagedBackground(SelectedNote.Record);
                SelectedNote.Record.BackgroundImageFileName = fileName;
                SelectedNote.BackgroundImagePath = target;
                BackgroundStatusText = string.Empty;
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { BackgroundStatusText = $"背景图片保存失败：{ex.Message}"; }
        }
    }

    [RelayCommand]
    private void ClearBackground()
    {
        if (SelectedNote is not null && ConfirmationDialog.Confirm("清除确认", "确定要清除这条便签的背景图片吗？"))
        {
            DeleteManagedBackground(SelectedNote.Record);
            SelectedNote.BackgroundImagePath = string.Empty;
        }
    }

    [RelayCommand]
    private void ChooseColor()
    {
        if (SelectedNote is null) return;
        using var dialog = new System.Windows.Forms.ColorDialog { Color = System.Drawing.Color.FromArgb(SelectedNote.ColorArgb), FullOpen = true };
        if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK) SelectedNote.ColorArgb = dialog.Color.ToArgb();
    }

    [RelayCommand]
    private void ChooseFontColor()
    {
        if (SelectedNote is null) return;
        using var dialog = new System.Windows.Forms.ColorDialog { Color = System.Drawing.Color.FromArgb(SelectedNote.FontColorArgb), FullOpen = true };
        if (dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK) SelectedNote.FontColorArgb = System.Drawing.Color.FromArgb(255, dialog.Color.R, dialog.Color.G, dialog.Color.B).ToArgb();
    }

    [RelayCommand]
    private void SetTransparentColor() { if (SelectedNote is not null) SelectedNote.ColorArgb = 0x00FFFFFF; }

    [RelayCommand]
    private void PinSelectedNote()
    {
        if (SelectedNote is not null) _widgets.Show($"note:{SelectedNote.Id}");
    }

    [RelayCommand]
    private void SetColor(string? value)
    {
        if (SelectedNote is null || string.IsNullOrWhiteSpace(value)) return;
        SelectedNote.ColorArgb = unchecked((int)Convert.ToUInt32(value, 16));
    }

    [RelayCommand]
    private void SetFontColor(string? value)
    {
        if (SelectedNote is null || string.IsNullOrWhiteSpace(value)) return;
        SelectedNote.FontColorArgb = unchecked((int)Convert.ToUInt32(value, 16));
    }

    private NoteItemViewModel AddWrapped(NoteRecord record)
    {
        var item = new NoteItemViewModel(record);
        item.PropertyChanged += OnNoteChanged;
        Notes.Add(item);
        return item;
    }

    private void OnNoteChanged(object? sender, PropertyChangedEventArgs e)
    {
        Workspace.MarkChanged();
        if (e.PropertyName is nameof(NoteItemViewModel.Title) or nameof(NoteItemViewModel.Text)) RefreshFilteredNotes();
    }

    private void RefreshFilteredNotes()
    {
        var query = SearchQuery.Trim();
        FilteredNotes.Clear();
        foreach (var note in Notes.Where(note => string.IsNullOrWhiteSpace(query) || note.Title.Contains(query, StringComparison.CurrentCultureIgnoreCase) || note.Text.Contains(query, StringComparison.CurrentCultureIgnoreCase)))
            FilteredNotes.Add(note);
        if (SelectedNote is not null && !FilteredNotes.Contains(SelectedNote)) SelectedNote = FilteredNotes.FirstOrDefault();
    }

    private void ResolveManagedBackground(NoteRecord record)
    {
        if (!string.IsNullOrWhiteSpace(record.BackgroundImageFileName))
        {
            record.BackgroundImageFileName = Path.GetFileName(record.BackgroundImageFileName);
            var managed = Path.Combine(_backgroundDirectory, record.BackgroundImageFileName);
            record.BackgroundImagePath = File.Exists(managed) ? managed : null;
            return;
        }
        if (string.IsNullOrWhiteSpace(record.BackgroundImagePath) || !File.Exists(record.BackgroundImagePath)) return;
        try
        {
            var extension = Path.GetExtension(record.BackgroundImagePath).ToLowerInvariant();
            var fileName = $"{record.Id}-{Guid.NewGuid():N}{extension}";
            var target = Path.Combine(_backgroundDirectory, fileName);
            File.Copy(record.BackgroundImagePath, target, overwrite: false);
            record.BackgroundImageFileName = fileName;
            record.BackgroundImagePath = target;
            Workspace.MarkChanged();
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private void DeleteManagedBackground(NoteRecord record)
    {
        if (string.IsNullOrWhiteSpace(record.BackgroundImageFileName)) return;
        try { File.Delete(Path.Combine(_backgroundDirectory, Path.GetFileName(record.BackgroundImageFileName))); } catch (IOException) { }
        record.BackgroundImageFileName = string.Empty;
        record.BackgroundImagePath = null;
    }

    private void CleanupOrphanBackgrounds()
    {
        var used = Workspace.State.Notes.Where(note => !string.IsNullOrWhiteSpace(note.BackgroundImageFileName)).Select(note => Path.GetFileName(note.BackgroundImageFileName)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var file in Directory.EnumerateFiles(_backgroundDirectory)) if (!used.Contains(Path.GetFileName(file))) try { File.Delete(file); } catch (IOException) { }
    }
}
