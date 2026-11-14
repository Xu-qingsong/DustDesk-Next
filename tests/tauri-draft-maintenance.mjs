import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rename, rmdir, rm } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { clipboardFixture } from './tauri-clipboard-support.mjs'

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const report = 'artifacts/tauri-migration/draft-maintenance-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native draft maintenance freezes and seals all actual editors without granting quit authority or trusting renderer ownership', async suite => {
  const guard = await clipboardFixture(); let app; let page; let task; let note; let pinned; let failed = false
  const scenarios = []; const evidence = {}; const errors = []
  const scenario = async (name, callback) => {
    await suite.test(name, async () => { try { await callback(); scenarios.push(name) } catch (error) { failed = true; console.error(app?.output()); throw error } })
    if (failed) throw Error('Draft maintenance scenario failed: ' + name)
  }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const find = key => app.browser.contexts().flatMap(context => context.pages()).find(target => !target.isClosed() && target.url().includes('widget.html') && new URL(target.url()).searchParams.get('widget') === key)
  const show = async key => { assert.equal((await api('setWidgetVisibility', key, true)).ok, true); const target = await waitFor(() => find(key)); await target.locator('.widget-head').waitFor(); target.on('pageerror', error => errors.push(String(error))); return target }
  const location = () => path.join(app.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')
  const disk = async () => JSON.parse(await readFile(location(), 'utf8'))
  const digest = async () => createHash('sha256').update(await readFile(location())).digest('hex')
  const editors = () => [page, task, note, pinned].filter(target => target && !target.isClosed())
  const frozen = async value => { for (const target of editors()) await waitFor(() => target.evaluate(value => document.documentElement.inert === value, value)) }
  const prepare = () => app.invoke('drafts_prepare', {}, page)
  const end = async checkpoint => { assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }, page), true); await frozen(false) }
  const hold = async target => { await page.evaluate(() => { window.__draftRequests = [] }); await target.evaluate(() => { window.__draftEntered = false; window.__draftStop = window.dustdesk.onBeforeQuit(async () => { window.__draftEntered = true; await new Promise(resolve => { window.__draftContinue = resolve }) }) }) }
  const unhold = target => target.evaluate(() => { window.__draftStop(); window.__draftContinue() })
  const observe = () => page.evaluate(async () => { window.__draftRequests = []; await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event: 'drafts:flush', target: { kind: 'WebviewWindow', label: 'workspace-main' }, handler: window.__TAURI_INTERNALS__.transformCallback(event => window.__draftRequests.push(event.payload.requestId)) }) })
  try {
    await guard.request('set-text', { text: 'draft-maintenance-start-disabled' })
    app = await launchTauri({ clipboardMonitoring: true })
    const electron = await mainFixture(suite); const initial = await electron.load()
    initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false; initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; initial.DesktopCategories = []; initial.ClipboardHistory = []; initial.Notes = initial.Notes.slice(0, 1)
    const noteId = initial.Notes[0].Id; const pinnedKey = 'note:' + noteId
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace')
    page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html'))); await page.locator('.app-shell').waitFor(); page.on('pageerror', error => errors.push(String(error)))
    task = await show('todo'); note = await show('notes'); pinned = await show(pinnedKey)
    await task.getByLabel('桌面新增任务').waitFor(); await note.getByLabel('便签标题').waitFor(); await pinned.getByLabel('便签标题').waitFor(); await observe()
    await scenario('actual dirty task and independent generic/pinned notes flush under a native checkpoint whose fingerprint matches disk', async () => {
      await task.getByLabel('桌面新增任务').fill('维护未提交任务-' + randomUUID())
      await note.getByLabel('便签标题').fill('通用窗口维护草稿'); await pinned.getByLabel('便签标题').fill('固定窗口独立维护草稿')
      const checkpoint = await prepare(); await frozen(true)
      assert.match(checkpoint.requestId, /^[0-9a-f-]{36}$/); assert.equal(checkpoint.leaseMilliseconds, 120000); assert.equal(checkpoint.workspaceFingerprint, await digest())
      const drafts = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('widget-note:') || key.startsWith('widget-task-draft:'))))
      const values = Object.values(drafts).map(value => JSON.parse(value)); assert.ok(values.some(value => value.title?.startsWith('维护未提交任务-')))
      const savedNote = (await disk()).Notes[0]
      for (const title of ['通用窗口维护草稿', '固定窗口独立维护草稿']) assert.ok(values.some(value => value.title === title) || savedNote.Title === title)
      assert.equal(Object.keys(drafts).filter(key => key.startsWith('widget-note:v2:')).length, 2)
      assert.ok(['通用窗口维护草稿', '固定窗口独立维护草稿'].includes(savedNote.Title)); assert.equal((await disk()).Todos.some(item => item.Title?.startsWith('维护未提交任务-')), false)
      evidence.checkpoint = checkpoint; evidence.draftKeys = Object.keys(drafts); await end(checkpoint)
    })
    await scenario('sealed workspace queue rejects saves, productivity, backups, prototype writes, new windows and quit until owner ends', async () => {
      const state = await api('loadWorkspace'); const checkpoint = await prepare(); const before = await readFile(location(), 'utf8')
      for (const [command, args, target] of [
        ['workspace_save', { state }, page], ['workspace_load', {}, page], ['workspace_backup_create', {}, page],
        ['workspace_productivity', { action: { type: 'capture', kind: 'task', title: 'must-not-write', text: '', requestId: randomUUID() } }, task],
        ['prototype_workspace_save', { state }, app.page], ['prototype_open_workspace', {}, app.page],
        ['workspace_window', { visible: false }, page], ['widgets_set', { key: 'monitor', visible: true }, page], ['application_quit', {}, page]
      ]) await assert.rejects(app.invoke(command, args, target), /迁移维护|维护请求/)
      await delay(1300); assert.equal(await readFile(location(), 'utf8'), before); assert.equal(app.child.exitCode, null); await frozen(true)
      await end(checkpoint); assert.equal((await api('saveWorkspace', state)).ok, true)
    })
    await scenario('only actual main owns preparation/end and acknowledgements are purpose-bound, single-use and participant-scoped', async () => {
      for (const target of [task, app.page]) for (const command of ['drafts_prepare', 'drafts_end']) await assert.rejects(app.invoke(command, { requestId: 'forged', window: 'workspace-main' }, target), /not allowed|权限|denied/i)
      await hold(task); const pending = prepare(); await waitFor(() => task.evaluate(() => window.__draftEntered)); const requestId = await waitFor(() => page.evaluate(() => window.__draftRequests.at(-1)))
      await assert.rejects(app.invoke('application_flushed', { requestId, error: null }, task), /失效/)
      await assert.rejects(app.invoke('drafts_checkpoint_ready', { requestId: 'old', error: null }, task), /失效/)
      await assert.rejects(app.invoke('drafts_checkpoint_ready', { requestId, error: null, window: 'workspace-main' }, app.page), /not allowed|权限|denied/i)
      await assert.rejects(app.invoke('drafts_checkpoint_ready', { requestId, error: null }, page), /已处理|未参与/)
      await assert.rejects(app.invoke('application_quit', {}, page), /迁移维护/)
      await assert.rejects(app.invoke('widgets_set', { key: 'monitor', visible: true }, page), /迁移维护/)
      assert.equal(await app.invoke('drafts_end', { requestId }, page), false)
      await unhold(task); const checkpoint = await pending; assert.equal(checkpoint.requestId, requestId)
      await assert.rejects(app.invoke('drafts_checkpoint_ready', { requestId, error: null }, task), /失效/); await end(checkpoint)
      const next = await prepare(); assert.notEqual(next.requestId, requestId); assert.equal(await app.invoke('drafts_end', { requestId }, page), false); await frozen(true); await end(next)
    })
    await scenario('a real renderer draft storage exception cancels maintenance and keeps unsaved task text available for retry', async () => {
      const key = 'widget-task-draft:v1:todo'
      await task.evaluate(key => { window.__draftSet = Storage.prototype.setItem; Storage.prototype.setItem = function (name, value) { if (name === key) throw Error('maintenance storage fixture'); return window.__draftSet.call(this, name, value) } }, key)
      const title = '维护存储失败保留输入'; await task.getByLabel('桌面新增任务').fill(title)
      try { await assert.rejects(prepare(), /maintenance storage fixture/); await frozen(false); assert.equal(await task.getByLabel('桌面新增任务').inputValue(), title) } finally { await task.evaluate(() => { Storage.prototype.setItem = window.__draftSet }) }
      await task.getByRole('button', { name: '重试任务草稿', exact: true }).click(); const checkpoint = await prepare(); assert.equal(await digest(), checkpoint.workspaceFingerprint); await end(checkpoint)
    })
    await scenario('a real workspace backup-file obstruction vetoes dirty-note checkpoint rather than fingerprinting a failed save', async () => {
      const fresh = await api('productivity', { type: 'capture', kind: 'note', title: '维护磁盘验证', text: '', requestId: randomUUID() }); assert.equal(fresh.ok, true)
      const state = await api('loadWorkspace'); const created = state.Notes.find(item => item.Title === '维护磁盘验证'); const target = await show('note:' + created.Id); await target.getByLabel('便签标题').fill('维护磁盘验证修改')
      const backup = location() + '.bak'; const held = backup + '.draft-held'; await rename(backup, held); await mkdir(backup)
      try { await assert.rejects(prepare()); await waitFor(() => target.evaluate(() => !document.documentElement.inert)); assert.equal(await target.getByLabel('便签标题').inputValue(), '维护磁盘验证修改'); assert.equal((await disk()).Notes.find(item => item.Id === created.Id).Title, '维护磁盘验证') } finally { await rmdir(backup); await rename(held, backup) }
      const checkpoint = await prepare(); assert.equal((await disk()).Notes.find(item => item.Id === created.Id).Title, '维护磁盘验证修改'); await end(checkpoint); await api('hideWidget', 'note:' + created.Id)
    })
    await scenario('synthetic composition-in-progress vetoes checkpoint without claiming physical IME validation', async () => {
      await task.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
      try { await assert.rejects(prepare(), /输入法组合输入/); await frozen(false) } finally { await task.evaluate(() => document.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))) }
      const checkpoint = await prepare(); await end(checkpoint)
    })
    await scenario('a hung renderer flusher reaches native timeout and its late completion cannot thaw a new maintenance session', async () => {
      await hold(task); const pending = prepare().then(value => ({ value }), error => ({ error: String(error) })); await waitFor(() => task.evaluate(() => window.__draftEntered)); const stale = await page.evaluate(() => window.__draftRequests.at(-1))
      const result = await pending; assert.match(result.error, /等待所有窗口保存超时/); await frozen(false)
      await task.evaluate(() => window.__draftStop()); const next = await prepare(); await frozen(true); await task.evaluate(() => window.__draftContinue()); await delay(250)
      assert.equal(await app.invoke('drafts_end', { requestId: stale }, page), false); await frozen(true); await end(next)
    })
    await scenario('losing a participant during preparation cancels the waiting native receiver without waiting for its timeout', async () => {
      await hold(task); const pending = prepare().then(value => ({ value }), error => ({ error: String(error) })); await waitFor(() => task.evaluate(() => window.__draftEntered))
      const started = Date.now(); await task.reload(); await task.getByLabel('桌面新增任务').waitFor(); const result = await pending
      assert.match(result.error, /参与窗口已关闭/); assert.ok(Date.now() - started < 10000); await frozen(false); const next = await prepare(); await end(next)
    })
    await scenario('real widget reload invalidates checkpoint and all other editors resume before a new preparation', async () => {
      const checkpoint = await prepare(); await task.reload(); await task.getByLabel('桌面新增任务').waitFor(); await frozen(false)
      assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }, page), false); const next = await prepare(); await end(next)
    })
    await scenario('real main reload invalidates ownership and resumes native and widget operations', async () => {
      const checkpoint = await prepare(); await page.reload(); await page.locator('.app-shell').waitFor(); await frozen(false); await observe()
      assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }, page), false); const next = await prepare(); await end(next)
    })
    await scenario('native clipboard worker is drained and paused in Ready and captures actual system changes after resume', async () => {
      const state = await api('loadWorkspace'); state.Settings.ClipboardMonitoringEnabled = true; assert.equal((await api('saveWorkspace', state)).ok, true)
      const before = 'checkpoint-before-' + randomUUID(); await guard.request('set-text', { text: before }); await waitFor(async () => (await disk()).ClipboardHistory.some(item => item.Text === before))
      const checkpoint = await prepare(); const stable = await digest(); const during = 'checkpoint-paused-' + randomUUID(); await guard.request('set-text', { text: during }); await delay(1300)
      assert.equal(await digest(), stable); assert.equal((await disk()).ClipboardHistory.some(item => item.Text === during), false)
      await end(checkpoint); const after = 'checkpoint-after-' + randomUUID(); await guard.request('set-text', { text: after }); await waitFor(async () => (await disk()).ClipboardHistory.some(item => item.Text === after))
      const disabled = await api('loadWorkspace'); disabled.Settings.ClipboardMonitoringEnabled = false; assert.equal((await api('saveWorkspace', disabled)).ok, true); evidence.clipboardPauseResume = true
    })
    await scenario('short native lease automatically resumes and an earlier lease timer cannot cancel a later session', async () => {
      const root = app.root; await app.close({ preserve: true }); app = await launchTauri({ rootDirectory: root, workspace: true, draftLeaseMs: 4000 }); page = app.page; await page.locator('.app-shell').waitFor(); task = await show('todo'); note = await show('notes'); pinned = await show(pinnedKey)
      const first = await prepare(); assert.equal(first.leaseMilliseconds, 4000); await delay(1200); await end(first); const second = await prepare(); await delay(2950)
      await frozen(true); await assert.rejects(app.invoke('workspace_load', {}, page), /迁移维护/)
      await frozen(false); assert.equal(await app.invoke('drafts_end', { requestId: second.requestId }, page), false); assert.ok((await api('loadWorkspace')).Notes.length); evidence.nativeLeaseExpired = true
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ productionReady: false, scope: 'isolated-native-all-editor-maintenance-checkpoint', scenarios, evidence, pending: ['production-export-import-file-workflow', 'Electron-maintenance-and-old-origin-reader', 'native-lineage-and-cross-runtime-lock', 'real-IME-and-DPI', 'production-cutover-and-rollback'] }, null, 2))
  } finally { await app?.close(); await guard.close() }
})
