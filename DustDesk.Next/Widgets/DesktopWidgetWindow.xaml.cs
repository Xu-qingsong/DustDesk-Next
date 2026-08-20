using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Threading;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.Widgets;

public partial class DesktopWidgetWindow : Window
{
    private const double CollapsedHeight = 34;
    private const double ExpandedMinHeight = 120;
    private const double SearchCapsuleWidth = 520;
    private const double SearchCompactSize = 52;
    private const double SearchResultsHeight = 360;
    private readonly WidgetPlacementRecord _placement;
    private readonly Action _changed;
    private readonly SearchWidgetView? _searchView;
    private int _backgroundColorArgb;
    private bool _collapsed;
    private bool _locked;
    private double _expandedHeight;
    private bool _initializing = true;
    private bool _snapping;
    private bool _dragging;
    private NativePoint _dragStartCursor;
    private NativeRect _dragStartWindowRect;
    private IntPtr _handle;
    private bool _searchLayoutChanging;
    private readonly DispatcherTimer _autoCollapseTimer = new() { Interval = TimeSpan.FromSeconds(10) };

    public DesktopWidgetWindow(string title, object content, WidgetPlacementRecord placement, Action changed, int backgroundColorArgb = unchecked((int)0xFFFFFFFF))
    {
        InitializeComponent();
        Title = title;
        WidgetContent.Content = content;
        _searchView = content as SearchWidgetView;
        if (content is WorkdayCountdownWidgetView)
        {
            MinWidth = 500;
            MinHeight = 220;
        }
        _placement = placement;
        _changed = changed;
        _backgroundColorArgb = backgroundColorArgb;
        Width = placement.Width > 0 ? placement.Width : 390;
        Height = placement.Height > 0 ? placement.Height : 320;
        Left = placement.X != 0 ? placement.X : 120;
        Top = placement.Y != 0 ? placement.Y : 120;
        EnsureVisible();
        Opacity = 0.86;
        Topmost = placement.TopMost;
        _locked = placement.Locked;
        ResizeMode = _locked ? ResizeMode.NoResize : ResizeMode.CanResizeWithGrip;
        _collapsed = placement.IsCollapsed;
        _expandedHeight = Math.Max(Height, 160);
        if (_searchView is not null) ConfigureSearchWidget();
        else if (_collapsed) { MinHeight = CollapsedHeight; Height = CollapsedHeight; }
        else MinHeight = ExpandedMinHeight;
        LocationChanged += (_, _) => SavePlacement();
        SizeChanged += (_, _) => SavePlacement();
        SourceInitialized += (_, _) =>
        {
            _handle = new WindowInteropHelper(this).Handle;
            _initializing = false;
            if (_searchView is not null) ApplySearchLayout(); else SavePlacement();
        };
        _autoCollapseTimer.Tick += (_, _) => { _autoCollapseTimer.Stop(); if (_placement.AutoCollapseEnabled && !_collapsed) SetCollapsed(true); };
        MouseEnter += (_, _) => { if (_placement.AutoCollapseEnabled && _collapsed) SetCollapsed(false); ResetAutoCollapseTimer(); };
        MouseMove += (_, _) => ResetAutoCollapseTimer();
        Closed += (_, _) => _autoCollapseTimer.Stop();
        ResetAutoCollapseTimer();
        UpdateHeaderState();
        UpdateAppearance();
    }

    private void Header_OnMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
    {
        if (e.ClickCount == 2)
        {
            SetCollapsed(!_collapsed);
            e.Handled = true;
            return;
        }

        if (_locked || e.ButtonState != MouseButtonState.Pressed) return;

        _dragging = true;
        e.Handled = true;
        try { DragMove(); }
        catch (InvalidOperationException) { }
        finally
        {
            _dragging = false;
            SavePlacement();
        }
    }

    private void Header_OnMouseMove(object sender, MouseEventArgs e)
    {
        if (!_dragging || _locked || e.LeftButton != MouseButtonState.Pressed) return;
        if (!GetCursorPos(out var cursor)) return;

        var screenX = _dragStartWindowRect.Left + cursor.X - _dragStartCursor.X;
        var screenY = _dragStartWindowRect.Top + cursor.Y - _dragStartCursor.Y;
        MoveNativeWindow(screenX, screenY);
        e.Handled = true;
    }

    private void Header_OnMouseLeftButtonUp(object sender, MouseButtonEventArgs e) => FinishDragging();
    private void Header_OnLostMouseCapture(object sender, MouseEventArgs e) => FinishDragging();

