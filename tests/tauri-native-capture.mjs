import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import { mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import { chromium } from 'playwright'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { clipboardFixture, holdClipboard } from './tauri-clipboard-support.mjs'

const run = promisify(execFile)
const report = 'artifacts/tauri-migration/native-capture-native.json'
await mkdir(path.dirname(report), { recursive: true })
await rm(report, { force: true })

// Click the actual notification icon and native submenu. No product command or
// synthetic renderer event is used to start a background capture.
async function tray(processId, ...captions) {
  const parameters = Buffer.from(JSON.stringify({ processId, captions, script: path.resolve('tests/tauri-pin-tray.ps1') })).toString('base64')
  const command = "$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + parameters + "'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Captions @($parameters.captions)"
  return JSON.parse((await run('pwsh.exe', ['-Sta', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 })).stdout.trim())
}
async function keyboardQuit(processId) {
  const parameters = Buffer.from(JSON.stringify({ processId, script: path.resolve('tests/tauri-pin-tray.ps1') })).toString('base64')
  const command = "$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + parameters + "'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Captions @('退出 DustDesk') -KeyboardContext"
  return JSON.parse((await run('pwsh.exe', ['-Sta', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 })).stdout.trim())
}

async function descendants(processId) {
  const command = '$rows=@(Get-CimInstance Win32_Process);$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(' + processId + ');do{$added=$false;foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)){$added=$true}}}while($added);ConvertTo-Json -InputObject @($rows|Where-Object{$ids.Contains([int]$_.ProcessId)}|Select-Object ProcessId,Name) -Compress'
  return JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 })).stdout)
}

