using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class LauncherItemViewModel : ObservableObject
{
    public LauncherItemViewModel(LauncherRecord record)
    {
        Record = record;
        _name = record.Name;
        _path = record.Path;
    }
    public LauncherRecord Record { get; }
    [ObservableProperty] private string _name;
    [ObservableProperty] private string _path;
    partial void OnNameChanged(string value) => Record.Name = value.Trim();
    partial void OnPathChanged(string value) => Record.Path = value;
}
