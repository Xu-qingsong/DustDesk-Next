namespace DustDesk.Next.Services;

public interface ITrayService : IDisposable
{
    event Action? ShowRequested;
    event Action? ExitRequested;
    void ShowNotification(string title, string message);
}
