using System.IO;
using System.IO.Compression;
using DustDesk.Next.Models;
using DustDesk.Next.Services;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class BackupArchiveServiceTests
{
    [Fact]
    public async Task AutomaticRecoveryPointIsCreatedOnlyOncePerDay()
    {
        using var scope = new BackupTestScope();
        scope.WriteData("workspace.json", "{}");
        var service = scope.CreateService();
        var morning = new DateTime(2026, 7, 23, 8, 30, 0);

        var first = await service.CreateAutomaticAsync(morning);
        var second = await service.CreateAutomaticAsync(morning.AddHours(9));

        Assert.NotNull(first);
        Assert.Null(second);
        Assert.Single(service.GetRecoveryPoints(), point => point.Kind == RecoveryPointKind.Automatic);
    }

    [Fact]
    public async Task ArchiveIncludesWorkspaceAndNestedAssets()
    {
        using var scope = new BackupTestScope();
        scope.WriteData("workspace.json", "{\"schemaVersion\":2}");
        scope.WriteData(Path.Combine("assets", "previews", "sample.txt"), "asset");
        var service = scope.CreateService();
        var archivePath = Path.Combine(scope.RootDirectory, "manual.zip");

        await service.CreateArchiveAsync(archivePath);

        using var archive = ZipFile.OpenRead(archivePath);
        var entries = archive.Entries.Select(entry => entry.FullName).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Assert.Contains("workspace.json", entries);
        Assert.Contains("assets/previews/sample.txt", entries);
    }

    [Fact]
    public async Task AutomaticRetentionKeepsSevenDailyAndFourOlderWeeklyPoints()
    {
        using var scope = new BackupTestScope();
        scope.WriteData("workspace.json", "{}");
        var service = scope.CreateService();
        var firstDay = new DateTime(2026, 5, 1, 9, 0, 0);

        for (var offset = 0; offset < 42; offset++)
        {
            await service.CreateAutomaticAsync(firstDay.AddDays(offset));
        }

        var points = service.GetRecoveryPoints().Where(point => point.Kind == RecoveryPointKind.Automatic).ToList();
        var latestDay = firstDay.AddDays(41).Date;
        var recentDates = Enumerable.Range(0, 7).Select(offset => latestDay.AddDays(-offset)).ToHashSet();
        var daily = points.Where(point => recentDates.Contains(point.CreatedAt.Date)).ToList();
        var weekly = points.Where(point => !recentDates.Contains(point.CreatedAt.Date)).ToList();

        Assert.Equal(11, points.Count);
        Assert.Equal(7, daily.Count);
        Assert.Equal(4, weekly.Count);
        Assert.All(recentDates, date => Assert.Contains(daily, point => point.CreatedAt.Date == date));
        Assert.All(weekly, point => Assert.True(point.CreatedAt.Date < latestDay.AddDays(-6)));
        Assert.Equal(4, weekly.Select(point => StartOfWeek(point.CreatedAt.Date)).Distinct().Count());
    }

    [Fact]
    public async Task SafetyRetentionKeepsFivePointsForEachOperationKind()
    {
        using var scope = new BackupTestScope();
        scope.WriteData("workspace.json", "{}");
        var service = scope.CreateService();
        var start = new DateTime(2026, 7, 23, 10, 0, 0);
        var kinds = new[]
        {
            RecoveryPointKind.BeforeRestore,
            RecoveryPointKind.BeforeReset,
            RecoveryPointKind.BeforeUpdate
        };

        foreach (var kind in kinds)
        {
            for (var offset = 0; offset < 8; offset++)
            {
                await service.CreateSafetyAsync(kind, start.AddMinutes(offset));
            }
        }

        var points = service.GetRecoveryPoints();
        Assert.All(kinds, kind => Assert.Equal(5, points.Count(point => point.Kind == kind)));
        Assert.Equal(15, points.Count);
    }

    [Fact]
    public async Task ExtractionRejectsPathsOutsideTargetDirectory()
    {
        using var scope = new BackupTestScope();
        var service = scope.CreateService();
        var archivePath = Path.Combine(scope.RootDirectory, "unsafe.zip");
        using (var archive = ZipFile.Open(archivePath, ZipArchiveMode.Create))
        {
            var entry = archive.CreateEntry("../outside.txt");
            await using var writer = new StreamWriter(entry.Open());
            await writer.WriteAsync("unsafe");
        }
        var targetDirectory = Path.Combine(scope.RootDirectory, "restore");
        var outsidePath = Path.Combine(scope.RootDirectory, "outside.txt");

        await Assert.ThrowsAsync<InvalidDataException>(() => service.ExtractArchiveAsync(archivePath, targetDirectory));

        Assert.False(File.Exists(outsidePath));
    }

    private static DateTime StartOfWeek(DateTime date)
    {
        var daysSinceMonday = ((int)date.DayOfWeek + 6) % 7;
        return date.AddDays(-daysSinceMonday);
    }

    private sealed class BackupTestScope : IDisposable
    {
        public BackupTestScope()
        {
            RootDirectory = Path.Combine(Path.GetTempPath(), "DustDesk.Next.Tests", "BackupArchive", Guid.NewGuid().ToString("N"));
            DataDirectory = Path.Combine(RootDirectory, "Data");
            Directory.CreateDirectory(DataDirectory);
        }

        public string RootDirectory { get; }
        public string DataDirectory { get; }

        public BackupArchiveService CreateService() => new(new TestStateStore(DataDirectory));

        public void WriteData(string relativePath, string content)
        {
            var path = Path.Combine(DataDirectory, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, content);
        }

        public void Dispose()
        {
            try { if (Directory.Exists(RootDirectory)) Directory.Delete(RootDirectory, true); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
        }
    }

    private sealed class TestStateStore(string dataDirectory) : IAppStateStore
    {
        public string DataFilePath => Path.Combine(DataDirectory, "workspace.json");
        public string DataDirectory { get; } = dataDirectory;
        public Task<WorkspaceState> LoadAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task SaveAsync(WorkspaceState state, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
