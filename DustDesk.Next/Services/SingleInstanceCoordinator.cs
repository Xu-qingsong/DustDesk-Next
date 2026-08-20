namespace DustDesk.Next.Services;

public sealed class SingleInstanceCoordinator : IDisposable
{
    private readonly string _eventName;
    private readonly Mutex _mutex;
    private readonly EventWaitHandle? _activationEvent;
    private readonly Action _activate;
    private volatile bool _stopping;

    public SingleInstanceCoordinator(string scope, Action activate)
    {
        _activate = activate;
        var safeScope = string.Concat(scope.Select(character => char.IsLetterOrDigit(character) || character is '.' or '-' ? character : '_'));
        _eventName = $"Local\\{safeScope}.Activate";
        _mutex = new Mutex(true, $"Local\\{safeScope}.SingleInstance", out var createdNew);
        IsPrimary = createdNew;
        if (!IsPrimary) return;
        _activationEvent = new EventWaitHandle(false, EventResetMode.AutoReset, _eventName);
        _ = Task.Run(Listen);
    }

    public bool IsPrimary { get; }

    public bool SignalExisting()
    {
        if (IsPrimary) return false;
        try { using var signal = EventWaitHandle.OpenExisting(_eventName); return signal.Set(); }
        catch (WaitHandleCannotBeOpenedException) { return false; }
    }

    private void Listen()
    {
        while (!_stopping)
        {
            try { _activationEvent?.WaitOne(); }
            catch (ObjectDisposedException) { break; }
            if (!_stopping) _activate();
        }
    }

    public void Dispose()
    {
        _stopping = true;
        _activationEvent?.Set();
        _activationEvent?.Dispose();
        _mutex.Dispose();
    }
}
