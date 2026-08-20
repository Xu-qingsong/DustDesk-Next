using System.Globalization;
using System.IO.Compression;

namespace DustDesk.Next.Services;

public enum RecoveryPointKind
{
    Automatic,
    BeforeRestore,
    BeforeReset,
    BeforeUpdate
}

public sealed record RecoveryPointInfo(string FilePath, DateTime CreatedAt, long SizeBytes, RecoveryPointKind Kind);

public sealed class BackupArchiveService
{
    private const int DailyRetentionCount = 7;
    private const int WeeklyRetentionCount = 4;
    private const int SafetyRetentionCount = 5;
    private const string TimestampFormat = "yyyyMMdd-HHmmssfff";
    private readonly IAppStateStore _store;
    private readonly SemaphoreSlim _operationLock = new(1, 1);

    public BackupArchiveService(IAppStateStore store)
    {
        _store = store;
        BackupDirectory = Path.Combine(Path.GetDirectoryName(store.DataDirectory) ?? store.DataDirectory, "Backups");
    }

    public string BackupDirectory { get; }

    public IReadOnlyList<RecoveryPointInfo> GetRecoveryPoints()
    {
        if (!Directory.Exists(BackupDirectory)) return Array.Empty<RecoveryPointInfo>();
        return Directory.EnumerateFiles(BackupDirectory, "*.zip", SearchOption.TopDirectoryOnly)
            .Select(TryDescribe)
            .Where(item => item is not null)
            .Cast<RecoveryPointInfo>()
            .OrderByDescending(item => item.CreatedAt)
            .ToList();
    }

