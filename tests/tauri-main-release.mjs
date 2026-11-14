import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, readFile, rename, rmdir, rm } from 'node:fs/promises'
import { execFile, spawn, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { chromium } from 'playwright'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { operateMenu } from './tauri-menu.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { clipboardFixture } from './tauri-clipboard-support.mjs'

const run = promisify(execFile)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
async function nativeWindow(app, action = 'snapshot') {
  const script = path.resolve('tests/tauri-main-window.ps1')
  const parameters = Buffer.from(JSON.stringify({ script, processId: app.child.pid, action })).toString('base64')
  const command = "$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + parameters + "'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Action $parameters.action"
  const result = await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 })
  return JSON.parse(result.stdout.trim())
}
const report = 'artifacts/tauri-migration/main-release-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('main overview reclamation protects real drafts, services, native identity and last-WebView residency', async suite => {
  let app = await launchTauri({ releaseDelayMs: 400 }); let page; let failed = false; const scenarios = []; const evidence = {}; const errors = []
  const scenario = async (name, callback) => { await suite.test(name, async () => { try { await callback(); scenarios.push(name) } catch (error) { failed = true; console.error(app.output()); throw error } }); if (failed) throw Error('Main release scenario failed: ' + name) }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const attachPage = target => { target.on('pageerror', error => errors.push(String(error))); return target }
  const show = async () => { await app.invoke('prototype_open_workspace'); page = attachPage(await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => !target.isClosed() && target.url().includes('tauri.html')))); await page.locator('.app-shell').waitFor(); return page }
  const closed = target => waitFor(() => target.isClosed(), 12000)
  const retained = async () => { const before = page; await delay(1800); assert.equal(before.isClosed(), false); assert.equal(app.child.exitCode, null) }
  const sockets = new Set(); let requested = false
  const server = createServer(() => { requested = true }); server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port
  try {
    const electron = await mainFixture(suite); const initial = await electron.load(); initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false; initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; initial.Settings.SidebarHidden = []
    const menuPath = path.join(app.root, 'main-release-menu.txt'); await writeFile(menuPath, 'isolated main menu'); initial.Launchers = [{ Id: randomUUID(), Name: '主窗菜单验证', Path: menuPath }]
    initial.DesktopCategories = [{ Id: randomUUID(), Name: '主窗回收菜单授权分类', ItemPaths: [menuPath], IsCollapsed: false }]
    initial.LinkGroups = [{ Id: 'main-release-group', Name: '隔离资源', Links: [{ Id: 'main-release-link', Name: '等待资源', Url: origin + '/hold', CreatedAt: '2026-11-10T00:00:00.000Z', UpdatedAt: '2026-11-10T00:00:00.000Z' }] }]
    await app.invoke('prototype_workspace_initialize', { state: initial }); await show()
    const location = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json'); const disk = async () => JSON.parse(await readFile(location, 'utf8'))
    await scenario('a clean overview releases its native WebView and recreates lazily with its same-process geometry', async () => {
      const before = page; await nativeWindow(app, 'move'); const bounds = await nativeWindow(app); await api('hideMainWindow'); await closed(before); assert.equal(app.child.exitCode, null)
      await show(); assert.notEqual(page, before); const restored = await nativeWindow(app); for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored[field] - bounds[field]) <= 2, JSON.stringify({ bounds, restored })); evidence.sameProcessBounds = restored
    })
    await scenario('a persisted nonempty quick note survives reclamation without treating all saved textarea content as a dirty draft', async () => {
      const state = await api('loadWorkspace'); state.QuickNote = '主窗回收后仍在的快速记录-' + randomUUID(); assert.equal((await api('saveWorkspace', state)).ok, true); const text = state.QuickNote
      await waitFor(async () => await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue() === text); const before = page; await api('hideMainWindow'); await closed(before); await show(); assert.equal(await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), text); evidence.savedQuickNote = true
    })
    await scenario('recreated maximized windows retain their earlier normal rectangle when restored', async () => {
      await nativeWindow(app, 'move'); const normal = await nativeWindow(app); await nativeWindow(app, 'maximize'); assert.equal((await nativeWindow(app)).maximized, true)
      const before = page; await api('hideMainWindow'); await closed(before); await show(); assert.equal((await nativeWindow(app)).maximized, true); await show(); assert.equal((await nativeWindow(app)).maximized, true)
      await nativeWindow(app, 'minimize'); await show(); assert.equal((await nativeWindow(app)).maximized, true)
      await nativeWindow(app, 'restore'); const restored = await nativeWindow(app); for (const field of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(restored[field] - normal[field]) <= 2, JSON.stringify({ normal, restored }))
    })
    await scenario('unsaved overview input, global search and non-overview pages retain their actual UI instead of being discarded', async () => {
      await page.getByPlaceholder('添加一项任务...').fill('尚未提交的概览任务'); await api('hideMainWindow'); await retained(); await show(); assert.equal(await page.getByPlaceholder('添加一项任务...').inputValue(), '尚未提交的概览任务'); await page.getByPlaceholder('添加一项任务...').fill('')
      await page.getByRole('combobox', { name: '全局搜索' }).fill('保留查询'); await api('hideMainWindow'); await retained(); await show(); assert.equal(await page.getByRole('combobox', { name: '全局搜索' }).inputValue(), '保留查询'); await page.getByRole('combobox', { name: '全局搜索' }).fill('')
      await page.getByRole('button', { name: '便签', exact: true }).click(); await page.getByLabel('便签标题').waitFor(); await api('hideMainWindow'); await retained(); await show(); await page.getByLabel('便签标题').waitFor(); await page.getByRole('button', { name: '概览', exact: true }).click()
    })
    await scenario('a visited tool keeps its mounted input after returning to overview and hiding', async () => {
      await page.getByRole('button', { name: '文本工具箱', exact: true }).click(); await page.getByLabel('文本输入').fill('工具草稿不能回收'); await page.getByRole('button', { name: '概览', exact: true }).click(); await api('hideMainWindow'); await retained(); await show(); await page.getByRole('button', { name: '文本工具箱', exact: true }).click(); assert.equal(await page.getByLabel('文本输入').inputValue(), '工具草稿不能回收')
      await page.screenshot({ path: 'artifacts/tauri-migration/main-release-tool-retained.png' }); await page.reload(); await page.locator('.app-shell').waitFor()
    })
    await scenario('actual failed workspace writes retain the pending save queue after its notification expires and recovery permits later release', async () => {
      const backup = location + '.bak'; const held = backup + '.main-held'; await rename(backup, held); await mkdir(backup)
      try { await page.getByPlaceholder('把刚刚想到的事记下来...').fill('主窗磁盘失败的快速记录'); await page.getByText('保存失败，修改仍保留在界面中；下次保存或退出时会重试', { exact: true }).waitFor(); await api('hideMainWindow'); await delay(3800); assert.equal(page.isClosed(), false); assert.notEqual((await disk()).QuickNote, '主窗磁盘失败的快速记录'); await show(); assert.equal(await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), '主窗磁盘失败的快速记录') } finally { await rmdir(backup); await rename(held, backup) }
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('主窗恢复后保存的快速记录'); await waitFor(async () => (await disk()).QuickNote === '主窗恢复后保存的快速记录'); const before = page; await api('hideMainWindow'); await closed(before); await show(); assert.equal(await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), '主窗恢复后保存的快速记录')
    })
    await scenario('composition and a genuinely stalled release check retain the window and reopening invalidates the old nonce', async () => {
      await page.getByPlaceholder('添加一项任务...').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '中' }))); await api('hideMainWindow'); await retained(); await show(); await page.getByPlaceholder('添加一项任务...').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '中' })))
      await page.evaluate(async () => { window.__mainReleaseIds = []; await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'window:release-check', target: { kind: 'WebviewWindow', label: 'workspace-main' }, handler: window.__TAURI_INTERNALS__.transformCallback(event => window.__mainReleaseIds.push(event.payload)) }); window.__mainReleaseCount = 0; window.__removeMainGuard = window.dustdesk.onMainWindowReleaseCheck(() => { if (++window.__mainReleaseCount === 1) { window.__mainStallStarted = Date.now(); const end = Date.now() + 4300; while (Date.now() < end) {} window.__mainStallEnded = Date.now(); return true } return false }) })
      await api('hideMainWindow'); await delay(5100); assert.equal(page.isClosed(), false); const requestId = await page.evaluate(() => window.__mainReleaseIds[0]); assert.ok(requestId); assert.ok(await page.evaluate(() => window.__mainStallEnded - window.__mainStallStarted >= 4300)); await show(); assert.equal(await app.invoke('window_release_ready', { requestId, ready: true }, page), false); await assert.rejects(app.invoke('window_release_ready', { requestId, ready: true }), /not allowed|权限|denied/i); await page.evaluate(() => window.__removeMainGuard()); await waitFor(() => page.evaluate(() => !document.documentElement.inert)); evidence.realTimeoutMilliseconds = 3000
    })
    await scenario('an active real file menu owned by another widget vetoes main reclamation until quit cancellation releases the session', async () => {
      assert.equal((await api('setWidgetVisibility', 'organizer', true)).ok, true); const organizer = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html') && new URL(target.url()).searchParams.get('widget') === 'organizer')); await organizer.locator('.widget-head').click()
      assert.equal((await organizer.evaluate(menuPath => window.dustdesk.showPathContextMenu(menuPath), menuPath)).ok, true); assert.equal(JSON.parse(await operateMenu(app)).length, 3); await api('hideMainWindow'); await retained()
      await page.evaluate(() => { window.__mainMenuQuitVeto = window.dustdesk.onBeforeQuit(async () => { throw Error('main menu quit veto fixture') }) }); await assert.rejects(app.invoke('prototype_quit'), /main menu quit veto fixture/); await page.evaluate(() => window.__mainMenuQuitVeto()); await show(); await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      assert.equal((await api('hideWidget', 'organizer')).ok, true); await closed(organizer)
    })
    await scenario('an actual outstanding STA picker retains its main renderer until it is cancelled', async () => {
      await page.evaluate(() => { window.__mainPicker = window.dustdesk.pickPath('主窗回收对话框验证') }); await operateDialog(app, '主窗回收对话框验证'); await api('hideMainWindow'); await retained(); await operateDialog(app, '主窗回收对话框验证', 'cancel'); const reply = await page.evaluate(() => window.__mainPicker); assert.equal(reply.canceled, true); await show()
    })
    await scenario('an actual held resource scan prevents reclamation even when invoked outside the frontend tracked-write set', async () => {
      const resource = { kind: 'link', id: 'main-release-link', parentId: 'main-release-group', name: '等待资源', target: origin + '/hold', status: 'warning', detail: '' }
      await page.evaluate(resource => { window.__mainResource = window.dustdesk.checkResources({ requestId: 'main-release-resource', resource }) }, resource); await waitFor(() => requested); await api('hideMainWindow'); await retained(); await api('cancelResourceCheck', 'main-release-resource'); await page.evaluate(() => window.__mainResource); await show()
    })
    await scenario('native WM_CLOSE enters the same hide/release path and activation restores a minimized main window', async () => {
      await nativeWindow(app, 'minimize'); assert.equal((await nativeWindow(app)).minimized, true); await show(); assert.equal((await nativeWindow(app)).minimized, false)
      const before = page; await nativeWindow(app, 'close'); await closed(before); await show(); assert.notEqual(page, before)
    })
    await scenario('repeated hide/show races never let an old release cycle destroy the finally visible main window', async () => {
      for (let index = 0; index < 8; index++) { const old = page; await api('hideMainWindow'); await delay(index % 2 ? 430 : 70); await show(); assert.equal((await nativeWindow(app)).visible, true); if (!old.isClosed()) assert.equal(page, old) }
      await delay(1200); assert.equal(page.isClosed(), false); assert.equal((await nativeWindow(app)).visible, true)
    })
    await scenario('real quit begun during a stalled release keeps participants and cancellation restores editing', async () => {
      assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true); const task = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html'))); await task.getByLabel('桌面新增任务').waitFor(); await task.evaluate(() => { window.__quitMainVeto = window.dustdesk.onBeforeQuit(async () => { await new Promise(resolve => { window.__continueMainQuit = resolve }); throw Error('main release quit veto fixture') }) })
      await page.evaluate(() => { window.__mainQuitStallCount = 0; window.__removeMainQuitGuard = window.dustdesk.onMainWindowReleaseCheck(() => { if (++window.__mainQuitStallCount === 1) { const end = Date.now() + 4300; while (Date.now() < end) {} return true } return false }) }); await api('hideMainWindow'); await delay(650)
      const quit = app.invoke('prototype_quit').then(() => ({ ok: true }), error => ({ error: String(error) })); await waitFor(() => task.evaluate(() => Boolean(window.__continueMainQuit))); await delay(4500); assert.equal(page.isClosed(), false); await task.evaluate(() => window.__continueMainQuit()); const reply = await quit; assert.match(reply.error, /main release quit veto fixture/); await waitFor(() => page.evaluate(() => !document.documentElement.inert)); await page.evaluate(() => window.__removeMainQuitGuard()); await task.evaluate(() => window.__quitMainVeto()); await show(); assert.equal((await api('hideWidget', 'todo')).ok, true); await closed(task)
    })
    await scenario('reclaiming a sole main WebView retains the actual clipboard worker and single-instance activation recreates a usable main window', async () => {
      const guard = await clipboardFixture()
      try {
        const state = await api('loadWorkspace'); state.Settings.ClipboardMonitoringEnabled = true; assert.equal((await api('saveWorkspace', state)).ok, true); const expected = state.QuickNote; await guard.request('set-text', { text: 'before-main-release-' + randomUUID() })
        const quit = app.invoke('application_quit', {}, page).then(() => ({}), error => ({ error: String(error) })); await waitFor(() => app.child.exitCode !== null, 22000); const result = await quit; if (result.error) assert.match(result.error, /closed|destroyed|disconnected/i); assert.equal(app.child.exitCode, 0)
        const root = app.root; await app.close({ preserve: true }); app = await launchTauri({ workspace: true, rootDirectory: root, releaseDelayMs: 400, clipboardMonitoring: true }); page = app.page; await page.locator('.app-shell').waitFor(); assert.equal(app.browser.contexts().flatMap(context => context.pages()).filter(target => target.url().includes('prototype.html') || target.url().includes('widget.html')).length, 0)
        await api('hideMainWindow'); await closed(page); await delay(1200); assert.equal(app.child.exitCode, null); const text = 'no-main-webview-' + randomUUID(); await guard.request('set-text', { text }); await waitFor(async () => (await disk()).ClipboardHistory.some(item => item.Text === text)); evidence.clipboardWithoutMainWebView = true
        const activation = spawn(app.executable, ['--workspace'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, DUSTDESK_TEST_USER_DATA_DIR: path.join(app.root, 'user-data'), DUSTDESK_TAURI_DISABLE_HOTKEYS: '1' } }); try { await waitFor(() => activation.exitCode !== null, 12000); assert.equal(activation.exitCode, 0) } finally { if (activation.pid && activation.exitCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(activation.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} } }
        await waitFor(async () => { try { return (await fetch(app.endpoint + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } }); const resumed = await chromium.connectOverCDP(app.endpoint)
        try { page = await waitFor(() => resumed.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html'))); await page.locator('.app-shell').waitFor(); assert.equal(await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), expected); const quitting = app.invoke('application_quit', {}, page).then(() => ({}), error => ({ error: String(error) })); await waitFor(() => app.child.exitCode !== null, 22000); const reply = await quitting; if (reply.error) assert.match(reply.error, /closed|destroyed|disconnected/i); assert.equal(app.child.exitCode, 0) } finally { await resumed.close().catch(() => {}) }
        evidence.soleMainReclaimedAndReactivated = true
      } finally { await app.close({ preserve: true }); await guard.close() }
    })
    assert.deepEqual(errors, []); await writeFile(report, JSON.stringify({ productionReady: false, scope: 'conservative-clean-overview-native-reclamation', scenarios, evidence, pending: ['all-page-draft-checkpoints', 'production-takeover', 'mixed-DPI-IME-sleep-drop', 'five-run-full-Release-performance', 'installer-green-ZIP-rollback'] }, null, 2))
  } finally { await app.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) }
})
