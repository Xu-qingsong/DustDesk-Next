using System.Collections.ObjectModel;
using System.Windows.Threading;
using CommunityToolkit.Mvvm.ComponentModel;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class SystemMonitorViewModel : ObservableObject, IDisposable
{
    private readonly ISystemMetricsService _metrics;
    private readonly WorkspaceViewModel _workspace;
    private readonly DispatcherTimer _timer = new() { Interval = TimeSpan.FromSeconds(1) };
    public SystemMonitorViewModel(ISystemMetricsService metrics, WorkspaceViewModel workspace)
    {
        _metrics = metrics; _workspace = workspace;
        var settings = workspace.State.Settings;
        _showDownload = settings.MonitorShowDownload; _showUpload = settings.MonitorShowUpload;
        _showMemory = settings.MonitorShowMemory; _showCpu = settings.MonitorShowCpu;
        _showDiskIo = settings.MonitorShowDiskIo; _showDiskSpace = settings.MonitorShowDiskSpace;
        _showPing = settings.MonitorShowPing; _showUptime = settings.MonitorShowUptime;
        _timer.Tick += async (_, _) => await RefreshAsync(); _timer.Start(); _ = RefreshAsync();
    }
    [ObservableProperty] private double _cpuPercent;
    [ObservableProperty] private double _memoryPercent;
    [ObservableProperty] private string _memoryText = "检测中";
    [ObservableProperty] private string _downloadText = "检测中";
    [ObservableProperty] private string _uploadText = "检测中";
    [ObservableProperty] private string _diskSpaceStatusText = "检测中";
    [ObservableProperty] private bool _showDiskSpaceStatus = true;
    [ObservableProperty] private string _pingText = "检测中";
    [ObservableProperty] private string _uptimeText = "检测中";
    [ObservableProperty] private string _diskIoText = "检测中";
    [ObservableProperty] private bool _showDownload;
    [ObservableProperty] private bool _showUpload;
    [ObservableProperty] private bool _showMemory;
    [ObservableProperty] private bool _showCpu;
    [ObservableProperty] private bool _showDiskIo;
    [ObservableProperty] private bool _showDiskSpace;
    [ObservableProperty] private bool _showPing;
    [ObservableProperty] private bool _showUptime;
    public ObservableCollection<DiskSpaceItemViewModel> DiskSpaces { get; } = new();
    partial void OnShowDownloadChanged(bool value) => Save(value, setting => setting.MonitorShowDownload = value);
    partial void OnShowUploadChanged(bool value) => Save(value, setting => setting.MonitorShowUpload = value);
    partial void OnShowMemoryChanged(bool value) => Save(value, setting => setting.MonitorShowMemory = value);
    partial void OnShowCpuChanged(bool value) => Save(value, setting => setting.MonitorShowCpu = value);
    partial void OnShowDiskIoChanged(bool value) => Save(value, setting => setting.MonitorShowDiskIo = value);
    partial void OnShowDiskSpaceChanged(bool value) => Save(value, setting => setting.MonitorShowDiskSpace = value);
    partial void OnShowPingChanged(bool value) => Save(value, setting => setting.MonitorShowPing = value);
    partial void OnShowUptimeChanged(bool value) => Save(value, setting => setting.MonitorShowUptime = value);
    private void Save(bool _, Action<Models.AppSettings> update) { update(_workspace.State.Settings); _workspace.MarkChanged(); }
    private async Task RefreshAsync()
    {
        var value = await _metrics.SampleAsync();
        CpuPercent = value.CpuPercent; MemoryPercent = value.MemoryPercent;
        MemoryText = $"{FormatBytes(value.UsedMemoryBytes)} / {FormatBytes(value.TotalMemoryBytes)}";
        DownloadText = FormatSpeed(value.DownloadBytesPerSecond); UploadText = FormatSpeed(value.UploadBytesPerSecond);
        DiskIoText = $"读取 {FormatSpeed(value.DiskReadBytesPerSecond)} / 写入 {FormatSpeed(value.DiskWriteBytesPerSecond)}";
        UpdateDiskSpaces(value.DiskSpaces);
        PingText = value.PingMilliseconds >= 0 ? $"{value.PingMilliseconds} ms" : "不可用";
        UptimeText = $"{(int)value.Uptime.TotalDays}天 {value.Uptime:hh\\:mm\\:ss}";
    }
    private void UpdateDiskSpaces(IReadOnlyList<DiskSpaceMetric> values)
    {
        for (var index = 0; index < values.Count; index++)
        {
            var value = values[index];
            var usedPercent = value.TotalBytes == 0 ? 0 : Math.Clamp((value.TotalBytes - value.FreeBytes) * 100d / value.TotalBytes, 0, 100);
            var item = new DiskSpaceItemViewModel(value.DriveName, $"{FormatBytes(value.FreeBytes)} 可用 / {FormatBytes(value.TotalBytes)}", usedPercent);
            if (index < DiskSpaces.Count)
            {
                if (DiskSpaces[index] != item) DiskSpaces[index] = item;
            }
            else DiskSpaces.Add(item);
        }
        while (DiskSpaces.Count > values.Count) DiskSpaces.RemoveAt(DiskSpaces.Count - 1);
        ShowDiskSpaceStatus = DiskSpaces.Count == 0;
        DiskSpaceStatusText = ShowDiskSpaceStatus ? "未检测到可用磁盘" : string.Empty;
    }
    private static string FormatBytes(ulong value) => value >= 1UL << 30 ? $"{value / (double)(1UL << 30):0.0} GB" : $"{value / (double)(1UL << 20):0.0} MB";
    private static string FormatSpeed(double value) => value >= 1024 * 1024 ? $"{value / 1024 / 1024:0.0} MB/s" : $"{value / 1024:0.0} KB/s";
    public void Dispose() => _timer.Stop();
}

public sealed record DiskSpaceItemViewModel(string DriveName, string SpaceText, double UsedPercent);