    private void OptionsButton_OnClick(object sender, RoutedEventArgs e)
    {
        FinishDragging();
        OpenOptionsMenu(OptionsButton);
        e.Handled = true;
    }

    private void SearchOptionsButton_OnClick(object sender, RoutedEventArgs e) { OpenOptionsMenu(SearchOptionsButton); e.Handled = true; }

    private void OpenOptionsMenu(UIElement target)
    {
        UpdateHeaderState();
        OptionsMenu.PlacementTarget = target;
        OptionsMenu.IsOpen = true;
    }

    private void FinishDragging()
    {
        if (!_dragging) return;
        _dragging = false;
        if (Header.IsMouseCaptured) Header.ReleaseMouseCapture();
        SaveNativePlacement();
    }

    private void WidgetMenu_OnOpened(object sender, RoutedEventArgs e) => UpdateHeaderState();
    private void Collapse_OnClick(object sender, RoutedEventArgs e) => SetCollapsed(!_collapsed);
    private void Lock_OnClick(object sender, RoutedEventArgs e) { _locked = !_locked; if (_locked) FinishDragging(); ResizeMode = _locked ? ResizeMode.NoResize : ResizeMode.CanResizeWithGrip; Header.Cursor = _locked ? Cursors.Arrow : Cursors.SizeAll; _placement.Locked = _locked; UpdateHeaderState(); _changed(); }
    private void AutoCollapse_OnClick(object sender, RoutedEventArgs e) { _placement.AutoCollapseEnabled = !_placement.AutoCollapseEnabled; UpdateHeaderState(); if (_placement.AutoCollapseEnabled) ResetAutoCollapseTimer(); else { _autoCollapseTimer.Stop(); if (_collapsed) SetCollapsed(false); } _changed(); }
    private void Transparent_OnClick(object sender, RoutedEventArgs e) { _placement.TransparentBackground = !_placement.TransparentBackground; UpdateAppearance(); UpdateHeaderState(); _changed(); }
    private void TopMost_OnClick(object sender, RoutedEventArgs e) { _placement.TopMost = !_placement.TopMost; Topmost = _placement.TopMost; UpdateHeaderState(); _changed(); }
    private void Close_OnClick(object sender, RoutedEventArgs e) => Close();
    private void SetCollapsed(bool value)
    {
        if (_collapsed == value) return;
        if (value) { _expandedHeight = Height; MinHeight = CollapsedHeight; Height = CollapsedHeight; }
        else { MinHeight = ExpandedMinHeight; Height = Math.Max(_expandedHeight, 160); }
        _collapsed = value; _placement.IsCollapsed = value; _changed();
    }
    private void SavePlacement()
    {
        if (_initializing || _dragging || _searchLayoutChanging) return;
        if (_searchView is not null) { SaveSearchPlacement(); return; }
        if (_handle != IntPtr.Zero && GetParent(_handle) != IntPtr.Zero)
        {
            _placement.Width = Width;
            if (!_collapsed) { _placement.Height = Height; _expandedHeight = Height; }
            SaveNativePlacement();
            return;
        }

        SnapToWorkArea();
        _placement.X = Left; _placement.Y = Top; _placement.Width = Width;
        if (!_collapsed) { _placement.Height = Height; _expandedHeight = Height; }
        _changed();
    }
    private void ResetAutoCollapseTimer()
    {
        _autoCollapseTimer.Stop();
        if (_placement.AutoCollapseEnabled && !_collapsed) _autoCollapseTimer.Start();
    }
    private void SnapToWorkArea()
    {
        if (!_placement.SnapToEdges || _snapping) return;
        var area = SystemParameters.WorkArea;
        var left = Math.Abs(Left - area.Left) <= 14 ? area.Left : Left;
        var top = Math.Abs(Top - area.Top) <= 14 ? area.Top : Top;
        if (Math.Abs(Left + ActualWidth - area.Right) <= 14) left = area.Right - ActualWidth;
        if (Math.Abs(Top + ActualHeight - area.Bottom) <= 14) top = area.Bottom - ActualHeight;
        if (left == Left && top == Top) return;
        _snapping = true; Left = left; Top = top; _snapping = false;
    }
    private void UpdateHeaderState()
    {
        CollapseMenuText.Text = _collapsed ? "展开组件" : "折叠组件";
        LockCheck.Visibility = _locked ? Visibility.Visible : Visibility.Collapsed;
        AutoCollapseCheck.Visibility = _placement.AutoCollapseEnabled ? Visibility.Visible : Visibility.Collapsed;
        TopMostCheck.Visibility = _placement.TopMost ? Visibility.Visible : Visibility.Collapsed;
        TransparentCheck.Visibility = _placement.TransparentBackground ? Visibility.Visible : Visibility.Collapsed;
        Header.Cursor = _locked ? Cursors.Arrow : Cursors.SizeAll;
        if (_searchView is not null)
        {
            CollapseMenuItem.Visibility = Visibility.Collapsed;
            AutoCollapseMenuItem.Visibility = Visibility.Collapsed;
        }
    }
    public void SetAppearance(double opacity, int backgroundColorArgb)
    {
        Opacity = Math.Clamp(opacity, 0.2, 1);
        _backgroundColorArgb = backgroundColorArgb;
        UpdateAppearance();
    }
    private void UpdateAppearance()
    {
        var value = unchecked((uint)_backgroundColorArgb);
        var baseColor = System.Windows.Media.Color.FromRgb((byte)(value >> 16), (byte)(value >> 8), (byte)value);
        Root.Background = new System.Windows.Media.SolidColorBrush(System.Windows.Media.Color.FromArgb(_placement.TransparentBackground ? (byte)72 : (byte)245, baseColor.R, baseColor.G, baseColor.B));
        UpdateAdaptiveTabColors(baseColor);
    }

