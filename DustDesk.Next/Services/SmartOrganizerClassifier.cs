namespace DustDesk.Next.Services;

public sealed record SmartOrganizerMove(OrganizerEntry Entry, string CategoryName);

public sealed record SmartOrganizerPlan(IReadOnlyList<SmartOrganizerMove> Moves, int SkippedApplicationCount);

public static class SmartOrganizerClassifier
{
    public const string FolderCategory = "文件夹";
    public const string DocumentCategory = "文档";
    public const string ImageCategory = "图片";
    public const string MediaCategory = "音视频";
    public const string ArchiveCategory = "压缩包";
    public const string OtherCategory = "其他文件";

    public static IReadOnlyList<string> CategoryOrder { get; } =
    [
        FolderCategory,
        DocumentCategory,
        ImageCategory,
        MediaCategory,
        ArchiveCategory,
        OtherCategory
    ];

    private static readonly HashSet<string> ApplicationExtensions = CreateExtensionSet(
        ".exe", ".com", ".msi", ".msix", ".msixbundle", ".appx", ".appxbundle", ".appref-ms",
        ".lnk", ".url", ".bat", ".cmd", ".ps1", ".vbs", ".vbe", ".js", ".jse", ".wsf",
        ".wsh", ".scr", ".jar", ".dll", ".sys", ".ocx", ".cpl", ".drv");

    private static readonly HashSet<string> DocumentExtensions = CreateExtensionSet(
        ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".pdf", ".txt", ".rtf", ".md",
        ".csv", ".tsv", ".odt", ".ods", ".odp", ".epub", ".mobi");

    private static readonly HashSet<string> ImageExtensions = CreateExtensionSet(
        ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp", ".svg", ".ico", ".heic", ".tif",
        ".tiff", ".raw");

    private static readonly HashSet<string> MediaExtensions = CreateExtensionSet(
        ".mp3", ".wav", ".flac", ".aac", ".m4a", ".ogg", ".wma", ".mp4", ".mkv", ".avi",
        ".mov", ".wmv", ".webm", ".flv", ".m4v");

    private static readonly HashSet<string> ArchiveExtensions = CreateExtensionSet(
        ".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".cab", ".iso");

    public static SmartOrganizerPlan CreatePlan(IEnumerable<OrganizerEntry> entries)
    {
        var moves = new List<SmartOrganizerMove>();
        var skippedApplications = 0;

        foreach (var entry in entries)
        {
            var category = Classify(entry);
            if (category is null)
            {
                skippedApplications++;
                continue;
            }

            moves.Add(new SmartOrganizerMove(entry, category));
        }

        var categoryIndexes = CategoryOrder
            .Select((category, index) => (category, index))
            .ToDictionary(item => item.category, item => item.index, StringComparer.Ordinal);
        moves.Sort((left, right) =>
        {
            var categoryComparison = categoryIndexes[left.CategoryName].CompareTo(categoryIndexes[right.CategoryName]);
            return categoryComparison != 0
                ? categoryComparison
                : StringComparer.CurrentCultureIgnoreCase.Compare(left.Entry.Name, right.Entry.Name);
        });

        return new SmartOrganizerPlan(moves, skippedApplications);
    }

    public static string? Classify(OrganizerEntry entry)
    {
        if (entry.IsDirectory) return FolderCategory;

        var extension = Path.GetExtension(entry.Name);
        if (ApplicationExtensions.Contains(extension)) return null;
        if (DocumentExtensions.Contains(extension)) return DocumentCategory;
        if (ImageExtensions.Contains(extension)) return ImageCategory;
        if (MediaExtensions.Contains(extension)) return MediaCategory;
        if (ArchiveExtensions.Contains(extension)) return ArchiveCategory;
        return OtherCategory;
    }

    private static HashSet<string> CreateExtensionSet(params string[] extensions) =>
        new(extensions, StringComparer.OrdinalIgnoreCase);
}
