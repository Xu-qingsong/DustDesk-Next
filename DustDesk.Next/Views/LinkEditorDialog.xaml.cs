using System.Collections.Generic;
using System.Windows;
using DustDesk.Next.ViewModels;

namespace DustDesk.Next.Views;

public partial class LinkEditorDialog : Wpf.Ui.Controls.FluentWindow
{
    public LinkEditorDialog(IEnumerable<LinkGroupViewModel> groups, LinkGroupViewModel selectedGroup, LinkItemViewModel? link = null)
    {
        InitializeComponent();
        GroupBox.ItemsSource = groups;
        GroupBox.SelectedItem = selectedGroup;
        if (link is null) return;

        Title = "编辑链接";
        DialogTitle.Text = "编辑链接";
        NameBox.Text = link.Name;
        UrlBox.Text = link.Url;
        NoteBox.Text = link.Note;
    }

    public string NameValue => NameBox.Text.Trim();
    public string UrlValue { get; private set; } = string.Empty;
    public string NoteValue => NoteBox.Text.Trim();
    public LinkGroupViewModel SelectedGroup => (LinkGroupViewModel)GroupBox.SelectedItem;

    private void Save_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(NameValue))
        {
            ErrorText.Text = "请输入链接名称。";
            NameBox.Focus();
            return;
        }

        if (!LinksViewModel.TryNormalizeUrl(UrlBox.Text, out var normalized))
        {
            ErrorText.Text = "网址格式无效，请输入 HTTP 或 HTTPS 地址。";
            UrlBox.Focus();
            return;
        }

        if (GroupBox.SelectedItem is null)
        {
            ErrorText.Text = "请选择分类。";
            return;
        }

        UrlValue = normalized;
        DialogResult = true;
    }
}
