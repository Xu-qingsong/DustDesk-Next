using System.IO;
using DustDesk.Next.Models;
using DustDesk.Next.Services;
using DustDesk.Next.ViewModels;
using Xunit;

namespace DustDesk.Next.Tests;

public sealed class ProjectNavigationTests
{
    [Fact]
    public async Task ProjectSearchResultNavigatesAndSelectsOwningPhase()
    {
        var dataDirectory = Path.Combine(Path.GetTempPath(), "DustDesk.Next.Tests", Guid.NewGuid().ToString("N"));
        try
        {
            var workspace = new WorkspaceViewModel(JsonAppStateStore.CreateForDirectory(dataDirectory), new NoLegacyImporter());
            await workspace.InitializeAsync();

            var subtask = new ProjectSubtaskRecord { Title = "Ship navigation" };
            var phase = new ProjectPhaseRecord { Title = "Release", Subtasks = { subtask } };
            var project = new ProjectRecord { Name = "DustDesk", Phases = { phase } };
            workspace.State.Projects.Add(project);

            var projects = new ProjectsViewModel(workspace, new DesktopStub(), new WidgetStub());
            var search = new SearchViewModel(workspace, new EmptySearchService(), new DesktopStub(), new ShellMenuStub());
            var shell = new ShellViewModel(
                null!,
                null!,
                null!,
                projects,
                null!,
                null!,
                search,
                null!,
                null!,
                null!,
                null!,
                null!,
                workspace);

            search.OpenResultCommand.Execute(new SearchResult(subtask.Title, string.Empty, "项目子事项", "projects", subtask.Id));

            Assert.Same(projects, shell.CurrentPage);
            Assert.True(shell.NavigationItems.Single(item => item.Key == "projects").IsSelected);
            Assert.Same(projects.Projects.Single(), projects.SelectedProject);
            Assert.Same(projects.SelectedProject!.Phases.Single(), projects.SelectedPhase);
        }
        finally
        {
            if (Directory.Exists(dataDirectory)) Directory.Delete(dataDirectory, true);
        }
    }

    private sealed class NoLegacyImporter : ILegacyDataImporter
    {
        public Task<bool> ImportAsync(WorkspaceState target, CancellationToken cancellationToken = default) => Task.FromResult(false);
    }

    private sealed class EmptySearchService : ISearchService
    {
        public Task<IReadOnlyList<SearchResult>> SearchAsync(string query, IEnumerable<string> projectPaths, AppSettings settings, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<SearchResult>>(Array.Empty<SearchResult>());
    }

    private sealed class DesktopStub : IDesktopService
    {
        public string? PickFile(string title, string filter = "所有文件|*.*") => null;
        public string? PickFolder(string title) => null;
        public string? PickFileOrFolder(string title) => null;
        public void Open(string path) { }
    }

    private sealed class WidgetStub : IWidgetManager
    {
        public bool IsVisible(string key) => false;
        public void Show(string key) { }
        public void Hide(string key) { }
        public void Toggle(string key) { }
        public void ToggleConfigured() { }
        public void RestoreConfigured() { }
        public void CloseAll(bool preserveVisibility) { }
        public void RefreshAppearance() { }
    }

    private sealed class ShellMenuStub : IShellContextMenuService
    {
        public bool ShowForPath(string path) => false;
        public bool ShowDesktopBackground() => false;
    }
}
