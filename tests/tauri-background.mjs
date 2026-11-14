import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, readdir, mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

assert.equal(process.platform, 'win32')
const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-background-'))
const executable = path.resolve(process.env.DUSTDESK_TAURI_EXECUTABLE || 'src-tauri/target/debug/DustDesk.exe')
const environment = { ...process.env, DUSTDESK_TEST_USER_DATA_DIR: root, DUSTDESK_TAURI_DISABLE_HOTKEYS: '1' }
delete environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
const child = spawn(executable, ['--hidden'], { env: environment, windowsHide: true, stdio: 'ignore' })
try {
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  await new Promise(resolve => setTimeout(resolve, 3000))
  assert.equal(child.exitCode, null)
  const script = '$rows = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(' + child.pid + '); do { $added = $false; foreach ($row in $rows) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true } } } while ($added); $processes = @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,Name); $samples = @(Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) } | Select-Object IDProcess,WorkingSetPrivate); @{ processes = $processes; samples = $samples } | ConvertTo-Json -Depth 4 -Compress'
  const measured = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }))
  console.log(JSON.stringify({ hiddenStartupProcesses: measured.processes }))
  assert.ok(measured.processes.every(process => process.ProcessId === child.pid || process.Name.toLowerCase() === 'conhost.exe'), 'Tray-only startup must not create WebView2 children; debug console hosts are included in measurement')
  assert.equal(measured.samples.length, measured.processes.length)
  assert.ok(measured.processes.some(process => process.ProcessId === child.pid))
  assert.deepEqual(await readdir(root), ['tauri-preview'])
  const report = { ok: true, scenario: 'preview-hidden-no-workspace-services', debugger: false, build: executable.includes(path.sep + 'release' + path.sep) ? 'release' : 'debug', privateWorkingSetMiB: +(measured.samples.reduce((total, sample) => total + Number(sample.WorkingSetPrivate), 0) / 1048576).toFixed(2), processes: measured.processes, performanceGateSatisfied: false }
  await mkdir('artifacts/tauri-migration', { recursive: true })
  await writeFile('artifacts/tauri-migration/background-prototype.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
} finally {
  if (child.pid && child.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
