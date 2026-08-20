namespace DustDesk.Next.Services;

public sealed record DiskSpaceMetric(
    string DriveName,
    ulong FreeBytes,
    ulong TotalBytes);

public sealed record SystemMetrics(
    double CpuPercent,
    double MemoryPercent,
    ulong UsedMemoryBytes,
    ulong TotalMemoryBytes,
    double DownloadBytesPerSecond,
    double UploadBytesPerSecond,
    double DiskReadBytesPerSecond,
    double DiskWriteBytesPerSecond,
    IReadOnlyList<DiskSpaceMetric> DiskSpaces,
    long PingMilliseconds,
    TimeSpan Uptime);

public interface ISystemMetricsService : IDisposable
{
    Task<SystemMetrics> SampleAsync(CancellationToken cancellationToken = default);
}
