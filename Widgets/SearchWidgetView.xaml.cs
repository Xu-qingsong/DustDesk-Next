using System.Collections.Specialized;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using DustDesk.Next.Models;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Widgets;

public partial class SearchWidgetView : UserControl
{
    private SearchViewModel? _viewModel;
    private bool _dragMoved;
    private Point _dragStart;

    public SearchWidgetView()
    {
        InitializeComponent();
        DataContextChanged += (_, _) => ObserveViewModel();
        Loaded += (_, _) => ObserveViewModel();
    }

    public event Action? LayoutStateChanged;
    public WidgetDockEdge DockEdge { get; private set; }
    public bool IsCapsuleExpanded { get; private set; } = true;
    public bool HasActiveQuery => _viewModel?.HasActiveQuery == true;

    public void SetDockEdge(WidgetDockEdge edge)
    {
        var wasSide = DockEdge is WidgetDockEdge.Left or WidgetDockEdge.Right;
        DockEdge = edge;
        if (edge is WidgetDockEdge.Top or WidgetDockEdge.Bottom or WidgetDockEdge.None) IsCapsuleExpanded = true;
        else if (!wasSide) IsCapsuleExpanded = false;
        UpdateVisualState();
    }

    public void FocusSearch()
    {
        IsCapsuleExpanded = true;
        UpdateVisualState();
        LayoutStateChanged?.Invoke();
        Dispatcher.BeginInvoke(DispatcherPriority.Input, () =>
        {
            if (Window.GetWindow(this) is DesktopWidgetWindow window) window.ActivateSearchInput(QueryBox);
            QueryBox.CaretIndex = QueryBox.Text.Length;
        });
    }

    public void CollapseToDockIcon()
    {
        if (DockEdge is not (WidgetDockEdge.Left or WidgetDockEdge.Right)) return;
        IsCapsuleExpanded = false;
        UpdateVisualState();
    }

    private void ObserveViewModel()
    {
        if (ReferenceEquals(_viewModel, DataContext)) return;
        if (_viewModel is not null)
        {
            _viewModel.PropertyChanged -= ViewModel_OnPropertyChanged;
            _viewModel.Results.CollectionChanged -= Results_OnCollectionChanged;
        }
        _viewModel = DataContext as SearchViewModel;
        if (_viewModel is not null)
        {
            _viewModel.PropertyChanged += ViewModel_OnPropertyChanged;
            _viewModel.Results.CollectionChanged += Results_OnCollectionChanged;
        }
        UpdateVisualState();
    }

    private void ViewModel_OnPropertyChanged(object? sender, PropertyChangedEventArgs e)
    {
        if (e.PropertyName is nameof(SearchViewModel.Query) or nameof(SearchViewModel.HasActiveQuery) or nameof(SearchViewModel.IsSearching) or nameof(SearchViewModel.StatusText))
        {
            UpdateVisualState();
            LayoutStateChanged?.Invoke();
        }
    }

    private void Results_OnCollectionChanged(object? sender, NotifyCollectionChangedEventArgs e) => LayoutStateChanged?.Invoke();

    private void UpdateVisualState()
    {
        var sideCollapsed = DockEdge is WidgetDockEdge.Left or WidgetDockEdge.Right && !IsCapsuleExpanded;
        CapsuleBorder.Visibility = sideCollapsed ? Visibility.Collapsed : Visibility.Visible;
        CircleButton.Visibility = sideCollapsed ? Visibility.Visible : Visibility.Collapsed;
        CloseCapsuleButton.Visibility = DockEdge is WidgetDockEdge.Left or WidgetDockEdge.Right ? Visibility.Visible : Visibility.Collapsed;
        ResultsPanel.Visibility = !sideCollapsed && HasActiveQuery ? Visibility.Visible : Visibility.Collapsed;
        Grid.SetRow(CapsuleBorder, DockEdge == WidgetDockEdge.Bottom ? 1 : 0);
        Grid.SetRow(ResultsPanel, DockEdge == WidgetDockEdge.Bottom ? 0 : 1);
    }

    private void CloseCapsule_OnClick(object sender, RoutedEventArgs e)
    {
        if (_viewModel is not null) _viewModel.Query = string.Empty;
        IsCapsuleExpanded = false;
        UpdateVisualState();
        LayoutStateChanged?.Invoke();
    }

    private void QueryBox_OnPreviewKeyDown(object sender, KeyEventArgs e)
    {
        if (e.Key == Key.Enter) { _viewModel?.OpenFirstCommand.Execute(null); e.Handled = true; }
        else if (e.Key == Key.Escape)
        {
            if (_viewModel is not null) _viewModel.Query = string.Empty;
            if (DockEdge is WidgetDockEdge.Left or WidgetDockEdge.Right) IsCapsuleExpanded = false;
            UpdateVisualState(); LayoutStateChanged?.Invoke(); e.Handled = true;
        }
    }

    private void QueryBox_OnPreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (Window.GetWindow(this) is DesktopWidgetWindow window) window.ActivateSearchInput(QueryBox);
    }

    private void DragHandle_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        _dragMoved = false;
        _dragStart = e.GetPosition(this);
        ((UIElement)sender).CaptureMouse();
        (Window.GetWindow(this) as DesktopWidgetWindow)?.BeginSearchDrag();
        e.Handled = true;
    }

    private void DragHandle_OnMouseMove(object sender, MouseEventArgs e)
    {
        if (!((UIElement)sender).IsMouseCaptured || e.LeftButton != MouseButtonState.Pressed) return;
        var point = e.GetPosition(this);
        if (Math.Abs(point.X - _dragStart.X) > 3 || Math.Abs(point.Y - _dragStart.Y) > 3) _dragMoved = true;
        if (_dragMoved) (Window.GetWindow(this) as DesktopWidgetWindow)?.ContinueSearchDrag();
    }

    private void DragHandle_OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e) => EndDrag(sender, false);
    private void CircleButton_OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e) => EndDrag(sender, true);
    private void DragHandle_OnLostMouseCapture(object sender, MouseEventArgs e) { if (e.LeftButton != MouseButtonState.Pressed) (Window.GetWindow(this) as DesktopWidgetWindow)?.EndSearchDrag(); }

    private void EndDrag(object sender, bool openWhenClicked)
    {
        if (((UIElement)sender).IsMouseCaptured) ((UIElement)sender).ReleaseMouseCapture();
        (Window.GetWindow(this) as DesktopWidgetWindow)?.EndSearchDrag();
        if (openWhenClicked && !_dragMoved) FocusSearch();
    }
}
