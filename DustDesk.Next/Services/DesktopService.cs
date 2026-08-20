using System.Diagnostics;
using System.IO;
using Microsoft.Win32;

namespace DustDesk.Next.Services;

public sealed class DesktopService : IDesktopService
{
    public string? PickFile(string title, string filter = "所有文件|*.*")
    {
        var dialog = new OpenFileDialog { Title = title, Filter = filter, CheckFileExists = true };
        return dialog.ShowDialog() == true ? dialog.FileName : null;
    }

    public string? PickFolder(string title)
    {
        var dialog = new OpenFolderDialog { Title = title, Multiselect = false };
        return dialog.ShowDialog() == true ? dialog.FolderName : null;
    }

    public string? PickFileOrFolder(string title)
    {
        var choice = System.Windows.MessageBox.Show(
            "选择“是”关联文件夹，选择“否”关联文件。",
            title,
            System.Windows.MessageBoxButton.YesNoCancel,
            System.Windows.MessageBoxImage.Question);
        return choice switch
        {
            System.Windows.MessageBoxResult.Yes => PickFolder(title),
            System.Windows.MessageBoxResult.No => PickFile(title),
            _ => null
        };
    }

    public void Open(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }

        if (Uri.TryCreate(path, UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true });
            return;
        }

        if (!File.Exists(path) && !Directory.Exists(path)) return;

        Process.Start(new ProcessStartInfo(path) { UseShellExecute = true });
    }
}