    private void UpdateAdaptiveTabColors(System.Windows.Media.Color baseColor)
    {
        var isLight = RelativeLuminance(baseColor) >= 0.45;
        var contrast = isLight ? System.Windows.Media.Colors.Black : System.Windows.Media.Colors.White;
        Resources["WidgetTabSelectedBrush"] = new System.Windows.Media.SolidColorBrush(Blend(baseColor, contrast, isLight ? 0.16 : 0.22));
        Resources["WidgetTabHoverBrush"] = new System.Windows.Media.SolidColorBrush(Blend(baseColor, contrast, isLight ? 0.07 : 0.10));
        Resources["WidgetTabIdleForegroundBrush"] = new System.Windows.Media.SolidColorBrush(Blend(baseColor, contrast, isLight ? 0.82 : 0.88));
        Resources["WidgetTabSelectedForegroundBrush"] = new System.Windows.Media.SolidColorBrush(Blend(baseColor, contrast, isLight ? 0.90 : 0.96));
        Resources["WidgetTabAccentBrush"] = new System.Windows.Media.SolidColorBrush(Blend(baseColor, contrast, isLight ? 0.52 : 0.62));
    }

    private static System.Windows.Media.Color Blend(System.Windows.Media.Color source, System.Windows.Media.Color target, double targetWeight)
    {
        static byte Mix(byte left, byte right, double weight) => (byte)Math.Clamp(Math.Round(left + (right - left) * weight), 0, 255);
        return System.Windows.Media.Color.FromRgb(Mix(source.R, target.R, targetWeight), Mix(source.G, target.G, targetWeight), Mix(source.B, target.B, targetWeight));
    }

    private static double RelativeLuminance(System.Windows.Media.Color color)
    {
        static double Linear(byte channel)
        {
            var value = channel / 255d;
            return value <= 0.04045 ? value / 12.92 : Math.Pow((value + 0.055) / 1.055, 2.4);
        }
        return 0.2126 * Linear(color.R) + 0.7152 * Linear(color.G) + 0.0722 * Linear(color.B);
    }
    private void EnsureVisible()
    {
        var virtualLeft = SystemParameters.VirtualScreenLeft; var virtualTop = SystemParameters.VirtualScreenTop;
        var virtualRight = virtualLeft + SystemParameters.VirtualScreenWidth; var virtualBottom = virtualTop + SystemParameters.VirtualScreenHeight;
        if (Left + 80 < virtualLeft || Left + 80 > virtualRight || Top + 40 < virtualTop || Top + 40 > virtualBottom)
        {
            var area = SystemParameters.WorkArea; Left = Math.Max(area.Left + 8, area.Right - Width - 36); Top = area.Top + 88;
        }
    }

    private void ConfigureSearchWidget()
    {
        _placement.SnapToEdges = true;
        _placement.IsCollapsed = false;
        _collapsed = false;
        Header.Visibility = Visibility.Collapsed;
        HeaderRow.Height = new GridLength(0);
        Grid.SetRow(WidgetContent, 0);
        Grid.SetRowSpan(WidgetContent, 2);
        WidgetContent.Margin = new Thickness(0);
        MinWidth = SearchCompactSize;
        MinHeight = SearchCompactSize;
        ResizeMode = ResizeMode.NoResize;
        ShowActivated = false;
        Root.CornerRadius = new CornerRadius(26);
        _searchView!.SetDockEdge(_placement.DockEdge);
        _searchView.LayoutStateChanged += ApplySearchLayout;
        Width = _placement.DockEdge is WidgetDockEdge.Left or WidgetDockEdge.Right ? SearchCompactSize : SearchCapsuleWidth;
        Height = SearchCompactSize;
    }

