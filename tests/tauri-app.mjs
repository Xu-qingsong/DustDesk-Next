import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'

await test('shared React application uses real Tauri workspace and quit lifecycle', async suite => {
  const reportPath = 'artifacts/tauri-migration/app-native.json'
  await rm(reportPath, { force: true })
  const application = await launchTauri()
  const { invoke } = application
  const location = path.join(application.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')
  const errors = []
  let failed = false
  const scenario = (name, callback) => suite.test(name, async context => { try { await callback(context) } catch (error) { failed = true; throw error } })
  try {
    await invoke('prototype_open_workspace')
    const page = await waitFor(() => application.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
    page.on('pageerror', error => errors.push(String(error)))
    const api = (name, ...args) => page.evaluate(({ name, args }) => window.dustdesk[name](...args), { name, args })
    await scenario('new profile requires explicit initialization before the unchanged React App mounts', async () => {
      await page.getByRole('button', { name: '创建工作区', exact: true }).waitFor()
      await assert.rejects(access(location))
      assert.equal(await page.locator('.app-shell').count(), 0)
      await page.getByRole('button', { name: '创建工作区', exact: true }).click()
      await page.locator('.app-shell').waitFor()
      assert.equal((await api('loadWorkspace')).SchemaVersion, 3)
      assert.equal(await page.evaluate(() => window.dustdesk.platform), 'win32')
      assert.equal(await api('getDataLocation'), path.dirname(location))
      await assert.rejects(invoke('workspace_load'), /not allowed|权限/i)
      await assert.rejects(invoke('prototype_workspace_load', {}, page), /not allowed|权限/i)
      await assert.rejects(invoke('workspace_initialize', {}, page), /禁止覆盖/)
      const result = await api('setHotkeys', { mainWindow: 'Ctrl+Alt+Y' })
      assert.equal(result.ok, true)
      assert.equal((await api('loadWorkspace')).Settings.MainWindowHotKey, 'Ctrl+Alt+Y')
    })
    await scenario('overview task creation and delayed quick notes persist through a real WebView reload', async () => {
      const title = 'Tauri 主页面真实任务'
      await page.getByPlaceholder('添加一项任务...').fill(title)
      await page.getByPlaceholder('添加一项任务...').press('Enter')
      await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).Todos.some(item => item.Title === title))
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('Rust 保存的快速记录')
      await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).QuickNote === 'Rust 保存的快速记录')
      await page.reload()
      await page.locator('.app-shell').waitFor()
      assert.equal(await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), 'Rust 保存的快速记录')
      assert.ok((await api('loadWorkspace')).Todos.some(item => item.Title === title))
      await mkdir('artifacts/tauri-migration', { recursive: true })
      await page.screenshot({ path: 'artifacts/tauri-migration/shared-app.png', fullPage: true })
    })
    await scenario('the shared Notes page edits and reads the Rust store without a page-specific invoke bridge', async () => {
      await page.getByRole('button', { name: '便签', exact: true }).click()
      await page.getByRole('textbox', { name: '便签标题' }).fill('来自真实共用便签页')
      await page.locator('.note-text').fill('正文通过 DustDeskApi 保存到 Rust')
      await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).Notes.some(item => item.Title === '来自真实共用便签页' && item.Text === '正文通过 DustDeskApi 保存到 Rust'))
      await page.reload()
      await page.locator('.app-shell').waitFor()
      await page.getByRole('button', { name: '便签', exact: true }).click()
      assert.equal(await page.getByRole('textbox', { name: '便签标题' }).inputValue(), '来自真实共用便签页')
      assert.equal(await page.locator('.note-text').inputValue(), '正文通过 DustDeskApi 保存到 Rust')
      await page.getByRole('button', { name: '概览', exact: true }).click()
    })
    await scenario('real cross-window saves arrive through the adapter before rendering subsequent edits', async () => {
      const baseline = (await invoke('prototype_workspace_load')).state
      await invoke('prototype_workspace_save', { state: { ...baseline, QuickNote: '原型窗口独立更新' }, baseline })
      await waitFor(async () => await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue() === '原型窗口独立更新')
      await api('hideMainWindow')
      await api('showMainWindow')
    })
    await scenario('failed disk save cancels quit, restores input, and retries the retained pending write', async () => {
      const before = await readFile(location)
      await rm(location + '.bak')
      await mkdir(location + '.bak')
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('失败退出必须保留的输入')
      await invoke('application_quit', {}, page).catch(() => {})
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await page.getByRole('alert').filter({ hasText: /保存|denied|directory|目录|拒绝|访问/i }).first().waitFor()
      assert.equal(application.child.exitCode, null)
      assert.deepEqual(await readFile(location), before)
      assert.equal(await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), '失败退出必须保留的输入')
      await rmdir(location + '.bak')
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('磁盘恢复后继续保存')
      await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).QuickNote === '磁盘恢复后继续保存')
      await assert.rejects(invoke('application_flushed', { requestId: 'stale-request', error: null }, page), /已失效/)
    })
    await scenario('failed native focus checkpoint cancels quit even after frontend callbacks succeeded', async () => {
      assert.equal((await api('productivity', {type:'focus-start',taskId:'',projectId:'',minutes:1})).ok,true)
      const before = await readFile(location)
      await rm(location + '.bak')
      await mkdir(location + '.bak')
      try {
        await assert.rejects(invoke('application_quit',{},page))
        await waitFor(() => page.evaluate(() => !document.documentElement.inert))
        assert.equal(application.child.exitCode,null)
        assert.deepEqual(await readFile(location),before)
        assert.notEqual(JSON.parse(before).ActiveFocus.RunningSince,null)
      } finally { await rmdir(location + '.bak') }
      assert.equal((await api('productivity',{type:'focus-cancel'})).ok,true)
    })
    await scenario('a failed registered flush callback blocks both native and in-page quit requests', async () => {
      await page.evaluate(() => { window.__removeFailingFlush = window.dustdesk.onBeforeQuit(async () => { throw Error('测试草稿持久化失败') }) })
      await assert.rejects(invoke('prototype_quit'), /测试草稿持久化失败/)
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      assert.equal(application.child.exitCode, null)
      await assert.rejects(invoke('application_quit', {}, page), /测试草稿持久化失败/)
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await page.evaluate(() => { window.__removeFailingFlush(); delete window.__removeFailingFlush })
    })
    await scenario('native quit timeout resumes editing and a late flush cannot acknowledge a different request', async () => {
      await page.evaluate(() => {
        const gate = { release: undefined, called: false, remove: undefined }
        gate.remove = window.dustdesk.onBeforeQuit(async () => {
          gate.called = true
          await new Promise(resolve => { gate.release = resolve })
        })
        window.__quitTimeoutGate = gate
      })
      try {
        const quitting = assert.rejects(invoke('application_quit', {}, page), /超时/)
        await waitFor(() => page.evaluate(() => window.__quitTimeoutGate.called && document.documentElement.inert))
        await assert.rejects(invoke('application_quit', {}, page), /正在处理/)
        assert.equal(await page.evaluate(() => document.documentElement.inert), true)
        await quitting
        await waitFor(() => page.evaluate(() => !document.documentElement.inert))
        assert.equal(application.child.exitCode, null)
        await page.evaluate(() => {
          window.__quitTimeoutGate.remove()
          const gate = { release: undefined, called: false, remove: undefined }
          gate.remove = window.dustdesk.onBeforeQuit(async () => {
            gate.called = true
            await new Promise(resolve => { gate.release = resolve })
            throw Error('第二代退出主动取消')
          })
          window.__nextQuitGate = gate
        })
        const nextQuit = assert.rejects(invoke('application_quit', {}, page), /第二代退出主动取消/)
        await waitFor(() => page.evaluate(() => window.__nextQuitGate.called && document.documentElement.inert))
        await page.evaluate(async () => { window.__quitTimeoutGate.release(); await new Promise(resolve => setTimeout(resolve, 100)) })
        assert.equal(await page.evaluate(() => document.documentElement.inert), true, 'A late first-generation callback must not resume the next quit')
        assert.equal(application.child.exitCode, null)
        await page.evaluate(() => window.__nextQuitGate.release())
        await nextQuit
        await waitFor(() => page.evaluate(() => !document.documentElement.inert))
        await page.evaluate(() => { window.__nextQuitGate.remove(); delete window.__nextQuitGate })
        await page.getByPlaceholder('把刚刚想到的事记下来...').fill('退出超时后编辑仍可继续')
        await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).QuickNote === '退出超时后编辑仍可继续')
        await assert.rejects(invoke('application_flushed', { requestId: 'expired-timeout', error: null }, page), /已失效/)
      } finally {
        await page.evaluate(() => {
          window.__quitTimeoutGate?.remove(); window.__quitTimeoutGate?.release?.(); delete window.__quitTimeoutGate
          window.__nextQuitGate?.remove(); window.__nextQuitGate?.release?.(); delete window.__nextQuitGate
        })
      }
    })
    await scenario('quit flushes a debounce-pending real React edit before exiting the full process', async () => {
      assert.equal((await api('productivity', { type: 'focus-start', taskId: '', projectId: '', minutes: 1 })).ok, true)
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('退出前最后一次尚未防抖保存的输入')
      await invoke('application_quit', {}, page).catch(() => {})
      await waitFor(() => application.child.exitCode !== null)
      assert.equal(application.child.exitCode, 0)
      assert.equal(JSON.parse(await readFile(location, 'utf8')).QuickNote, '退出前最后一次尚未防抖保存的输入')
      assert.equal(JSON.parse(await readFile(location, 'utf8')).ActiveFocus.RunningSince, null)
    })
    assert.deepEqual(errors, [])
    assert.equal(failed, false)
    await mkdir('artifacts/tauri-migration', { recursive: true })
    await writeFile(reportPath, JSON.stringify({ ok: true, executable: application.executable, scope: 'shared-react-app-and-workspace-only', checks: ['explicit-initialization', 'same-react-App', 'typed-workspace-adapter', 'role-capability-boundary', 'task-create', 'notes-edit', 'quicknote-debounce', 'reload-persistence', 'cross-window-events', 'disk-failure-cancels-quit', 'native-quit-handshake', 'callback-failure-cancels-quit', 'quit-timeout-restores-editing', 'late-previous-generation-callback', 'pending-write-flushed-before-exit', 'native-checkpoint-failure-cancels-quit', 'normal-quit-pauses-focus'], pending: ['full-public-API', 'all-assets-and-drafts-handoff', 'all-widget-flush-participants', 'organizer-exit-restore', 'background-service-shutdown', 'full-release-gates'] }, null, 2))
  } finally { await application.close() }
})
