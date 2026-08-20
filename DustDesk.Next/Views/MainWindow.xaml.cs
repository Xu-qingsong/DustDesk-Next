using System.Windows;
using System.Windows.Input;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class MainWindow : Wpf.Ui.Controls.FluentWindow
{
    private readonly SearchViewModel _search;
    private QuickSearchWindow? _quickSearch;

    public MainWindow(ShellViewModel viewModel, SearchViewModel search)
    {
        InitializeComponent();
        DataContext = viewModel;
        _search = search;
        PreviewKeyDown += (_, e) => { if (e.Key == Key.K && Keyboard.Modifiers == ModifierKeys.Control) { ShowQuickSearch(); e.Handled = true; } };
        StateChanged += (_, _) => UpdateWindowControls();
        UpdateWindowControls();
    }

    private void TitleBar_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != MouseButton.Left) return;
        if (e.ClickCount == 2) { ToggleMaximized(); e.Handled = true; return; }
        if (WindowState == WindowState.Maximized) WindowState = WindowState.Normal;
        DragMove();
        e.Handled = true;
    }

    private void Minimize_OnClick(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;
    private void Maximize_OnClick(object sender, RoutedEventArgs e) => ToggleMaximized();
    private void Close_OnClick(object sender, RoutedEventArgs e) => Close();
    private void ToggleMaximized() => WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
    private void UpdateWindowControls()
    {
        if (MaximizeButton is null) return;
        MaximizeButton.Content = WindowState == WindowState.Maximized ? "\uE923" : "\uE922";
        MaximizeButton.ToolTip = WindowState == WindowState.Maximized ? "还原" : "全屏";
    }

    private void QuickSearch_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e) { e.Handled = true; ShowQuickSearch(); }
    private void More_OnClick(object sender, RoutedEventArgs e)
    {
        MoreMenu.PlacementTarget = MoreButton;
        MoreMenu.IsOpen = true;
        e.Handled = true;
    }

    private void ShowQuickSearch()
    {
        if (_quickSearch is { IsVisible: true }) { _quickSearch.Activate(); return; }
        _quickSearch = new QuickSearchWindow(_search) { Owner = this };
        _quickSearch.Closed += (_, _) => _quickSearch = null;
        _quickSearch.Show();
    }
}
