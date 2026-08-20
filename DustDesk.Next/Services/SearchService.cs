using System.Diagnostics;
using System.IO;
using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public sealed class SearchService : ISearchService
{
    public async Task<IReadOnlyList<SearchResult>> SearchAsync(string query, IEnumerable<string> projectPaths, AppSettings settings, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(query)) return Array.Empty<SearchResult>();
        var normalizedQuery = query.Trim();
        var everythingTask = SearchEverythingAsync(normalizedQuery, cancellationToken);
        var knownTask = Task.Run(() => SearchKnownLocations(normalizedQuery, projectPaths, settings, cancellationToken), cancellationToken);
        await Task.WhenAll(everythingTask, knownTask).ConfigureAwait(false);
        var everything = await everythingTask.ConfigureAwait(false);
        var known = await knownTask.ConfigureAwait(false);
        return everything.Concat(known)
            .GroupBy(item => item.Path, StringComparer.OrdinalIgnoreCase)
            .Select(group => group.First())
            .Take(120)
            .ToList();
    }

    private static async Task<List<SearchResult>> SearchEverythingAsync(string query, CancellationToken cancellationToken)
    {
        var executable = FindEverythingExecutable();
        if (executable is null) return new();
        try
        {
            using var process = new Process();
            process.StartInfo = new ProcessStartInfo
            {
                FileName = executable,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true
            };
            process.StartInfo.ArgumentList.Add("-n");
            process.StartInfo.ArgumentList.Add("100");
            process.StartInfo.ArgumentList.Add(query);
            if (!process.Start()) return new();
            using var registration = cancellationToken.Register(() => { try { process.Kill(true); } catch { } });
            var output = await process.StandardOutput.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
            await process.WaitForExitAsync(cancellationToken).ConfigureAwait(false);
            return output.Split(new[] { '\r', '\n' }, StringSplitOptions.RemoveEmptyEntries)
                .Where(path => File.Exists(path) || Directory.Exists(path))
                .Select(path => new SearchResult(Path.GetFileName(path.TrimEnd(Path.DirectorySeparatorChar)), path, Directory.Exists(path) ? "文件夹" : "文件"))
                .ToList();
        }
        catch
        {
            return new();
        }
    }

    private static List<SearchResult> SearchKnownLocations(string query, IEnumerable<string> projectPaths, AppSettings settings, CancellationToken cancellationToken)
    {
        var roots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (settings.SearchDesktopFiles) roots.Add(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory));
        if (settings.SearchStartMenuApps) { roots.Add(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu)); roots.Add(Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu)); }
        if (settings.SearchProjectPaths) foreach (var root in projectPaths.Where(Directory.Exists)) roots.Add(root);
        if (settings.SearchCustomPaths) foreach (var root in settings.SearchCustomRoots.Where(Directory.Exists)) roots.Add(root);
        var results = new List<SearchResult>();
        foreach (var root in roots.Where(Directory.Exists))
        {
            var pending = new Stack<(string Path, int Depth)>();
            pending.Push((root, 0));
            while (pending.Count > 0 && results.Count < 120)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var current = pending.Pop();
                try
                {
                    foreach (var path in Directory.EnumerateFileSystemEntries(current.Path))
                    {
                        var name = Path.GetFileName(path);
                        if (name.Contains(query, StringComparison.CurrentCultureIgnoreCase))
                        {
                            results.Add(new SearchResult(name, path, Directory.Exists(path) ? "文件夹" : "文件"));
                        }
                        if (current.Depth < 4 && Directory.Exists(path)) pending.Push((path, current.Depth + 1));
                    }
                }
                catch (UnauthorizedAccessException) { }
                catch (IOException) { }
            }
        }
        return results;
    }

    private static string? FindEverythingExecutable()
    {
        var candidates = new[]
        {
            Path.Combine(AppContext.BaseDirectory, "es.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Everything", "es.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Everything", "es.exe")
        };
        return candidates.FirstOrDefault(File.Exists);
    }
}
