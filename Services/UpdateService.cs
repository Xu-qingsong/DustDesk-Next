using System.Diagnostics;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Windows;

namespace DustDesk.Next.Services;

public sealed class UpdateService : IUpdateService
{
    private const string ApiUrl = "https://api.github.com/repos/Abyxs/DustDesk-Desktop-Manager/releases/latest";
    private const long MaxPackageBytes = 500L * 1024 * 1024;
    private const long MaxExtractedBytes = 1200L * 1024 * 1024;
    public string CurrentVersion => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";

    public async Task<AppUpdateInfo?> CheckAsync(CancellationToken cancellationToken = default)
    {
        using var client = CreateClient(TimeSpan.FromSeconds(8));
        using var response = await client.GetAsync(ApiUrl, cancellationToken);
        if (!response.IsSuccessStatusCode) return null;
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        var release = await JsonSerializer.DeserializeAsync<ReleaseDto>(stream, cancellationToken: cancellationToken);
        if (!TryVersion(release?.TagName, out var latest) || !TryVersion(CurrentVersion, out var current) || latest <= current) return null;

        var version = latest.ToString(3);
        var asset = release?.Assets?
            .Where(item => item.Name.EndsWith(".zip", StringComparison.OrdinalIgnoreCase))
            .FirstOrDefault(item => item.Name.Contains("win-x64", StringComparison.OrdinalIgnoreCase) && item.Name.Contains(version, StringComparison.OrdinalIgnoreCase));
        var checksum = asset is null ? null : release?.Assets?.FirstOrDefault(item =>
            item.Name.Equals(asset.Name + ".sha256", StringComparison.OrdinalIgnoreCase) ||
            item.Name.Equals(Path.GetFileNameWithoutExtension(asset.Name) + ".sha256", StringComparison.OrdinalIgnoreCase));
        return new AppUpdateInfo(version, release?.HtmlUrl ?? "https://github.com/Abyxs/DustDesk-Desktop-Manager/releases/latest", asset?.Url, checksum?.Url);
    }

