import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import ts from 'typescript'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { draftModuleSource, draftModuleUrl } from './draft-module.mjs'
import { electronPreloadSource } from './preload-source.mjs'

const migration = await import(draftModuleUrl)
const browserPath = [process.env.DUSTDESK_HEADLESS_BROWSER, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value))
const report = 'artifacts/tauri-migration/draft-format-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
const moduleSource = ts.transpileModule(await draftModuleSource(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const install = page => page.evaluate('(() => { const exports = {}; ' + moduleSource + '; window.__draftMigration = exports; })()')
await test('shared browser draft archive round trips real Electron renderer inputs through native WebView2 without claiming a production checkpoint workflow', { skip: !browserPath && 'No headless browser available' }, async suite => {
  let app = await launchTauri(); const scenarios = []; const evidence = {}; let browser; let server; let failed = false
  const scenario = async (name, callback) => { await suite.test(name, async () => { try { await callback(); scenarios.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Draft format scenario failed: ' + name) }
  try {
    const electron = await mainFixture(suite); const initial = await electron.load(); initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false; initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; await writeFile(path.join(electron.data, 'workspace.json'), JSON.stringify(initial))
    const fingerprint = await migration.draftDigest(JSON.stringify(initial)); const root = path.resolve('out/tauri')
    server = createServer(async (request, response) => { try { const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname)); const relative = path.relative(root, file); if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return } response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] ?? 'application/octet-stream'); response.end(await readFile(file)) } catch { response.writeHead(404); response.end() } }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = 'http://127.0.0.1:' + server.address().port
    browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu', '--disable-background-networking'] })
    const preload = await electronPreloadSource()
    const context = async () => {
      const result = await browser.newContext(); await result.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
      await result.exposeFunction('__draftInvoke', (channel, args) => electron.invoke(channel, ...args))
      await result.addInitScript({ content: '(() => { const process = { platform: "win32" }; const listeners = new Map(); const contextBridge = { exposeInMainWorld: (name, value) => { window[name] = value } }; const ipcRenderer = { invoke: (channel, ...args) => window.__draftInvoke(channel, args), on: (channel, callback) => { const values = listeners.get(channel) || new Set(); values.add(callback); listeners.set(channel, values) }, removeListener: (channel, callback) => listeners.get(channel)?.delete(callback), send: () => {} }; ' + preload + ' })();' })
      return result
    }
    const sourceContext = await context(); const sourceMain = await sourceContext.newPage(); await sourceMain.goto(origin); await sourceMain.locator('.app-shell').waitFor(); await install(sourceMain)
    const sourceNote = await sourceContext.newPage(); await sourceNote.goto(origin + '/?widget=notes'); await sourceNote.getByLabel('便签标题').waitFor()
    const sourceTask = await sourceContext.newPage(); await sourceTask.goto(origin + '/?widget=todo'); await sourceTask.getByLabel('桌面新增任务').waitFor()
    const capture = await sourceContext.newPage(); await capture.goto(origin + '/?capture=1'); await capture.getByLabel('记录标题').waitFor(); await waitFor(() => capture.getByLabel('记录标题').isEnabled())
    let serialized; let nativeMain; let nativeNote; let nativeTask; let reverse
    await scenario('real Electron shared editors produce a whitelist-only archive with exact unsaved titles, body and stable request ids', async () => {
      await sourceNote.getByLabel('便签标题').fill('Electron 未提交便签🪶'); await sourceNote.getByLabel('便签正文').fill('原正文没有被覆盖\n保留草稿'); await sourceTask.getByLabel('桌面新增任务').fill('Electron 未提交任务'); await capture.getByLabel('记录标题').fill('Electron 快速记录草稿'); await capture.getByLabel('记录正文').fill('快速记录正文')
      for (const page of [sourceMain, sourceNote, sourceTask, capture]) await page.evaluate(() => { document.documentElement.inert = true })
      await sourceMain.evaluate(() => { localStorage.setItem('access-token', 'must-not-export'); localStorage.setItem('private-cache', 'must-not-export-cache') })
      serialized = await sourceMain.evaluate(({ fingerprint }) => window.__draftMigration.createDraftArchive(window.__draftMigration.collectDrafts(localStorage), { runtime: 'electron', appVersion: '1.0.2', workspaceFingerprint: fingerprint }), { fingerprint })
      const verified = await migration.verifyDraftArchive(serialized); assert.equal(verified.payload.entries.length, 3); assert.ok(!serialized.includes('must-not-export')); assert.equal((await electron.load()).Todos.some(item => item.Title === 'Electron 未提交任务'), false); assert.notEqual((await electron.load()).Notes[0].Title, 'Electron 未提交便签🪶')
      evidence.sourceWhitelistedKeys = verified.payload.entries.map(entry => entry.key)
      await sourceContext.close()
    })
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace'); nativeMain = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.html'))); await nativeMain.locator('.app-shell').waitFor(); await install(nativeMain)
    await scenario('real WebView2 staging requires a synchronous test guard and cancellation before receipt commit removes only the staged writes', async () => {
      const staged = await nativeMain.evaluate(async ({ serialized, fingerprint }) => {
        document.documentElement.inert = true
        const migration = window.__draftMigration; const prepared = await migration.prepareDraftImport(serialized, fingerprint)
        window.__draftStageActive = true; window.__draftTransaction = prepared.stage(localStorage, () => window.__draftStageActive === true)
        return { entries: migration.collectDrafts(localStorage).length, receipt: localStorage.getItem(migration.draftMigrationReceiptsKey), journal: Boolean(localStorage.getItem(migration.draftMigrationJournalKey)) }
      }, { serialized, fingerprint })
      assert.deepEqual(staged, { entries: 3, receipt: null, journal: true })
      const aborted = await nativeMain.evaluate(() => {
        window.__draftStageActive = false; let error
        try { window.__draftTransaction.commit() } catch (reason) { error = String(reason) }
        const migration = window.__draftMigration
        return { error, entries: migration.collectDrafts(localStorage), receipt: localStorage.getItem(migration.draftMigrationReceiptsKey), journal: localStorage.getItem(migration.draftMigrationJournalKey) }
      })
      assert.match(aborted.error, /维护屏障已失效/); assert.deepEqual(aborted.entries, []); assert.equal(aborted.receipt, null); assert.equal(aborted.journal, null)
    })
    await scenario('an uncommitted stage survives normal native process restart and explicit recovery rolls it back before test editors reopen', async () => {
      const pending = await nativeMain.evaluate(async ({ serialized, fingerprint }) => {
        const migration = window.__draftMigration; const prepared = await migration.prepareDraftImport(serialized, fingerprint)
        window.__draftTransaction = prepared.stage(localStorage, () => true)
        return localStorage.getItem(migration.draftMigrationJournalKey)
      }, { serialized, fingerprint })
      assert.ok(pending)
      const root = app.root; const child = app.child
      await app.invoke('application_quit', {}, nativeMain).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
      await waitFor(() => child.exitCode !== null || child.signalCode !== null)
      assert.equal(child.exitCode, 0); await app.close({ preserve: true })
      app = await launchTauri({ rootDirectory: root, workspace: true, expectRecoveryBlock: true }); nativeMain = app.page; await nativeMain.getByRole('alert').waitFor(); await install(nativeMain)
      assert.equal(await nativeMain.locator('.app-shell, input, textarea').count(), 0)
      const recovered = await nativeMain.evaluate(pending => {
        document.documentElement.inert = true
        const migration = window.__draftMigration
        const before = { matches: localStorage.getItem(migration.draftMigrationJournalKey) === pending, entries: migration.collectDrafts(localStorage).length, receipt: localStorage.getItem(migration.draftMigrationReceiptsKey) }
        migration.recoverDraftImport(localStorage)
        return { before, entries: migration.collectDrafts(localStorage), journal: localStorage.getItem(migration.draftMigrationJournalKey) }
      }, pending)
      assert.deepEqual(recovered.before, { matches: true, entries: 3, receipt: null }); assert.deepEqual(recovered.entries, []); assert.equal(recovered.journal, null)
      await nativeMain.reload(); await nativeMain.locator('.app-shell').waitFor(); await install(nativeMain)
      evidence.uncommittedStageRecoveredAfterActualNativeRestart = true
    })
    await scenario('actual WebView2 storage write failure rolls back every imported key before a successful retry', async () => {
      const result = await nativeMain.evaluate(async ({ serialized, fingerprint }) => { const original = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === window.__draftMigration.taskDraftStorageKey) throw Error('native quota fixture'); return original.call(this, key, value) }; let error; try { await window.__draftMigration.importDraftArchive(localStorage, serialized, fingerprint) } catch (reason) { error = String(reason) } finally { Storage.prototype.setItem = original } return { error, entries: window.__draftMigration.collectDrafts(localStorage), journal: localStorage.getItem(window.__draftMigration.draftMigrationJournalKey) } }, { serialized, fingerprint })
      assert.match(result.error, /native quota fixture/); assert.deepEqual(result.entries, []); assert.equal(result.journal, null)
      const reply = await nativeMain.evaluate(({ serialized, fingerprint }) => window.__draftMigration.importDraftArchive(localStorage, serialized, fingerprint), { serialized, fingerprint }); assert.equal(reply.importedKeys.length, 3)
    })
    const show = async key => { assert.equal((await nativeMain.evaluate(key => window.dustdesk.setWidgetVisibility(key, true), key)).ok, true); const target = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('widget.html') && new URL(page.url()).searchParams.get('widget') === key)); await target.locator('.widget-head').waitFor(); return target }
    await scenario('actual native shared editors restore imported private note and task drafts without creating saved workspace records', async () => {
      nativeNote = await show('notes'); nativeTask = await show('todo'); await waitFor(async () => await nativeNote.getByLabel('便签标题').inputValue() === 'Electron 未提交便签🪶'); assert.equal(await nativeNote.getByLabel('便签正文').inputValue(), '原正文没有被覆盖\n保留草稿'); assert.equal(await nativeTask.getByLabel('桌面新增任务').inputValue(), 'Electron 未提交任务')
      const state = await nativeMain.evaluate(() => window.dustdesk.loadWorkspace()); assert.notEqual(state.Notes[0].Title, 'Electron 未提交便签🪶'); assert.ok(!state.Todos.some(item => item.Title === 'Electron 未提交任务'))
      const storedCapture = await nativeMain.evaluate(() => JSON.parse(localStorage.getItem('quick-capture-draft'))); assert.equal(storedCapture.title, 'Electron 快速记录草稿'); assert.ok(storedCapture.requestId)
      await nativeNote.screenshot({ path: 'artifacts/tauri-migration/draft-format-native-note.png' }); evidence.nativeEditorsRestoredImportedDrafts = true
    })
    await scenario('reimport preserves newer native edits and a Tauri archive restores those edits into a fresh Electron renderer', async () => {
      await nativeNote.getByLabel('便签标题').fill('Tauri 修改后的未提交便签'); await nativeTask.getByLabel('桌面新增任务').fill('Tauri 修改后的未提交任务')
      const repeated = await nativeMain.evaluate(({ serialized, fingerprint }) => window.__draftMigration.importDraftArchive(localStorage, serialized, fingerprint), { serialized, fingerprint }); assert.equal(repeated.alreadyImported, true); assert.equal(await nativeNote.getByLabel('便签标题').inputValue(), 'Tauri 修改后的未提交便签')
      for (const page of [nativeMain, nativeNote, nativeTask]) await page.evaluate(() => { document.documentElement.inert = true })
      reverse = await nativeMain.evaluate(fingerprint => window.__draftMigration.createDraftArchive(window.__draftMigration.collectDrafts(localStorage), { runtime: 'tauri', appVersion: '1.0.2', workspaceFingerprint: fingerprint }), fingerprint)
      const targetContext = await context(); const target = await targetContext.newPage(); await target.goto(origin); await target.locator('.app-shell').waitFor(); await install(target); await target.evaluate(({ reverse, fingerprint }) => window.__draftMigration.importDraftArchive(localStorage, reverse, fingerprint), { reverse, fingerprint })
      await target.goto(origin + '/?widget=notes'); await target.getByLabel('便签标题').waitFor(); assert.equal(await target.getByLabel('便签标题').inputValue(), 'Tauri 修改后的未提交便签'); await target.goto(origin + '/?widget=todo'); await target.getByLabel('桌面新增任务').waitFor(); assert.equal(await target.getByLabel('桌面新增任务').inputValue(), 'Tauri 修改后的未提交任务'); await targetContext.close(); evidence.reverseSharedEditorsRestored = true
    })
    await writeFile(report, JSON.stringify({ productionReady: false, scope: 'shared-format-and-storage-engine-with-test-coordinated-editor-pause-and-test-supplied-commit-guard', scenarios, evidence, pending: ['native-atomic-import-and-startup-recovery', 'user-facing-Tauri-import', 'production-source-and-snapshot-binding', 'cross-directory-controlled-transfer', 'quick-capture-Tauri-window', 'production-takeover-and-rollback'] }, null, 2))
  } finally { await app.close(); await browser?.close(); if (server) await new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }) }
})
