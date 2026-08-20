using System.Collections.ObjectModel;
using System.ComponentModel;
using CommunityToolkit.Mvvm.ComponentModel;
using CommunityToolkit.Mvvm.Input;
using DustDesk.Next.Models;
using DustDesk.Next.Services;

namespace DustDesk.Next.ViewModels;

public partial class LinksViewModel : ObservableObject
{
    private readonly IDesktopService _desktop;
    private readonly IWidgetManager _widgets;

    public LinksViewModel(WorkspaceViewModel workspace, IDesktopService desktop, IWidgetManager widgets)
    {
        Workspace = workspace;
        _desktop = desktop;
        _widgets = widgets;
        foreach (var record in workspace.State.LinkGroups) AddWrapped(record);
        SelectedGroup = Groups.FirstOrDefault();
    }

    public WorkspaceViewModel Workspace { get; }
    public ObservableCollection<LinkGroupViewModel> Groups { get; } = new();

    [ObservableProperty] private LinkGroupViewModel? _selectedGroup;
    [ObservableProperty] private LinkItemViewModel? _selectedLink;
    [ObservableProperty] private LinkGroupViewModel? _moveTargetGroup;
    [ObservableProperty] private string _newGroupName = string.Empty;
    [ObservableProperty] private string _errorText = string.Empty;

    partial void OnSelectedGroupChanged(LinkGroupViewModel? value)
    {
        SelectedLink = value?.Links.FirstOrDefault();
        MoveTargetGroup = value;
    }

    [RelayCommand]
    private void AddGroup()
    {
        if (AddGroup(NewGroupName)) NewGroupName = string.Empty;
    }

    public bool AddGroup(string name)
    {
        name = name.Trim();
        if (string.IsNullOrWhiteSpace(name)) { ErrorText = "请输入分组名称。"; return false; }
        if (Groups.Any(item => string.Equals(item.Name, name, StringComparison.CurrentCultureIgnoreCase))) { ErrorText = "已存在同名分组。"; return false; }
        var record = new LinkGroupRecord { Name = name };
        Workspace.State.LinkGroups.Add(record);
        SelectedGroup = AddWrapped(record);
        ErrorText = string.Empty;
        Workspace.MarkChanged();
        return true;
    }

    public bool RenameGroup(LinkGroupViewModel? group, string name)
    {
        name = name.Trim();
        if (group is null || !Groups.Contains(group)) { ErrorText = "请选择要编辑的分组。"; return false; }
        if (string.IsNullOrWhiteSpace(name)) { ErrorText = "请输入分组名称。"; return false; }
        if (Groups.Any(item => item != group && string.Equals(item.Name, name, StringComparison.CurrentCultureIgnoreCase)))
        {
            ErrorText = "已存在同名分组。";
            return false;
        }

        group.Name = name;
        ErrorText = string.Empty;
        Workspace.MarkChanged();
        return true;
    }

