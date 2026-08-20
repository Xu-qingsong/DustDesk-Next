using System.Collections.ObjectModel;
using System.IO;
using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class DesktopCategoryViewModel : ObservableObject
{
    public DesktopCategoryViewModel(DesktopCategoryRecord record)
    {
        Record = record; _name = record.Name; _isCollapsed = record.IsCollapsed;
        foreach (var path in record.ItemPaths.Where(path => File.Exists(path) || Directory.Exists(path))) Items.Add(new OrganizerEntry(Path.GetFileName(path), path, Directory.Exists(path)));
    }
    public DesktopCategoryRecord Record { get; }
    public ObservableCollection<OrganizerEntry> Items { get; } = new();
    [ObservableProperty] private string _name;
    [ObservableProperty] private bool _isCollapsed;
    [ObservableProperty] private bool _isSelectedForWidget;
    partial void OnIsCollapsedChanged(bool value) => Record.IsCollapsed = value;
}
