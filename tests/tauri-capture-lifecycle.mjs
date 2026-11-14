import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { quitOrganizer } from './tauri-organizer-session-support.mjs'

const report = 'artifacts/tauri-migration/capture-lifecycle-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('actual screenshot editors freeze in place for native maintenance and normal quit', { timeout: 300000 }, async suite => {
  let app, page, overlay, failed = false
  const evidence = [], errors = []
  const step = async (name, action) => {
    await suite.test(name, { timeout: 60000 }, async () => { try { await action(); evidence.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Screenshot lifecycle failed: ' + name + '\n' + app.output())
  }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const invoke = (command, args = {}, target = page) => app.invoke(command, args, target)
  const pages = () => app.browser.contexts().flatMap(context => context.pages()).filter(target => !target.isClosed())
  const frozen = value => waitFor(() => overlay.locator('.screenshot-editor').evaluate((element, value) => element.inert === value, value))
  const prepare = () => invoke('drafts_prepare')
  const end = async checkpoint => { assert.equal(await invoke('drafts_end', { requestId: checkpoint.requestId }), true); await frozen(false) }
  const outputs = () => readdir(path.join(app.root, 'user-data', 'tauri-preview', 'Workspace', 'Screenshots')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const snapshot = () => overlay.evaluate(async () => {
    const canvas = document.querySelector('.screenshot-image'), context = canvas.getContext('2d'), text = document.querySelector('textarea')
    const bytes = context.getImageData(0, 0, canvas.width, canvas.height).data
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
    return { digest, selection: document.querySelector('.editor-selection')?.getAttribute('style'), selected: [...document.querySelectorAll('.screenshot-tools .selected')].map(element => element.getAttribute('aria-label')), undo: document.querySelector('[aria-label="撤销"]').disabled, redo: document.querySelector('[aria-label="重做"]').disabled, view: document.querySelector('.screenshot-view-row').innerText, format: document.querySelector('[aria-label="导出格式"]').textContent, text: text?.value, start: text?.selectionStart, end: text?.selectionEnd, direction: text?.selectionDirection }
  })
  const start = async () => {
    assert.equal((await api('startScreenshot', 'FullScreen')).ok, true)
    overlay = await waitFor(() => pages().find(target => target.url().includes('capture.html')))
    overlay.on('pageerror', error => errors.push(error.message))
    await waitFor(() => overlay.getByRole('button', { name: '保存', exact: true }).isEnabled())
  }
  const draw = async (tool, x = 160) => {
    await overlay.getByRole('button', { name: tool, exact: true }).click()
    await overlay.mouse.move(x, 350); await overlay.mouse.down(); await overlay.mouse.move(x + 100, 420, { steps: 8 }); await overlay.mouse.up()
  }
  const textDraft = async () => {
    await overlay.getByRole('button', { name: '文字', exact: true }).click(); await overlay.mouse.click(350, 500)
    await overlay.getByRole('textbox', { name: '标注文字' }).fill('未提交标注🪶\n保留选择范围')
    await overlay.getByRole('textbox', { name: '标注文字' }).evaluate(element => element.setSelectionRange(2, 7, 'backward'))
  }
  const checkpointHold = () => overlay.evaluate(() => {
    window.__checkpointNative = window.__TAURI_INTERNALS__.invoke
    window.__checkpointFetch = window.fetch
    window.__checkpointArgs = undefined
    window.fetch = async (input, init) => {
      if (String(input).endsWith('/screenshot_overlay_checkpoint') && !window.__checkpointArgs) {
        window.__checkpointArgs = JSON.parse(init.body)
        await new Promise(resolve => { window.__checkpointRelease = resolve })
      }
      return window.__checkpointFetch.call(window, input, init)
    }
  })
  const releaseHold = () => overlay.evaluate(() => { window.fetch = window.__checkpointFetch; window.__checkpointRelease() })
  try {
    app = await launchTauri({ workspace: true }); page = app.page
    await page.getByRole('button', { name: '创建工作区', exact: true }).click(); await page.locator('.app-shell').waitFor()
    await page.evaluate(async () => {
      const state = await window.dustdesk.loadWorkspace()
      const saved = await window.dustdesk.saveWorkspace({ ...state, DesktopCategories: [], Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, ScreenshotAfterAction: 'edit', ScreenshotDelaySeconds: 0, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false } }, state)
      if (!saved.ok) throw Error(saved.error)
    })
    await start()
    await step('private capture channel grants only own checkpoint commands and rejects generic events, workspace and foreign responders', async () => {
      for (const target of [page]) for (const command of ['screenshot_overlay_events_attach', 'screenshot_overlay_events_detach', 'screenshot_overlay_checkpoint']) await assert.rejects(invoke(command, {}, target), /not allowed|权限/i)
      for (const command of ['workspace_load', 'application_flushed', 'drafts_checkpoint_ready', 'application_quit', 'drafts_prepare', 'plugin:event|listen']) await assert.rejects(invoke(command, {}, overlay), /not allowed|权限|不允许/i)
      await assert.rejects(invoke('screenshot_overlay_checkpoint', { requestId: 'old', maintenance: true, token: 'foreign' }, overlay), /连接已失效/)
      assert.equal(await overlay.evaluate(() => Boolean(window.dustdesk)), false)
    })
    await step('maintenance preserves real Worker pixels, selection, undo/redo, viewport, export format and uncommitted text without output', async () => {
      await draw('矩形'); await draw('椭圆', 300); await overlay.getByRole('button', { name: '撤销', exact: true }).click()
      await overlay.getByRole('button', { name: '缩小', exact: true }).click()
      await overlay.getByRole('combobox', { name: '导出格式' }).click(); await overlay.getByRole('option', { name: 'JPG', exact: true }).click()
      await textDraft()
      const before = await snapshot(), files = await outputs()
      assert.equal(before.undo, false); assert.equal(before.redo, false)
      const checkpoint = await prepare(); await frozen(true)
      assert.deepEqual(await snapshot(), before)
      for (const command of ['screenshot_overlay_cancel', 'screenshot_overlay_document', 'screenshot_overlay_region']) await assert.rejects(invoke(command, { rect: { x: 10, y: 10, width: 20, height: 20 } }, overlay), /退出|迁移维护/)
      await overlay.keyboard.press('Control+z'); await overlay.keyboard.press('Escape'); assert.deepEqual(await snapshot(), before)
      await end(checkpoint); assert.deepEqual(await snapshot(), before); assert.deepEqual(await outputs(), files)
      assert.equal(await overlay.getByRole('textbox', { name: '标注文字' }).evaluate(element => element === document.activeElement), true)
      await overlay.getByRole('textbox', { name: '标注文字' }).press('Escape')
      await overlay.getByRole('button', { name: '重做', exact: true }).click(); await waitFor(async () => (await snapshot()).digest !== before.digest)
    })
    await step('checkpoint acknowledgements bind actual channel token, request, purpose and native pending participant', async () => {
      await checkpointHold(); const pending = prepare()
      await waitFor(() => overlay.evaluate(() => Boolean(window.__checkpointArgs)))
      const args = await overlay.evaluate(() => window.__checkpointArgs); await frozen(true)
      for (const patch of [{ maintenance: false }, { requestId: 'stale' }, { token: 'foreign' }]) await assert.rejects(overlay.evaluate(args => window.__checkpointNative('screenshot_overlay_checkpoint', args), { ...args, ...patch }), /失效/)
      await releaseHold(); const checkpoint = await pending
      await assert.rejects(invoke('screenshot_overlay_checkpoint', args, overlay), /失效|已处理|未参与/)
      await end(checkpoint)
    })
    await step('composition and an active WebView pointer gesture veto maintenance while retaining the actual editing state', async () => {
      await textDraft(); const before = await snapshot()
      await overlay.getByRole('textbox', { name: '标注文字' }).dispatchEvent('compositionstart', { data: '中文' })
      await assert.rejects(prepare(), /组合输入/); await frozen(false); assert.deepEqual(await snapshot(), before)
      await overlay.getByRole('textbox', { name: '标注文字' }).dispatchEvent('compositionend', { data: '中文' })
      const checkpoint = await prepare(); await end(checkpoint)
      await overlay.getByRole('textbox', { name: '标注文字' }).press('Escape')
      await overlay.getByRole('button', { name: '矩形', exact: true }).click()
      await overlay.mouse.move(200, 200); await overlay.mouse.down(); await overlay.mouse.move(260, 260)
      try { await assert.rejects(prepare(), /拖动/); await frozen(false) } finally { await overlay.mouse.up() }
      const next = await prepare(); await end(next)
    })
    await step('a missing acknowledgement times out after the real native deadline and resumes the same text and pixels for retry', async () => {
      await textDraft(); const before = await snapshot()
      await checkpointHold(); const began = Date.now(), pending = prepare()
      await waitFor(() => overlay.evaluate(() => Boolean(window.__checkpointArgs))); await frozen(true)
      await assert.rejects(pending, /超时/); assert.ok(Date.now() - began >= 14000)
      await frozen(false); assert.deepEqual(await snapshot(), before)
      await releaseHold(); await waitFor(() => overlay.getByRole('alert').allTextContents().then(values => values.some(value => /失效/.test(value))))
      const checkpoint = await prepare(); await end(checkpoint)
      assert.deepEqual(await snapshot(), before)
      await overlay.getByRole('textbox', { name: '标注文字' }).press('Escape')
    })
    await step('another editor failure cancels quit and resumes the screenshot without discarding uncommitted text', async () => {
      await textDraft(); const before = await snapshot()
      await page.evaluate(() => { window.__failQuit = window.dustdesk.onBeforeQuit(async () => { await new Promise(resolve => setTimeout(resolve, 200)); throw Error('capture lifecycle main save failure') }) })
      try { await assert.rejects(invoke('application_quit'), /capture lifecycle main save failure/); await frozen(false); assert.deepEqual(await snapshot(), before) }
      finally { await page.evaluate(() => window.__failQuit()) }
      assert.equal(app.child.exitCode, null)
      await overlay.getByRole('textbox', { name: '标注文字' }).press('Escape')
    })
    await step('overlay navigation invalidates an actual Ready checkpoint and revokes old token acknowledgements', async () => {
      const checkpoint = await prepare(); await frozen(true)
      await overlay.reload(); await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      if (await overlay.getByRole('button', { name: '重试读取', exact: true }).count()) await overlay.getByRole('button', { name: '重试读取', exact: true }).click()
      await waitFor(() => overlay.getByRole('button', { name: '保存', exact: true }).isEnabled()); await frozen(false)
      assert.equal(await invoke('drafts_end', { requestId: checkpoint.requestId }), false)
      const next = await prepare(); await end(next)
    })
    await step('a real native Save As dialog vetoes maintenance and quit until cancelled and preserves the source', async () => {
      const before = await snapshot(), files = await outputs()
      await overlay.getByRole('button', { name: '另存为', exact: true }).click(); await operateDialog(app, '另存为截图', 'visible')
      try { await assert.rejects(prepare(), /截图正在进行/); await assert.rejects(invoke('application_quit'), /截图正在进行/) }
      finally { await operateDialog(app, '另存为截图', 'cancel') }
      await waitFor(() => overlay.getByRole('button', { name: '保存', exact: true }).isEnabled())
      assert.deepEqual(await snapshot(), before); assert.deepEqual(await outputs(), files)
    })
    await step('an idle overlay does not prevent maintenance from cancelling a main-owned native save picker and draining its tracked request', async () => {
      const before = await snapshot(), files = await outputs()
      await page.evaluate(async () => {
        const canvas = new OffscreenCanvas(3, 2); canvas.getContext('2d').fillRect(0, 0, 3, 2)
        const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer())
        const created = await window.dustdesk.createScreenshotDocument(png)
        if (!created.ok) throw Error(created.error)
        window.__mainLifecyclePayload = created.payload
        window.__mainLifecycleSave = window.dustdesk.finishScreenshot({ requestId: crypto.randomUUID(), document: created.payload.document, png, action: 'saveAs', format: 'png' })
      })
      await operateDialog(app, '另存为截图', 'visible')
      const checkpoint = await prepare(); await frozen(true)
      assert.equal((await page.evaluate(() => window.__mainLifecycleSave)).ok, false)
      await end(checkpoint); assert.deepEqual(await snapshot(), before); assert.deepEqual(await outputs(), files)
      const retained = await page.evaluate(() => window.dustdesk.readScreenshotDocument(window.__mainLifecyclePayload.document.id)); assert.equal(retained.ok, true)
      await page.evaluate(() => window.dustdesk.discardScreenshotDocument(window.__mainLifecyclePayload.document.id))
    })
    await step('the actual organizer Cancel resumes a frozen screenshot and successful normal quit closes ephemeral overlays without saving files', async () => {
      await overlay.getByRole('button', { name: '矩形', exact: true }).click(); await draw('矩形'); await textDraft()
      const state = await api('loadWorkspace'); state.DesktopCategories = [{ Id: 'capture-lifecycle', Name: '截图生命周期测试', IsCollapsed: false, ItemPaths: [] }]
      assert.equal((await api('saveWorkspace', state)).ok, true)
      const desktop = path.join(app.root, 'desktop'); await mkdir(desktop, { recursive: true }); const source = path.join(desktop, 'lifecycle.txt'); await writeFile(source, 'isolated organizer bytes')
      const moved = await api('moveIntoCategory', 'capture-lifecycle', source); assert.equal(moved.ok, true)
      const before = await snapshot(), files = await outputs()
      await quitOrganizer(app, page, 'cancel', async () => { await frozen(true); assert.deepEqual(await snapshot(), before) })
      await frozen(false); assert.deepEqual(await snapshot(), before)
      await quitOrganizer(app, page, 'keep'); assert.equal(app.child.exitCode, 0); assert.deepEqual(await outputs(), files)
      assert.equal(await readFile(moved.path, 'utf8'), 'isolated organizer bytes')
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, migrationComplete: false, evidence, errors, limits: ['in-process freeze retains state; overlay reload, crash and restart do not restore screenshot edits', 'composition event coverage does not prove physical IME behavior', 'physical mixed DPI, hotplug, release performance and packaging remain unverified'] }, null, 2))
  } catch (error) {
    await writeFile(report, JSON.stringify({ verified: false, productionReady: false, migrationComplete: false, evidence, errors, failure: String(error), output: app?.output() }, null, 2)); throw error
  } finally { await app?.close() }
})