    public async Task<RecoveryPointInfo?> CreateAutomaticAsync(DateTime now, CancellationToken cancellationToken = default)
    {
        await _operationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (GetRecoveryPoints().Any(item => item.Kind == RecoveryPointKind.Automatic && item.CreatedAt.Date == now.Date)) return null;
            var point = await CreateRecoveryPointCoreAsync(RecoveryPointKind.Automatic, now, cancellationToken).ConfigureAwait(false);
            PruneAutomaticRecoveryPoints();
            return point;
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public async Task<RecoveryPointInfo> CreateSafetyAsync(RecoveryPointKind kind, DateTime now, CancellationToken cancellationToken = default)
    {
        if (kind == RecoveryPointKind.Automatic) throw new ArgumentOutOfRangeException(nameof(kind));
        await _operationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var point = await CreateRecoveryPointCoreAsync(kind, now, cancellationToken).ConfigureAwait(false);
            PruneSafetyRecoveryPoints(kind);
            return point;
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public async Task CreateArchiveAsync(string outputPath, CancellationToken cancellationToken = default)
    {
        await _operationLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            await CreateArchiveCoreAsync(outputPath, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public Task ExtractArchiveAsync(string archivePath, string targetDirectory, CancellationToken cancellationToken = default) =>
        Task.Run(() => ExtractArchive(archivePath, targetDirectory, cancellationToken), cancellationToken);

    private async Task<RecoveryPointInfo> CreateRecoveryPointCoreAsync(RecoveryPointKind kind, DateTime now, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(BackupDirectory);
        var prefix = PrefixFor(kind);
        var fileName = $"{prefix}-{now.ToString(TimestampFormat, CultureInfo.InvariantCulture)}-{Guid.NewGuid():N}.zip";
        var path = Path.Combine(BackupDirectory, fileName);
        await CreateArchiveCoreAsync(path, cancellationToken).ConfigureAwait(false);
        return new RecoveryPointInfo(path, now, new FileInfo(path).Length, kind);
    }

    private async Task CreateArchiveCoreAsync(string outputPath, CancellationToken cancellationToken)
    {
        var fullOutputPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullOutputPath)!);
        try
        {
            await Task.Run(() =>
            {
                using var stream = File.Create(fullOutputPath);
                using var archive = new ZipArchive(stream, ZipArchiveMode.Create);
                if (!Directory.Exists(_store.DataDirectory)) return;
                foreach (var file in Directory.EnumerateFiles(_store.DataDirectory, "*", SearchOption.AllDirectories))
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    if (string.Equals(Path.GetFullPath(file), fullOutputPath, StringComparison.OrdinalIgnoreCase) ||
                        file.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase)) continue;
                    archive.CreateEntryFromFile(file, Path.GetRelativePath(_store.DataDirectory, file).Replace('\\', '/'), CompressionLevel.Optimal);
                }
            }, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            try { if (File.Exists(fullOutputPath)) File.Delete(fullOutputPath); } catch { }
            throw;
        }
    }

    private static void ExtractArchive(string archivePath, string targetDirectory, CancellationToken cancellationToken)
    {
        Directory.CreateDirectory(targetDirectory);
        var targetRoot = Path.GetFullPath(targetDirectory).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(archivePath);
        foreach (var entry in archive.Entries)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var destination = Path.GetFullPath(Path.Combine(targetDirectory, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
            if (!destination.StartsWith(targetRoot, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Backup contains an invalid path.");
            if (string.IsNullOrWhiteSpace(entry.Name))
            {
                Directory.CreateDirectory(destination);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, true);
        }
    }

    private void PruneAutomaticRecoveryPoints()
    {
        var automatic = GetRecoveryPoints().Where(item => item.Kind == RecoveryPointKind.Automatic).ToList();
        var dailyGroups = automatic.GroupBy(item => item.CreatedAt.Date).OrderByDescending(group => group.Key).ToList();
        var dailyKeep = dailyGroups.Take(DailyRetentionCount).Select(group => group.OrderByDescending(item => item.CreatedAt).First()).ToList();
        var oldestDailyDate = dailyKeep.Count == 0 ? DateTime.MaxValue : dailyKeep.Min(item => item.CreatedAt.Date);
        var weeklyKeep = automatic.Where(item => item.CreatedAt.Date < oldestDailyDate)
            .GroupBy(item => StartOfWeek(item.CreatedAt.Date))
            .OrderByDescending(group => group.Key)
            .Take(WeeklyRetentionCount)
            .Select(group => group.OrderByDescending(item => item.CreatedAt).First());
        var keep = dailyKeep.Concat(weeklyKeep).Select(item => Path.GetFullPath(item.FilePath)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var item in automatic.Where(item => !keep.Contains(Path.GetFullPath(item.FilePath)))) TryDelete(item.FilePath);
    }

    private void PruneSafetyRecoveryPoints(RecoveryPointKind kind)
    {
        foreach (var item in GetRecoveryPoints().Where(item => item.Kind == kind).Skip(SafetyRetentionCount)) TryDelete(item.FilePath);
    }

    private static RecoveryPointInfo? TryDescribe(string path)
    {
        var fileName = Path.GetFileNameWithoutExtension(path);
        var kind = Enum.GetValues<RecoveryPointKind>().FirstOrDefault(value => fileName.StartsWith(PrefixFor(value) + "-", StringComparison.OrdinalIgnoreCase));
        var prefix = PrefixFor(kind) + "-";
        if (!fileName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) return null;
        var timestampText = fileName[prefix.Length..];
        if (timestampText.Length < TimestampFormat.Length ||
            !DateTime.TryParseExact(timestampText[..TimestampFormat.Length], TimestampFormat, CultureInfo.InvariantCulture, DateTimeStyles.None, out var createdAt))
        {
            createdAt = File.GetLastWriteTime(path);
        }
        return new RecoveryPointInfo(path, createdAt, new FileInfo(path).Length, kind);
    }

    private static string PrefixFor(RecoveryPointKind kind) => kind switch
    {
        RecoveryPointKind.Automatic => "auto",
        RecoveryPointKind.BeforeRestore => "before-restore",
        RecoveryPointKind.BeforeReset => "before-reset",
        RecoveryPointKind.BeforeUpdate => "before-update",
        _ => throw new ArgumentOutOfRangeException(nameof(kind))
    };

    private static DateTime StartOfWeek(DateTime date)
    {
        var daysSinceMonday = ((int)date.DayOfWeek + 6) % 7;
        return date.AddDays(-daysSinceMonday);
    }

    private static void TryDelete(string path)
    {
        try { File.Delete(path); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}
