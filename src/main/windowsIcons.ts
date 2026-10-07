import { execFile } from 'node:child_process'
import path from 'node:path'

export type IconResource = { path: string; index: number; shortcut?: boolean; directory?: boolean; shellItem?: boolean }

// Read embedded resources directly. Shell file associations can return a
// non-empty generic program icon even when the executable has its own icon.
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
public static class DustDeskIconResource {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern uint ExtractIconEx(string file, int index, IntPtr[] large, IntPtr[] small, uint count);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FileInfo {
    public IntPtr icon; public int index; public uint attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string name;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string type;
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SHGetFileInfo(string file, uint attributes, out FileInfo info, uint size, uint flags);
  public static string Shell(string file) {
    var info = new FileInfo();
    try {
      SHGetFileInfo(file, 0, out info, (uint)Marshal.SizeOf(info), 0x100);
      if (info.icon == IntPtr.Zero) return null;
      using (var icon = (Icon)Icon.FromHandle(info.icon).Clone())
      using (var bitmap = icon.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return Convert.ToBase64String(stream.ToArray());
      }
    } catch { return null; }
    finally { if (info.icon != IntPtr.Zero) DestroyIcon(info.icon); }
  }
  public static string Image(string file) {
    try {
      if (new System.IO.FileInfo(file).Length > 4 * 1024 * 1024) return null;
      using (var image = System.Drawing.Image.FromFile(file))
      using (var stream = new MemoryStream()) {
        if (image.Width > 1024 || image.Height > 1024) return null;
        image.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return Convert.ToBase64String(stream.ToArray());
      }
    } catch { return null; }
  }
  public static string Read(string file, int index) {
    var large = new IntPtr[1]; var small = new IntPtr[1];
    try {
      if (ExtractIconEx(file, index, large, small, 1) == 0) return null;
      var handle = large[0] != IntPtr.Zero ? large[0] : small[0];
      if (handle == IntPtr.Zero) return null;
      using (var icon = (Icon)Icon.FromHandle(handle).Clone())
      using (var bitmap = icon.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, System.Drawing.Imaging.ImageFormat.Png);
        return Convert.ToBase64String(stream.ToArray());
      }
    } catch { return null; }
    finally {
      if (large[0] != IntPtr.Zero) DestroyIcon(large[0]);
      if (small[0] != IntPtr.Zero) DestroyIcon(small[0]);
    }
  }
}
'@
function Resolve-IconPath($value, $shortcutPath) {
  if (-not $value) { return $null }
  $value = [Environment]::ExpandEnvironmentVariables($value.Trim('"'))
  if (-not [IO.Path]::IsPathRooted($value)) { $value = [IO.Path]::Combine([IO.Path]::GetDirectoryName($shortcutPath), $value) }
  return $value
}
function Read-Resource($file, $index) {
  if (-not $file) { return $null }
  $data = [DustDeskIconResource]::Read($file, $index)
  if (-not $data -and $index -ne 0) { $data = [DustDeskIconResource]::Read($file, 0) }
  if (-not $data -and $file -match '\.(png|bmp|jpe?g|gif)$') { $data = [DustDeskIconResource]::Image($file) }
  return $data
}
function Read-Shortcut($file) {
  $ws = $null; $link = $null
  try {
    $ws = New-Object -ComObject WScript.Shell
    $link = $ws.CreateShortcut($file)
    $iconPath = $link.IconLocation; $index = 0
    if ($iconPath -match ',\s*(-?\d+)\s*$') { $index = [int]$Matches[1]; $iconPath = $iconPath.Substring(0, $iconPath.LastIndexOf(',')) }
    $data = Read-Resource (Resolve-IconPath $iconPath $file) $index
    if ($data) { return $data }
    $target = Resolve-IconPath $link.TargetPath $file
    $data = Read-Resource $target 0
    if (-not $data -and $target) { $data = [DustDeskIconResource]::Shell($target) }
    if ($data) { return $data }
  } catch { } finally {
    if ($link) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) }
    if ($ws) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($ws) }
  }
  return [DustDeskIconResource]::Shell($file)
}
$requests = [Console]::In.ReadToEnd() | ConvertFrom-Json
$results = @(foreach ($request in $requests) {
  try {
    if ($request.directory -or $request.shellItem) { $data = [DustDeskIconResource]::Shell($request.path) }
    elseif ($request.shortcut) { $data = Read-Shortcut $request.path }
    else { $data = Read-Resource $request.path ([int]$request.index) }
    @{ data = $data }
  } catch { @{ data = $null } }
})
ConvertTo-Json -InputObject $results -Compress
`

/** Batch extraction keeps a grid of applications from launching a process per icon. */
export function createWindowsIconReader(run = extractWindowsIconResources) {
  const cache = new Map<string, { value?: string; expires: number }>()
  const inflight = new Map<string, Promise<string | undefined>>()
  const pending: { key: string; resource: IconResource; resolve: (value: string | undefined) => void }[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  function schedule() {
    if (timer || running || !pending.length) return
    timer = setTimeout(() => { timer = undefined; void flush() }, 20)
  }
  async function flush() {
    running = true
    const batch = pending.splice(0, 32)
    let values: (string | undefined)[] = []
    let failed = false
    try { values = await run(batch.map(item => item.resource)) } catch { failed = true }
    for (const [index, item] of batch.entries()) {
      const value = values[index]
      // Missing resources are cached briefly so a broken shortcut cannot cause a process storm.
      if (!failed) cache.set(item.key, { value, expires: Date.now() + (value ? 60_000 : 3_000) })
      if (cache.size > 256) cache.delete(cache.keys().next().value!)
      inflight.delete(item.key)
      item.resolve(value)
    }
    running = false
    schedule()
  }
  return (resource: IconResource, fingerprint: string): Promise<string | undefined> => {
    const key = JSON.stringify([resource.path.toLowerCase(), resource.index, resource.shortcut, resource.directory, resource.shellItem, fingerprint])
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value)
    cache.delete(key)
    const shared = inflight.get(key)
    if (shared) return shared
    const result = new Promise<string | undefined>(resolve => {
      pending.push({ key, resource, resolve })
    })
    inflight.set(key, result)
    schedule()
    return result
  }
}

export async function extractWindowsIconResources(resources: IconResource[]): Promise<(string | undefined)[]> {
  if (process.platform !== 'win32' || !resources.length) return resources.map(() => undefined)
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const encodedScript = Buffer.from(script, 'utf16le').toString('base64')
  const output = await new Promise<string>((resolve, reject) => {
    const child = execFile(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], { windowsHide: true, timeout: 8000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(resources))
  })
  const parsed: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim())
  const values = Array.isArray(parsed) ? parsed : [parsed]
  return resources.map((_, index) => {
    const data = values[index]?.data
    return typeof data === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(data) ? `data:image/png;base64,${data}` : undefined
  })
}
