using System.Windows;
using System.Windows.Controls;
using DustDesk.Next.ViewModels;
namespace DustDesk.Next.Widgets; public partial class LauncherWidgetView : UserControl { public LauncherWidgetView() => InitializeComponent(); private void OnDrop(object sender, DragEventArgs e) { if (DataContext is not LaunchersViewModel owner || e.Data.GetData(DataFormats.FileDrop) is not string[] paths) return; foreach (var path in paths) owner.AddPath(path); } }
