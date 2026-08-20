using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public sealed record OrganizerEntry(string Name, string Path, bool IsDirectory);

public interface IOrganizerService
{
    IReadOnlyList<OrganizerEntry> GetDesktopEntries();
    bool SynchronizeCategories(ICollection<DesktopCategoryRecord> categories);
    string MoveIntoCategory(DesktopCategoryRecord category, string sourcePath);
    string RestoreToDesktop(DesktopCategoryRecord category, string sourcePath);
    void RenameCategory(DesktopCategoryRecord category, string newName);
    void DeleteCategory(ICollection<DesktopCategoryRecord> categories, DesktopCategoryRecord category);
}