    internal void ActivateSearchInput(TextBox input)
    {
        if (_handle != IntPtr.Zero) SetFocus(_handle);
        Activate();
        FocusManager.SetFocusedElement(this, input);
        input.Focus();
        Keyboard.Focus(input);
    }

    internal void BeginSearchDrag()
    {
        if (_searchView is null || _locked || _handle == IntPtr.Zero) return;
        if (!GetCursorPos(out _dragStartCursor) || !GetWindowRect(_handle, out _dragStartWindowRect)) return;
        _dragging = true;
    }

    internal void ContinueSearchDrag()
    {
        if (!_dragging || _locked || !GetCursorPos(out var cursor)) return;
        MoveNativeWindow(_dragStartWindowRect.Left + cursor.X - _dragStartCursor.X, _dragStartWindowRect.Top + cursor.Y - _dragStartCursor.Y);
    }

    internal void EndSearchDrag()
    {
        if (!_dragging || _searchView is null) return;
        _dragging = false;
        UpdateSearchDockFromCurrentPosition();
        _searchView.SetDockEdge(_placement.DockEdge);
        _searchView.CollapseToDockIcon();
        ApplySearchLayout();
        SaveSearchPlacement();
    }

    private void UpdateSearchDockFromCurrentPosition()
    {
        if (_handle == IntPtr.Zero || !GetWindowRect(_handle, out var rect)) return;
        var area = System.Windows.Forms.Screen.FromRectangle(new System.Drawing.Rectangle(rect.Left, rect.Top, Math.Max(1, rect.Right - rect.Left), Math.Max(1, rect.Bottom - rect.Top))).WorkingArea;
        var bounds = new System.Drawing.Rectangle(rect.Left, rect.Top, rect.Right - rect.Left, rect.Bottom - rect.Top);
        _placement.DockEdge = GetCursorPos(out var cursor)
            ? DetermineSearchDockEdgeDuringDrag(bounds, area, new System.Drawing.Point(cursor.X, cursor.Y))
            : DetermineSearchDockEdge(bounds, area);
    }

    private static WidgetDockEdge DetermineSearchDockEdgeDuringDrag(System.Drawing.Rectangle bounds, System.Drawing.Rectangle area, System.Drawing.Point cursor, int pointerThreshold = 48)
    {
        var pointerEdge = DetermineSearchDockEdge(new System.Drawing.Rectangle(cursor.X, cursor.Y, 1, 1), area, pointerThreshold);
        return pointerEdge != WidgetDockEdge.None ? pointerEdge : DetermineSearchDockEdge(bounds, area);
    }

    private static WidgetDockEdge DetermineSearchDockEdge(System.Drawing.Rectangle bounds, System.Drawing.Rectangle area, int threshold = 36)
    {
        var distances = new (WidgetDockEdge Edge, int Distance)[]
        {
            (WidgetDockEdge.Left, Math.Abs(bounds.Left - area.Left)),
            (WidgetDockEdge.Right, Math.Abs(area.Right - bounds.Right)),
            (WidgetDockEdge.Top, Math.Abs(bounds.Top - area.Top)),
            (WidgetDockEdge.Bottom, Math.Abs(area.Bottom - bounds.Bottom))
        };
        var nearest = distances.OrderBy(item => item.Distance).First();
        return nearest.Distance <= threshold ? nearest.Edge : WidgetDockEdge.None;
    }

