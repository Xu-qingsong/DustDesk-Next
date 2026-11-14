import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, lstat } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

export async function waitFor(check, timeout = 30000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw Error('Timed out waiting for Tauri prototype')
}

export async function launchTauri({ workspace = false, application = false, expectRecoveryBlock = false, desktopDirectory, rootDirectory, clipboardMonitoring = false, hotkeysEnabled = false, releaseDelayMs, draftLeaseMs, widgetStartup, updateBase, lanLocalOnly = false, startupTimeoutMs = 30000 } = {}) {
  assert.equal(process.platform, 'win32', 'Native prototype checks require Windows')
  assert.ok(Number.isInteger(startupTimeoutMs) && startupTimeoutMs >= 100 && startupTimeoutMs <= 120000, 'Startup timeout must be between 100 and 120000 ms')
  if(desktopDirectory!==undefined) assert.ok(path.isAbsolute(desktopDirectory),'Test desktop must be absolute')
  const root = rootDirectory === undefined ? await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-')) : path.resolve(rootDirectory)
  assert.ok(path.isAbsolute(root) && root.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(root).startsWith('dustdesk-tauri-test-'), 'Restart may only reuse an isolated harness root')
  assert.ok(!(await lstat(root)).isSymbolicLink())
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  const executable = path.resolve(process.env.DUSTDESK_TAURI_EXECUTABLE || 'src-tauri/target/debug/DustDesk.exe')
  let browser
  let output = ''
  const child = spawn(executable, widgetStartup ? ['--hidden'] : application ? [] : workspace ? ['--workspace'] : ['--prototype'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env,
    DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'),
    DUSTDESK_TEST_DATA_DIR: path.join(root, 'data'),
    DUSTDESK_TEST_DESKTOP_DIR: desktopDirectory??path.join(root, 'desktop'),
    DUSTDESK_TAURI_DISABLE_HOTKEYS: hotkeysEnabled ? undefined : '1',
    DUSTDESK_TAURI_TEST_UPDATE_BASE: updateBase,
    DUSTDESK_TAURI_TEST_LAN_LOCAL_ONLY: lanLocalOnly ? '1' : undefined,
    DUSTDESK_TAURI_ENABLE_TEST_CLIPBOARD: clipboardMonitoring ? '1' : undefined,
    DUSTDESK_TAURI_TEST_RELEASE_DELAY_MS: releaseDelayMs === undefined ? undefined : String(releaseDelayMs),
    DUSTDESK_TAURI_TEST_DRAFT_LEASE_MS: draftLeaseMs === undefined ? undefined : String(draftLeaseMs),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1 --no-first-run'
  } })
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  let launchError
  child.on('error', error => { launchError = error })
  const close = async ({ preserve = false } = {}) => {
    await browser?.close().catch(() => {})
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    }
    if (!preserve) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  let stage = 'debug-endpoint'
  try {
    const endpoint = 'http://127.0.0.1:' + port
    await waitFor(async () => {
      if (launchError) throw launchError
      if (child.exitCode !== null || child.signalCode !== null) throw Error('Tauri exited: ' + (child.exitCode ?? child.signalCode) + '\n' + output)
      try { const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) }); return response.ok } catch { return false }
    }, startupTimeoutMs)
    stage = 'connect-cdp'
    browser = await chromium.connectOverCDP(endpoint, { timeout: startupTimeoutMs })
    stage = 'page'
    const page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(page => widgetStartup ? page.url().includes('widget.html') && new URL(page.url()).searchParams.get('widget') === widgetStartup : page.url().includes((workspace || application) ? 'tauri.html' : 'prototype.html') && !page.url().includes('probe=')), startupTimeoutMs)
    stage = 'renderer'
    await (widgetStartup ? page.locator('.widget-head') : (workspace || application) ? page.locator(expectRecoveryBlock ? '[role="alert"]' : '.tauri-workspace-start, .app-shell').first() : page.getByTestId('native-probe')).waitFor({ timeout: startupTimeoutMs })
    await waitFor(() => page.evaluate(() => Boolean(window.__TAURI_INTERNALS__)), startupTimeoutMs)
    const invoke = (command, args = {}, target = page) => target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args })
    const findPage = async kind => waitFor(() => browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('probe=' + kind)))
    return { child, browser, page, invoke, findPage, root, executable, endpoint, close, output: () => output }
  } catch (error) {
    const pages = await Promise.all((browser?.contexts().flatMap(context => context.pages()).slice(0, 16) ?? []).map(async page => ({ url: page.url(), alerts: await page.getByRole('alert').allTextContents().then(values => values.map(value => value.slice(0, 2048))).catch(() => []) })))
    const diagnostics = { stage, root, executable, pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, output: output.slice(-65536), pages, callerOwnsRoot: rootDirectory !== undefined }
    if (error && typeof error === 'object') error.launchDiagnostics = diagnostics
    console.error('Native Tauri launch failed:', JSON.stringify(diagnostics))
    await close({ preserve: rootDirectory !== undefined })
    throw error
  }
}
