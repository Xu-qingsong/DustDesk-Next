import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPackage } from '@electron/asar'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { waitFor } from './tauri-harness.mjs'
import { draftModuleUrl } from './draft-module.mjs'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

const { verifyDraftArchive } = await import(draftModuleUrl)
const report = 'artifacts/tauri-migration/electron-legacy-drafts-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('a native source lease binds actual prepared Electron storage and Data across controlled legacy draft export', { timeout: 300000 }, async suite => {
  let app = await launchDustDesk(); let failed = false; const scenarios = []; const evidence = {}; const requests = []
  const server = createServer((request, response) => { requests.push(request.url); response.end('must not be requested') }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  const root = app.tempRoot; const installation = path.join(root, '旧安装 # & v1'); const staging = path.join(root, 'legacy-staging'); const archive = path.join(installation, 'resources', 'app.asar'); const location = pathToFileURL(path.join(archive, 'out', 'renderer', 'index.html')).href; const destination = path.join(root, 'legacy-browser-drafts.json')
  const legacyId = 'legacy-note-fixture'; const key = 'widget-note:' + legacyId; const value = JSON.stringify({ title: '旧安装路径未提交便签🪶', text: '旧正文不能被执行页面覆盖', previousTitle: '原便签', previousText: '原正文' })
  const entries = { [key]: value, 'widget-task-draft:v1:todo': JSON.stringify({ title: '旧桌面任务草稿', requestId: 'legacy-stable-task' }), 'quick-capture-draft': JSON.stringify({ kind: 'note', title: '旧快速记录', text: '旧快速记录正文', requestId: 'legacy-stable-capture' }), 'access-token': 'do-not-read-or-export', 'other-cache': 'not-a-draft' }
  const scenario = async (name, callback) => { await suite.test(name, async () => { try { await callback(); scenarios.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Legacy draft scenario failed: ' + name) }
  const menu = () => app.electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('export-legacy-browser-drafts').click())
  const results = () => app.electronApp.evaluate(() => globalThis.__legacyResults)
  const run = async () => { const before = (await results()).length; await menu(); return waitFor(async () => (await results())[before], 45000) }
  const api = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const clean = async () => { await waitFor(() => app.window.evaluate(() => !document.documentElement.inert)); assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.protocol.isProtocolHandled('file')), false); assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === globalThis.__legacyLocation).length), 0); assert.equal(await app.electronApp.evaluate(() => globalThis.__legacyHelpers.every(child => child.exitCode !== null || child.signalCode !== null)), true) }
  try {
    const reference = await extractOfficialLegacyReference(root)
    await rename(reference.root, installation)
    evidence.officialRelease = reference.release
    evidence.helperSha256 = await fileDigest('src-tauri/target/debug/DustDesk.exe')
    await mkdir(path.join(staging, 'out', 'renderer'), { recursive: true })
    await app.electronApp.evaluate(async ({ BrowserWindow }, options) => {
      const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html') && !window.webContents.getURL().includes('widget=')); const window = new BrowserWindow({ show: false, webPreferences: { session: owner.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      const session = owner.webContents.session
      session.protocol.handle('file', request => request.url === options.location ? new Response('<!doctype html><title>Controlled test storage seed</title>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'none'" } }) : session.fetch(request, { bypassCustomProtocolHandlers: true }))
      try { await window.loadURL(options.location); await window.webContents.executeJavaScript('for (const [key, value] of Object.entries(' + JSON.stringify(options.entries) + ')) localStorage.setItem(key, value)'); owner.webContents.session.flushStorageData() } finally { window.destroy(); session.protocol.unhandle('file') }
    }, { location, entries })
    const child = app.electronApp.process(); const quit = app.electronApp.evaluate(({ app }) => app.quit()).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) }); await waitFor(() => child.exitCode !== null, 25000); await quit; assert.equal(child.exitCode, 0); await closeDustDesk({ ...app, preserveTempRoot: true })
    const poison = '<!doctype html><script>localStorage.setItem(' + JSON.stringify(key) + ',' + JSON.stringify(JSON.stringify({ title: 'MALICIOUS OVERWRITE', text: '', previousTitle: '', previousText: '' })) + ');fetch(' + JSON.stringify(origin + '/script-ran') + ');window.open(' + JSON.stringify(origin + '/new-window') + ')</script><img src="' + origin + '/image"><iframe src="' + origin + '/frame"></iframe>'
    await writeFile(path.join(staging, 'out', 'renderer', 'index.html'), poison)
    const beforeArchive = await fileDigest(archive)
    const bootstrap = path.join(root, 'legacy-source-test-bootstrap.cjs')
    await writeFile(bootstrap, `globalThis.__legacyTestFs = require('node:fs'); globalThis.__legacyHelpers = []; const processModule = require('node:child_process'); const originalSpawn = processModule.spawn; processModule.spawn = (...args) => { const child = originalSpawn(...args); if (args[1]?.includes('--legacy-source-lease-v1')) globalThis.__legacyHelpers.push(child); return child; }; require(${JSON.stringify(path.resolve('out/main/index.js'))});`)
    app = await launchDustDesk({ tempRoot: root, bootstrap })
    await app.electronApp.evaluate(({ dialog, ipcMain }, options) => {
      globalThis.__legacyRoot = options.installation; globalThis.__legacyLocation = options.location; globalThis.__legacyDestination = options.destination; globalThis.__legacyResults = []; globalThis.__legacyReaderPreferences = []
      dialog.showOpenDialog = async () => ({ canceled: globalThis.__legacyRoot === null, filePaths: globalThis.__legacyRoot === null ? [] : [globalThis.__legacyRoot] })
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: globalThis.__legacyDestination })
      dialog.showMessageBox = async (...args) => { const options = args.at(-1); globalThis.__legacyResults.push({ kind: 'message', message: options.message }); return { response: 0 } }
      dialog.showErrorBox = (title, message) => globalThis.__legacyResults.push({ kind: 'error', title, message })
      ipcMain.on('draft-reader:ready', event => { const preferences = event.sender.getLastWebPreferences(); globalThis.__legacyReaderPreferences.push({ sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration }) })
    }, { installation, destination, location })
    const state = await api('loadWorkspace'); state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false; assert.equal((await api('saveWorkspace', state)).ok, true)
    await scenario('actual persisted storage survives restart and official code is authenticated but never executed or fetched', async () => {
      const outcome = await run(); assert.equal(outcome.kind, 'message', outcome.message); await clean(); const verified = await verifyDraftArchive(await readFile(destination, 'utf8')); const exported = Object.fromEntries(verified.payload.entries.map(entry => [entry.key, entry.value]))
      assert.equal(exported[key], value); assert.equal(JSON.parse(exported['widget-task-draft:v1:todo']).requestId, 'legacy-stable-task'); assert.equal(JSON.parse(exported['quick-capture-draft']).title, '旧快速记录'); assert.equal(exported['access-token'], undefined); assert.equal(exported['other-cache'], undefined)
      assert.equal(verified.payload.source.workspaceFingerprint, createHash('sha256').update(await readFile(path.join(root, 'data', 'workspace.json'))).digest('hex')); assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), beforeArchive); assert.deepEqual(requests, [])
      const preferences = await app.electronApp.evaluate(() => globalThis.__legacyReaderPreferences); assert.ok(preferences.length); assert.ok(preferences.every(value => value.sandbox && value.contextIsolation && !value.nodeIntegration)); evidence.oldAsarNotExecuted = true; evidence.exportedKeys = Object.keys(exported)
    })
    await scenario('changed old code cannot reuse the native binding or reach the private browser reader', async () => {
      const preserved = await readFile(destination, 'utf8'), count = await app.electronApp.evaluate(() => globalThis.__legacyReaderPreferences.length)
      const original = archive + '.original'; await rename(archive, original)
      try {
        await createPackage(staging, archive)
        const failure = await run(); assert.equal(failure.kind, 'error'); assert.match(failure.message, /文件大小不属于|未同时匹配/)
        assert.equal(await app.electronApp.evaluate(() => globalThis.__legacyReaderPreferences.length), count)
        assert.equal(await readFile(destination, 'utf8'), preserved); assert.deepEqual(requests, [])
      } finally { await rm(archive, { force: true }); await rename(original, archive) }
      await clean()
    })
    await scenario('source code and actual Data remain physically pinned while the controlled browser is reading', async () => {
      await app.electronApp.evaluate(({ ipcMain }, paths) => {
        const filesystem = globalThis.__legacyTestFs
        ipcMain.once('draft-reader:ready', () => {
          globalThis.__legacyPinnedChecks = paths.map(file => { try { filesystem.writeFileSync(file, 'must-not-write'); return false } catch { return true } })
        })
      }, [path.join(root, 'data', 'workspace.json'), path.join(installation, 'DustDesk.exe'), archive])
      assert.equal((await run()).kind, 'message'); assert.deepEqual(await app.electronApp.evaluate(() => globalThis.__legacyPinnedChecks), [true, true, true]); await clean()
      evidence.pinnedDuringActualReader = true
    })
    await scenario('native helper loss during real browser collection aborts publication and releases editors', async () => {
      const preserved = await readFile(destination, 'utf8')
      await app.electronApp.evaluate(({ ipcMain }) => { ipcMain.once('draft-reader:ready', () => globalThis.__legacyHelpers.at(-1).kill()) })
      const failure = await run(); assert.equal(failure.kind, 'error'); assert.match(failure.message, /来源租约|EPIPE|pipe/i)
      assert.equal(await readFile(destination, 'utf8'), preserved); await clean()
      assert.equal((await run()).kind, 'message'); await clean()
      evidence.nativeHelperLossBlockedPublication = true
    })
    await scenario('an existing file protocol handler is refused rather than overwritten and stays usable after failure', async () => {
      const preserved = await readFile(destination, 'utf8'); await app.electronApp.evaluate(({ BrowserWindow }) => { const session = BrowserWindow.getAllWindows()[0].webContents.session; session.protocol.handle('file', request => session.fetch(request, { bypassCustomProtocolHandlers: true })) })
      try { const failure = await run(); assert.equal(failure.kind, 'error'); assert.match(failure.message, /已有处理器/); assert.equal(await readFile(destination, 'utf8'), preserved); assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.protocol.isProtocolHandled('file')), true) } finally { await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.protocol.unhandle('file')) }
      await clean(); assert.equal((await run()).kind, 'message'); await clean(); assert.deepEqual(requests, [])
    })
    await scenario('destroying the actual private reader cancels export and restores the file protocol before the next attempt', async () => {
      const preserved = await readFile(destination, 'utf8'); await app.electronApp.evaluate(({ ipcMain, BrowserWindow }) => { ipcMain.once('draft-reader:ready', event => BrowserWindow.fromWebContents(event.sender)?.destroy()) })
      const failure = await run(); assert.equal(failure.kind, 'error'); assert.match(failure.message, /读取窗口已关闭/); await clean(); assert.equal(await readFile(destination, 'utf8'), preserved); assert.equal((await run()).kind, 'message'); await clean(); assert.deepEqual(requests, [])
    })
    await scenario('a foreign WebContents using the real private request token cannot replace the old source collection', async () => {
      await app.electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
        ipcMain.once('draft-reader:result', (_event, token) => { const owner = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('index.html') && window.webContents.getURL() !== globalThis.__legacyLocation); ipcMain.emit('draft-reader:result', { sender: owner.webContents, senderFrame: owner.webContents.mainFrame }, token, [{ key: 'widget-task-draft:v1:todo', value: JSON.stringify({ title: 'forged foreign collection', requestId: 'forged' }) }]) })
      })
      assert.equal((await run()).kind, 'message'); const verified = await verifyDraftArchive(await readFile(destination, 'utf8')); assert.equal(verified.payload.entries.find(entry => entry.key === key).value, value); await clean(); assert.deepEqual(requests, [])
    })
    await scenario('cancelled folder selection leaves profile, native protocol and earlier export unchanged', async () => {
      const preserved = await readFile(destination, 'utf8'); const before = (await results()).length; await app.electronApp.evaluate(() => { globalThis.__legacyRoot = null }); await menu(); await new Promise(resolve => setTimeout(resolve, 200)); assert.equal((await results()).length, before); await clean(); assert.equal(await readFile(destination, 'utf8'), preserved); await app.electronApp.evaluate((_electron, installation) => { globalThis.__legacyRoot = installation }, installation)
    })
    await scenario('normal app navigation and current-origin export still work after the private reader tears down', async () => {
      await app.window.reload(); await app.window.locator('.app-shell').waitFor(); const before = (await results()).length; await app.electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('export-browser-drafts').click()); await waitFor(async () => (await results())[before]?.kind === 'message'); await clean(); assert.deepEqual(requests, []); evidence.protocolRestored = true
    })
    await writeFile(report, JSON.stringify({ productionReady: false, migrationComplete: false, scope: 'live-native-official-source-actual-prepared-session-and-data-bound-legacy-export', scenarios, evidence, pending: ['historical-profile-authentication', 'frozen-lan-state-and-composed-production-source-snapshot', 'production-cutover-and-full-rollback', 'real-system-folder-dialog'] }, null, 2))
  } finally { await closeDustDesk(app); await new Promise(resolve => server.close(resolve)) }
})
