import { useEffect, useState } from 'react'
import type { SystemMetrics } from '../../../shared/types'
import { formatUptime } from '../utils/dates'
export function MonitorWidget() { const [metrics, setMetrics] = useState<SystemMetrics | null>(null); useEffect(() => { void window.dustdesk.sampleSystemMetrics().then(setMetrics); const timer = window.setInterval(() => void window.dustdesk.sampleSystemMetrics().then(setMetrics), 3000); return () => window.clearInterval(timer) }, []); return <div className="widget-metrics"><strong>CPU {metrics ? `${metrics.CpuPercent.toFixed(0)}%` : '--'}</strong><strong>内存 {metrics ? `${metrics.MemoryPercent.toFixed(0)}%` : '--'}</strong><strong>运行 {metrics ? formatUptime(metrics.UptimeSeconds) : '--'}</strong></div> }
