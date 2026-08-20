using System.Windows;
using System.Windows.Controls;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class LinksView : UserControl
{
    public LinksView() => InitializeComponent();

    private void AddGroup_OnClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not LinksViewModel viewModel) return;
        var dialog = new LinkGroupEditorDialog(validate: name =>
            viewModel.Groups.Any(group => string.Equals(group.Name, name.Trim(), StringComparison.CurrentCultureIgnoreCase))
                ? "已存在同名分组。"
                : null)
        { Owner = Window.GetWindow(this) };
        if (dialog.ShowDialog() == true) viewModel.AddGroup(dialog.NameValue);
    }

    private void EditGroup_OnClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not LinksViewModel { SelectedGroup: { } group } viewModel)
        {
            if (DataContext is LinksViewModel missingGroup) missingGroup.ErrorText = "请选择要编辑的分组。";
            return;
        }

        var dialog = new LinkGroupEditorDialog(group.Name, name =>
            viewModel.Groups.Any(item => item != group && string.Equals(item.Name, name.Trim(), StringComparison.CurrentCultureIgnoreCase))
                ? "已存在同名分组。"
                : null)
        { Owner = Window.GetWindow(this) };
        if (dialog.ShowDialog() == true) viewModel.RenameGroup(group, dialog.NameValue);
    }

    private void AddLink_OnClick(object sender, RoutedEventArgs e)
    {
        if (DataContext is not LinksViewModel viewModel || viewModel.SelectedGroup is null)
        {
            if (DataContext is LinksViewModel missingGroup) missingGroup.ErrorText = "请先创建或选择分组。";
            return;
        }

        var dialog = new LinkEditorDialog(viewModel.Groups, viewModel.SelectedGroup);
        dialog.Owner = Window.GetWindow(this);
        if (dialog.ShowDialog() == true)
            viewModel.AddLink(dialog.NameValue, dialog.UrlValue, dialog.NoteValue, dialog.SelectedGroup);
    }

    private void EditLink_OnClick(object sender, RoutedEventArgs e)
    {
        e.Handled = true;
        if (sender is FrameworkElement { DataContext: LinkItemViewModel link }) ShowEditor(link);
    }

    private void EditLinkMenu_OnClick(object sender, RoutedEventArgs e)
    {
        if (sender is MenuItem { DataContext: LinkItemViewModel link }) ShowEditor(link);
    }

    private void ShowEditor(LinkItemViewModel link)
    {
        if (DataContext is not LinksViewModel viewModel) return;
        var ownerGroup = viewModel.Groups.FirstOrDefault(group => group.Links.Contains(link));
        if (ownerGroup is null) return;

        var dialog = new LinkEditorDialog(viewModel.Groups, ownerGroup, link);
        dialog.Owner = Window.GetWindow(this);
        if (dialog.ShowDialog() == true)
            viewModel.UpdateLink(link, dialog.NameValue, dialog.UrlValue, dialog.NoteValue, dialog.SelectedGroup);
    }
}
