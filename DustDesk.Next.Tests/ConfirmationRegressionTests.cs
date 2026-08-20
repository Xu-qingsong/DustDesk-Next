using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class ConfirmationRegressionTests
{
    [Fact]
    public void DestructiveActionsNeverRequestASecondConfirmation()
    {
        var projectRoot = FindProjectRoot();
        var sources = Directory.GetFiles(projectRoot, "*.cs", SearchOption.AllDirectories)
            .Where(path => !path.Contains($"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}") &&
                           !path.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
            .Select(File.ReadAllText)
            .ToList();
        var allSource = string.Join(Environment.NewLine, sources);

        Assert.DoesNotContain("ConfirmTwice", allSource, StringComparison.Ordinal);
        Assert.DoesNotContain("第二次确认", allSource, StringComparison.Ordinal);
        Assert.DoesNotContain("再次确认", allSource, StringComparison.Ordinal);

        var maintenanceSource = File.ReadAllText(Path.Combine(projectRoot, "Services", "DataMaintenanceService.cs"));
        var resetMethod = Regex.Match(
            maintenanceSource,
            @"public async Task<bool> ResetAsync\(\)(.*?)private async Task<bool> RestoreArchiveAsync",
            RegexOptions.Singleline).Value;
        Assert.NotEmpty(resetMethod);
        Assert.Single(Regex.Matches(resetMethod, "MessageBox\\.Show"));
    }

    private static string FindProjectRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "DustDesk.Next");
            if (File.Exists(Path.Combine(candidate, "DustDesk.Next.csproj"))) return candidate;
        }

        throw new DirectoryNotFoundException("Could not locate the DustDesk.Next project root.");
    }
}
