using System.Text.Json;
using System.IO;
using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public sealed class JsonAppStateStore : IAppStateStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    private readonly SemaphoreSlim _writeLock = new(1, 1);

    public JsonAppStateStore()
    {
        DataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DustDesk.Next",
            "Data");
        DataFilePath = Path.Combine(DataDirectory, "workspace.json");
    }

    private JsonAppStateStore(string dataDirectory)
    {
        DataDirectory = Path.GetFullPath(dataDirectory);
        DataFilePath = Path.Combine(DataDirectory, "workspace.json");
    }

    public static JsonAppStateStore CreateForDirectory(string dataDirectory) => new(dataDirectory);

    public string DataFilePath { get; }
    public string DataDirectory { get; }
    private string BackupFilePath => DataFilePath + ".bak";

    public async Task<WorkspaceState> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (!File.Exists(DataFilePath))
        {
            return CreateInitialState();
        }

        try
        {
            return await ReadAndValidateFileAsync(DataFilePath, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is JsonException or InvalidDataException)
        {
            // Keep every failed load for diagnostics; startup retries can happen within one second.
            var corruptPath = $"{DataFilePath}.corrupt-{DateTime.Now:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}";
            File.Move(DataFilePath, corruptPath);
            if (File.Exists(BackupFilePath))
            {
                try { return await ReadAndValidateFileAsync(BackupFilePath, cancellationToken).ConfigureAwait(false); }
                catch (Exception backupException) when (backupException is JsonException or InvalidDataException) { }
            }
            return CreateInitialState();
        }
    }

    public async Task SaveAsync(WorkspaceState state, CancellationToken cancellationToken = default)
    {
        await _writeLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var directory = Path.GetDirectoryName(DataFilePath)!;
            Directory.CreateDirectory(directory);

            var tempPath = $"{DataFilePath}.tmp";
            await using (var stream = File.Create(tempPath))
            {
                await JsonSerializer.SerializeAsync(stream, state, JsonOptions, cancellationToken).ConfigureAwait(false);
            }

            await ReadAndValidateFileAsync(tempPath, cancellationToken).ConfigureAwait(false);
            if (File.Exists(DataFilePath)) File.Replace(tempPath, DataFilePath, BackupFilePath, ignoreMetadataErrors: true);
            else File.Move(tempPath, DataFilePath);
        }
        finally
        {
            var tempPath = $"{DataFilePath}.tmp";
            try { if (File.Exists(tempPath)) File.Delete(tempPath); } catch { }
            _writeLock.Release();
        }
    }

    public static async Task<WorkspaceState> ReadAndValidateFileAsync(string path, CancellationToken cancellationToken = default)
    {
        await using var stream = File.OpenRead(path);
        var state = await JsonSerializer.DeserializeAsync<WorkspaceState>(stream, JsonOptions, cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidDataException("工作区数据为空。");
        Validate(state);
        WorkspaceDefaults.Ensure(state);
        return state;
    }

    private static void Validate(WorkspaceState state)
    {
        if (state.SchemaVersion is < 1 or > 2) throw new InvalidDataException($"不支持的数据版本：{state.SchemaVersion}。");
        if (state.Settings is null || state.Todos is null || state.TagPresets is null || state.Notes is null || state.Projects is null ||
            state.Launchers is null || state.LinkGroups is null || state.ClipboardHistory is null || state.DesktopCategories is null)
            throw new InvalidDataException("工作区缺少必要的数据集合。");
        if (state.LinkGroups.Any(group => group is null || group.Links is null) ||
            state.Projects.Any(project => project is null || project.Phases is null || project.Phases.Any(phase => phase is null || phase.Subtasks is null)) ||
            state.DesktopCategories.Any(category => category is null || category.ItemPaths is null))
            throw new InvalidDataException("工作区包含无效的嵌套数据。");
    }

    private static WorkspaceState CreateInitialState() => WorkspaceDefaults.Create(includeStarterTodos: true);
}
