using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Models;

namespace DustDesk.Next.ViewModels;

public partial class ClipboardItemViewModel : ObservableObject
{
    public ClipboardItemViewModel(ClipboardRecord record, string? imagePath = null) { Record = record; ImagePath = imagePath ?? string.Empty; _isPinned = record.IsPinned; _isLocked = record.IsLocked; }
    public ClipboardRecord Record { get; }
    public string Id => Record.Id;
    public ClipboardContentKind Kind => Record.Kind;
    public string Text => Record.Text;
    public string ImagePath { get; }
    public string Summary => Kind == ClipboardContentKind.Image ? "图片内容" : Text.ReplaceLineEndings(" ").Trim();
    public DateTime CreatedAt => Record.CreatedAt;
    [ObservableProperty] private bool _isPinned;
    [ObservableProperty] private bool _isLocked;
    partial void OnIsPinnedChanged(bool value) => Record.IsPinned = value;
    partial void OnIsLockedChanged(bool value) => Record.IsLocked = value;
}
