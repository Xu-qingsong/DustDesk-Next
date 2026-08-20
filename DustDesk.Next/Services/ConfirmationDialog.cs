using System.Windows;

namespace DustDesk.Next.Services;

public static class ConfirmationDialog
{
    public static bool ConfirmDelete(string target) => Confirm("删除确认", $"确定要删除{target}吗？");

    public static bool Confirm(string title, string message)
    {
        var owner = Application.Current?.MainWindow;
        return MessageBox.Show(owner, message, title, MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK;
    }

}
