using System.Diagnostics;
using System.Text;
using System.Windows;
using DustDesk.Next.Models;
using DustDesk.Next.ViewModels;
using Microsoft.Win32;

namespace DustDesk.Next.Services;

public sealed class DataMaintenanceService : IDataMaintenanceService
{
    private readonly IAppStateStore _store;
    private readonly WorkspaceViewModel _workspace;
    private readonly IOrganizerService _organizer;
    private readonly IWidgetManager _widgets;
    private readonly BackupArchiveService _archives;
    private readonly SemaphoreSlim _operationLock = new(1, 1);

    public DataMaintenanceService(
        IAppStateStore store,
        WorkspaceViewModel workspace,
        IOrganizerService organizer,
        IWidgetManager widgets,
        BackupArchiveService archives)
    {
        _store = store;
        _workspace = workspace;
        _organizer = organizer;
        _widgets = widgets;
        _archives = archives;
    }

    public IReadOnlyList<RecoveryPointInfo> GetRecoveryPoints() => _archives.GetRecoveryPoints();

    public async Task<string?> BackupAsync()
    {
        var dialog = new SaveFileDialog
        {
            Title = "备份 DustDesk 数据",
            Filter = "DustDesk 备份文件|*.zip",
            FileName = $"DustDesk_Backup_{DateTime.Now:yyyyMMdd_HHmmss}.zip",
            AddExtension = true,
            DefaultExt = "zip"
        };
        if (dialog.ShowDialog() != true) return null;

        await _operationLock.WaitAsync();
        try
        {
            await _workspace.FlushAsync();
            await _archives.CreateArchiveAsync(dialog.FileName);
            return dialog.FileName;
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public async Task<bool> CreateAutomaticBackupAsync()
    {
        await _operationLock.WaitAsync();
        try
        {
            await _workspace.FlushAsync();
            return await _archives.CreateAutomaticAsync(DateTime.Now) is not null;
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public async Task CreateSafetyBackupAsync(RecoveryPointKind kind)
    {
        await _operationLock.WaitAsync();
        try
        {
            await _workspace.FlushAsync();
            await _archives.CreateSafetyAsync(kind, DateTime.Now);
        }
        finally
        {
            _operationLock.Release();
        }
    }

    public async Task<bool> RestoreAsync()
    {
        var dialog = new OpenFileDialog
        {
            Title = "恢复 DustDesk 备份",
            Filter = "DustDesk 备份文件|*.zip",
            CheckFileExists = true
        };
        if (dialog.ShowDialog() != true) return false;
        return await RestoreArchiveAsync(dialog.FileName, "恢复备份将替换当前数据，程序会先创建回滚恢复点。是否继续？");
    }

    public async Task<bool> RestoreRecoveryPointAsync(RecoveryPointInfo recoveryPoint)
    {
        var knownPoint = GetRecoveryPoints().FirstOrDefault(item =>
            string.Equals(Path.GetFullPath(item.FilePath), Path.GetFullPath(recoveryPoint.FilePath), StringComparison.OrdinalIgnoreCase));
        if (knownPoint is null || !File.Exists(knownPoint.FilePath)) return false;
        return await RestoreArchiveAsync(
            knownPoint.FilePath,
            $"将数据恢复到 {knownPoint.CreatedAt:yyyy-MM-dd HH:mm}，当前状态会先保存为回滚恢复点。是否继续？");
    }

    public async Task<bool> ResetAsync()
    {
        if (MessageBox.Show("这会清空全部任务、便签、项目和设置，并把收纳内容恢复到桌面。是否继续？", "重置数据", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return false;
        await _operationLock.WaitAsync();
        try
        {
            await _workspace.FlushAsync();
            await _archives.CreateSafetyAsync(RecoveryPointKind.BeforeReset, DateTime.Now);
            foreach (var category in _workspace.State.DesktopCategories.ToList()) _organizer.DeleteCategory(_workspace.State.DesktopCategories, category);
            _widgets.CloseAll(false);
            await _store.SaveAsync(WorkspaceDefaults.Create(includeStarterTodos: false, legacyImportCompleted: true));
            Restart();
            return true;
        }
        finally
        {
            _operationLock.Release();
        }
    }

    private async Task<bool> RestoreArchiveAsync(string archivePath, string confirmationText)
    {
        if (MessageBox.Show(confirmationText, "恢复备份", MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return false;

        await _operationLock.WaitAsync();
        var tempDirectory = Path.Combine(Path.GetTempPath(), $"DustDesk.Next.restore-{Guid.NewGuid():N}");
        RecoveryPointInfo? rollback = null;
        var dataReplaced = false;
        try
        {
            await _workspace.FlushAsync();
            rollback = await _archives.CreateSafetyAsync(RecoveryPointKind.BeforeRestore, DateTime.Now);
            await _archives.ExtractArchiveAsync(archivePath, tempDirectory);
            var workspacePath = Path.Combine(tempDirectory, "workspace.json");
            if (!File.Exists(workspacePath)) throw new InvalidDataException("备份中缺少 workspace.json。");
            await JsonAppStateStore.ReadAndValidateFileAsync(workspacePath);

            _widgets.CloseAll(false);
            ClearDirectory(_store.DataDirectory);
            dataReplaced = true;
            CopyDirectory(tempDirectory, _store.DataDirectory);
            Restart();
            return true;
        }
        catch (Exception restoreException)
        {
            if (!dataReplaced)
            {
                throw new InvalidOperationException("恢复未执行，当前数据未更改。", restoreException);
            }

            if (rollback is null)
            {
                throw new InvalidOperationException("恢复失败，当前数据可能已被更改，请从外部备份恢复。", restoreException);
            }

            try
            {
                ClearDirectory(_store.DataDirectory);
                await _archives.ExtractArchiveAsync(rollback.FilePath, _store.DataDirectory);
            }
            catch (Exception rollbackException)
            {
                throw new InvalidOperationException(
                    "恢复失败，自动回滚也未完成。请勿继续操作，并手动恢复“恢复操作前”的恢复点。",
                    new AggregateException(restoreException, rollbackException));
            }

            throw new InvalidOperationException("恢复失败，已自动回滚到操作前状态。", restoreException);
        }
        finally
        {
            TryDeleteDirectory(tempDirectory);
            _operationLock.Release();
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)), true);
        foreach (var directory in Directory.EnumerateDirectories(source)) CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
    }

    private static void ClearDirectory(string directory)
    {
        Directory.CreateDirectory(directory);
        foreach (var file in Directory.EnumerateFiles(directory))
        {
            File.SetAttributes(file, FileAttributes.Normal);
            File.Delete(file);
        }
        foreach (var child in Directory.EnumerateDirectories(directory)) Directory.Delete(child, true);
    }

    private static void Restart()
    {
        if (Environment.ProcessPath is { } path)
        {
            var script = Path.Combine(Path.GetTempPath(), $"DustDesk.Next.restart-{Guid.NewGuid():N}.cmd");
            File.WriteAllText(script, $"@echo off\r\ntimeout /t 2 /nobreak >nul\r\nstart \"\" \"{path}\"\r\ndel \"%~f0\"\r\n", new UTF8Encoding(false));
            Process.Start(new ProcessStartInfo(script) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
        }
        Application.Current.Shutdown();
    }

    private static void TryDeleteDirectory(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { }
    }
}
