using System.Windows;
using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public interface IClipboardMonitorService : IDisposable
{
    event Action<ClipboardRecord>? Captured;
    void Start(Window window);
    void Stop();
}
