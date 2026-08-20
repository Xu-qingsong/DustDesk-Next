using System.Globalization;
using System.IO;
using System.Xml.Linq;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class XamlRegressionTests
{
    private static readonly XNamespace Presentation = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";

    [Fact]
    public void ClipboardPreviewUsesOneWayBinding()
    {
        var document = LoadXaml("Views", "ClipboardView.xaml");
        var preview = document.Descendants(Presentation + "TextBox")
            .Single(element => ((string?)element.Attribute("Text"))?.Contains("SelectedItem.Text", StringComparison.Ordinal) == true);

        Assert.Contains("Mode=OneWay", (string)preview.Attribute("Text")!);
    }

    [Fact]
    public void SearchListsDisableHorizontalScrolling()
    {
        foreach (var path in new[] { ("Views", "QuickSearchWindow.xaml"), ("Views", "SearchView.xaml") })
        {
            var document = LoadXaml(path.Item1, path.Item2);
            var resultList = document.Descendants().Single(element =>
                element.Name.LocalName is "ListBox" or "ListView" && element.Attribute("ItemsSource")?.Value.Contains("Results", StringComparison.Ordinal) == true);

            Assert.Equal("Disabled", resultList.Attribute("ScrollViewer.HorizontalScrollBarVisibility")?.Value);
        }
    }

    [Fact]
    public void TasksUseOneDialogForCreatingAndEditing()
    {
        var tasks = LoadXaml("Views", "TasksView.xaml");
        var editor = LoadXaml("Views", "TaskEditorDialog.xaml");

        Assert.Contains(tasks.Descendants(Presentation + "Button"), element =>
            element.Attribute("AutomationProperties.Name")?.Value == "添加任务" &&
            element.Attribute("Click")?.Value == "AddTodo_OnClick");
        Assert.Contains(tasks.Descendants(Presentation + "Button"), element =>
            element.Attribute("AutomationProperties.Name")?.Value == "编辑任务" &&
            element.Attribute("Click")?.Value == "EditTodo_OnClick");

        foreach (var name in new[] { "任务标题", "任务标签", "提醒日期", "提醒时间", "重复提醒", "任务备注" })
        {
            Assert.Contains(editor.Descendants(), element => element.Attribute("AutomationProperties.Name")?.Value == name);
        }

        Assert.Contains(editor.Descendants(Presentation + "Button"), element =>
            element.Attribute("Click")?.Value == "Save_OnClick");
    }

    [Fact]
    public void DashboardTaskRowsKeepFieldsVerticallyCentered()
    {
        var dashboard = LoadXaml("Views", "DashboardView.xaml");
        var taskList = dashboard.Descendants(Presentation + "ListBox")
            .Single(element => element.Attribute("ItemsSource")?.Value.Contains("TodayTodos", StringComparison.Ordinal) == true);
        var rowGrid = taskList.Descendants(Presentation + "Grid")
            .Single(element => element.Descendants(Presentation + "TextBlock")
                .Any(text => text.Attribute("Text")?.Value.Contains("{Binding Title}", StringComparison.Ordinal) == true));
        var title = rowGrid.Descendants(Presentation + "TextBlock")
            .Single(element => element.Attribute("Text")?.Value.Contains("{Binding Title}", StringComparison.Ordinal) == true);
        var tag = rowGrid.Descendants(Presentation + "TextBlock")
            .Single(element => element.Attribute("Text")?.Value.Contains("{Binding Tag}", StringComparison.Ordinal) == true);

        Assert.Equal(3, rowGrid.Element(Presentation + "Grid.ColumnDefinitions")!.Elements().Count());
        Assert.Equal("Center", title.Attribute("VerticalAlignment")?.Value);
        Assert.Equal("Center", tag.Attribute("VerticalAlignment")?.Value);
    }

    [Fact]
    public void QuickSearchCanBeClosedWithTheMouse()
    {
        var quickSearch = LoadXaml("Views", "QuickSearchWindow.xaml");
        var closeButton = quickSearch.Descendants(Presentation + "Button")
            .Single(element => element.Attribute("AutomationProperties.Name")?.Value == "关闭快速搜索");

        Assert.Equal("Close_OnClick", closeButton.Attribute("Click")?.Value);
    }

    [Fact]
    public void SearchInputsExposeVisibleIdleBorders()
    {
        var styles = LoadXaml("Themes", "Styles.xaml");
        var searchStyle = styles.Descendants(Presentation + "Style")
            .Single(element => element.Attributes().Any(attribute =>
                attribute.Name.LocalName == "Key" && attribute.Value == "SearchInputStyle"));
        var setters = searchStyle.Elements(Presentation + "Setter").ToList();

        Assert.Contains(setters, setter =>
            setter.Attribute("Property")?.Value == "BorderBrush" &&
            setter.Attribute("Value")?.Value == "{StaticResource SearchBorderBrush}");
        Assert.Contains(setters, setter =>
            setter.Attribute("Property")?.Value == "BorderThickness" &&
            setter.Attribute("Value")?.Value == "1");

        foreach (var path in new[]
        {
            (Folder: "Views", File: "SearchView.xaml", Name: "搜索内容"),
            (Folder: "Views", File: "QuickSearchWindow.xaml", Name: "快速搜索内容")
        })
        {
            var document = LoadXaml(path.Folder, path.File);
            var input = document.Descendants(Presentation + "TextBox")
                .Single(element => element.Attribute("AutomationProperties.Name")?.Value == path.Name);

            Assert.Equal("{StaticResource SearchInputStyle}", input.Attribute("Style")?.Value);
        }

        var main = LoadXaml("Views", "MainWindow.xaml");
        var quickSearch = main.Descendants(Presentation + "Border")
            .Single(element => element.Attribute("ToolTip")?.Value.Contains("快速搜索", StringComparison.Ordinal) == true);
        Assert.Equal("{StaticResource SearchBorderBrush}", quickSearch.Attribute("BorderBrush")?.Value);
    }

    [Fact]
    public void MainGlassInputsExposeVisibleIdleBorders()
    {
        var styles = LoadXaml("Themes", "Styles.xaml");
        var inputStyle = styles.Descendants(Presentation + "Style")
            .Single(element => element.Attributes().Any(attribute =>
                attribute.Name.LocalName == "Key" && attribute.Value == "MainGlassInputStyle"));

        Assert.Contains(inputStyle.Elements(Presentation + "Setter"), setter =>
            setter.Attribute("Property")?.Value == "BorderBrush" &&
            setter.Attribute("Value")?.Value == "{StaticResource SearchBorderBrush}");
    }

    [Fact]
    public void SearchWidgetKeepsCapsuleBorderVisibleBeforeFocus()
    {
        var widget = LoadXaml("Widgets", "SearchWidgetView.xaml");
        var capsule = widget.Descendants(Presentation + "Border")
            .Single(element => element.Attributes().Any(attribute =>
                attribute.Name.LocalName == "Name" && attribute.Value == "CapsuleBorder"));
        var style = capsule.Descendants(Presentation + "Style").SingleOrDefault();

        Assert.NotNull(style);
        Assert.Contains(style!.Elements(Presentation + "Setter"), setter =>
            setter.Attribute("Property")?.Value == "BorderBrush" &&
            setter.Attribute("Value")?.Value == "{StaticResource SearchBorderBrush}");
        Assert.Contains(style.Elements(Presentation + "Setter"), setter =>
            setter.Attribute("Property")?.Value == "BorderThickness" &&
            setter.Attribute("Value")?.Value == "1");
        Assert.Contains(style.Descendants(Presentation + "Trigger"), trigger =>
            trigger.Attribute("Property")?.Value == "IsKeyboardFocusWithin" &&
            trigger.Attribute("Value")?.Value == "True");
    }

    [Fact]
    public void MainAndDashboardSurfacesMeetVisualContracts()
    {
        var main = LoadXaml("Views", "MainWindow.xaml");
        var rootGrid = main.Root!.Elements(Presentation + "Grid").Single();
        var background = rootGrid.Attribute("Background")!.Value;
        Assert.True(ParseAlpha(background) >= 0xE0, $"Main surface alpha is too low: {background}");

        var dashboard = LoadXaml("Views", "DashboardView.xaml");
        Assert.Contains(dashboard.Descendants(Presentation + "Border"), element =>
            element.Attribute("Background")?.Value == "{StaticResource SummarySurfaceBrush}");
    }

    [Fact]
    public void TopNavigationUsesItsTemplateFocusRingWithoutAnOpaqueAdorner()
    {
        var main = LoadXaml("Views", "MainWindow.xaml");
        var navigationStyle = main.Descendants(Presentation + "Style")
            .Single(element => element.Attributes().Any(attribute =>
                attribute.Name.LocalName == "Key" && attribute.Value == "TopNavigationButtonStyle"));
        var hoverBrush = main.Descendants(Presentation + "SolidColorBrush")
            .Single(element => element.Attributes().Any(attribute =>
                attribute.Name.LocalName == "Key" && attribute.Value == "MainGlassHoverBrush"));

        Assert.Equal("#E8EEEC", hoverBrush.Attribute("Color")?.Value);
        Assert.Contains(navigationStyle.Elements(Presentation + "Setter"), setter =>
            setter.Attribute("Property")?.Value == "FocusVisualStyle" &&
            setter.Attribute("Value")?.Value == "{x:Null}");
        Assert.Contains(navigationStyle.Descendants(Presentation + "Trigger"), trigger =>
            trigger.Attribute("Property")?.Value == "IsKeyboardFocused" &&
            trigger.Attribute("Value")?.Value == "True");

        var moreMenu = main.Descendants(Presentation + "ContextMenu")
            .Single(element => element.Attributes().Any(attribute =>
                attribute.Name.LocalName == "Name" && attribute.Value == "MoreMenu"));
        Assert.Equal("Bottom", moreMenu.Attribute("Placement")?.Value);
    }

    [Fact]
    public void DateAndMonitorLayoutsUseAvailableWidth()
    {
        var tasks = LoadXaml("Views", "TasksView.xaml");
        var datePicker = tasks.Descendants(Presentation + "DatePicker")
            .Single(element => element.Attribute("SelectedDate")?.Value.Contains("SelectedDate", StringComparison.Ordinal) == true);
        Assert.True(double.Parse(datePicker.Attribute("Width")!.Value, CultureInfo.InvariantCulture) >= 160);

        var monitor = LoadXaml("Views", "SystemMonitorView.xaml");
        Assert.Equal(2, monitor.Descendants(Presentation + "UniformGrid").Count());
        Assert.DoesNotContain(monitor.Descendants(Presentation + "Border"), element => element.Attribute("Width")?.Value == "400");
        Assert.Contains(monitor.Descendants(Presentation + "ItemsControl"), element => element.Attribute("ItemsSource")?.Value.Contains("DiskSpaces", StringComparison.Ordinal) == true);

        var monitorWidget = LoadXaml("Widgets", "MonitorWidgetView.xaml");
        Assert.Contains(monitorWidget.Descendants(Presentation + "ItemsControl"), element => element.Attribute("ItemsSource")?.Value.Contains("DiskSpaces", StringComparison.Ordinal) == true);
        Assert.Contains(monitorWidget.Descendants(Presentation + "ScrollViewer"), element => element.Attribute("VerticalScrollBarVisibility")?.Value == "Auto");
    }

    [Fact]
    public void WorkdayCountdownWidgetKeepsItsFourMetricsReadable()
    {
        var countdown = LoadXaml("Widgets", "WorkdayCountdownWidgetView.xaml");
        var root = countdown.Root!;

        Assert.True(double.Parse(root.Attribute("MinWidth")!.Value, CultureInfo.InvariantCulture) >= 472);
        Assert.Contains(countdown.Descendants(Presentation + "UniformGrid"), element => element.Attribute("Columns")?.Value.Contains("MetricColumnCount", StringComparison.Ordinal) == true);
        Assert.Contains(countdown.Descendants(Presentation + "Border"), element => element.Attribute("Visibility")?.Value.Contains("ShowTodayEarnings", StringComparison.Ordinal) == true);
        Assert.Contains(countdown.Descendants(Presentation + "ProgressBar"), element => element.Attribute("Value")?.Value.Contains("WorkdayProgressPercent", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void WorkdayCountdownSettingsUseAlignedControlsAndTwoDigitTimes()
    {
        var settings = LoadXaml("Views", "SettingsView.xaml");
        var timeSelectors = settings.Descendants(Presentation + "ComboBox")
            .Where(element => element.Attribute("SelectedItem")?.Value.Contains("Countdown.", StringComparison.Ordinal) == true)
            .Take(4)
            .ToList();

        Assert.Equal(4, timeSelectors.Count);
        Assert.All(timeSelectors, selector => Assert.Equal("{StaticResource TwoDigitNumberTemplate}", selector.Attribute("ItemTemplate")?.Value));
        var countdownLabels = settings.Descendants(Presentation + "TextBlock")
            .Where(element => new[] { "工作时间", "税前月薪", "每月发薪日", "倒数日期名称", "每年日期" }.Contains(element.Attribute("Text")?.Value))
            .ToList();
        Assert.Equal(5, countdownLabels.Count);
        Assert.All(countdownLabels, label => Assert.Equal("Center", label.Attribute("VerticalAlignment")?.Value));
        Assert.Contains(settings.Descendants(Presentation + "TextBox"), element =>
            element.Attribute("Text")?.Value.Contains("Countdown.MonthlySalary", StringComparison.Ordinal) == true &&
            element.Attribute("Style")?.Value == "{StaticResource MainGlassInputStyle}" &&
            element.Attribute("Height") is null &&
            element.Attribute("VerticalAlignment")?.Value == "Center");
    }

    [Fact]
    public void ShortcutAndWidgetDisplayRowsShareControlCenterlines()
    {
        var settings = LoadXaml("Views", "SettingsView.xaml");
        var centeredLabels = new[] { "工作台名称", "主窗口快捷键", "桌面组件快捷键", "图标大小" };

        foreach (var label in centeredLabels)
        {
            Assert.All(
                settings.Descendants(Presentation + "TextBlock").Where(element => element.Attribute("Text")?.Value == label),
                element => Assert.Equal("Center", element.Attribute("VerticalAlignment")?.Value));
        }

        Assert.All(
            settings.Descendants(Presentation + "CheckBox").Where(element => element.Attribute("Content")?.Value is "吸附屏幕边缘" or "显示名称"),
            element => Assert.Equal("Center", element.Attribute("VerticalAlignment")?.Value));
        Assert.All(
            settings.Descendants(Presentation + "Slider").Where(element => element.Attribute("Value")?.Value.Contains("IconSize", StringComparison.Ordinal) == true),
            element => Assert.Equal("Center", element.Attribute("VerticalAlignment")?.Value));
        Assert.All(
            settings.Descendants(Presentation + "TextBox").Where(element => element.Attribute("Text")?.Value.Contains("HotKey", StringComparison.Ordinal) == true),
            element => Assert.Null(element.Attribute("Height")));
    }

    [Fact]
    public void SettingsExposeRecoveryPointsWithStatusAndRestoreActions()
    {
        var settings = LoadXaml("Views", "SettingsView.xaml");
        var recoveryList = settings.Descendants(Presentation + "ListBox")
            .Single(element => element.Attribute("ItemsSource")?.Value == "{Binding RecoveryPoints}");

        Assert.Equal("{Binding SelectedRecoveryPoint}", recoveryList.Attribute("SelectedItem")?.Value);
        Assert.Equal("176", recoveryList.Attribute("MaxHeight")?.Value);
        Assert.Contains(settings.Descendants(Presentation + "TextBlock"), element =>
            element.Attribute("Text")?.Value == "{Binding RecoveryStatus}" &&
            element.Attribute("AutomationProperties.LiveSetting")?.Value == "Polite");
        Assert.Contains(settings.Descendants(Presentation + "ProgressBar"), element =>
            element.Attribute("Visibility")?.Value.Contains("IsBusy", StringComparison.Ordinal) == true);
        Assert.Contains(settings.Descendants(Presentation + "TextBlock"), element =>
            element.Attribute("Text")?.Value == "{Binding Detail}" &&
            element.Attribute("VerticalAlignment")?.Value == "Center");
        Assert.Contains(settings.Descendants(Presentation + "Button"), element =>
            element.Attribute("Command")?.Value.Contains("RestoreRecoveryPointCommand", StringComparison.Ordinal) == true &&
            element.Attribute("CommandParameter")?.Value == "{Binding}");
    }

    [Fact]
    public void OrganizerLoadsFileIconsWithoutBlockingTheFirstRender()
    {
        var organizer = LoadXaml("Views", "OrganizerView.xaml");

        Assert.Equal(2, organizer.Descendants().Count(element => element.Name.LocalName == "AsyncFileIcon"));
        Assert.DoesNotContain(
            organizer.Descendants(Presentation + "Image"),
            element => element.Attribute("Source")?.Value.Contains("FileIconConverter", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void OrganizerUsesDedicatedButtonsForCategorySelectionAndCollapse()
    {
        foreach (var path in new[] { ("Views", "OrganizerView.xaml"), ("Widgets", "OrganizerGroupWidgetView.xaml") })
        {
            var document = LoadXaml(path.Item1, path.Item2);
            Assert.DoesNotContain(document.Descendants(Presentation + "CheckBox"), element =>
                element.Attribute("IsChecked")?.Value.Contains("IsCollapsed", StringComparison.Ordinal) == true ||
                element.Attribute("IsChecked")?.Value.Contains("IsSelectedForWidget", StringComparison.Ordinal) == true);
            Assert.Contains(document.Descendants(Presentation + "Button"), element =>
                element.Attribute("Command")?.Value.Contains("ToggleCategoryCollapseCommand", StringComparison.Ordinal) == true);
        }

        var organizer = LoadXaml("Views", "OrganizerView.xaml");
        Assert.Contains(organizer.Descendants(Presentation + "ToggleButton"), element =>
            element.Attribute("IsChecked")?.Value.Contains("IsSelectedForWidget", StringComparison.Ordinal) == true);
    }

    [Fact]
    public void OrganizerCategoryToolbarKeepsActionsOnOneCenteredRow()
    {
        var organizer = LoadXaml("Views", "OrganizerView.xaml");
        var categoryTitle = organizer.Descendants(Presentation + "TextBlock")
            .Single(element => element.Attribute("Text")?.Value == "分类");
        var actions = organizer.Descendants(Presentation + "Button")
            .Where(element => new[]
            {
                "AddCategoryCommand",
                "MoveCategoryUpCommand",
                "MoveCategoryDownCommand"
            }.Any(command => element.Attribute("Command")?.Value.Contains(command, StringComparison.Ordinal) == true))
            .ToList();

        Assert.Equal(3, actions.Count);
        Assert.Equal("Center", categoryTitle.Attribute("VerticalAlignment")?.Value);
        Assert.All(actions, action =>
        {
            Assert.Same(categoryTitle.Parent, action.Parent);
            Assert.Equal("Center", action.Attribute("VerticalAlignment")?.Value);
            Assert.Equal("34", action.Attribute("Height")?.Value);
        });
    }

    [Fact]
    public void OrganizerExposesSmartOrganizeProgressAndAccessibleStatus()
    {
        var organizer = LoadXaml("Views", "OrganizerView.xaml");

        Assert.Contains(organizer.Descendants(Presentation + "Button"), element =>
            element.Attribute("Command")?.Value.Contains("SmartOrganizeCommand", StringComparison.Ordinal) == true);
        Assert.Contains(organizer.Descendants(Presentation + "ProgressBar"), element =>
            element.Attribute("Visibility")?.Value.Contains("IsSmartOrganizing", StringComparison.Ordinal) == true);
        Assert.Contains(organizer.Descendants(Presentation + "TextBlock"), element =>
            element.Attribute("Text")?.Value.Contains("SmartOrganizeStatus", StringComparison.Ordinal) == true &&
            element.Attribute("AutomationProperties.LiveSetting")?.Value == "Polite");
    }

    private static XDocument LoadXaml(params string[] relativePath) => XDocument.Load(Path.Combine(new[] { FindProjectRoot() }.Concat(relativePath).ToArray()));

    private static string FindProjectRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "DustDesk.Next");
            if (File.Exists(Path.Combine(candidate, "DustDesk.Next.csproj"))) return candidate;
        }

        throw new DirectoryNotFoundException("Could not locate the DustDesk.Next project root.");
    }

    private static int ParseAlpha(string color)
    {
        var value = color.TrimStart('#');
        return value.Length == 8 ? int.Parse(value[..2], NumberStyles.HexNumber, CultureInfo.InvariantCulture) : 0xFF;
    }
}
