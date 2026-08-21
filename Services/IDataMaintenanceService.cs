namespace DustDesk.Next.Services;

public interface IDataMaintenanceService
{
    Task<string?> BackupAsync();
    Task<bool> CreateAutomaticBackupAsync();
    Task CreateSafetyBackupAsync(RecoveryPointKind kind);
    IReadOnlyList<RecoveryPointInfo> GetRecoveryPoints();
    Task<bool> RestoreAsync();
    Task<bool> RestoreRecoveryPointAsync(RecoveryPointInfo recoveryPoint);
    Task<bool> ResetAsync();
}
