using System.Windows;

namespace DustDesk.Next.Views;

public partial class LinkGroupEditorDialog : Wpf.Ui.Controls.FluentWindow
{
    private readonly Func<string, string?>? _validate;

    public LinkGroupEditorDialog(string? currentName = null, Func<string, string?>? validate = null)
    {
        InitializeComponent();
        _validate = validate;
        var isEditing = !string.IsNullOrWhiteSpace(currentName);
        Title = isEditing ? "编辑分组" : "新增分组";
        DialogTitle.Text = Title;
        NameBox.Text = currentName ?? string.Empty;
        Loaded += (_, _) => { NameBox.Focus(); NameBox.SelectAll(); };
    }

    public string NameValue => NameBox.Text.Trim();

    private void Save_OnClick(object sender, RoutedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(NameValue))
        {
            ErrorText.Text = "请输入分组名称。";
            NameBox.Focus();
            return;
        }

        if (_validate?.Invoke(NameValue) is { Length: > 0 } validationError)
        {
            ErrorText.Text = validationError;
            NameBox.Focus();
            NameBox.SelectAll();
            return;
        }

        DialogResult = true;
    }
}
