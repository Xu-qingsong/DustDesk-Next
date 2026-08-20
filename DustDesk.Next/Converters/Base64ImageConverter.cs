using System.Globalization;
using System.Windows.Data;
using System.Windows.Media.Imaging;

namespace DustDesk.Next.Converters;

public sealed class Base64ImageConverter : IValueConverter
{
    public object? Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not string text || string.IsNullOrWhiteSpace(text)) return null;
        try { var bytes = System.Convert.FromBase64String(text); using var stream = new MemoryStream(bytes); return BitmapFrame.Create(stream, BitmapCreateOptions.PreservePixelFormat, BitmapCacheOption.OnLoad); }
        catch (FormatException) { return null; }
    }
    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;
}
