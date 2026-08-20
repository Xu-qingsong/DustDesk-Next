using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Widgets;

public sealed record OrganizerGroupWidgetContext(IReadOnlyList<DesktopCategoryViewModel> Categories, OrganizerViewModel Owner);

public partial class OrganizerGroupWidgetView : UserControl
{
    public OrganizerGroupWidgetView() => InitializeComponent();
    private void OnCategoryDrop(object sender, DragEventArgs e)
    {
        if (DataContext is not OrganizerGroupWidgetContext context || sender is not FrameworkElement { DataContext: DesktopCategoryViewModel category }) return;
        if (e.Data.GetData(typeof(OrganizerEntry)) is OrganizerEntry entry) { context.Owner.MoveEntryToCategory(category, entry); return; }
        if (e.Data.GetData(DataFormats.FileDrop) is string[] paths) foreach (var path in paths) context.Owner.MovePathToCategory(category, path);
    }
    private void OnEntryMouseMove(object sender, MouseEventArgs e)
    {
        if (e.LeftButton == MouseButtonState.Pressed && sender is FrameworkElement { DataContext: OrganizerEntry entry } element)
            DragDrop.DoDragDrop(element, new DataObject(typeof(OrganizerEntry), entry), DragDropEffects.Move);
    }
}
