using DustDesk.Next.Services;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class SmartOrganizerClassifierTests
{
    [Theory]
    [InlineData("会议纪要.docx", SmartOrganizerClassifier.DocumentCategory)]
    [InlineData("需求.md", SmartOrganizerClassifier.DocumentCategory)]
    [InlineData("截图.PNG", SmartOrganizerClassifier.ImageCategory)]
    [InlineData("演示.mp4", SmartOrganizerClassifier.MediaCategory)]
    [InlineData("资料.7z", SmartOrganizerClassifier.ArchiveCategory)]
    [InlineData("无扩展名", SmartOrganizerClassifier.OtherCategory)]
    public void ClassifiesFilesByExtension(string name, string expectedCategory)
    {
        Assert.Equal(expectedCategory, SmartOrganizerClassifier.Classify(new OrganizerEntry(name, name, false)));
    }

    [Fact]
    public void ClassifiesDirectoriesAsFolders()
    {
        Assert.Equal(
            SmartOrganizerClassifier.FolderCategory,
            SmartOrganizerClassifier.Classify(new OrganizerEntry("项目", "项目", true)));
    }

    [Theory]
    [InlineData("应用.exe")]
    [InlineData("应用快捷方式.LNK")]
    [InlineData("网站.url")]
    [InlineData("安装包.msi")]
    [InlineData("启动脚本.cmd")]
    public void LeavesApplicationsAndLaunchersOnDesktop(string name)
    {
        Assert.Null(SmartOrganizerClassifier.Classify(new OrganizerEntry(name, name, false)));
    }

    [Fact]
    public void PlanCountsSkippedApplicationsAndUsesStableCategoryOrder()
    {
        var plan = SmartOrganizerClassifier.CreatePlan(
        [
            new OrganizerEntry("图片.png", "图片.png", false),
            new OrganizerEntry("应用.lnk", "应用.lnk", false),
            new OrganizerEntry("文件夹", "文件夹", true),
            new OrganizerEntry("文档.pdf", "文档.pdf", false)
        ]);

        Assert.Equal(1, plan.SkippedApplicationCount);
        Assert.Equal(
            [SmartOrganizerClassifier.FolderCategory, SmartOrganizerClassifier.DocumentCategory, SmartOrganizerClassifier.ImageCategory],
            plan.Moves.Select(move => move.CategoryName));
    }
}
