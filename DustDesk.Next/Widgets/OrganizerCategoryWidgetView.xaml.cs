using System.Windows;
using System.Windows.Controls;
using DustDesk.Next.ViewModels;
namespace DustDesk.Next.Widgets; public sealed record OrganizerCategoryWidgetContext(DesktopCategoryViewModel Category, OrganizerViewModel Owner); public partial class OrganizerCategoryWidgetView : UserControl { public OrganizerCategoryWidgetView() => InitializeComponent(); private void OnDrop(object sender, DragEventArgs e) { if (DataContext is not OrganizerCategoryWidgetContext context || e.Data.GetData(DataFormats.FileDrop) is not string[] paths) return; foreach (var path in paths) context.Owner.MovePathToCategory(context.Category, path); } }
