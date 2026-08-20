using System.IO;
using System.Net.NetworkInformation;
using System.Runtime.InteropServices;

namespace DustDesk.Next.Services;

public sealed class SystemMetricsService : ISystemMetricsService
{
    private ulong _lastIdle;
    private ulong _lastKernel;
    private ulong _lastUser;
    private long _lastReceived;
    private long _lastSent;
    private DateTime _lastNetworkAt = DateTime.UtcNow;
    private readonly DiskIoSampler _diskIo = new();

    public async Task<SystemMetrics> SampleAsync(CancellationToken cancellationToken = default)
    {
        var cpu = ReadCpu();
        var memory = ReadMemory();
        var network = ReadNetwork();
        var disks = ReadDisks();
        var diskIo = _diskIo.Sample();
        var ping = await ReadPingAsync(cancellationToken).ConfigureAwait(false);
        return new SystemMetrics(cpu, memory.Percent, memory.Used, memory.Total, network.Download, network.Upload, diskIo.Read, diskIo.Write, disks, ping, TimeSpan.FromMilliseconds(Environment.TickCount64));
    }

    private double ReadCpu()
    {
        if (!GetSystemTimes(out var idleFile, out var kernelFile, out var userFile)) return 0;
        var idle = ToUInt64(idleFile); var kernel = ToUInt64(kernelFile); var user = ToUInt64(userFile);
        var totalDelta = kernel - _lastKernel + user - _lastUser;
        var idleDelta = idle - _lastIdle;
        _lastIdle = idle; _lastKernel = kernel; _lastUser = user;
        return totalDelta == 0 ? 0 : Math.Clamp((totalDelta - idleDelta) * 100d / totalDelta, 0, 100);
    }

    private static (double Percent, ulong Used, ulong Total) ReadMemory()
    {
        var status = new MemoryStatusEx { Length = (uint)Marshal.SizeOf<MemoryStatusEx>() };
        if (!GlobalMemoryStatusEx(ref status)) return (0, 0, 0);
        var used = status.TotalPhysical - status.AvailablePhysical;
        return (status.MemoryLoad, used, status.TotalPhysical);
    }

    private (double Download, double Upload) ReadNetwork()
    {
        long received = 0, sent = 0;
        foreach (var item in NetworkInterface.GetAllNetworkInterfaces().Where(item => item.OperationalStatus == OperationalStatus.Up))
        {
            try { var stats = item.GetIPv4Statistics(); received += stats.BytesReceived; sent += stats.BytesSent; } catch { }
        }
        var now = DateTime.UtcNow;
        var seconds = Math.Max(0.1, (now - _lastNetworkAt).TotalSeconds);
        var result = (_lastReceived == 0 ? 0 : Math.Max(0, received - _lastReceived) / seconds, _lastSent == 0 ? 0 : Math.Max(0, sent - _lastSent) / seconds);
        _lastReceived = received; _lastSent = sent; _lastNetworkAt = now;
        return result;
    }

    private static IReadOnlyList<DiskSpaceMetric> ReadDisks()
    {
        var result = new List<DiskSpaceMetric>();
        DriveInfo[] drives;
        try { drives = DriveInfo.GetDrives(); }
        catch (IOException) { return result; }
        catch (UnauthorizedAccessException) { return result; }

        foreach (var drive in drives.OrderBy(item => item.Name, StringComparer.OrdinalIgnoreCase))
        {
            try
            {
                if (!drive.IsReady || drive.DriveType is not (DriveType.Fixed or DriveType.Removable)) continue;
                result.Add(new DiskSpaceMetric(
                    drive.Name.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar),
                    (ulong)drive.AvailableFreeSpace,
                    (ulong)drive.TotalSize));
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }

        return result;
    }

    private static async Task<long> ReadPingAsync(CancellationToken cancellationToken)
    {
        try { using var ping = new Ping(); var reply = await ping.SendPingAsync("1.1.1.1", TimeSpan.FromSeconds(1), cancellationToken: cancellationToken); return reply.Status == IPStatus.Success ? reply.RoundtripTime : -1; }
        catch { return -1; }
    }

    private static ulong ToUInt64(FileTime value) => ((ulong)value.High << 32) | value.Low;
    [StructLayout(LayoutKind.Sequential)] private struct FileTime { public uint Low; public uint High; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)] private struct MemoryStatusEx { public uint Length; public uint MemoryLoad; public ulong TotalPhysical; public ulong AvailablePhysical; public ulong TotalPageFile; public ulong AvailablePageFile; public ulong TotalVirtual; public ulong AvailableVirtual; public ulong AvailableExtendedVirtual; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetSystemTimes(out FileTime idleTime, out FileTime kernelTime, out FileTime userTime);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)] private static extern bool GlobalMemoryStatusEx(ref MemoryStatusEx buffer);
    public void Dispose() => _diskIo.Dispose();

    private sealed class DiskIoSampler : IDisposable
    {
        private IntPtr _query;
        private IntPtr _readCounter;
        private IntPtr _writeCounter;
        public DiskIoSampler()
        {
            if (PdhOpenQuery(null, IntPtr.Zero, out _query) != 0) return;
            if (PdhAddEnglishCounter(_query, @"\PhysicalDisk(_Total)\Disk Read Bytes/sec", IntPtr.Zero, out _readCounter) != 0 ||
                PdhAddEnglishCounter(_query, @"\PhysicalDisk(_Total)\Disk Write Bytes/sec", IntPtr.Zero, out _writeCounter) != 0)
            { PdhCloseQuery(_query); _query = IntPtr.Zero; return; }
            PdhCollectQueryData(_query);
        }
        public (double Read, double Write) Sample()
        {
            if (_query == IntPtr.Zero || PdhCollectQueryData(_query) != 0) return (0, 0);
            return (ReadValue(_readCounter), ReadValue(_writeCounter));
        }
        private static double ReadValue(IntPtr counter) => PdhGetFormattedCounterValue(counter, 0x00000200, out _, out var value) == 0 && value.DoubleValue >= 0 ? value.DoubleValue : 0;
        public void Dispose() { if (_query != IntPtr.Zero) { PdhCloseQuery(_query); _query = IntPtr.Zero; } }
        [StructLayout(LayoutKind.Explicit)] private struct PdhFormattedCounterValue { [FieldOffset(0)] public uint Status; [FieldOffset(8)] public double DoubleValue; }
        [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhOpenQuery(string? dataSource, IntPtr userData, out IntPtr query);
        [DllImport("pdh.dll", EntryPoint = "PdhAddEnglishCounterW", CharSet = CharSet.Unicode)] private static extern uint PdhAddEnglishCounter(IntPtr query, string fullCounterPath, IntPtr userData, out IntPtr counter);
        [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
        [DllImport("pdh.dll")] private static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out PdhFormattedCounterValue value);
        [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);
    }
}
