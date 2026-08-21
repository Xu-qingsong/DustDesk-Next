namespace DustDesk.Next.Services;

using DustDesk.Next.Models;

public sealed record SearchResult(string Name, string Path, string Kind, string? PageKey = null, string? ItemId = null);

public interface ISearchService
{
    Task<IReadOnlyList<SearchResult>> SearchAsync(string query, IEnumerable<string> projectPaths, AppSettings settings, CancellationToken cancellationToken = default);
}
