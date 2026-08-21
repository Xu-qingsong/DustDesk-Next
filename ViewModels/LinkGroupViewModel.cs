using System.Collections.ObjectModel;
using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class LinkGroupViewModel : ObservableObject
{
    public LinkGroupViewModel(LinkGroupRecord record)
    {
        Record = record;
        _name = record.Name;
        foreach (var link in record.Links) Links.Add(new LinkItemViewModel(link));
        Links.CollectionChanged += (_, _) => OnPropertyChanged(nameof(LinkCount));
    }

    public LinkGroupRecord Record { get; }
    public string Id => Record.Id;
    public ObservableCollection<LinkItemViewModel> Links { get; } = new();
    public int LinkCount => Links.Count;

    [ObservableProperty] private string _name;

    partial void OnNameChanged(string value) => Record.Name = value.Trim();
}
