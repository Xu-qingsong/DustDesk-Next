using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class LinkItemViewModel : ObservableObject
{
    public LinkItemViewModel(LinkRecord record)
    {
        Record = record;
        _name = record.Name;
        _url = record.Url;
        _note = record.Note;
    }

    public LinkRecord Record { get; }
    public string Id => Record.Id;
    public DateTime UpdatedAt => Record.UpdatedAt;

    [ObservableProperty] private string _name;
    [ObservableProperty] private string _url;
    [ObservableProperty] private string _note;

    partial void OnNameChanged(string value) => Touch(() => Record.Name = value.Trim());
    partial void OnUrlChanged(string value) => Touch(() => Record.Url = value.Trim());
    partial void OnNoteChanged(string value) => Touch(() => Record.Note = value);

    private void Touch(Action change)
    {
        change();
        Record.UpdatedAt = DateTime.Now;
        OnPropertyChanged(nameof(UpdatedAt));
    }
}
