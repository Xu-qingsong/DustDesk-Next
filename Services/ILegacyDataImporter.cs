using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public interface ILegacyDataImporter
{
    Task<bool> ImportAsync(WorkspaceState target, CancellationToken cancellationToken = default);
}
