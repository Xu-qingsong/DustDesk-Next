using System.ComponentModel;
using System.IO;
using System.Windows;
using System.Windows.Threading;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;
using DustDesk.Next.Views;
using Microsoft.Extensions.DependencyInjection;

namespace DustDesk.Next;

public partial class App : Application
{
    private SingleInstanceCoordinator? _singleInstance;
    private ServiceProvider? _services;
    private WorkspaceViewModel? _workspace;
    private bool _shutdownReady;
    private bool _exitRequested;
    private MainWindow? _window;
    private bool _activationPending;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        Wpf.Ui.Appearance.ApplicationAccentColorManager.Apply(
            System.Windows.Media.Color.FromRgb(0x0F, 0x8A, 0x72),
            Wpf.Ui.Appearance.ApplicationTheme.Light,
            false,
            false);
        DispatcherUnhandledException += HandleDispatcherException;
        TaskScheduler.UnobservedTaskException += HandleUnobservedTaskException;

        _singleInstance = new SingleInstanceCoordinator("DustDesk.Next", RequestActivation);
        if (!_singleInstance.IsPrimary)
        {
            if (!_singleInstance.SignalExisting()) MessageBox.Show("DustDesk 已经在运行，但暂时无法唤醒窗口。", "DustDesk", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        var services = new ServiceCollection();
        services.AddSingleton<IAppStateStore, JsonAppStateStore>();
        services.AddSingleton<ILegacyDataImporter, LegacyDataImporter>();
        services.AddSingleton<IDesktopService, DesktopService>();
        services.AddSingleton<ISearchService, SearchService>();
        services.AddSingleton<IClipboardMonitorService, ClipboardMonitorService>();
        services.AddSingleton<ISystemMetricsService, SystemMetricsService>();
        services.AddSingleton<IStartupService, StartupService>();
        services.AddSingleton<IOrganizerService, OrganizerService>();
        services.AddSingleton<ITrayService, TrayService>();
        services.AddSingleton<IGlobalHotKeyService, GlobalHotKeyService>();
        services.AddSingleton<IWidgetManager, WidgetManager>();
        services.AddSingleton<ITodoReminderService, TodoReminderService>();
        services.AddSingleton<IProjectExportService, ProjectExportService>();
        services.AddSingleton<BackupArchiveService>();
        services.AddSingleton<IDataMaintenanceService, DataMaintenanceService>();
        services.AddSingleton<IUpdateService, UpdateService>();
        services.AddSingleton<IShellContextMenuService, ShellContextMenuService>();
        services.AddSingleton<WorkspaceViewModel>();
        services.AddSingleton<DashboardViewModel>();
        services.AddSingleton<TasksViewModel>();
        services.AddSingleton<NotesViewModel>();
        services.AddSingleton<ProjectsViewModel>();
        services.AddSingleton<LaunchersViewModel>();
        services.AddSingleton<LinksViewModel>();
        services.AddSingleton<SearchViewModel>();
        services.AddSingleton<ClipboardViewModel>();
        services.AddSingleton<SystemMonitorViewModel>();
        services.AddSingleton<WorkdayCountdownViewModel>();
        services.AddSingleton<SettingsViewModel>();
        services.AddSingleton<OrganizerViewModel>();
        services.AddSingleton<StatsViewModel>();
        services.AddSingleton<ShellViewModel>();
        services.AddSingleton<MainWindow>();
        _services = services.BuildServiceProvider();

        _workspace = _services.GetRequiredService<WorkspaceViewModel>();
        await _workspace.InitializeAsync();
        await _workspace.FlushAsync();

        _window = _services.GetRequiredService<MainWindow>();
        _window.Closing += HandleMainWindowClosing;
        _window.Loaded += async (_, _) =>
        {
            var clipboardMonitor = _services.GetRequiredService<IClipboardMonitorService>();
            clipboardMonitor.Captured += _services.GetRequiredService<ClipboardViewModel>().Capture;
            if (_workspace.State.Settings.ClipboardMonitoringEnabled) clipboardMonitor.Start(_window);

            var hotKeys = _services.GetRequiredService<IGlobalHotKeyService>();
            hotKeys.Pressed += HandleHotKey;
            hotKeys.Register(_window, 0x4444, _workspace.State.Settings.MainWindowHotKey);
            hotKeys.Register(_window, 0x4445, _workspace.State.Settings.DesktopWidgetsHotKey);

            var tray = _services.GetRequiredService<ITrayService>();
            tray.ShowRequested += ShowMainWindow;
            tray.ExitRequested += ExitApplication;
            _services.GetRequiredService<IWidgetManager>().RestoreConfigured();
            _services.GetRequiredService<ITodoReminderService>().Start();
            await _services.GetRequiredService<SettingsViewModel>().EnsureAutomaticBackupAsync();
        };
        MainWindow = _window;
        _window.Show();
        if (_workspace.State.Settings.StartHiddenToTray) _window.Hide();
        if (_activationPending) ShowMainWindow();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        if (_services is not null)
        {
            _services.GetService<IWidgetManager>()?.CloseAll(true);
            _services.Dispose();
        }
        _singleInstance?.Dispose();

        base.OnExit(e);
    }

    private void HandleDispatcherException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        WriteCrashLog(e.Exception);
        MessageBox.Show($"DustDesk 发生错误，已记录诊断日志。\n\n{e.Exception.Message}", "DustDesk", MessageBoxButton.OK, MessageBoxImage.Error);
        e.Handled = true;
        Shutdown();
    }