    private void ApplySearchLayout()
    {
        if (_searchView is null) return;
        _searchView.SetDockEdge(_placement.DockEdge);
        var sideCollapsed = _placement.DockEdge is WidgetDockEdge.Left or WidgetDockEdge.Right && !_searchView.IsCapsuleExpanded;
        var width = sideCollapsed ? SearchCompactSize : SearchCapsuleWidth;
        var height = !sideCollapsed && _searchView.HasActiveQuery ? SearchResultsHeight : SearchCompactSize;
        SearchOptionsButton.Visibility = sideCollapsed ? Visibility.Collapsed : Visibility.Visible;
        SearchOptionsButton.VerticalAlignment = _placement.DockEdge == WidgetDockEdge.Bottom ? VerticalAlignment.Bottom : VerticalAlignment.Top;
        SearchOptionsButton.Margin = _placement.DockEdge == WidgetDockEdge.Bottom ? new Thickness(0, 0, 7, 7) : new Thickness(0, 7, 7, 0);
        Root.CornerRadius = new CornerRadius(sideCollapsed ? 26 : 8);

        _searchLayoutChanging = true;
        try
        {
            Width = width;
            Height = height;
            if (_handle == IntPtr.Zero) return;
            if (!GetWindowRect(_handle, out var rect)) return;
            var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(this);
            var widthPixels = (int)Math.Round(width * dpi.DpiScaleX);
            var heightPixels = (int)Math.Round(height * dpi.DpiScaleY);
            var area = System.Windows.Forms.Screen.FromRectangle(new System.Drawing.Rectangle(rect.Left, rect.Top, Math.Max(1, rect.Right - rect.Left), Math.Max(1, rect.Bottom - rect.Top))).WorkingArea;
            var x = Math.Clamp(rect.Left, area.Left, Math.Max(area.Left, area.Right - widthPixels));
            var y = Math.Clamp(rect.Top, area.Top, Math.Max(area.Top, area.Bottom - heightPixels));
            switch (_placement.DockEdge)
            {
                case WidgetDockEdge.Left: x = area.Left; break;
                case WidgetDockEdge.Right: x = area.Right - widthPixels; break;
                case WidgetDockEdge.Top: y = area.Top; break;
                case WidgetDockEdge.Bottom: y = area.Bottom - heightPixels; break;
            }
            SetNativeWindowBounds(x, y, widthPixels, heightPixels);
        }
        finally { _searchLayoutChanging = false; }
        SaveSearchPlacement();
    }

    private void SaveSearchPlacement()
    {
        if (_handle == IntPtr.Zero || !GetWindowRect(_handle, out var rect)) return;
        var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(this);
        _placement.X = rect.Left / dpi.DpiScaleX;
        _placement.Y = rect.Top / dpi.DpiScaleY;
        _placement.Width = (rect.Right - rect.Left) / dpi.DpiScaleX;
        _placement.Height = (rect.Bottom - rect.Top) / dpi.DpiScaleY;
        _changed();
    }

    private void MoveNativeWindow(int screenX, int screenY)
    {
        var parent = GetParent(_handle);
        var target = new NativePoint { X = screenX, Y = screenY };
        if (parent != IntPtr.Zero && !ScreenToClient(parent, ref target)) return;
        SetWindowPos(_handle, IntPtr.Zero, target.X, target.Y, 0, 0, SwpNoSize | SwpNoZOrder | SwpNoActivate);
    }

    private void SetNativeWindowBounds(int screenX, int screenY, int width, int height)
    {
        var parent = GetParent(_handle);
        var target = new NativePoint { X = screenX, Y = screenY };
        if (parent != IntPtr.Zero && !ScreenToClient(parent, ref target)) return;
        SetWindowPos(_handle, IntPtr.Zero, target.X, target.Y, width, height, SwpNoZOrder | SwpNoActivate);
    }

    private void SaveNativePlacement()
    {
        if (_searchView is not null) { SaveSearchPlacement(); return; }
        if (_handle == IntPtr.Zero || !GetWindowRect(_handle, out var rect)) return;
        var dpi = System.Windows.Media.VisualTreeHelper.GetDpi(this);
        var left = rect.Left / dpi.DpiScaleX;
        var top = rect.Top / dpi.DpiScaleY;

        if (_placement.SnapToEdges)
        {
            var area = SystemParameters.WorkArea;
            var width = (rect.Right - rect.Left) / dpi.DpiScaleX;
            var height = (rect.Bottom - rect.Top) / dpi.DpiScaleY;
            if (Math.Abs(left - area.Left) <= 14) left = area.Left;
            if (Math.Abs(top - area.Top) <= 14) top = area.Top;
            if (Math.Abs(left + width - area.Right) <= 14) left = area.Right - width;
            if (Math.Abs(top + height - area.Bottom) <= 14) top = area.Bottom - height;

            var snappedX = (int)Math.Round(left * dpi.DpiScaleX);
            var snappedY = (int)Math.Round(top * dpi.DpiScaleY);
            if (snappedX != rect.Left || snappedY != rect.Top) MoveNativeWindow(snappedX, snappedY);
        }

        _placement.X = left;
        _placement.Y = top;
        _changed();
    }

    private const int SwpNoSize = 0x0001;
    private const int SwpNoZOrder = 0x0004;
    private const int SwpNoActivate = 0x0010;

    [StructLayout(LayoutKind.Sequential)]
    private struct NativePoint
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeRect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out NativePoint point);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr handle, out NativeRect rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetParent(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool ScreenToClient(IntPtr handle, ref NativePoint point);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr handle, IntPtr insertAfter, int x, int y, int width, int height, int flags);

}
