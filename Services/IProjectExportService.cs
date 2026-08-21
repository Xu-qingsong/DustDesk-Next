using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public interface IProjectExportService
{
    string? Export(IReadOnlyCollection<ProjectRecord> projects);
}
