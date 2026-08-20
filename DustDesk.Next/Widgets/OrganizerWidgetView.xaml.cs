using System.Windows;
using System.Windows.Controls;
using DustDesk.Next.ViewModels;
namespace DustDesk.Next.Widgets; public partial class OrganizerWidgetView : UserControl { public OrganizerWidgetView() => InitializeComponent(); private void OnDrop(object sender, DragEventArgs e) { if (DataContext is not OrganizerViewModel owner || owner.SelectedCategory is null || e.Data.GetData(DataFormats.FileDrop) is not string[] paths) return; foreach (var path in paths) owner.MovePathToCategory(owner.SelectedCategory, path); } }
