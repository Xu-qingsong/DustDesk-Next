using System.Windows;
using System.Windows.Controls;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class OrganizerView : UserControl
{
    public OrganizerView() => InitializeComponent();
    private void OnExternalDrop(object sender, DragEventArgs e)
    {
        if (DataContext is not OrganizerViewModel viewModel || !e.Data.GetDataPresent(DataFormats.FileDrop)) return;
        if (e.Data.GetData(DataFormats.FileDrop) is not string[] paths) return;
        foreach (var path in paths) viewModel.MovePath(path);
    }
}
