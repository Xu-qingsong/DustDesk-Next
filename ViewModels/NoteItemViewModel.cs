using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class NoteItemViewModel : ObservableObject
{
    public NoteItemViewModel(NoteRecord record)
    {
        Record = record;
        _title = record.Title;
        _text = record.Text;
        _fontSize = record.FontSize;
        _fontBold = record.FontBold;
        _backgroundImagePath = record.BackgroundImagePath ?? string.Empty;
        _colorArgb = record.ColorArgb;
        _fontColorArgb = record.FontColorArgb;
        _imageOnly = record.ImageOnly;
    }

    public NoteRecord Record { get; }
    public string Id => Record.Id;
    public DateTime UpdatedAt => Record.UpdatedAt;

    [ObservableProperty] private string _title;
    [ObservableProperty] private string _text;
    [ObservableProperty] private double _fontSize;
    [ObservableProperty] private bool _fontBold;
    [ObservableProperty] private string _backgroundImagePath;
    [ObservableProperty] private int _colorArgb;
    [ObservableProperty] private int _fontColorArgb;
    [ObservableProperty] private bool _imageOnly;

    partial void OnTitleChanged(string value) => Touch(() => Record.Title = value.Trim());
    partial void OnTextChanged(string value) => Touch(() => Record.Text = value);
    partial void OnFontSizeChanged(double value) => Touch(() => Record.FontSize = Math.Clamp(value, 8, 42));
    partial void OnFontBoldChanged(bool value) => Touch(() => Record.FontBold = value);
    partial void OnBackgroundImagePathChanged(string value) => Touch(() => Record.BackgroundImagePath = string.IsNullOrWhiteSpace(value) ? null : value);
    partial void OnColorArgbChanged(int value) => Touch(() => Record.ColorArgb = value);
    partial void OnFontColorArgbChanged(int value) => Touch(() => Record.FontColorArgb = value);
    partial void OnImageOnlyChanged(bool value) => Touch(() => Record.ImageOnly = value);

    private void Touch(Action change)
    {
        change();
        Record.UpdatedAt = DateTime.Now;
        OnPropertyChanged(nameof(UpdatedAt));
    }
}