    [RelayCommand]
    private void DeleteGroup(LinkGroupViewModel? group)
    {
        group ??= SelectedGroup;
        if (group is null || !ConfirmationDialog.Confirm("删除分组", $"确定要删除“{group.Name}”及其中全部网址吗？")) return;
        foreach (var link in group.Links) link.PropertyChanged -= OnItemChanged;
        group.PropertyChanged -= OnItemChanged;
        Groups.Remove(group);
        Workspace.State.LinkGroups.Remove(group.Record);
        SelectedGroup = Groups.FirstOrDefault();
        ErrorText = string.Empty;
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void AddLink()
    {
        if (SelectedGroup is null) { ErrorText = "请先创建或选择分组。"; return; }
        var record = new LinkRecord { Name = "新链接", Url = "https://" };
        SelectedGroup.Record.Links.Add(record);
        var item = new LinkItemViewModel(record);
        item.PropertyChanged += OnItemChanged;
        SelectedGroup.Links.Add(item);
        SelectedLink = item;
        MoveTargetGroup = SelectedGroup;
        ErrorText = string.Empty;
        Workspace.MarkChanged();
    }

    public bool AddLink(string name, string url, string note, LinkGroupViewModel? group = null)
    {
        group ??= SelectedGroup;
        name = name.Trim();
        if (group is null) { ErrorText = "请先创建或选择分组。"; return false; }
        if (string.IsNullOrWhiteSpace(name)) { ErrorText = "请输入链接名称。"; return false; }
        if (!TryNormalizeUrl(url, out var normalized)) { ErrorText = "网址格式无效，请输入 HTTP 或 HTTPS 地址。"; return false; }

        var record = new LinkRecord { Name = name, Url = normalized, Note = note.Trim() };
        group.Record.Links.Add(record);
        var item = new LinkItemViewModel(record);
        item.PropertyChanged += OnItemChanged;
        group.Links.Add(item);
        SelectedGroup = group;
        SelectedLink = item;
        MoveTargetGroup = group;
        ErrorText = string.Empty;
        Workspace.MarkChanged();
        return true;
    }

    public bool UpdateLink(LinkItemViewModel link, string name, string url, string note, LinkGroupViewModel targetGroup)
    {
        var owner = Groups.FirstOrDefault(group => group.Links.Contains(link));
        name = name.Trim();
        if (owner is null || !Groups.Contains(targetGroup)) { ErrorText = "链接所属分组不存在。"; return false; }
        if (string.IsNullOrWhiteSpace(name)) { ErrorText = "请输入链接名称。"; return false; }
        if (!TryNormalizeUrl(url, out var normalized)) { ErrorText = "网址格式无效，请输入 HTTP 或 HTTPS 地址。"; return false; }

        link.Name = name;
        link.Url = normalized;
        link.Note = note.Trim();
        if (owner != targetGroup)
        {
            owner.Links.Remove(link);
            owner.Record.Links.Remove(link.Record);
            targetGroup.Links.Add(link);
            targetGroup.Record.Links.Add(link.Record);
        }

        SelectedGroup = targetGroup;
        SelectedLink = link;
        MoveTargetGroup = targetGroup;
        ErrorText = string.Empty;
        Workspace.MarkChanged();
        return true;
    }

    [RelayCommand]
    private void DeleteLink(LinkItemViewModel? link)
    {
        link ??= SelectedLink;
        var owner = link is null ? null : Groups.FirstOrDefault(group => group.Links.Contains(link));
        if (link is null || owner is null || !ConfirmationDialog.ConfirmDelete("这个网址")) return;
        link.PropertyChanged -= OnItemChanged;
        owner.Links.Remove(link);
        owner.Record.Links.Remove(link.Record);
        if (SelectedLink == link) SelectedLink = SelectedGroup?.Links.FirstOrDefault();
        ErrorText = string.Empty;
        Workspace.MarkChanged();
    }

    [RelayCommand]
    private void OpenLink(LinkItemViewModel? link)
    {
        link ??= SelectedLink;
        if (link is null) return;
        if (!TryNormalizeUrl(link.Url, out var normalized)) { ErrorText = "网址格式无效，请输入 HTTP 或 HTTPS 地址。"; return; }
        if (!string.Equals(link.Url, normalized, StringComparison.Ordinal)) link.Url = normalized;
        ErrorText = string.Empty;
        _desktop.Open(normalized);
    }

    [RelayCommand]
    private void MoveSelectedLink()
    {
        if (SelectedGroup is null || SelectedLink is null || MoveTargetGroup is null || MoveTargetGroup == SelectedGroup) return;
        var link = SelectedLink;
        SelectedGroup.Links.Remove(link);
        SelectedGroup.Record.Links.Remove(link.Record);
        MoveTargetGroup.Links.Add(link);
        MoveTargetGroup.Record.Links.Add(link.Record);
        SelectedGroup = MoveTargetGroup;
        SelectedLink = link;
        Workspace.MarkChanged();
    }

    [RelayCommand] private void PinWidget() => _widgets.Show("links");

    public void SelectLink(string id)
    {
        foreach (var group in Groups)
        {
            if (group.Links.FirstOrDefault(item => item.Id == id) is not { } link) continue;
            SelectedGroup = group;
            SelectedLink = link;
            return;
        }
    }

    private LinkGroupViewModel AddWrapped(LinkGroupRecord record)
    {
        var group = new LinkGroupViewModel(record);
        group.PropertyChanged += OnItemChanged;
        foreach (var link in group.Links) link.PropertyChanged += OnItemChanged;
        Groups.Add(group);
        return group;
    }

    private void OnItemChanged(object? sender, PropertyChangedEventArgs e) => Workspace.MarkChanged();

    public static bool TryNormalizeUrl(string value, out string normalized)
    {
        value = value.Trim();
        normalized = string.Empty;
        if (string.IsNullOrWhiteSpace(value) || value == "https://") return false;
        if (!value.Contains("://", StringComparison.Ordinal)) value = "https://" + value;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return false;
        normalized = uri.AbsoluteUri;
        return true;
    }
}
