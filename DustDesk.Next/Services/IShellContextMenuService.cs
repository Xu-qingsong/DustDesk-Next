namespace DustDesk.Next.Services;

public interface IShellContextMenuService
{
    bool ShowForPath(string path);
    bool ShowDesktopBackground();
}
