using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public interface IAppStateStore
{
    string DataFilePath { get; }
    string DataDirectory { get; }
    Task<WorkspaceState> LoadAsync(CancellationToken cancellationToken = default);
    Task SaveAsync(WorkspaceState state, CancellationToken cancellationToken = default);
}
