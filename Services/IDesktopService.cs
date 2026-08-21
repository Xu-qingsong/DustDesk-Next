namespace DustDesk.Next.Services;

public interface IDesktopService
{
    string? PickFile(string title, string filter = "所有文件|*.*");
    string? PickFolder(string title);
    string? PickFileOrFolder(string title);
    void Open(string path);
}
