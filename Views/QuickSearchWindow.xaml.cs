using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class QuickSearchWindow : Wpf.Ui.Controls.FluentWindow
{
    private readonly SearchViewModel _viewModel;
    public QuickSearchWindow(SearchViewModel viewModel) { InitializeComponent(); _viewModel = viewModel; DataContext = viewModel; Loaded += (_, _) => { QueryBox.Focus(); QueryBox.SelectAll(); }; }
    private void Close_OnClick(object sender, RoutedEventArgs e) => Close();
    private void Window_OnPreviewKeyDown(object sender, KeyEventArgs e) { if (e.Key == Key.Escape) Close(); else if (e.Key == Key.Enter) { _viewModel.OpenFirstCommand.Execute(null); Close(); } }
    private void Results_OnMouseDoubleClick(object sender, MouseButtonEventArgs e) { if (sender is ListBox { SelectedItem: SearchResult result }) { _viewModel.OpenResultCommand.Execute(result); Close(); } }
}
