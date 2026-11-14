import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, rename, rmdir, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'

const key = 'widget-task-draft:v1:todo'
const report = 'artifacts/tauri-migration/task-drafts-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native task input drafts survive actual quit and restart without acknowledging failed storage or duplicating committed tasks', async suite => {
  let app = await launchTauri({ releaseDelayMs: 400 }); let page; let task; let failed = false; const scenarios = []; const evidence = {}
  const scenario = async (name, callback) => { await suite.test(name, async () => { try { await callback(); scenarios.push(name) } catch (error) { failed = true; console.error(app.output()); throw error } }); if (failed) throw Error('Task draft scenario failed: ' + name) }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const show = async () => { assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true); task = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => !target.isClosed() && target.url().includes('widget.html') && new URL(target.url()).searchParams.get('widget') === 'todo')); await task.getByLabel('桌面新增任务').waitFor(); return task }
  const quit = async () => { const pending = app.invoke('application_quit', {}, page).then(() => ({ ok: true }), error => ({ error: String(error) })); await waitFor(() => app.child.exitCode !== null, 22000); const reply = await pending; if (reply.error) assert.match(reply.error, /closed|destroyed|disconnected/i); assert.equal(app.child.exitCode, 0) }
  const restart = async () => { const root = app.root; await app.close({ preserve: true }); app = await launchTauri({ workspace: true, rootDirectory: root, releaseDelayMs: 400 }); page = app.page; await page.locator('.app-shell').waitFor(); await show() }
  const block = () => task.evaluate(key => { window.__taskOriginalSet = Storage.prototype.setItem; Storage.prototype.setItem = function (name, value) { if (name === key) throw Error('task draft storage fixture'); return window.__taskOriginalSet.call(this, name, value) } }, key)
  const unblock = () => task.evaluate(() => { Storage.prototype.setItem = window.__taskOriginalSet })
  try {
    const electron = await mainFixture(suite); const initial = await electron.load(); initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false; initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace'); page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html'))); await page.locator('.app-shell').waitFor(); await show()
    const title = '跨进程未提交任务🪶-' + randomUUID(); let identifier
    await scenario('actual normal quit and process restart restore an unsaved task title and its stable request id', async () => {
      await task.getByLabel('桌面新增任务').fill(title); const stored = await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key); identifier = stored.requestId; assert.equal(stored.title, title)
      await quit(); await restart(); await waitFor(async () => await task.getByLabel('桌面新增任务').inputValue() === title); assert.equal((await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).requestId, identifier)
      assert.ok(!(await api('loadWorkspace')).Todos.some(item => item.Id === identifier)); evidence.normalProcessRestartRestoredDraft = true
    })
    await scenario('a real renderer storage exception vetoes hidden reclaim and all-editor quit until retry persists the retained text', async () => {
      await block(); const changed = title + '-存储失败'; await task.getByLabel('桌面新增任务').fill(changed); await task.getByText('任务草稿暂未写入磁盘，内容仍保留在当前窗口；请重试。', { exact: false }).waitFor()
      assert.equal((await api('hideWidget', 'todo')).ok, true); await new Promise(resolve => setTimeout(resolve,1800)); assert.equal(task.isClosed(), false)
      await assert.rejects(app.invoke('application_quit', {}, page), /task draft storage fixture/); assert.equal(app.child.exitCode, null); await show(); await waitFor(() => task.evaluate(() => !document.documentElement.inert)); assert.equal(await task.getByLabel('桌面新增任务').inputValue(), changed)
      await unblock(); await task.getByRole('button', { name: '重试任务草稿', exact: true }).click(); assert.equal((await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).title, changed)
      await quit(); await restart(); await waitFor(async () => await task.getByLabel('桌面新增任务').inputValue() === changed)
    })
    await scenario('a successful task with failed local cleanup is reconciled on renderer reload rather than submitted twice', async () => {
      await block(); await task.getByRole('button', { name: '添加', exact: true }).click(); await task.getByText('任务已保存，但本地草稿清理失败；不会重复提交，请重试。', { exact: false }).waitFor(); assert.equal(await task.getByLabel('桌面新增任务').inputValue(), '')
      assert.equal((await api('loadWorkspace')).Todos.filter(item => item.Id === identifier).length, 1); const old = await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key); assert.equal(old.requestId, identifier); assert.ok(old.title)
      await task.reload(); await task.getByLabel('桌面新增任务').waitFor(); await waitFor(() => task.getByLabel('桌面新增任务').isEnabled()); assert.equal(await task.getByLabel('桌面新增任务').inputValue(), ''); assert.equal((await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).title, '')
      assert.equal((await api('loadWorkspace')).Todos.filter(item => item.Id === identifier).length, 1); evidence.cleanupFailureDidNotDuplicate = true
    })
    await scenario('actual workspace write failure keeps the input and request id for an exact one-task retry', async () => {
      const title = '工作区失败重试-' + randomUUID(); await task.getByLabel('桌面新增任务').fill(title); const stored = await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key)
      const backup = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json.bak'); const held = backup + '.task-held'; await rename(backup, held); await mkdir(backup)
      try { await task.getByRole('button', { name: '添加', exact: true }).click(); await task.getByRole('alert').waitFor(); assert.equal(await task.getByLabel('桌面新增任务').inputValue(), title); assert.equal((await task.evaluate(key => JSON.parse(localStorage.getItem(key)), key)).requestId, stored.requestId); assert.ok(!(await api('loadWorkspace')).Todos.some(item => item.Id === stored.requestId)) } finally { await rmdir(backup); await rename(held, backup) }
      await task.getByRole('button', { name: '添加', exact: true }).click(); await waitFor(async () => await task.getByLabel('桌面新增任务').inputValue() === ''); assert.equal((await api('loadWorkspace')).Todos.filter(item => item.Id === stored.requestId).length, 1)
    })
    await scenario('malformed persisted draft is not silently replaced and failed load cannot acknowledge quit', async () => {
      const original = await task.evaluate(key => localStorage.getItem(key), key); await task.evaluate(key => localStorage.setItem(key, '{invalid-kept'), key); await task.reload(); await task.getByRole('button', { name: '重试任务草稿', exact: true }).waitFor(); assert.equal(await task.getByLabel('桌面新增任务').isEnabled(), false)
      assert.equal(await task.evaluate(key => localStorage.getItem(key), key), '{invalid-kept'); await assert.rejects(app.invoke('application_quit', {}, page), /任务草稿尚未读取/)
      await task.evaluate(({ key, original }) => localStorage.setItem(key, original), { key, original }); await waitFor(() => task.evaluate(() => !document.documentElement.inert)); await task.getByRole('button', { name: '重试任务草稿', exact: true }).click(); await waitFor(() => task.getByLabel('桌面新增任务').isEnabled())
      await task.screenshot({ path: 'artifacts/tauri-migration/task-drafts-restored.png' }); await quit(); evidence.malformedDraftPreserved = true
    })
    await writeFile(report, JSON.stringify({ productionReady: false, scope: 'isolated-task-widget-local-storage-normal-restart-and-failure-guards', scenarios, evidence, pending: ['Electron-browser-draft-export-import', 'OS-crash-power-loss-durability', 'all-main-page-draft-checkpoints', 'production-takeover'] }, null, 2))
  } finally { await app.close() }
})
