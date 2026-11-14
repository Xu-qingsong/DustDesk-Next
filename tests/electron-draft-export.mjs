import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { waitFor } from './tauri-harness.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const { verifyDraftArchive } = await import(draftModuleUrl)
const report = 'artifacts/tauri-migration/electron-draft-export-native.json'
await mkdir(path.dirname(report), { recursive: true })
await rm(report, { force: true }); await rm('artifacts/tauri-migration/electron-browser-drafts.json', { force: true })
await test('real sandboxed Electron editors export a native-file draft archive under all-window maintenance', async suite => {
  const app = await launchDustDesk(); let failed = false; const scenarios = []; const errors = []; const evidence = {}
  let page = app.window; const destination = path.join(app.tempRoot, 'browser-drafts.json')
  const scenario = async (name, callback) => { await suite.test(name, async () => { try { await callback(); scenarios.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Electron draft export failed: ' + name) }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const show = async key => { assert.equal((await api('setWidgetVisibility', key, true)).ok, true); const target = await waitFor(() => app.electronApp.windows().find(target => target.url().includes('widget=') && new URL(target.url()).searchParams.get('widget') === key)); await target.locator('.widget-head').waitFor(); target.on('pageerror', error => errors.push(String(error))); return target }
  const menu = () => app.electronApp.evaluate(({ Menu }) => { const item = Menu.getApplicationMenu()?.getMenuItemById('export-browser-drafts'); if (!item) throw Error('Missing native migration export menu'); item.click() })
  const results = () => app.electronApp.evaluate(() => globalThis.__draftExportResults)
  const run = async () => { const before = (await results()).length; await menu(); return waitFor(async () => (await results())[before], 45000) }
  const targetFile = value => app.electronApp.evaluate((_electron, value) => { globalThis.__draftExportTarget = value }, value)
  const holdNativeWrite = location => app.electronApp.evaluate(({ app }, location) => {
    const storage = process.getBuiltinModule('fs').promises; const rename = storage.rename
    globalThis.__lineageWriteEntered = false; globalThis.__lineageQuitEntered = false
    storage.rename = async (source, target) => { if (target === location) { globalThis.__lineageWriteEntered = true; await new Promise(resolve => { globalThis.__lineageContinue = resolve }) } return rename(source, target) }
    globalThis.__lineageRestore = () => { storage.rename = rename; globalThis.__lineageContinue?.() }
    app.once('before-quit', () => { globalThis.__lineageQuitEntered = true })
  }, location)
  const releaseNativeWrite = () => app.electronApp.evaluate(() => globalThis.__lineageRestore())
  try {
    await app.electronApp.evaluate(({ dialog }, destination) => {
      globalThis.__draftExportTarget = destination; globalThis.__draftExportResults = []; globalThis.__draftSaveDialogs = 0
      dialog.showSaveDialog = async () => { ++globalThis.__draftSaveDialogs; return { canceled: globalThis.__draftExportTarget === null, filePath: globalThis.__draftExportTarget } }
      dialog.showMessageBox = async (...args) => { const options = args.at(-1); globalThis.__draftExportResults.push({ kind: 'message', title: options.title, message: options.message }); if (globalThis.__draftNoticeFailure) throw Error('native export notice failure fixture'); return { response: 0 } }
      dialog.showErrorBox = (title, message) => { globalThis.__draftExportResults.push({ kind: 'error', title, message }) }
    }, destination)
    const initial = await api('loadWorkspace'); initial.Settings.ClipboardMonitoringEnabled = false; initial.Settings.AutomaticBackupEnabled = false; assert.equal((await api('saveWorkspace', initial)).ok, true)
    const noteId = initial.Notes[0].Id; const task = await show('todo'); const note = await show('notes'); const pinned = await show('note:' + noteId)
    await api('showQuickCapture'); const capture = await waitFor(() => app.electronApp.windows().find(target => target.url().includes('capture=1'))); await capture.getByLabel('记录标题').waitFor()
    const participants = [page, task, note, pinned, capture]
    const resumed = async () => { for (const target of participants) await waitFor(() => target.evaluate(() => !document.documentElement.inert)) }
    await scenario('native file-origin preload exports all private drafts and omits arbitrary storage while preserving stable request IDs', async () => {
      await task.getByLabel('桌面新增任务').fill('原生 Electron 未提交任务'); await note.getByLabel('便签标题').fill('原生通用便签草稿'); await pinned.getByLabel('便签标题').fill('原生固定便签草稿')
      await capture.getByLabel('记录标题').fill('原生快速记录未提交'); await capture.getByLabel('记录正文').fill('快速记录正文🪶')
      await page.evaluate(() => localStorage.setItem('private-token', 'must-not-export'))
      assert.equal((await run()).kind, 'message'); await resumed()
      const serialized = await readFile(destination, 'utf8'); const verified = await verifyDraftArchive(serialized); const entries = Object.fromEntries(verified.payload.entries.map(entry => [entry.key, JSON.parse(entry.value)]))
      assert.equal(verified.payload.source.runtime, 'electron'); assert.equal(verified.payload.source.workspaceFingerprint, createHash('sha256').update(await readFile(path.join(app.tempRoot, 'data', 'workspace.json'))).digest('hex'))
      const ledger = JSON.parse(await readFile(path.join(app.tempRoot, 'data', 'MigrationLineage', 'lineage.json'), 'utf8'))
      const receipt = ledger.exports.find(item => item.archiveId === verified.payload.id)
      assert.ok(receipt); assert.equal(receipt.archiveSha256, createHash('sha256').update(serialized).digest('hex')); assert.equal(receipt.payloadSha256, verified.archive.sha256)
      assert.equal(receipt.workspaceFingerprint, verified.payload.source.workspaceFingerprint); assert.equal(JSON.stringify(ledger).includes('must-not-export'), false)
      evidence.nativeWorkspaceId = ledger.workspaceId; evidence.nativeExactArchiveReceipt = true
      assert.equal(entries['widget-task-draft:v1:todo'].title, '原生 Electron 未提交任务'); assert.ok(entries['widget-task-draft:v1:todo'].requestId)
      assert.equal(entries['quick-capture-draft'].title, '原生快速记录未提交'); assert.equal(entries['quick-capture-draft'].text, '快速记录正文🪶'); assert.equal(entries['private-token'], undefined)
      const stored = await api('loadWorkspace'); const values = Object.values(entries)
      for (const title of ['原生通用便签草稿', '原生固定便签草稿']) assert.ok(values.some(value => value.title === title) || stored.Notes.some(value => value.Title === title))
      assert.equal(stored.Todos.some(item => item.Title === '原生 Electron 未提交任务'), false); assert.equal(stored.Notes.some(item => item.Title === '原生快速记录未提交'), false)
      evidence.archiveKeys = Object.keys(entries); await writeFile('artifacts/tauri-migration/electron-browser-drafts.json', serialized)
    })
    await scenario('preparation freezes every actual editor, blocks native quit and new widgets, and ignores a duplicate export request', async () => {
      await task.evaluate(() => { window.__draftEntered = false; window.__draftStop = window.dustdesk.onBeforeQuit(async () => { window.__draftEntered = true; await new Promise(resolve => { window.__draftContinue = resolve }) }) })
      const before = (await results()).length; await menu(); await waitFor(() => task.evaluate(() => window.__draftEntered)); for (const target of participants) await waitFor(() => target.evaluate(() => document.documentElement.inert))
      assert.equal((await api('setWidgetVisibility', 'monitor', true)).ok, false); await api('hideMainWindow'); await app.electronApp.evaluate(({ app }) => app.quit()); assert.equal(app.electronApp.process().exitCode, null)
      const dialogs = await app.electronApp.evaluate(() => globalThis.__draftSaveDialogs); await menu(); assert.equal(await app.electronApp.evaluate(() => globalThis.__draftSaveDialogs), dialogs)
      await task.evaluate(() => { window.__draftStop(); window.__draftContinue() }); assert.equal((await waitFor(async () => (await results())[before])).kind, 'message'); await resumed()
    })
    await scenario('save failure, malformed whitelist storage and synthetic composition cancel export without replacing an earlier file', async () => {
      const preserved = await readFile(destination, 'utf8'); await task.evaluate(() => { window.__draftVeto = window.dustdesk.onBeforeQuit(async () => { throw Error('native Electron draft save veto') }) })
      assert.match((await run()).message, /native Electron draft save veto/); await resumed(); await task.evaluate(() => window.__draftVeto()); assert.equal(await readFile(destination, 'utf8'), preserved)
      await page.evaluate(() => localStorage.setItem('widget-note:v9:fixture', '{}')); assert.equal((await run()).kind, 'error'); await resumed(); assert.equal(await readFile(destination, 'utf8'), preserved); assert.equal(await page.evaluate(() => localStorage.getItem('widget-note:v9:fixture')), '{}'); await page.evaluate(() => localStorage.removeItem('widget-note:v9:fixture'))
      await capture.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))); assert.match((await run()).message, /输入法组合输入/); await capture.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))); await resumed(); assert.equal(await readFile(destination, 'utf8'), preserved)
    })
    await scenario('real renderer reload while another window is waiting cancels the native checkpoint and restores all remaining editors', async () => {
      await task.evaluate(() => { window.__draftEntered = false; window.__draftStop = window.dustdesk.onBeforeQuit(async () => { window.__draftEntered = true; await new Promise(resolve => { window.__draftContinue = resolve }) }) })
      const before = (await results()).length; await menu(); await waitFor(() => task.evaluate(() => window.__draftEntered)); await page.reload(); await page.locator('.app-shell').waitFor()
      const failure = await waitFor(async () => (await results())[before]); assert.equal(failure.kind, 'error'); assert.match(failure.message, /已关闭或重载/); await task.evaluate(() => { window.__draftStop(); window.__draftContinue() }); await resumed(); assert.equal((await run()).kind, 'message')
    })
    await scenario('native destination protection rejects workspace overwrite and cancellation leaves all data and drafts available', async () => {
      await targetFile(path.join(app.tempRoot, 'data', 'workspace.json')); const failure = await run(); assert.equal(failure.kind, 'error'); assert.match(failure.message, /应用数据目录/); await resumed(); assert.ok(JSON.parse(await readFile(path.join(app.tempRoot, 'data', 'workspace.json'), 'utf8')).Notes.length)
      await targetFile(null); const before = (await results()).length; const dialogs = await app.electronApp.evaluate(() => globalThis.__draftSaveDialogs); await menu(); await waitFor(async () => await app.electronApp.evaluate(() => globalThis.__draftSaveDialogs) > dialogs); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await results()).length, before); await resumed(); assert.equal(await task.getByLabel('桌面新增任务').inputValue(), '原生 Electron 未提交任务')
      await targetFile(destination); assert.equal((await run()).kind, 'message'); evidence.cancelAndRetry = true
    })
    await scenario('a failed post-write notification does not misreport the completed archive as a failed export', async () => {
      const before = (await results()).length; await app.electronApp.evaluate(() => { globalThis.__draftNoticeFailure = true })
      try { assert.equal((await run()).kind, 'message'); await new Promise(resolve => setTimeout(resolve, 150)); assert.equal((await results()).length, before + 1); await verifyDraftArchive(await readFile(destination, 'utf8')); await resumed() }
      finally { await app.electronApp.evaluate(() => { globalThis.__draftNoticeFailure = false }) }
    })
    await scenario('damaged native lineage vetoes export without overwriting the earlier archive or resetting trust', async () => {
      const location = path.join(app.tempRoot, 'data', 'MigrationLineage', 'lineage.json')
      const previous = await readFile(location, 'utf8'); const archive = await readFile(destination, 'utf8')
      await writeFile(location, '{broken-native-lineage')
      try {
        assert.equal((await run()).kind, 'error'); await resumed()
        assert.equal(await readFile(location, 'utf8'), '{broken-native-lineage'); assert.equal(await readFile(destination, 'utf8'), archive)
      } finally { await writeFile(location, previous) }
      assert.equal((await run()).kind, 'message')
    })
    await scenario('a stalled native receipt write times out quit without discarding the write or editor drafts', async () => {
      const location = path.join(app.tempRoot, 'data', 'MigrationLineage', 'lineage.json'); const preserved = await readFile(destination, 'utf8')
      await holdNativeWrite(location); await menu(); await waitFor(() => app.electronApp.evaluate(() => globalThis.__lineageWriteEntered))
      const before = (await results()).length; const started = Date.now()
      try {
        await app.electronApp.evaluate(({ app }) => app.quit())
        const failure = await waitFor(async () => (await results()).slice(before).find(item => item.kind === 'error' && item.message.includes('等待迁移草稿落盘超时')), 23000)
        assert.match(failure.message, /退出已取消/); assert.ok(Date.now() - started >= 14000)
        assert.equal(app.electronApp.process().exitCode, null); await resumed(); assert.equal(await readFile(destination, 'utf8'), preserved)
        assert.equal(await task.getByLabel('桌面新增任务').inputValue(), '原生 Electron 未提交任务')
      } finally { await releaseNativeWrite() }
      await waitFor(async () => (await results()).slice(before).some(item => item.kind === 'message'))
      evidence.nativeWriteTimeoutCancelsQuit = true
    })
    await scenario('normal exit waits for native receipt commit and restart retains lineage before the next export', async () => {
      const location = path.join(app.tempRoot, 'data', 'MigrationLineage', 'lineage.json')
      let previous = JSON.parse(await readFile(location, 'utf8')); const child = app.electronApp.process(); const preserved = await readFile(destination, 'utf8')
      await holdNativeWrite(location)
      await menu(); await waitFor(() => app.electronApp.evaluate(() => globalThis.__lineageWriteEntered))
      const quit = app.electronApp.evaluate(({ app }) => app.quit()).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
      await waitFor(() => app.electronApp.evaluate(() => globalThis.__lineageQuitEntered)); await new Promise(resolve => setTimeout(resolve, 150))
      assert.equal(child.exitCode, null); assert.equal(child.signalCode, null); assert.equal(await readFile(destination, 'utf8'), preserved)
      await releaseNativeWrite()
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 25000); await quit; assert.equal(child.exitCode, 0)
      const committed = JSON.parse(await readFile(location, 'utf8')); assert.equal(committed.exports.length, previous.exports.length + 1); previous = committed
      const beforeRestart = await readFile(destination, 'utf8'); const committedArchive = await verifyDraftArchive(beforeRestart)
      assert.equal(previous.exports.find(item => item.archiveId === committedArchive.payload.id).archiveSha256, createHash('sha256').update(beforeRestart).digest('hex'))
      evidence.normalQuitDrainsNativeReceiptAndExternalFile = true
      await closeDustDesk({ ...app, preserveTempRoot: true })
      const restarted = await launchDustDesk({ tempRoot: app.tempRoot })
      try {
        restarted.window.on('pageerror', error => errors.push(String(error)))
        assert.equal(JSON.parse(await readFile(location, 'utf8')).workspaceId, previous.workspaceId)
        await restarted.electronApp.evaluate(({ dialog, Menu }, destination) => {
          globalThis.__restartExportResult = undefined
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
          dialog.showMessageBox = async () => { globalThis.__restartExportResult = 'success'; return { response: 0 } }
          dialog.showErrorBox = (_title, message) => { globalThis.__restartExportResult = message }
          Menu.getApplicationMenu().getMenuItemById('export-browser-drafts').click()
        }, destination)
        assert.equal(await waitFor(() => restarted.electronApp.evaluate(() => globalThis.__restartExportResult), 45000), 'success')
        const current = JSON.parse(await readFile(location, 'utf8')); const serialized = await readFile(destination, 'utf8'); const verified = await verifyDraftArchive(serialized)
        assert.equal(current.workspaceId, previous.workspaceId); assert.equal(current.exports.length, previous.exports.length + 1)
        assert.equal(current.exports.find(item => item.archiveId === verified.payload.id).archiveSha256, createHash('sha256').update(serialized).digest('hex'))
        evidence.nativeLineageSurvivesNormalRestart = true
      } finally { await closeDustDesk({ ...restarted, preserveTempRoot: true }) }
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ productionReady: false, scope: 'real-Electron-current-file-origin-draft-export', scenarios, evidence, pending: ['old-origin-controlled-reader', 'trusted-persistent-lineage', 'Tauri-production-import-and-atomic-lease-commit', 'cross-runtime-takeover-and-rollback'] }, null, 2))
  } finally { await closeDustDesk(app) }
})
