using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Data;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace DustDesk.Next.Converters;

public sealed class FileIconConverter : IValueConverter
{
    private readonly Dictionary<string, ImageSource> _cache = new(StringComparer.OrdinalIgnoreCase);
    public object? Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not string path || string.IsNullOrWhiteSpace(path)) return null;
        if (_cache.TryGetValue(path, out var cached)) return cached;
        var result = SHGetFileInfo(path, 0, out var info, (uint)Marshal.SizeOf<ShellFileInfo>(), 0x100 | 0x1);
        if (result == IntPtr.Zero || info.Icon == IntPtr.Zero) return null;
        try
        {
            var source = Imaging.CreateBitmapSourceFromHIcon(info.Icon, Int32Rect.Empty, BitmapSizeOptions.FromWidthAndHeight(32, 32));
            source.Freeze(); _cache[path] = source; return source;
        }
        finally { DestroyIcon(info.Icon); }
    }
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ShellFileInfo { public IntPtr Icon; public int IconIndex; public uint Attributes; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string DisplayName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string TypeName; }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SHGetFileInfo(string path, uint attributes, out ShellFileInfo info, uint size, uint flags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
}
