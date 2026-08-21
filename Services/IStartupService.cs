namespace DustDesk.Next.Services;

public interface IStartupService
{
    bool IsEnabled { get; }
    void SetEnabled(bool enabled);
}