    public async Task InstallAsync(AppUpdateInfo update, IProgress<int>? progress = null, CancellationToken cancellationToken = default)
    {
        if (update.DownloadUrl is null || update.ChecksumUrl is null)
        {
            Process.Start(new ProcessStartInfo(update.ReleaseUrl) { UseShellExecute = true });
            throw new InvalidDataException("该版本没有可验证的 Windows x64 安装包，已打开发布页面。");
        }

        var root = Path.Combine(Path.GetTempPath(), "DustDesk.Next", "Updates", Guid.NewGuid().ToString("N"));
        var zip = Path.Combine(root, "update.zip");
        var extracted = Path.Combine(root, "extracted");
        var rollback = Path.Combine(root, "rollback");
        Directory.CreateDirectory(root);

        using var client = CreateClient(TimeSpan.FromMinutes(5));
        await DownloadAsync(client, update.DownloadUrl, zip, progress, cancellationToken);
        var expectedHash = ParseChecksum(await client.GetStringAsync(update.ChecksumUrl, cancellationToken));
        string actualHash;
        await using (var hashStream = File.OpenRead(zip)) actualHash = Convert.ToHexString(await SHA256.HashDataAsync(hashStream, cancellationToken));
        if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(expectedHash), Encoding.ASCII.GetBytes(actualHash)))
            throw new InvalidDataException("更新包 SHA-256 校验失败，安装已取消。");

        ValidateArchive(zip);
        ZipFile.ExtractToDirectory(zip, extracted, true);
        ValidateExtractedPackage(extracted, update.Version);

        var target = AppContext.BaseDirectory.TrimEnd('\\');
        var currentExe = Environment.ProcessPath ?? Path.Combine(target, "DustDesk.Next.exe");
        var script = Path.Combine(root, "install.cmd");
        File.WriteAllText(script, BuildInstallScript(extracted, target, rollback, currentExe, root), new UTF8Encoding(false));
        Process.Start(new ProcessStartInfo(script) { UseShellExecute = true, WindowStyle = ProcessWindowStyle.Hidden });
        Application.Current.Shutdown();
    }

    private static HttpClient CreateClient(TimeSpan timeout)
    {
        var client = new HttpClient { Timeout = timeout };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("DustDesk-Updater/2.0");
        return client;
    }

    private static async Task DownloadAsync(HttpClient client, string url, string destination, IProgress<int>? progress, CancellationToken cancellationToken)
    {
        using var response = await client.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        var total = response.Content.Headers.ContentLength;
        if (total > MaxPackageBytes) throw new InvalidDataException("更新包超过允许的大小。");
        await using var input = await response.Content.ReadAsStreamAsync(cancellationToken);
        await using var output = File.Create(destination);
        var buffer = new byte[81920];
        long readTotal = 0;
        while (true)
        {
            var read = await input.ReadAsync(buffer, cancellationToken);
            if (read == 0) break;
            readTotal += read;
            if (readTotal > MaxPackageBytes) throw new InvalidDataException("更新包超过允许的大小。");
            await output.WriteAsync(buffer.AsMemory(0, read), cancellationToken);
            if (total > 0) progress?.Report((int)(readTotal * 100 / total.Value));
        }
    }

    private static string ParseChecksum(string value)
    {
        var hash = value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries).FirstOrDefault()?.Trim().ToUpperInvariant() ?? string.Empty;
        if (hash.Length != 64 || hash.Any(character => !Uri.IsHexDigit(character))) throw new InvalidDataException("更新校验文件格式无效。");
        return hash;
    }

    private static void ValidateArchive(string path)
    {
        using var archive = ZipFile.OpenRead(path);
        if (archive.Entries.Count is 0 or > 2000) throw new InvalidDataException("更新包文件数量异常。");
        long total = 0;
        foreach (var entry in archive.Entries)
        {
            total += entry.Length;
            if (total > MaxExtractedBytes) throw new InvalidDataException("更新包解压后超过允许的大小。");
            var normalized = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
            if (Path.IsPathRooted(normalized) || normalized.Split(Path.DirectorySeparatorChar).Any(part => part == ".."))
                throw new InvalidDataException("更新包包含非法路径。");
        }
    }

    private static void ValidateExtractedPackage(string directory, string expectedVersion)
    {
        var required = new[] { "DustDesk.Next.exe", "DustDesk.Next.dll", "DustDesk.Next.deps.json", "DustDesk.Next.runtimeconfig.json" };
        var missing = required.Where(name => !File.Exists(Path.Combine(directory, name))).ToList();
        if (missing.Count > 0) throw new InvalidDataException($"更新包缺少必要文件：{string.Join("、", missing)}。");
        var assembly = AssemblyName.GetAssemblyName(Path.Combine(directory, "DustDesk.Next.dll"));
        if (!string.Equals(assembly.Name, "DustDesk.Next", StringComparison.Ordinal)) throw new InvalidDataException("更新包程序标识无效。");
        if (!TryVersion(assembly.Version?.ToString(), out var actual) || !TryVersion(expectedVersion, out var expected) || actual.ToString(3) != expected.ToString(3))
            throw new InvalidDataException($"更新包版本不匹配，期望 {expectedVersion}，实际 {assembly.Version}。");
    }

    private static string BuildInstallScript(string source, string target, string rollback, string currentExe, string root) =>
        $"@echo off\r\n" +
        $"timeout /t 2 /nobreak >nul\r\n" +
        $"robocopy \"{target}\" \"{rollback}\" /MIR /R:2 /W:1 >nul\r\n" +
        $"if errorlevel 8 goto backup_failed\r\n" +
        $"robocopy \"{source}\" \"{target}\" /MIR /R:3 /W:1 >nul\r\n" +
        $"if errorlevel 8 goto rollback\r\n" +
        $"start \"\" \"{Path.Combine(target, "DustDesk.Next.exe")}\"\r\n" +
        $"timeout /t 8 /nobreak >nul\r\n" +
        $"tasklist /FI \"IMAGENAME eq DustDesk.Next.exe\" | find /I \"DustDesk.Next.exe\" >nul\r\n" +
        $"if errorlevel 1 goto rollback\r\n" +
        $"rmdir /S /Q \"{rollback}\"\r\n" +
        $"goto cleanup\r\n" +
        $":rollback\r\n" +
        $"robocopy \"{rollback}\" \"{target}\" /MIR /R:3 /W:1 >nul\r\n" +
        $"start \"\" \"{currentExe}\"\r\n" +
        $"goto cleanup\r\n" +
        $":backup_failed\r\n" +
        $"start \"\" \"{currentExe}\"\r\n" +
        $":cleanup\r\n" +
        $"timeout /t 2 /nobreak >nul\r\n" +
        $"rmdir /S /Q \"{root}\"\r\n";

    private static bool TryVersion(string? text, out Version version)
    {
        var parsed = Version.TryParse(text?.Trim().TrimStart('v', 'V').Split('-')[0], out var candidate);
        version = candidate ?? new Version(0, 0, 0);
        return parsed;
    }

    private sealed class ReleaseDto
    {
        [JsonPropertyName("tag_name")] public string TagName { get; set; } = string.Empty;
        [JsonPropertyName("html_url")] public string HtmlUrl { get; set; } = string.Empty;
        [JsonPropertyName("assets")] public List<AssetDto> Assets { get; set; } = new();
    }

    private sealed class AssetDto
    {
        [JsonPropertyName("name")] public string Name { get; set; } = string.Empty;
        [JsonPropertyName("browser_download_url")] public string Url { get; set; } = string.Empty;
    }
}
