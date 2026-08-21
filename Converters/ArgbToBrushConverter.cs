using System.Globalization;
using System.Windows.Data;
using System.Windows.Media;

namespace DustDesk.Next.Converters;

public sealed class ArgbToBrushConverter : IValueConverter
{
    public object Convert(object value, Type targetType, object parameter, CultureInfo culture)
    {
        if (value is not int argb)
        {
            return Brushes.Transparent;
        }

        var unsigned = unchecked((uint)argb);
        return new SolidColorBrush(Color.FromArgb(
            (byte)(unsigned >> 24),
            (byte)(unsigned >> 16),
            (byte)(unsigned >> 8),
            (byte)unsigned));
    }

    public object ConvertBack(object value, Type targetType, object parameter, CultureInfo culture) => Binding.DoNothing;
}
