param([Parameter(Mandatory = $true)][int]$AppProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DustDeskMetricsReference {
    [StructLayout(LayoutKind.Sequential)]
    public struct MemoryStatus {
        public uint Length;
        public uint Load;
        public ulong TotalPhys;
        public ulong AvailablePhys;
        public ulong TotalPageFile;
        public ulong AvailablePageFile;
        public ulong TotalVirtual;
        public ulong AvailableVirtual;
        public ulong AvailableExtendedVirtual;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    [DllImport("kernel32.dll")]
    public static extern ulong GetTickCount64();
    public static MemoryStatus ReadMemory() {
        var status = new MemoryStatus();
        status.Length = (uint)Marshal.SizeOf(status);
        if (!GlobalMemoryStatusEx(ref status)) throw new Win32Exception();
        return status;
    }
}
'@
$memory = [DustDeskMetricsReference]::ReadMemory()
$disks = @(foreach ($drive in [IO.DriveInfo]::GetDrives()) {
    try {
        if ($drive.IsReady) {
            @{ DriveName = $drive.Name.TrimEnd('\'); FreeBytes = $drive.AvailableFreeSpace; TotalBytes = $drive.TotalSize }
        }
    } catch {}
})
$children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $AppProcessId" | Select-Object -ExpandProperty Name)
$diskIo = $null
$diskIoError = $null
try {
    $counter = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name = '_Total'" | Select-Object -First 1
    if ($null -ne $counter) {
        $diskIo = @{ Read = $counter.DiskReadBytesPersec; Write = $counter.DiskWriteBytesPersec }
    }
} catch { $diskIoError = $_.Exception.Message }
$process = [Diagnostics.Process]::GetProcessById($AppProcessId)
@{
    TotalMemoryBytes = $memory.TotalPhys
    UsedMemoryBytes = $memory.TotalPhys - $memory.AvailablePhys
    UptimeSeconds = [Math]::Floor([DustDeskMetricsReference]::GetTickCount64() / 1000)
    DiskSpaces = $disks
    DiskIo = $diskIo
    DiskIoError = $diskIoError
    HandleCount = $process.HandleCount
    Children = $children
} | ConvertTo-Json -Depth 5 -Compress
