import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

// Run after building. The Windows samples use Task Manager's private working
// set, not total working sets (which double-count shared Electron code).
const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-memory-'))
let application
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const environment = { ...process.env, DUSTDESK_TEST_DATA_DIR: path.join(root, 'data'), DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'), DUSTDESK_TEST_DESKTOP_DIR: path.join(root, 'desktop'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' }
async function ordinaryMemory(executable, args, label) {
  if (process.platform !== 'win32') return
  const child = spawn(executable, args, { env: environment, windowsHide: true, stdio: 'ignore' })
  try {
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    await pause(5000)
    assert.equal(child.exitCode, null, 'The ordinary runtime remains running')
    const script = `$processRows = Get-CimInstance Win32_Process; $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(${child.pid}); do { $added = $false; foreach ($row in $processRows) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true } } } while ($added); @(Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $ids.Contains([int]$_.IDProcess) } | Select-Object IDProcess,WorkingSetPrivate) | ConvertTo-Json -Compress`
    const data = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true }))
    const samples = Array.isArray(data) ? data : [data]
    const totalMiB = samples.reduce((sum, p) => sum + Number(p.WorkingSetPrivate), 0) / 1048576
    console.log(JSON.stringify({ label, processes: samples.length, privateWorkingSetMiB: +totalMiB.toFixed(2), debugger: false }))
    const budget = Number(process.env.DUSTDESK_MEMORY_BUDGET_MIB)
    if (Number.isFinite(budget) && budget > 0 && !label.startsWith('baseline')) assert.ok(totalMiB < budget, `${label}: ${totalMiB.toFixed(2)} MiB must be below ${budget} MiB`)
  } finally {
    if (child.pid && child.exitCode === null) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
  }
}
async function until(check) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) { if (await check()) return; await pause(100) }
  throw Error('Timed out waiting for background state')
}
async function workspace() { return JSON.parse(await readFile(path.join(root, 'data', 'workspace.json'), 'utf8')) }
async function memory(label) {
  if (process.platform !== 'win32') return
  const processes = await application.evaluate(({ app }) => app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type })))
  const ids = processes.map(p => p.pid).join(',')
  const counters = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command', `$ids = @(${ids}); @(Get-CimInstance Win32_PerfRawData_PerfProc_Process | Where-Object { $ids -contains [int]$_.IDProcess } | Select-Object IDProcess,WorkingSetPrivate) | ConvertTo-Json -Compress`], { encoding: 'utf8', windowsHide: true }))
  const samples = Array.isArray(counters) ? counters : [counters]
  assert.equal(samples.length, processes.length, 'Every Electron process participates in the sample')
  console.log(JSON.stringify({ label, processes: processes.length, privateWorkingSetMiB: +(samples.reduce((sum, p) => sum + Number(p.WorkingSetPrivate), 0) / 1048576).toFixed(2) }))
}
try {
  application = await electron.launch({
    ...(process.env.DUSTDESK_PRESET_EXECUTABLE ? { executablePath: process.env.DUSTDESK_PRESET_EXECUTABLE } : {}),
    args: [...(process.env.DUSTDESK_PRESET_EXECUTABLE ? [] : [path.resolve('out/main/index.js')]), '--hidden'],
    env: environment
  })
  await until(async () => { try { await workspace(); return true } catch { return false } })
  await pause(1500)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0, 'Tray startup must not allocate a hidden renderer')
  await assert.rejects(access(path.join(root, 'user-data', 'LanTransfers', 'identity.json')), { code: 'ENOENT' })
  await memory('tray startup')

  // Substitute reads inside this isolated app; do not modify the user's clipboard.
  await application.evaluate(({ clipboard, nativeImage }) => {
    clipboard.readText = () => 'background-memory-regression'
    clipboard.readImage = () => nativeImage.createEmpty()
  })
  await until(async () => (await workspace()).ClipboardHistory.some(item => item.Text === 'background-memory-regression'))
  await application.evaluate(({ clipboard }) => {
    const fs = process.getBuiltinModule('fs').promises
    const rename = fs.rename
    globalThis.clipboardRetryFailed = false
    fs.rename = async (source, target) => {
      if (!globalThis.clipboardRetryFailed && String(target).endsWith('workspace.json')) {
        globalThis.clipboardRetryFailed = true
        throw Error('SIMULATED_CLIPBOARD_WRITE_FAILURE')
      }
      return rename(source, target)
    }
    globalThis.restoreClipboardRename = () => { fs.rename = rename }
    clipboard.readText = () => 'background-retry-without-changing-clipboard'
  })
  await until(async () => (await workspace()).ClipboardHistory.some(item => item.Text === 'background-retry-without-changing-clipboard'))
  assert.equal(await application.evaluate(() => { globalThis.restoreClipboardRename(); return globalThis.clipboardRetryFailed }), true)
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0)
  await application.evaluate(({ app }) => { app.emit('second-instance') })
  const page = await application.firstWindow()
  await page.locator('h1').waitFor()
  assert.ok((await page.evaluate(() => window.dustdesk.loadWorkspace())).ClipboardHistory.some(item => item.Text === 'background-memory-regression'))
  await pause(3000)
  await memory('main window')

  const capturePromise = application.waitForEvent('window')
  await page.evaluate(() => window.dustdesk.showQuickCapture())
  const capture = await capturePromise
  await capture.getByLabel('记录标题').fill('Retained after renderer release')
  await capture.getByLabel('记录正文').fill('Draft body')
  await page.evaluate(() => window.dustdesk.hideQuickCapture())
  await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))
  const reopenedPromise = application.waitForEvent('window')
  await page.evaluate(() => window.dustdesk.showQuickCapture())
  const reopened = await reopenedPromise
  await reopened.getByLabel('记录标题').waitFor()
  assert.equal(await reopened.getByLabel('记录标题').inputValue(), 'Retained after renderer release')
  assert.equal(await reopened.getByLabel('记录正文').inputValue(), 'Draft body')
  await page.evaluate(() => window.dustdesk.hideQuickCapture())
  await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))

  const widgetPromise = application.waitForEvent('window')
  await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))
  const widget = await widgetPromise
  await widget.locator('.widget-content').waitFor()
  await widget.evaluate(() => window.dustdesk.hideMainWindow())
  await until(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 1))
  await pause(3000)
  await memory('tray with one widget')
  assert.equal((await widget.evaluate(() => window.dustdesk.getWidgetVisibility(['todo']))).todo, true)
  const mainPromise = application.waitForEvent('window')
  await widget.evaluate(() => window.dustdesk.showMainWindow())
  const main = await mainPromise
  await main.locator('h1').waitFor()
  // An unsubmitted task on the overview must prevent renderer release.
  await main.getByPlaceholder('添加一项任务...').fill('Keep this unsaved task')
  await main.evaluate(() => window.dustdesk.hideMainWindow())
  await pause(500)
  assert.equal(main.isClosed(), false)
  await widget.evaluate(() => window.dustdesk.showMainWindow())
  assert.equal(await main.getByPlaceholder('添加一项任务...').inputValue(), 'Keep this unsaved task')
  console.log('Tray-only clipboard persistence, lazy main window, quick capture draft release/reopen and widget visibility passed')
  await application.evaluate(({ app }) => app.exit())
  await application.close()
  application = undefined
  // Playwright enables debugging in the browser/renderer. Also sample an
  // ordinary app with the same saved widget and no debugger attached.
  const executable = process.env.DUSTDESK_PRESET_EXECUTABLE ?? createRequire(import.meta.url)('electron')
  await ordinaryMemory(executable, [...(process.env.DUSTDESK_PRESET_EXECUTABLE ? [] : [path.resolve('out/main/index.js')]), '--hidden'], 'ordinary tray with one widget')
  if (process.env.DUSTDESK_MEMORY_BASELINE_EXECUTABLE) await ordinaryMemory(process.env.DUSTDESK_MEMORY_BASELINE_EXECUTABLE, ['--hidden'], 'baseline tray with one widget')
} finally {
  if (application) { await application.evaluate(({ app }) => app.exit()).catch(() => {}); await application.close().catch(() => {}) }
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
