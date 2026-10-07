import { useEffect, useState } from 'react'
import type { AppSettings, SystemMetrics } from '../../../shared/types'
import { formatUptime } from '../utils/dates'
import { formatBytes, formatRate } from '../utils/format'

export function MonitorWidget({ settings }: { settings: AppSettings }) {
  const [metrics, setMetrics] = useState<SystemMetrics | null>(null)
  useEffect(() => {
    let active = true
    let pending = false
    const sample = async () => {
      if (pending) return
      pending = true
      try { const result = await window.dustdesk.sampleSystemMetrics(); if (active) setMetrics(result) }
      catch { if (active) setMetrics(null) }
      finally { pending = false }
    }
    void sample()
    const timer = window.setInterval(() => void sample(), 3000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])
  const rows: [boolean, string, string][] = [
    [settings.MonitorShowCpu, 'CPU', metrics ? `${metrics.CpuPercent.toFixed(0)}%` : '--'],
    [settings.MonitorShowMemory, '内存', metrics ? `${metrics.MemoryPercent.toFixed(0)}%` : '--'],
    [settings.MonitorShowDownload, '下载', metrics ? formatRate(metrics.DownloadBytesPerSecond) : '--'],
    [settings.MonitorShowUpload, '上传', metrics ? formatRate(metrics.UploadBytesPerSecond) : '--'],
    [settings.MonitorShowDiskIo, '磁盘读取', metrics?.DiskReadBytesPerSecond != null ? formatRate(metrics.DiskReadBytesPerSecond) : '--'],
    [settings.MonitorShowDiskIo, '磁盘写入', metrics?.DiskWriteBytesPerSecond != null ? formatRate(metrics.DiskWriteBytesPerSecond) : '--'],
    ...((metrics?.DiskSpaces.length ? metrics.DiskSpaces : [null]).map(disk => [settings.MonitorShowDiskSpace, disk ? `${disk.DriveName} 可用` : '磁盘空间', disk ? formatBytes(disk.FreeBytes) : '--'] as [boolean, string, string])),
    [settings.MonitorShowPing, '延迟', metrics && metrics.PingMilliseconds >= 0 ? `${metrics.PingMilliseconds} ms` : '--'],
    [settings.MonitorShowUptime, '运行', metrics ? formatUptime(metrics.UptimeSeconds) : '--']
  ]
  return <div className="widget-metrics">{rows.filter(([visible]) => visible).map(([, label, value]) => <strong key={label}>{label} {value}</strong>)}{!rows.some(([visible]) => visible) && <p className="muted">未选择指标，请在系统检测页设置</p>}</div>
}