    private static void HandleUnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        WriteCrashLog(e.Exception);
        e.SetObserved();
    }

    private static void WriteCrashLog(Exception exception)
    {
        try
        {
            var directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DustDesk.Next", "Logs");
            Directory.CreateDirectory(directory);
            File.AppendAllText(Path.Combine(directory, "crash.log"), $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}\n{exception}\n\n");
        }
        catch { }
    }

    private async void HandleMainWindowClosing(object? sender, CancelEventArgs e)
    {
        if (_shutdownReady || sender is not MainWindow window || _workspace is null)
        {
            return;
        }

        if (!_exitRequested)
        {
            e.Cancel = true;
            try
            {
                await _workspace.FlushAsync();
                window.Hide();
            }
            catch (Exception exception)
            {
                MessageBox.Show(window, $"本地数据保存失败，窗口不会隐藏。\n\n{exception.Message}", "DustDesk", MessageBoxButton.OK, MessageBoxImage.Error);
            }
            return;
        }

        e.Cancel = true;
        window.IsEnabled = false;

        try
        {
            await _workspace.FlushAsync();
            _shutdownReady = true;
            window.Close();
        }
        catch (Exception exception)
        {
            window.IsEnabled = true;
            MessageBox.Show(
                window,
                $"本地数据保存失败，请重试。\n\n{exception.Message}",
                "DustDesk",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
    }

    private void ShowMainWindow()
    {
        if (_window is null) return;
        _window.Show();
        if (_window.WindowState == WindowState.Minimized) _window.WindowState = WindowState.Normal;
        _window.Activate();
    }

    private void RequestActivation()
    {
        Dispatcher.BeginInvoke(() =>
        {
            if (_window is null) _activationPending = true;
            else ShowMainWindow();
        });
    }

    private void ExitApplication()
    {
        if (_window is null) return;
        _exitRequested = true;
        _window.Close();
    }

    private void HandleHotKey(int id)
    {
        if (_window is null) return;
        if (id == 0x4445) { _services?.GetService<IWidgetManager>()?.ToggleConfigured(); return; }
        if (id != 0x4444) return;
        if (_window.IsVisible && _window.WindowState != WindowState.Minimized) _window.Hide(); else ShowMainWindow();
    }
}
