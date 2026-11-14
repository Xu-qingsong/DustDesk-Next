import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export type DiskThroughput = { read: number | null; write: number | null }
export const byteRate = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null

export async function sampleWindowsDiskThroughput(run = execute): Promise<DiskThroughput> {
  try {
    const { stdout } = await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter \"Name='_Total'\" | Select-Object @{n='read';e={[double]$_.DiskReadBytesPersec}},@{n='write';e={[double]$_.DiskWriteBytesPersec}} | ConvertTo-Json -Compress"
    ], { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024, encoding: 'utf8' })
    const result = JSON.parse(String(stdout).trim())
    return { read: byteRate(result?.read), write: byteRate(result?.write) }
  } catch { return { read: null, write: null } }
}
