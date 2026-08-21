using System.Windows;
using System.Windows.Controls;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class LaunchersView : UserControl
{
    public LaunchersView() => InitializeComponent();

    private void OnDrop(object sender, DragEventArgs e)
    {
        if (DataContext is not LaunchersViewModel viewModel || !e.Data.GetDataPresent(DataFormats.FileDrop)) return;
        if (e.Data.GetData(DataFormats.FileDrop) is not string[] paths) return;
        foreach (var path in paths) viewModel.AddPath(path);
    }
}
