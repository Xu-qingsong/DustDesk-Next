using CommunityToolkit.Mvvm.ComponentModel;

namespace DustDesk.Next.ViewModels;

public partial class NavigationItemViewModel : ObservableObject
{
    public required string Key { get; init; }
    public required string Label { get; init; }
    public required string Glyph { get; init; }
    public bool IsEnabled { get; init; } = true;

    [ObservableProperty]
    private bool _isSelected;
}
