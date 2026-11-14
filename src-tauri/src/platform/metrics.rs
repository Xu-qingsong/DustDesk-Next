use crate::metrics::{
    cpu_percent, network_rates, valid_disk_rate, CpuTimes, DiskSpace, NetworkCounters,
    SystemMetrics,
};
use std::time::{Duration, Instant};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::{FILETIME, HANDLE},
        NetworkManagement::{
            IpHelper::{
                GetBestInterface, GetIfEntry2, IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho,
                ICMP_ECHO_REPLY, MIB_IF_ROW2,
            },
            Ndis::IfOperStatusUp,
        },
        Storage::FileSystem::{GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW},
        System::{
            Performance::{
                PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData,
                PdhGetFormattedCounterValue, PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE,
                PDH_HCOUNTER, PDH_HQUERY,
            },
            SystemInformation::{GetTickCount64, GlobalMemoryStatusEx, MEMORYSTATUSEX},
            Threading::GetSystemTimes,
        },
    },
};

const PING_DESTINATION: u32 = u32::from_ne_bytes([1, 1, 1, 1]);

fn cpu_times() -> Option<CpuTimes> {
    let mut idle = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
    let ticks =
        |time: FILETIME| (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime);
    Some(CpuTimes {
        idle: ticks(idle),
        kernel: ticks(kernel),
        user: ticks(user),
    })
}

fn network_counters() -> Option<NetworkCounters> {
    let mut index = 0;
    if unsafe { GetBestInterface(PING_DESTINATION, &mut index) } != 0 {
        return None;
    }
    let mut row = MIB_IF_ROW2 {
        InterfaceIndex: index,
        ..Default::default()
    };
    if unsafe { GetIfEntry2(&mut row) }.is_err() || row.OperStatus != IfOperStatusUp {
        return None;
    }
    Some(NetworkCounters {
        interface: unsafe { row.InterfaceLuid.Value },
        received: row.InOctets,
        sent: row.OutOctets,
        at: Instant::now(),
    })
}

struct DiskQuery {
    query: PDH_HQUERY,
    read: Option<PDH_HCOUNTER>,
    write: Option<PDH_HCOUNTER>,
}

impl DiskQuery {
    fn open() -> Option<Self> {
        let mut query = PDH_HQUERY::default();
        if unsafe { PdhOpenQueryW(PCWSTR::null(), 0, &mut query) } != 0 {
            return None;
        }
        let add = |name| {
            let mut counter = PDH_HCOUNTER::default();
            (unsafe { PdhAddEnglishCounterW(query, name, 0, &mut counter) } == 0).then_some(counter)
        };
        let counters = Self {
            query,
            read: add(w!("\\PhysicalDisk(_Total)\\Disk Read Bytes/sec")),
            write: add(w!("\\PhysicalDisk(_Total)\\Disk Write Bytes/sec")),
        };
        if unsafe { PdhCollectQueryData(query) } != 0 {
            return None;
        }
        Some(counters)
    }

    fn sample(&self) -> (Option<f64>, Option<f64>) {
        if unsafe { PdhCollectQueryData(self.query) } != 0 {
            return (None, None);
        }
        let rate = |counter| {
            let mut value = PDH_FMT_COUNTERVALUE::default();
            if unsafe { PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut value) }
                != 0
                || value.CStatus > 1
            {
                return None;
            }
            valid_disk_rate(unsafe { value.Anonymous.doubleValue })
        };
        (self.read.and_then(rate), self.write.and_then(rate))
    }
}

impl Drop for DiskQuery {
    fn drop(&mut self) {
        unsafe { PdhCloseQuery(self.query) };
    }
}

fn disk_spaces() -> Vec<DiskSpace> {
    let required = unsafe { GetLogicalDriveStringsW(None) } as usize;
    if required == 0 || required > 4096 {
        return Vec::new();
    }
    let mut buffer = vec![0; required + 1];
    let length = unsafe { GetLogicalDriveStringsW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return Vec::new();
    }
    let mut disks = Vec::new();
    for drive in buffer[..=length].split_inclusive(|character| *character == 0) {
        if drive.len() < 2 || unsafe { GetDriveTypeW(PCWSTR(drive.as_ptr())) } < 2 {
            continue;
        }
        let mut available = 0;
        let mut total = 0;
        if unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(drive.as_ptr()),
                Some(&mut available),
                Some(&mut total),
                None,
            )
        }
        .is_err()
            || total == 0
        {
            continue;
        }
        disks.push(DiskSpace {
            drive_name: String::from_utf16_lossy(&drive[..drive.len() - 1])
                .trim_end_matches('\\')
                .to_owned(),
            free_bytes: available.min(total),
            total_bytes: total,
        });
    }
    disks
}

struct IcmpHandle(HANDLE);

impl Drop for IcmpHandle {
    fn drop(&mut self) {
        let _ = unsafe { IcmpCloseHandle(self.0) };
    }
}

fn ping() -> i64 {
    let Ok(handle) = (unsafe { IcmpCreateFile() }) else {
        return -1;
    };
    let handle = IcmpHandle(handle);
    let payload = b"DustDesk-monitor";
    let mut reply = [0usize; 64];
    if unsafe {
        IcmpSendEcho(
            handle.0,
            PING_DESTINATION,
            payload.as_ptr().cast(),
            payload.len() as u16,
            None,
            reply.as_mut_ptr().cast(),
            std::mem::size_of_val(&reply) as u32,
            1000,
        )
    } == 0
    {
        return -1;
    }
    let result = unsafe { &*reply.as_ptr().cast::<ICMP_ECHO_REPLY>() };
    if result.Status == 0 {
        i64::from(result.RoundTripTime)
    } else {
        -1
    }
}

pub fn sample_system_metrics() -> Result<SystemMetrics, String> {
    let disk = DiskQuery::open();
    let before_cpu = cpu_times();
    let before_network = network_counters();
    std::thread::sleep(Duration::from_millis(250));
    let cpu = cpu_percent(before_cpu, cpu_times());
    let (download, upload) = network_rates(before_network, network_counters());
    let (read, write) = disk.as_ref().map_or((None, None), DiskQuery::sample);
    drop(disk);
    let mut memory = MEMORYSTATUSEX {
        dwLength: std::mem::size_of::<MEMORYSTATUSEX>() as u32,
        ..Default::default()
    };
    unsafe { GlobalMemoryStatusEx(&mut memory) }
        .map_err(|error| format!("读取物理内存失败：{error}"))?;
    if memory.ullTotalPhys == 0 {
        return Err("物理内存总量无效".into());
    }
    let used = memory.ullTotalPhys.saturating_sub(memory.ullAvailPhys);
    Ok(SystemMetrics {
        cpu_percent: cpu,
        memory_percent: used as f64 / memory.ullTotalPhys as f64 * 100.0,
        used_memory_bytes: used,
        total_memory_bytes: memory.ullTotalPhys,
        download_bytes_per_second: download,
        upload_bytes_per_second: upload,
        disk_read_bytes_per_second: read,
        disk_write_bytes_per_second: write,
        disk_spaces: disk_spaces(),
        ping_milliseconds: ping(),
        uptime_seconds: unsafe { GetTickCount64() } / 1000,
    })
}
