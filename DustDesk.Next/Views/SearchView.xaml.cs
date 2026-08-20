using System.Windows.Controls;
using System.Windows.Input;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class SearchView : UserControl
{
    public SearchView() => InitializeComponent();
    private void Results_OnMouseDoubleClick(object sender, MouseButtonEventArgs e)
    {
        if (sender is ListView { SelectedItem: SearchResult result } && DataContext is SearchViewModel viewModel)
            viewModel.OpenResultCommand.Execute(result);
    }
}
