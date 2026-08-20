namespace DustDesk.Next.Services;

public sealed record AppUpdateInfo(string Version, string ReleaseUrl, string? DownloadUrl, string? ChecksumUrl = null);
public interface IUpdateService
{
    string CurrentVersion { get; }
    Task<AppUpdateInfo?> CheckAsync(CancellationToken cancellationToken = default);
    Task InstallAsync(AppUpdateInfo update, IProgress<int>? progress = null, CancellationToken cancellationToken = default);
}
