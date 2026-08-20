using System.IO;
using System.Security.Cryptography;
using DustDesk.Next.Models;

namespace DustDesk.Next.Services;

public sealed class OrganizerService : IOrganizerService
{
    private readonly string _organizerRoot;
    private readonly string _logPath;
    private readonly string _desktop;

    public OrganizerService(IAppStateStore store) : this(store, Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory)) { }

    public OrganizerService(IAppStateStore store, string desktopDirectory)
    {
        _organizerRoot = Path.Combine(store.DataDirectory, "DesktopOrganizer");
        _logPath = Path.Combine(store.DataDirectory, "Logs", "organizer-move.log");
        _desktop = Path.GetFullPath(desktopDirectory);
        Directory.CreateDirectory(_desktop);
    }

    public IReadOnlyList<OrganizerEntry> GetDesktopEntries()
    {
        if (!Directory.Exists(_desktop)) return Array.Empty<OrganizerEntry>();
        try
        {
            return Directory.EnumerateFileSystemEntries(_desktop)
                .Where(path => !string.Equals(Path.GetFileName(path), "desktop.ini", StringComparison.OrdinalIgnoreCase))
                .Select(path => new OrganizerEntry(Path.GetFileName(path), path, Directory.Exists(path)))
                .OrderByDescending(item => item.IsDirectory)
                .ThenBy(item => item.Name, StringComparer.CurrentCultureIgnoreCase)
                .ToList();
        }
        catch (IOException) { return Array.Empty<OrganizerEntry>(); }
        catch (UnauthorizedAccessException) { return Array.Empty<OrganizerEntry>(); }
    }

    public bool SynchronizeCategories(ICollection<DesktopCategoryRecord> categories)
    {
        if (!Directory.Exists(_organizerRoot)) return false;
        var changed = false;
        foreach (var directory in Directory.EnumerateDirectories(_organizerRoot))
        {
            var name = Path.GetFileName(directory);
            var category = categories.FirstOrDefault(item => string.Equals(item.Name, name, StringComparison.OrdinalIgnoreCase));
            if (category is null)
            {
                category = new DesktopCategoryRecord { Name = name };
                categories.Add(category); changed = true;
            }
            foreach (var path in Directory.EnumerateFileSystemEntries(directory))
            {
                if (!category.ItemPaths.Contains(path, StringComparer.OrdinalIgnoreCase)) { category.ItemPaths.Add(path); changed = true; }
            }
            for (var i = category.ItemPaths.Count - 1; i >= 0; i--)
            {
                if (!File.Exists(category.ItemPaths[i]) && !Directory.Exists(category.ItemPaths[i])) { category.ItemPaths.RemoveAt(i); changed = true; }
            }
        }
        return changed;
    }

    public string MoveIntoCategory(DesktopCategoryRecord category, string sourcePath)
    {
        EnsureExists(sourcePath);
        var targetDirectory = Path.Combine(_organizerRoot, Sanitize(category.Name));
        var target = Path.Combine(targetDirectory, Path.GetFileName(sourcePath));
        if (PathExists(target) && !SamePath(sourcePath, target)) throw new IOException("分类中已存在同名文件或文件夹。");
        var moved = MoveWithLogging("收纳", sourcePath, target);
        foreach (var other in category.ItemPaths.Where(path => SamePath(path, sourcePath)).ToList()) category.ItemPaths.Remove(other);
        if (!category.ItemPaths.Contains(moved, StringComparer.OrdinalIgnoreCase)) category.ItemPaths.Add(moved);
        return moved;
    }

    public string RestoreToDesktop(DesktopCategoryRecord category, string sourcePath)
    {
        EnsureExists(sourcePath);
        var target = Path.Combine(_desktop, Path.GetFileName(sourcePath));
        if (PathExists(target) && !SamePath(sourcePath, target)) throw new IOException("桌面上已存在同名文件或文件夹，请先处理冲突。");
        var moved = MoveWithLogging("恢复桌面", sourcePath, target);
        category.ItemPaths.RemoveAll(path => SamePath(path, sourcePath));
        return moved;
    }

    public void RenameCategory(DesktopCategoryRecord category, string newName)
    {
        newName = newName.Trim();
        if (string.IsNullOrWhiteSpace(newName)) throw new ArgumentException("分类名称不能为空。");
        var oldDirectory = Path.Combine(_organizerRoot, Sanitize(category.Name));
        var newDirectory = Path.Combine(_organizerRoot, Sanitize(newName));
        if (!SamePath(oldDirectory, newDirectory) && Directory.Exists(newDirectory)) throw new IOException("已存在同名分类。");
        if (Directory.Exists(oldDirectory) && !SamePath(oldDirectory, newDirectory)) Directory.Move(oldDirectory, newDirectory);
        category.Name = newName;
        for (var i = 0; i < category.ItemPaths.Count; i++)
        {
            var name = Path.GetFileName(category.ItemPaths[i]);
            category.ItemPaths[i] = Path.Combine(newDirectory, name);
        }
    }

    public void DeleteCategory(ICollection<DesktopCategoryRecord> categories, DesktopCategoryRecord category)
    {
        foreach (var path in category.ItemPaths.ToList()) RestoreToDesktop(category, path);
        var directory = Path.Combine(_organizerRoot, Sanitize(category.Name));
        if (Directory.Exists(directory) && !Directory.EnumerateFileSystemEntries(directory).Any()) Directory.Delete(directory);
        categories.Remove(category);
    }

    private string MoveWithLogging(string operation, string source, string target)
    {
        try { return MoveVerified(source, target); }
        catch (Exception ex)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(_logPath)!);
                File.AppendAllText(_logPath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss} [{operation}] {source} -> {target}{Environment.NewLine}{ex}{Environment.NewLine}{Environment.NewLine}");
            }
            catch { }
            throw;
        }
    }

    private static string MoveVerified(string source, string target)
    {
        if (SamePath(source, target)) return Path.GetFullPath(source);
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        if (File.Exists(source))
        {
            try { File.Move(source, target); }
            catch (IOException) when (!SameVolume(source, target)) { CopyFileAcrossVolumes(source, target); }
        }
        else
        {
            EnsureDirectoryFilesAvailable(source);
            try { Directory.Move(source, target); }
            catch (IOException) when (!SameVolume(source, target))
            {
                CopyDirectoryAcrossVolumes(source, target);
            }
        }
        if (!PathExists(target)) throw new IOException("移动校验失败，目标不存在。");
        return Path.GetFullPath(target);
    }

    private static void CopyFileAcrossVolumes(string source, string target)
    {
        var staging = target + $".dustdesk-moving-{Guid.NewGuid():N}";
        try
        {
            File.Copy(source, staging);
            VerifyFile(source, staging);
            File.Move(staging, target);
            File.Delete(source);
        }
        catch
        {
            try { if (File.Exists(staging)) File.Delete(staging); } catch { }
            throw;
        }
    }

    private static void CopyDirectoryAcrossVolumes(string source, string target)
    {
        var staging = target + $".dustdesk-moving-{Guid.NewGuid():N}";
        try
        {
            CopyDirectory(source, staging);
            VerifyDirectory(source, staging);
            Directory.Move(staging, target);
            Directory.Delete(source, true);
        }
        catch
        {
            try { if (Directory.Exists(staging)) Directory.Delete(staging, true); } catch { }
            throw;
        }
    }

    private static void CopyDirectory(string source, string target)
    {
        Directory.CreateDirectory(target);
        foreach (var file in Directory.EnumerateFiles(source)) File.Copy(file, Path.Combine(target, Path.GetFileName(file)));
        foreach (var directory in Directory.EnumerateDirectories(source)) CopyDirectory(directory, Path.Combine(target, Path.GetFileName(directory)));
    }

    private static void VerifyDirectory(string source, string target)
    {
        var sourceFiles = Directory.EnumerateFiles(source, "*", SearchOption.AllDirectories).ToList();
        var targetFiles = Directory.EnumerateFiles(target, "*", SearchOption.AllDirectories).ToList();
        if (sourceFiles.Count != targetFiles.Count) throw new IOException("跨盘复制校验失败，文件数量不一致，源文件已保留。");
        foreach (var file in sourceFiles)
        {
            var destination = Path.Combine(target, Path.GetRelativePath(source, file));
            VerifyFile(file, destination);
        }
    }

    private static void VerifyFile(string source, string target)
    {
        if (!File.Exists(target) || new FileInfo(source).Length != new FileInfo(target).Length) throw new IOException("跨盘复制校验失败，源文件已保留。");
        using var sourceStream = File.OpenRead(source); using var targetStream = File.OpenRead(target);
        if (!SHA256.HashData(sourceStream).SequenceEqual(SHA256.HashData(targetStream))) throw new IOException("跨盘复制校验失败，文件内容不一致，源文件已保留。");
    }

    private static void EnsureDirectoryFilesAvailable(string directory)
    {
        foreach (var file in Directory.EnumerateFiles(directory, "*", SearchOption.AllDirectories))
        {
            try { using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.None); }
            catch (IOException ex) { throw new IOException($"文件正在被占用，请关闭后重试：{file}", ex); }
        }
    }

    private static bool SameVolume(string left, string right) => string.Equals(Path.GetPathRoot(Path.GetFullPath(left)), Path.GetPathRoot(Path.GetFullPath(right)), StringComparison.OrdinalIgnoreCase);

    private static void EnsureExists(string path) { if (!PathExists(path)) throw new FileNotFoundException("文件或文件夹不存在。", path); }
    private static bool PathExists(string path) => File.Exists(path) || Directory.Exists(path);
    private static bool SamePath(string left, string right) => string.Equals(Path.GetFullPath(left).TrimEnd('\\'), Path.GetFullPath(right).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
    private static string Sanitize(string value) { var invalid = Path.GetInvalidFileNameChars().ToHashSet(); var result = new string(value.Select(ch => invalid.Contains(ch) ? '_' : ch).ToArray()).Trim(); return string.IsNullOrWhiteSpace(result) ? "未命名" : result; }
}
