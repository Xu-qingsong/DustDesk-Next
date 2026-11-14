import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rm, rename, rmdir } from 'node:fs/promises'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:net'
import path from 'node:path'
import { chromium } from 'playwright'
import { randomUUID } from 'node:crypto'
import { launchTauri, waitFor } from './tauri-harness.mjs'

const run = promisify(execFile)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const report = 'artifacts/tauri-migration/quick-capture-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
async function native(app, action) {
  const parameters = Buffer.from(JSON.stringify({ script: path.resolve('tests/tauri-main-window.ps1'), processId: app.child.pid, action })).toString('base64')
  const command = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + parameters + "'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($p.script,[Text.Encoding]::UTF8))) -ProcessId $p.processId -Action $p.action -WindowTitle 'DustDesk 快速记录'"
  return JSON.parse((await run('pwsh.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 15000 })).stdout)
}
async function tray(pid, caption) {
  const parameters = Buffer.from(JSON.stringify({ script: path.resolve('tests/tauri-pin-tray.ps1'), pid, caption })).toString('base64')
  const command = "$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + parameters + "'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($p.script,[Text.Encoding]::UTF8))) -ProcessId $p.pid -Captions @($p.caption)"
  return JSON.parse((await run('pwsh.exe', ['-Sta', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], { windowsHide: true, timeout: 30000 })).stdout)
}
async function descendants(pid) {
  const command = '$rows=@(Get-CimInstance Win32_Process);$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add(' + pid + ');do{$added=$false;foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)){$added=$true}}}while($added);ConvertTo-Json -InputObject @($rows|Where-Object{$ids.Contains([int]$_.ProcessId)}|Select-Object ProcessId,Name) -Compress'
  return JSON.parse((await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 15000 })).stdout)
}

await test('native quick capture preserves drafts, scopes commands and participates in maintenance and quit', { timeout: 240000 }, async suite => {
  let app = await launchTauri({ workspace: true, releaseDelayMs: 150 }), quick, child, browser, output = '', failed = false
  const evidence = [], errors = [], processSamples = [], clicks = []
  const root = app.root, executable = app.executable
  const location = path.join(root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')
  const disk = async () => JSON.parse(await readFile(location, 'utf8'))
  const pages = () => (browser ?? app.browser).contexts().flatMap(context => context.pages()).filter(target => !target.isClosed())
  const invoke = (command, args = {}, target = quick) => target.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args })
  const api = (method, ...args) => app.page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const attach = async () => { quick = await waitFor(() => pages().find(target => target.url().includes('quick.html'))); quick.on('pageerror', error => errors.push(error.message)); await waitFor(() => quick.getByLabel('记录标题').isEnabled()); return quick }
  const show = async () => { await api('showQuickCapture'); return attach() }
  const closed = target => waitFor(() => target.isClosed(), 12000)
  const draft = () => quick.evaluate(() => JSON.parse(localStorage.getItem('quick-capture-draft')))
  const scenario = async (name, callback) => { await suite.test(name, async () => { try { await callback(); evidence.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Quick capture failed: ' + name) }
  try {
    await app.page.getByRole('button', { name: '创建工作区', exact: true }).click(); await app.page.locator('.app-shell').waitFor()
    const state = await api('loadWorkspace'); state.Settings.AutomaticBackupEnabled = false; state.Settings.ClipboardMonitoringEnabled = false
    assert.equal((await api('saveWorkspace', state)).ok, true)
    await scenario('main entry creates only the shared quick capture UI and native role rejects unrelated commands', async () => {
      await show(); assert.equal((await native(app, 'snapshot')).visible, true)
      assert.equal(await quick.evaluate(() => typeof window.dustdesk), 'undefined')
      for (const command of ['workspace_load', 'workspace_save', 'workspace_productivity', 'quick_capture_show', 'quick_capture_request_hide', 'clipboard_read', 'application_quit', 'screenshot_start', 'widget_events_attach', 'plugin:event|listen', 'plugin:window|destroy']) await assert.rejects(invoke(command), /not allowed|权限|不允许/i)
      for (const command of ['quick_capture_save', 'quick_capture_committed', 'quick_capture_hide', 'quick_capture_events_attach']) await assert.rejects(app.invoke(command, {}, app.page), /not allowed|权限|不允许/i)
      const capture = { kind: 'note', title: 'must reject', text: '', requestId: randomUUID(), sourceNoteId: 'private' }
      await assert.rejects(invoke('quick_capture_save', { draft: capture }), /unknown field/i)
      await assert.rejects(invoke('quick_capture_abort'), /编辑器已就绪/)
    })
    await scenario('task keyboard submission is IME safe and broadcasts to the real main and todo widget', async () => {
      assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true)
      const todo = await waitFor(() => pages().find(target => target.url().includes('widget.html'))); await todo.getByLabel('桌面新增任务').waitFor()
      await quick.getByLabel('记录标题').fill('原生任务记录'); await quick.getByLabel('记录正文').fill('正文内容')
      for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
        await quick.getByLabel('记录正文').dispatchEvent('keydown', { key: 'Enter', ctrlKey: true, ...composition })
        await quick.getByLabel('记录标题').dispatchEvent('keydown', { key: 'Escape', ...composition })
        assert.equal((await disk()).Todos.some(item => item.Title === '原生任务记录'), false)
        assert.equal((await native(app, 'snapshot')).visible, true)
      }
      const old = quick; await quick.getByLabel('记录正文').press('Control+Enter'); await closed(old)
      await todo.getByText('原生任务记录', { exact: true }).waitFor(); assert.equal((await api('loadWorkspace')).Todos.filter(item => item.Title === '原生任务记录').length, 1)
      await api('hideWidget', 'todo'); await closed(todo); await show(); assert.equal(await quick.getByLabel('记录标题').inputValue(), '')
    })
    await scenario('Escape and physical WM_CLOSE retain exact draft and recreate the released WebView', async () => {
      await quick.getByRole('button', { name: '便签', exact: true }).click(); await quick.getByLabel('记录标题').fill('收起后保留'); await quick.getByLabel('记录正文').fill('含中文\n第二行')
      const saved = await draft(), old = quick; await quick.getByLabel('记录标题').press('Escape'); await closed(old); await show(); assert.deepEqual(await draft(), saved)
      const before = quick; await native(app, 'close'); await closed(before); await show(); assert.deepEqual(await draft(), saved)
      await quick.getByRole('button', { name: '保存并收起', exact: true }).click(); await closed(quick)
      assert.equal((await disk()).Notes.find(item => item.Id === saved.requestId).Text, saved.text)
    })
    await scenario('actual browser storage failure vetoes close, quit and maintenance while preserving memory and disk draft', async () => {
      await show(); await quick.getByLabel('记录标题').fill('磁盘中的草稿')
      await quick.evaluate(() => { window.__quickOriginalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'quick-capture-draft') throw Error('quick storage failure fixture'); return window.__quickOriginalSet.call(this, key, value) } })
      await quick.getByLabel('记录标题').fill('仅在内存中的草稿'); await quick.getByRole('alert').filter({ hasText: '草稿暂未写入磁盘' }).waitFor()
      await native(app, 'close'); await delay(600); assert.equal((await native(app, 'snapshot')).visible, true); assert.equal((await draft()).title, '磁盘中的草稿')
      await assert.rejects(app.invoke('application_quit', {}, app.page), /quick storage failure fixture/); await waitFor(() => quick.evaluate(() => !document.documentElement.inert))
      await assert.rejects(app.invoke('drafts_prepare', {}, app.page), /quick storage failure fixture/); await waitFor(() => quick.evaluate(() => !document.documentElement.inert))
      assert.equal(await quick.getByLabel('记录标题').inputValue(), '仅在内存中的草稿')
      await quick.evaluate(() => { Storage.prototype.setItem = window.__quickOriginalSet }); await quick.getByRole('button', { name: '重试保存草稿', exact: true }).click(); assert.equal((await draft()).title, '仅在内存中的草稿')
      await api('hideQuickCapture'); await closed(quick)
    })
    await scenario('save-success cleanup failure is reconciled after reload and never resubmits the old request', async () => {
      await show(); await quick.getByLabel('记录标题').fill('提交成功清理失败'); const saved = await draft()
      await quick.evaluate(() => { window.__quickOriginalSet = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'quick-capture-draft' && !JSON.parse(value).title) throw Error('quick cleanup failure fixture'); return window.__quickOriginalSet.call(this, key, value) } })
      await quick.getByRole('button', { name: '保存并收起', exact: true }).click(); await quick.getByRole('alert').filter({ hasText: '本地草稿清理失败' }).waitFor()
      assert.equal((await draft()).requestId, saved.requestId); assert.equal((await disk()).Notes.filter(item => item.Id === saved.requestId).length, 1)
      await quick.reload(); await waitFor(() => quick.getByLabel('记录标题').isEnabled()); assert.equal(await quick.getByLabel('记录标题').inputValue(), ''); assert.notEqual((await draft()).requestId, saved.requestId)
      assert.equal((await disk()).Notes.filter(item => item.Id === saved.requestId).length, 1)
      // A committed and subsequently recycled record must not resurrect either.
      const state = await api('loadWorkspace'); state.Notes = state.Notes.filter(item => item.Id !== saved.requestId); assert.equal((await api('saveWorkspace', state)).ok, true)
      await quick.evaluate(value => localStorage.setItem('quick-capture-draft', JSON.stringify(value)), saved); await quick.reload(); await waitFor(() => quick.getByLabel('记录标题').isEnabled()); assert.equal(await quick.getByLabel('记录标题').inputValue(), '')
      assert.equal((await disk()).Notes.some(item => item.Id === saved.requestId), false); assert.equal((await disk()).RecycleBin.some(item => item.value.Id === saved.requestId), true)
    })
    await scenario('real workspace write failure retains the request and later save persists once', async () => {
      await quick.getByLabel('记录标题').fill('工作区写入失败重试'); const saved = await draft(), backup = location + '.bak', held = backup + '.quick-held'
      await rename(backup, held); await mkdir(backup)
      try {
        await quick.getByRole('button', { name: '保存并收起', exact: true }).click(); await waitFor(() => quick.getByRole('button', { name: '保存并收起', exact: true }).isEnabled())
        assert.equal((await disk()).Notes.some(item => item.Id === saved.requestId), false); assert.deepEqual(await draft(), saved); assert.equal((await native(app, 'snapshot')).visible, true)
      } finally { await rmdir(backup); await rename(held, backup) }
      await quick.getByRole('button', { name: '保存并收起', exact: true }).click(); await closed(quick); assert.equal((await disk()).Notes.filter(item => item.Id === saved.requestId).length, 1)
    })
    await scenario('maintenance rejects composition then seals all participants and refuses new capture actions until resumed', async () => {
      await show(); await quick.getByLabel('记录标题').fill('维护检查点草稿'); const saved = await draft()
      await quick.getByLabel('记录标题').dispatchEvent('compositionstart', { data: '中' }); await assert.rejects(app.invoke('drafts_prepare', {}, app.page), /组合输入/)
      await waitFor(() => quick.evaluate(() => !document.documentElement.inert)); await quick.getByLabel('记录标题').dispatchEvent('compositionend', { data: '中' })
      const checkpoint = await app.invoke('drafts_prepare', {}, app.page)
      assert.equal(await quick.evaluate(() => document.documentElement.inert), true); assert.deepEqual(await draft(), saved)
      for (const command of ['quick_capture_hide', 'quick_capture_save']) await assert.rejects(invoke(command, command.endsWith('save') ? { draft: saved } : {}), /退出|维护/)
      await assert.rejects(api('showQuickCapture'), /退出|维护/)
      await assert.rejects(app.invoke('drafts_checkpoint_ready', { requestId: checkpoint.requestId, error: null }), /请求已失效/)
      assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }, app.page), true); await waitFor(() => quick.evaluate(() => !document.documentElement.inert))
      assert.equal(await quick.getByLabel('记录标题').inputValue(), saved.title)
    })
    await scenario('backup restore explicitly protects the live quick draft until a successful checkpoint and release', async () => {
      const backup = await api('createBackup'); assert.equal(backup.ok, true); const preview = await api('previewBackup', backup.path)
      const result = await api('restoreBackup', preview.path, preview.fingerprint); assert.equal(result.ok, false); assert.match(result.error, /快速记录/)
      assert.equal(await quick.getByLabel('记录标题').inputValue(), '维护检查点草稿')
      await api('hideQuickCapture'); await closed(quick); assert.equal((await api('restoreBackup', preview.path, preview.fingerprint)).ok, true)
    })
    await scenario('main reload and repeated hide/show invalidate old release attempts without losing the quick draft', async () => {
      await show(); await quick.getByLabel('记录标题').fill('主窗重载独立草稿'); const saved = await draft(), original = quick
      await app.page.reload(); await app.page.locator('.app-shell').waitFor(); assert.equal(quick, original); assert.equal(quick.isClosed(), false); assert.deepEqual(await draft(), saved)
      for (let index = 0; index < 6; index++) { await api('hideQuickCapture'); await delay(index % 2 ? 170 : 40); await show(); assert.equal((await native(app, 'snapshot')).visible, true); assert.deepEqual(await draft(), saved) }
      await delay(600); assert.equal(quick.isClosed(), false); assert.equal((await native(app, 'snapshot')).visible, true)
      await api('hideQuickCapture'); await closed(quick)
    })
    await scenario('real fifteen-second missing quit acknowledgement cancels exit and restores editing', async () => {
      await show(); await quick.evaluate(() => {
        window.__quickFetch = window.fetch
        window.fetch = async function(input, options) {
          const url = typeof input === 'string' ? input : input.url
          if (url.endsWith('/application_flushed')) { window.__quickAckBlocked = true; await new Promise(resolve => { window.__quickReleaseAck = resolve }) }
          return window.__quickFetch.call(this, input, options)
        }
      })
      const started = Date.now(); await assert.rejects(app.invoke('application_quit', {}, app.page), /保存超时/); assert.ok(Date.now() - started >= 14500)
      await waitFor(() => quick.evaluate(() => !document.documentElement.inert)); assert.equal(app.child.exitCode, null)
      assert.equal(await quick.evaluate(() => window.__quickAckBlocked), true)
      await quick.evaluate(() => { window.fetch = window.__quickFetch; window.__quickReleaseAck() }); await quick.getByLabel('记录标题').fill('超时后仍可编辑'); await api('hideQuickCapture'); await closed(quick)
    })
    await scenario('an unresolved browser journal opens no editor and both the error action and physical close preserve disk drafts', async () => {
      await show(); const saved = await draft()
      // Even a renderer that detaches/replaces its channel cannot turn a live
      // editor into a pre-mount error page and bypass the draft checkpoint.
      const token = await quick.evaluate(() => { const callback = window.__TAURI_INTERNALS__.transformCallback(() => {}); return window.__TAURI_INTERNALS__.invoke('quick_capture_events_attach', { channel: '__CHANNEL__:' + callback }) })
      assert.equal(await invoke('quick_capture_events_detach', { token }), true)
      await assert.rejects(invoke('quick_capture_abort'), /编辑器已就绪/)
      await quick.evaluate(() => localStorage.setItem('dustdesk:draft-migration:pending:v1', 'quick journal barrier fixture'))
      await quick.reload(); await quick.getByRole('alert').filter({ hasText: '未完成草稿导入' }).waitFor(); assert.equal(await quick.getByLabel('记录标题').count(), 0)
      const errorPage = quick; await quick.getByRole('button', { name: '收起并保留草稿', exact: true }).click(); await closed(errorPage)
      await api('showQuickCapture'); quick = await waitFor(() => pages().find(target => target.url().includes('quick.html'))); await quick.getByRole('alert').filter({ hasText: '未完成草稿导入' }).waitFor(); assert.deepEqual(await draft(), saved)
      await native(app, 'close'); await closed(quick)
      await app.page.evaluate(() => localStorage.removeItem('dustdesk:draft-migration:pending:v1'))
    })
    await scenario('pure tray restart starts with zero WebViews and physical quick capture needs no main receiver', async () => {
      const quitting = app.invoke('application_quit', {}, app.page).catch(error => { if (!String(error).includes('closed')) throw error })
      await waitFor(() => app.child.exitCode !== null); await quitting; assert.equal(app.child.exitCode, 0)
      await app.close({ preserve: true })
      const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise(resolve => server.close(resolve))
      const endpoint = 'http://127.0.0.1:' + port
      child = spawn(executable, ['--hidden', '--workspace'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'), DUSTDESK_TEST_DATA_DIR: path.join(root, 'data'), DUSTDESK_TEST_DESKTOP_DIR: path.join(root, 'desktop'), DUSTDESK_TAURI_DISABLE_HOTKEYS: '1', DUSTDESK_TAURI_TEST_RELEASE_DELAY_MS: '150', WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1 --no-first-run' } })
      child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) }); await delay(500)
      const sample = await descendants(child.pid); processSamples.push(sample); assert.ok(sample.every(row => row.ProcessId === child.pid || row.Name.toLowerCase() === 'conhost.exe'), JSON.stringify(sample))
      clicks.push(await tray(child.pid, '快速记录'))
      await waitFor(async () => { try { return (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(1000) })).ok } catch { return false } })
      browser = await chromium.connectOverCDP(endpoint); await attach(); assert.equal(await quick.getByLabel('记录标题').inputValue(), '超时后仍可编辑')
      assert.ok(pages().every(target => target.url().includes('quick.html')))
      await quick.getByLabel('记录标题').fill('纯托盘便签'); const saved = await draft(); await quick.getByRole('button', { name: '保存并收起', exact: true }).click(); await closed(quick)
      assert.equal((await disk()).Notes.filter(item => item.Id === saved.requestId).length, 1)
      await browser.close().catch(() => {}); browser = undefined
      await waitFor(async () => !(await descendants(child.pid)).some(row => row.Name.toLowerCase() === 'msedgewebview2.exe'))
      processSamples.push(await descendants(child.pid))
      clicks.push(await tray(child.pid, '退出 DustDesk')); await waitFor(() => child.exitCode !== null); assert.equal(child.exitCode, 0)
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, migrationComplete: false, evidence, errors, clicks, processSamples }, null, 2))
  } catch (error) {
    console.error(app.output(), output)
    await writeFile(report, JSON.stringify({ verified: false, evidence, error: String(error), output: app.output() + output, pages: await Promise.all(pages().map(async page => ({ url: page.url(), body: await page.locator('body').innerText().catch(() => '') }))) }, null, 2)); throw error
  } finally {
    await browser?.close().catch(() => {})
    if (child?.pid && child.exitCode === null) await run('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {})
    await app.close()
  }
})
