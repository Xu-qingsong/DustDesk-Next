using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace DustDesk.Next.Controls;

public sealed class AsyncFileIcon : Image
{
    public static readonly DependencyProperty PathProperty = DependencyProperty.Register(
        nameof(Path),
        typeof(string),
        typeof(AsyncFileIcon),
        new PropertyMetadata(null, OnPathChanged));

    private int _requestVersion;

    public string? Path
    {
        get => (string?)GetValue(PathProperty);
        set => SetValue(PathProperty, value);
    }

    private static void OnPathChanged(DependencyObject dependencyObject, DependencyPropertyChangedEventArgs args)
    {
        var image = (AsyncFileIcon)dependencyObject;
        image.Source = null;
        var path = args.NewValue as string;
        var requestVersion = ++image._requestVersion;
        if (!string.IsNullOrWhiteSpace(path)) _ = image.LoadAsync(path, requestVersion);
    }

    private async Task LoadAsync(string path, int requestVersion)
    {
        var source = await FileIconLoader.GetAsync(path).ConfigureAwait(false);
        if (Dispatcher.HasShutdownStarted) return;

        await Dispatcher.InvokeAsync(() =>
        {
            if (requestVersion == _requestVersion && string.Equals(path, Path, StringComparison.OrdinalIgnoreCase)) Source = source;
        });
    }
}

internal static class FileIconLoader
{
    private const uint ShgfiIcon = 0x100;
    private const uint ShgfiSmallIcon = 0x1;
    private static readonly SemaphoreSlim LoadGate = new(1);
    private static readonly ConcurrentDictionary<string, Lazy<Task<ImageSource?>>> Cache = new(StringComparer.OrdinalIgnoreCase);

    public static Task<ImageSource?> GetAsync(string path) => Cache.GetOrAdd(
        path,
        static value => new Lazy<Task<ImageSource?>>(
            () => LoadAsync(value),
            LazyThreadSafetyMode.ExecutionAndPublication)).Value;

    private static async Task<ImageSource?> LoadAsync(string path)
    {
        await LoadGate.WaitAsync().ConfigureAwait(false);
        try
        {
            return await Task.Run(() => Extract(path)).ConfigureAwait(false);
        }
        catch (Exception)
        {
            return null;
        }
        finally
        {
            LoadGate.Release();
        }
    }

    private static ImageSource? Extract(string path)
    {
        var result = SHGetFileInfo(path, 0, out var info, (uint)Marshal.SizeOf<ShellFileInfo>(), ShgfiIcon | ShgfiSmallIcon);
        if (result == IntPtr.Zero || info.Icon == IntPtr.Zero) return null;
        try
        {
            var source = Imaging.CreateBitmapSourceFromHIcon(info.Icon, Int32Rect.Empty, BitmapSizeOptions.FromWidthAndHeight(32, 32));
            source.Freeze();
            return source;
        }
        finally
        {
            DestroyIcon(info.Icon);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ShellFileInfo
    {
        public IntPtr Icon;
        public int IconIndex;
        public uint Attributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string TypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SHGetFileInfo(string path, uint attributes, out ShellFileInfo info, uint size, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);
}