await test('actual native tray capture starts with zero WebViews and survives cold main creation', { timeout: 240000 }, async suite => {
  let seed, child, browser, root, overlay, page, clipboard, failed = false, output = '', expectedOutputs = []
  const evidence = [], clicks = [], errors = [], processSamples = []
  const scenario = async (name, callback) => {
    await suite.test(name, { timeout: 60000 }, async () => { try { await callback(); evidence.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Native background capture failed: ' + name + '\n' + output)
  }
  const pages = () => browser?.contexts().flatMap(context => context.pages()).filter(target => !target.isClosed()) ?? []
  const invoke = (command, args = {}, target = overlay) => target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args })
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const source = (id, target = overlay, pin = false) => target.evaluate(async ({ id, pin }) => {
    const bytes = new Uint8Array(await window.__TAURI_INTERNALS__.invoke(pin ? 'screenshot_pin_source' : 'screenshot_overlay_source', pin ? { id, version: 0 } : { id }))
    const digest = await crypto.subtle.digest('SHA-256', bytes), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const image = await createImageBitmap(new Blob([bytes])), canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d')
    context.drawImage(image, 0, 0); image.close()
    const pixels = await crypto.subtle.digest('SHA-256', context.getImageData(0, 0, canvas.width, canvas.height).data)
    const hex = value => [...new Uint8Array(value)].map(value => value.toString(16).padStart(2, '0')).join('')
    return { length: bytes.length, sha256: hex(digest), pixelSha256: hex(pixels), width: view.getUint32(16), height: view.getUint32(20) }
  }, { id, pin })
  const outputFiles = () => readdir(path.join(root, 'user-data', 'tauri-preview', 'Workspace', 'Screenshots')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const cancel = async () => {
    const targets = pages().filter(target => target.url().includes('capture.html')), target = overlay
    await invoke('screenshot_overlay_cancel', {}, target).catch(error => { if (!target.isClosed() || !String(error).includes('closed')) throw error })
    await waitFor(() => targets.every(target => target.isClosed())); overlay = undefined
  }
  let endpoint, executable
  const clickCapture = async mode => { clicks.push(await tray(child.pid, '截图', mode === 'Region' ? '区域截图' : '全屏截图')) }
  const findCapture = async mode => {
    if (!browser?.isConnected()) {
      await waitFor(async () => { try { return (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })
      browser = await chromium.connectOverCDP(endpoint)
    }
    overlay = await waitFor(() => pages().find(target => target.url().includes('capture.html')))
    overlay.on('pageerror', error => errors.push(error.message))
    await overlay.locator(mode === 'Region' ? '.region-live-selector' : '.screenshot-editor').waitFor()
    if (mode !== 'Region') await waitFor(() => overlay.getByRole('button', { name: '在应用内编辑', exact: true }).isEnabled())
  }
  const noMain = () => assert.ok(pages().every(target => !/tauri\.html|prototype\.html/.test(target.url())), pages().map(target => target.url()).join('\n'))
  const assertZeroWebViews = async () => {
    const sample = await descendants(child.pid); processSamples.push(sample)
    assert.ok(sample.some(row => row.ProcessId === child.pid))
    assert.ok(sample.every(row => row.ProcessId === child.pid || row.Name.toLowerCase() === 'conhost.exe'), JSON.stringify(sample))
  }
  const startBackground = async () => {
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve))
    endpoint = 'http://127.0.0.1:' + port
    child = spawn(executable, ['--hidden', '--workspace'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'), DUSTDESK_TEST_DATA_DIR: path.join(root, 'data'), DUSTDESK_TEST_DESKTOP_DIR: path.join(root, 'desktop'), DUSTDESK_TAURI_DISABLE_HOTKEYS: '1', DUSTDESK_TAURI_TEST_RELEASE_DELAY_MS: '120', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1 --no-first-run' } })
    child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    await assertZeroWebViews(); assert.equal(child.exitCode, null)
  }
  try {
    await scenario('seed isolated settings then restart as a pure tray process without a main or prototype WebView', async () => {
      seed = await launchTauri({ workspace: true }); root = seed.root; executable = seed.executable
      await seed.page.getByRole('button', { name: '创建工作区', exact: true }).click(); await seed.page.locator('.app-shell').waitFor()
      await seed.page.evaluate(async () => { const state = await window.dustdesk.loadWorkspace(); const saved = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, ScreenshotDelaySeconds: 0, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false, ScreenshotAfterAction: 'edit' } }, state); if (!saved.ok) throw Error(saved.error) })
      await seed.close({ preserve: true }); seed = undefined
      await startBackground()
    })
    await scenario('physical tray region capture creates only selectors and cancellation releases the last WebView', async () => {
      await clickCapture('Region'); await findCapture('Region'); noMain()
      const metadata = await invoke('screenshot_overlay_document'); assert.equal(metadata.liveRegion, true); assert.equal(metadata.document.sourceAssetId, '')
      for (const command of ['workspace_load', 'workspace_save', 'screenshot_start', 'clipboard_read', 'application_quit']) await assert.rejects(invoke(command), /not allowed|权限|不允许/i)
      const selected = await invoke('screenshot_overlay_region', { rect: { x: 100, y: 100, width: 120, height: 90 } })
      assert.ok(selected.document.sourceAssetId); assert.equal((await source(selected.document.id)).width, selected.document.sourceRect.width)
      assert.deepEqual(await outputFiles(), [])
      await cancel(); await browser.close().catch(() => {}); browser = undefined
      await waitFor(async () => !(await descendants(child.pid)).some(row => row.Name.toLowerCase() === 'msedgewebview2.exe'))
      await assertZeroWebViews()
    })
    await scenario('a no-main editor with uncommitted text acknowledges actual tray quit and the next process starts without screenshot restoration', async () => {
      await clickCapture('FullScreen'); await findCapture('FullScreen'); noMain()
      await overlay.getByRole('button', { name: '文字', exact: true }).click(); await overlay.mouse.click(350, 500)
      await overlay.getByRole('textbox', { name: '标注文字' }).fill('后台截图临时文字')
      clicks.push(await keyboardQuit(child.pid)); await waitFor(() => child.exitCode !== null, 22000)
      assert.equal(child.exitCode, 0); assert.deepEqual(await outputFiles(), [])
      await browser?.close().catch(() => {}); browser = undefined; overlay = undefined
      await startBackground(); await assertZeroWebViews()
    })
    await scenario('physical tray fullscreen capture and pinning need no main page', async () => {
      await clickCapture('FullScreen'); await findCapture('FullScreen'); noMain()
      const metadata = await invoke('screenshot_overlay_document'), bytes = await source(metadata.document.id)
      assert.ok(bytes.length > 8); assert.equal(bytes.width, metadata.document.width); assert.equal(bytes.height, metadata.document.height)
      await overlay.getByRole('button', { name: '贴图', exact: true }).click(); await waitFor(() => overlay.isClosed()); overlay = undefined
      const pin = await waitFor(() => pages().find(target => target.url().includes('pin.html')))
      await pin.getByAltText('贴图', { exact: true }).waitFor(); noMain(); assert.deepEqual(await outputFiles(), [])
      const id = new URL(pin.url()).searchParams.get('pin')
      const rendered = await source(id, pin, true)
      assert.deepEqual({ width: rendered.width, height: rendered.height, pixels: rendered.pixelSha256 }, { width: bytes.width, height: bytes.height, pixels: bytes.pixelSha256 })
      await invoke('screenshot_pin_control', { id, action: 'edit', value: null }, pin)
      await findCapture('FullScreen'); noMain()
      await browser.contexts()[0].addInitScript(() => {
        if (!location.pathname.endsWith('/tauri.html') || sessionStorage.getItem('native-capture-ready-held')) return
        sessionStorage.setItem('native-capture-ready-held', '1')
        const original = window.fetch
        window.__captureReadyHold = true
        window.__captureReadyWaiting = false
        window.fetch = async (input, options) => {
          const url = typeof input === 'string' ? input : input.url
          if (url.endsWith('/screenshot_editor_pending') && window.__captureReadyHold) {
            window.__captureReadyWaiting = true
            await new Promise(resolve => { window.__captureReadyRelease = resolve })
            window.__captureReadyWaiting = false
          }
          return original.call(window, input, options)
        }
      })
      const original = await invoke('screenshot_overlay_document'), originalBytes = await source(original.document.id)
      await overlay.getByRole('button', { name: '在应用内编辑', exact: true }).click()
      page = await waitFor(() => pages().find(target => target.url().includes('tauri.html')))
      page.on('pageerror', error => errors.push(error.message))
      await page.locator('.app-shell').waitFor(); await waitFor(() => page.evaluate(() => window.__captureReadyWaiting))
      await overlay.getByRole('alert').filter({ hasText: '主编辑页准备接收截图超时' }).waitFor({ timeout: 20000 })
      assert.equal(overlay.isClosed(), false); assert.deepEqual(await source(original.document.id), originalBytes); assert.deepEqual(await outputFiles(), [])
      await page.evaluate(() => { window.__captureReadyHold = false; window.__captureReadyRelease() })
      await waitFor(() => page.evaluate(() => !window.__captureReadyWaiting))
      await overlay.getByRole('button', { name: '在应用内编辑', exact: true }).click()
      await page.locator('.screenshot-editor').waitFor(); await waitFor(() => overlay.isClosed()); overlay = undefined
      assert.equal(pages().filter(target => target.url().includes('tauri.html')).length, 1)
      assert.equal(pages().filter(target => target.url().includes('prototype.html')).length, 0)
      assert.equal(await page.getByRole('alert').count(), 0); assert.deepEqual(await outputFiles(), [])
      await invoke('screenshot_pin_control', { id, action: 'close', value: null }, pin).catch(error => { if (!pin.isClosed() || !String(error).includes('closed')) throw error })
      await waitFor(() => pin.isClosed())
    })
    await scenario('main reload retains the independent native source and its overlay can still hand off', async () => {
      await clickCapture('FullScreen'); await findCapture('FullScreen')
      const metadata = await invoke('screenshot_overlay_document'), before = await source(metadata.document.id)
      await page.reload(); await page.locator('.app-shell').waitFor()
      assert.equal(overlay.isClosed(), false); assert.deepEqual(await source(metadata.document.id), before)
      await overlay.getByRole('button', { name: '在应用内编辑', exact: true }).click()
      await waitFor(() => overlay.isClosed()); overlay = undefined; await page.locator('.screenshot-editor').waitFor()
      assert.equal(await page.getByRole('alert').count(), 0); assert.deepEqual(await outputFiles(), [])
    })
    await scenario('sealed maintenance refuses real tray capture then an explicit retry works after resume', async () => {
      const checkpoint = await invoke('drafts_prepare', {}, page)
      try { const offset = output.length; await clickCapture('Region'); await waitFor(() => /截图未启动/.test(output.slice(offset))); assert.equal(pages().filter(target => target.url().includes('capture.html')).length, 0) }
      finally { assert.equal(await invoke('drafts_end', { requestId: checkpoint.requestId }, page), true) }
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await clickCapture('Region'); await findCapture('Region'); await cancel()
    })
    await scenario('main-issued fullscreen capture publishes without reentering the session lock and remains bound to its caller', async () => {
      const result = await api('startScreenshot', 'FullScreen'); assert.equal(result.ok, true, JSON.stringify(result))
      await findCapture('FullScreen'); const metadata = await invoke('screenshot_overlay_document'); assert.ok((await source(metadata.document.id)).length > 8)
      const owned = overlay; await page.reload(); await page.locator('.app-shell').waitFor(); await waitFor(() => owned.isClosed()); overlay = undefined
      assert.equal((await api('readScreenshotDocument', metadata.document.id)).ok, false); assert.deepEqual(await outputFiles(), [])
    })
    await scenario('a delayed native request survives main reload while its selectors retain their own authority', async () => {
      await page.evaluate(async () => { const state = await window.dustdesk.loadWorkspace(); const saved = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, ScreenshotDelaySeconds: 2 } }, state); if (!saved.ok) throw Error(saved.error) })
      await clickCapture('Region'); await page.reload(); await page.locator('.app-shell').waitFor(); await findCapture('Region')
      await page.reload(); await page.locator('.app-shell').waitFor(); assert.equal(overlay.isClosed(), false)
      const selected = await invoke('screenshot_overlay_region', { rect: { x: 100, y: 100, width: 120, height: 90 } })
      assert.ok(selected.document.sourceAssetId); assert.ok((await source(selected.document.id)).length > 8)
      await cancel()
    })
    await scenario('a saved native source keeps its warning receipt across main reload and cannot publish the same request twice', async () => {
      clipboard = await clipboardFixture()
      await page.evaluate(async () => { const state = await window.dustdesk.loadWorkspace(); const saved = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, ScreenshotDelaySeconds: 0, ScreenshotAutoCopy: true } }, state); if (!saved.ok) throw Error(saved.error) })
      await clickCapture('FullScreen'); await findCapture('FullScreen')
      const metadata = await invoke('screenshot_overlay_document'), original = await source(metadata.document.id), release = await holdClipboard()
      let first
      try {
        first = await overlay.evaluate(async document => {
          const png = new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_source', { id: document.id }))
          const metadata = new TextEncoder().encode(JSON.stringify({ requestId: 'native-save-warning-once', document, action: 'save', format: 'png', pngLength: png.length, jpegLength: 0 }))
          const packet = new Uint8Array(4 + metadata.length + png.length); new DataView(packet.buffer).setUint32(0, metadata.length, true); packet.set(metadata, 4); packet.set(png, 4 + metadata.length)
          window.__nativeSavePacket = packet
          return window.__TAURI_INTERNALS__.invoke('screenshot_overlay_finish', packet)
        }, metadata.document)
      } finally { await release() }
      assert.equal(first.ok, true, JSON.stringify(first)); assert.match(first.warning, /自动复制失败/); assert.ok(first.path)
      expectedOutputs = await outputFiles(); assert.equal(expectedOutputs.length, 1)
      await page.reload(); await page.locator('.app-shell').waitFor(); assert.deepEqual(await source(metadata.document.id), original)
      const replay = await overlay.evaluate(() => window.__TAURI_INTERNALS__.invoke('screenshot_overlay_finish', window.__nativeSavePacket))
      assert.deepEqual(replay, first); assert.deepEqual(await outputFiles(), expectedOutputs); assert.equal(overlay.isClosed(), false)
      await cancel(); await clipboard.close(); clipboard = undefined
    })
    await scenario('normal quit after cancellation drains the shared main without publishing another screenshot', async () => {
      assert.deepEqual(await outputFiles(), expectedOutputs); assert.deepEqual(errors, [])
      clicks.push(await tray(child.pid, '退出 DustDesk')); await waitFor(() => child.exitCode !== null || child.signalCode !== null); assert.equal(child.exitCode, 0, output)
    })
    await writeFile(report, JSON.stringify({ productionReady: false, scope: 'isolated-physical-tray-region-fullscreen-zero-WebView-and-cold-editor-handoff', evidence, clicks, processSamples, remaining: ['global-shortcuts', 'clipboard-pin-entry', 'full-screenshot-maintenance-and-quit-checkpoints', 'physical-mixed-DPI-IME-hotplug-sleep', 'Release-performance-and-packaging'] }, null, 2) + '\n')
  } catch (error) {
    await writeFile('artifacts/tauri-migration/native-capture-failure.json', JSON.stringify({ output, pages: await Promise.all(pages().map(async target => ({ url: target.url(), alerts: await target.getByRole('alert').allTextContents().catch(() => []) }))) }, null, 2))
    throw error
  } finally {
    try { await clipboard?.close() } finally {
      await seed?.close(); await browser?.close().catch(() => {})
      if (child?.pid && child.exitCode === null && child.signalCode === null) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
  }
})
