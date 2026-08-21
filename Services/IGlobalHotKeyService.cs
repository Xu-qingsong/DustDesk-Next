using System.Windows;

namespace DustDesk.Next.Services;

public interface IGlobalHotKeyService : IDisposable
{
    event Action<int>? Pressed;
    bool Register(Window window, int id, string shortcut);
    void Unregister(int id);
}
