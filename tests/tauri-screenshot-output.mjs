import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { browserReference } from './browser-reference.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { clipboardFixture, holdClipboard } from './tauri-clipboard-support.mjs'

const report = 'artifacts/tauri-migration/screenshot-output-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native screenshot outputs preserve shared document transactions and actual file clipboard effects', { timeout: 180000 }, async suite => {
  const guard = await clipboardFixture()
  let app; let referenceBrowser; let page; let failed = false; let formats; let document
  const evidence = []; const errors = []; const reference = {}
  const scenario = async (name, callback) => { await suite.test(name, { timeout: 30000 }, async () => { try { await callback(); evidence.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Screenshot output failed: ' + name) }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const finish = (request, bytes = formats.png, jpeg) => {
    const pending = page.evaluate(({ request, bytes, jpeg }) => window.dustdesk.finishScreenshot({ ...request, png: new Uint8Array(bytes), ...(jpeg ? { jpeg: new Uint8Array(jpeg) } : {}) }), { request, bytes, jpeg })
    void pending.catch(() => undefined); return pending
  }
  const settings = patch => page.evaluate(async patch => { const state = await window.dustdesk.loadWorkspace(); const result = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, ...patch } }, state); if (!result.ok) throw Error(result.error) }, patch)
  const workspace = () => api('loadWorkspace')
  const request = (requestId, action = 'save', edited = document) => ({ requestId, action, document: edited, format: 'png' })
  const history = async () => (await workspace()).ClipboardHistory
  try {
    await scenario('independent browser supplies exact PNG JPEG bytes and known clipboard pixel expectations', async () => {
      referenceBrowser = await browserReference()
      formats = await referenceBrowser.page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 20
        const context = canvas.getContext('2d'); context.fillStyle = '#1446be'; context.fillRect(0, 0, 24, 20)
        const result = {}
        for (const format of ['png', 'jpeg']) result[format] = [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/' + format, .92))).arrayBuffer())]
        return result
      })
      reference.png = Buffer.from(formats.png); reference.jpeg = Buffer.from(formats.jpeg)
      reference.clipboard = {image:{width:24,height:20,first:[20,70,190,255]}}
      await referenceBrowser.close(); referenceBrowser = null
    })
    await guard.request('clear')
    app = await launchTauri({ releaseDelayMs: 1000, clipboardMonitoring: true }); await app.invoke('prototype_open_workspace')
    page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
    page.on('pageerror', error => errors.push(error.message))
    await page.getByRole('button', { name: '创建工作区', exact: true }).click(); await page.locator('.app-shell').waitFor()
    await settings({ AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false, ScreenshotFormat: 'png', SidebarHidden: [] })
    const created = await page.evaluate(bytes => window.dustdesk.createScreenshotDocument(new Uint8Array(bytes)), formats.png)
    assert.equal(created.ok, true); document = created.payload.document
    const root = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace')
    const outputDirectory = path.join(root, 'Screenshots')
    const readDocument = async () => (await api('readScreenshotDocument', document.id)).payload.document
    await scenario('only the actual main may output and malformed or forged documents leave no file', async () => {
      await assert.rejects(app.invoke('screenshot_finish', {}, app.page), /not allowed|权限|不允许/i)
      await assert.rejects(app.invoke('screenshot_finish', {}, page), /二进制/)
      for (const edited of [{ ...document, sourceAssetId: 'foreign' }, { ...document, width: 25 }, { ...document, revision: -1 }, { ...document, sourceRect: null }, { ...document, targetPinId: null }, { ...document, annotations: [{ id: 'bad', kind: 'pen', points: [], style: {} }] }]) {
        const result = await finish(request('bad-' + JSON.stringify(edited).length, 'save', edited)); assert.equal(result.ok, false)
      }
      assert.equal((await finish(request('bad-image'), [1, 2, 3])).ok, false)
      assert.equal((await readdir(root)).includes('Screenshots'), false)
      assert.deepEqual(await readDocument(), document)
    })
    await scenario('default PNG and supplied JPEG match frozen reference bytes and duplicate requests publish once', async () => {
      const before = await history()
      const edited = { ...document, revision: 1 }
      const [first, duplicate] = await Promise.all([finish(request('same-save', 'save', edited)), finish(request('same-save', 'save', edited))])
      assert.equal(first.ok, true, JSON.stringify(first)); assert.deepEqual(duplicate, first)
      assert.deepEqual(await readFile(first.path), reference.png)
      assert.equal((await readdir(outputDirectory)).length, 1)
      assert.equal((await finish({ ...request('same-save', 'save', edited), format: 'jpg' }, formats.png, formats.jpeg)).ok, false)
      const jpeg = await finish({ ...request('jpeg', 'save', edited), format: 'jpg' }, formats.png, formats.jpeg)
      assert.equal(jpeg.ok, true); assert.deepEqual(await readFile(jpeg.path), reference.jpeg)
      assert.equal((await readdir(outputDirectory)).length, 2)
      assert.deepEqual(await history(), before); document = edited
    })
    await scenario('native Save As cancellation preserves edits and a JPEG selection uses exact rendered JPEG', async () => {
      const edited = { ...document, revision: 2 }
      let pending = finish(request('save-as-cancel', 'saveAs', edited)); await operateDialog(app, '另存为截图', 'cancel')
      assert.deepEqual(await pending, { ok: false, canceled: true }); assert.deepEqual(await readDocument(), document)
      const target = path.join(app.root, '中文🪶-另存.jpeg')
      pending = finish(request('save-as-cancel', 'saveAs', edited), formats.png, formats.jpeg)
      await operateDialog(app, '另存为截图', 'select', target)
      const result = await pending; assert.equal(result.ok, true, JSON.stringify(result)); assert.deepEqual(await readFile(result.path), reference.jpeg)
      document = edited
    })
    await scenario('native overwrite confirmation replaces only the chosen PNG and a hardlinked target is rejected', async () => {
      const target = path.join(app.root, '原生覆盖.png'); await writeFile(target, 'old bytes')
      const pending = finish(request('save-as-overwrite', 'saveAs'), formats.png, formats.jpeg)
      const selecting = operateDialog(app, '另存为截图', 'select', target)
      await Promise.all([selecting, operateDialog(app, '确认另存为', 'confirm')])
      const result = await pending; assert.equal(result.ok, true); assert.deepEqual(await readFile(result.path), reference.png)
      const { link } = await import('node:fs/promises')
      const alias = path.join(app.root, '硬链接.png'); await link(target, alias)
      const rejected = finish(request('hardlink', 'saveAs'))
      const choosing = operateDialog(app, '另存为截图', 'select', alias)
      await Promise.all([choosing, operateDialog(app, '确认另存为', 'confirm')])
      const failure = await rejected; assert.equal(failure.ok, false); assert.match(failure.error, /硬链接/)
      assert.deepEqual(await readFile(target), reference.png); assert.deepEqual(await readFile(alias), reference.png)
    })
    await scenario('invalid JPEG output dimensions preserve the prior document and produce no file', async () => {
      const before = await readdir(outputDirectory)
      const edited = { ...document, revision: document.revision + 1 }
      const bad = await finish({ ...request('jpeg-invalid', 'save', edited), format: 'jpg' }, formats.png, formats.png)
      assert.equal(bad.ok, false); assert.match(bad.error, /JPEG/)
      const small = await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1
        return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))).arrayBuffer())]
      })
      const wrongSize = await finish({ ...request('jpeg-invalid', 'save', edited), format: 'jpg' }, formats.png, small)
      assert.equal(wrongSize.ok, false); assert.match(wrongSize.error, /尺寸不一致/)
      assert.deepEqual(await readDocument(), document); assert.deepEqual(await readdir(outputDirectory), before)
    })
    await scenario('native clipboard copy matches the known source and a locked clipboard preserves the document for explicit retry', async () => {
      const edited = { ...document, revision: 3 }
      await guard.request('set-text', { text: 'preserved before failed screenshot copy' })
      const release = await holdClipboard()
      try { const failed = await finish(request('copy-retry', 'copy', edited)); assert.equal(failed.ok, false); assert.deepEqual(await readDocument(), document) } finally { await release() }
      const copied = await finish(request('copy-retry', 'copy', edited)); assert.equal(copied.ok, true, JSON.stringify(copied))
      const actual = await guard.request('inspect'); assert.deepEqual(actual.image, reference.clipboard.image); assert.ok(actual.formats.includes('PNG'))
      assert.deepEqual(await history(), []); document = edited
    })
    await scenario('explicit screenshot history ignores disabled monitoring and deduplicates without storing PNG in broadcasts', async () => {
      await page.evaluate(() => { window.screenshotHistoryEvents = []; window.dustdesk.onClipboardChanged(record => window.screenshotHistoryEvents.push(record)) })
      await settings({ ScreenshotAutoAddToClipboardHistory: true, ClipboardMonitoringEnabled: false })
      assert.equal((await finish(request('history-one', 'copy'))).ok, true)
      const records = await history(); assert.equal(records.length, 1)
      assert.equal(records[0].ImagePngBase64, ''); assert.equal(records[0].ImageSha256, createHash('sha256').update(Buffer.from(formats.png)).digest('hex'))
      assert.deepEqual(await readFile(path.join(root, 'ClipboardImages', records[0].ImageAssetName)), Buffer.from(formats.png))
      await waitFor(async () => (await page.evaluate(() => window.screenshotHistoryEvents)).length === 1)
      assert.deepEqual((await page.evaluate(() => window.screenshotHistoryEvents))[0], records[0])
      assert.equal((await finish(request('history-two', 'copy'))).ok, true); assert.equal((await history()).length, 1)
      await settings({ ScreenshotAutoAddToClipboardHistory: false })
    })
    await scenario('screenshot auto-copy suppresses only its own monitor sequence instead of duplicating explicit history', async () => {
      await guard.request('clear')
      await settings({ ScreenshotAutoAddToClipboardHistory: true, ClipboardMonitoringEnabled: true, ScreenshotAutoCopy: true })
      const before = (await history()).length
      assert.equal((await finish(request('monitor-sequence'))).ok, true)
      await new Promise(resolve => setTimeout(resolve, 800))
      assert.equal((await history()).length, before)
      await guard.request('set-text', { text: 'external copy after screenshot output' })
      await waitFor(async () => (await history()).some(record => record.Text === 'external copy after screenshot output'))
      await settings({ ScreenshotAutoAddToClipboardHistory: false, ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false })
    })
    await scenario('automatic clipboard failure warns after a durable save and retries do not duplicate the file', async () => {
      await settings({ ScreenshotAutoCopy: true })
      const release = await holdClipboard(); let result
      try { result = await finish(request('warn-save')); assert.equal(result.ok, true); assert.match(result.warning, /自动复制失败/); assert.deepEqual(await readFile(result.path), reference.png) } finally { await release() }
      assert.deepEqual(await finish(request('warn-save')), result)
      await settings({ ScreenshotAutoCopy: false })
    })
    await scenario('screenshot copying and saving retain the full 32 MiB boundary rather than the normal clipboard 12 MiB limit', async () => {
      const before = (await history()).length
      await settings({ ScreenshotAutoAddToClipboardHistory: true })
      const result = await page.evaluate(async ({ document, bytes }) => {
        const png = new Uint8Array(32 * 1024 * 1024); png.set(bytes)
        const copy = await window.dustdesk.finishScreenshot({ requestId: 'boundary-copy', document, action: 'copy', png })
        const saved = await window.dustdesk.finishScreenshot({ requestId: 'boundary-save', document, action: 'save', png, format: 'png' })
        const oversized = await window.dustdesk.finishScreenshot({ requestId: 'oversized-copy', document, action: 'copy', png: new Uint8Array(png.length + 1) })
        return { copy, saved, oversized }
      }, { document, bytes: formats.png })
      assert.equal(result.copy.ok, true, JSON.stringify(result.copy)); assert.equal(result.saved.ok, true)
      assert.match(result.copy.warning, /加入剪贴板历史失败/); assert.match(result.saved.warning, /加入剪贴板历史失败/)
      const saved = await readFile(result.saved.path); assert.equal(saved.length, 32 * 1024 * 1024); assert.deepEqual(saved.subarray(0, formats.png.length), Buffer.from(formats.png))
      assert.equal(result.oversized.ok, false); assert.match(result.oversized.error, /32 MB/)
      assert.deepEqual((await guard.request('inspect')).image, reference.clipboard.image)
      assert.equal((await history()).length, before)
      await settings({ ScreenshotAutoAddToClipboardHistory: false })
    })
    await scenario('filesystem and protected destination failures do not commit and the same request can succeed after repair', async () => {
      const blocked = path.join(app.root, 'not-a-directory'); await writeFile(blocked, 'keep')
      const edited = { ...document, revision: 4 }
      await settings({ ScreenshotSaveDirectory: blocked })
      assert.equal((await finish(request('disk-retry', 'save', edited))).ok, false); assert.deepEqual(await readDocument(), document); assert.equal(await readFile(blocked, 'utf8'), 'keep')
      await settings({ ScreenshotSaveDirectory: path.join(root, 'ClipboardImages') })
      const protectedResult = await finish(request('disk-retry', 'save', edited)); assert.equal(protectedResult.ok, false); assert.match(protectedResult.error, /内部数据目录/)
      const custom = path.join(app.root, '自定义截图目录'); await settings({ ScreenshotSaveDirectory: custom })
      const result = await finish(request('disk-retry', 'save', edited)); assert.equal(result.ok, true); assert.deepEqual(await readFile(result.path), reference.png)
      document = edited; await settings({ ScreenshotSaveDirectory: '' })
    })
    await scenario('maintenance cancels an actual screenshot save dialog and resumes the retained source', async () => {
      const edited = { ...document, revision: 5 }
      const pending = finish(request('maintenance', 'saveAs', edited)); await operateDialog(app, '另存为截图', 'visible')
      const prepared = await app.invoke('drafts_prepare', {}, page)
      assert.equal((await pending).ok, false)
      await app.invoke('drafts_end', { requestId: prepared.requestId }, page)
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      assert.deepEqual(await readDocument(), document)
      assert.equal((await finish(request('maintenance', 'save', edited))).ok, true); document = edited
    })
    await scenario('the output queue is bounded while a real picker is open and queued requests revalidate after cancellation', async () => {
      const first = finish(request('queue-first', 'saveAs')); await operateDialog(app, '另存为截图', 'visible')
      const second = finish(request('queue-second'))
      const third = await finish(request('queue-overflow'))
      assert.equal(third.ok, false); assert.match(third.error, /队列已满/)
      await operateDialog(app, '另存为截图', 'cancel'); assert.equal((await first).canceled, true); assert.equal((await second).ok, true)
    })
    await scenario('reload cancels the picker revokes old IDs and leaves no temporary exports', async () => {
      const pending = finish(request('reload', 'saveAs')); await operateDialog(app, '另存为截图', 'visible')
      await page.reload(); await page.locator('.app-shell').waitFor(); await pending.catch(() => undefined)
      assert.equal((await api('readScreenshotDocument', document.id)).ok, false)
      assert.equal((await finish(request('stale'))).ok, false)
      assert.ok((await readdir(outputDirectory)).every(name => name.endsWith('.png') || name.endsWith('.jpg')))
    })
    await scenario('native quit cancels the actual screenshot save picker and drains its tracked request', async () => {
      const created = await page.evaluate(bytes => window.dustdesk.createScreenshotDocument(new Uint8Array(bytes)), formats.png); assert.equal(created.ok,true); document = created.payload.document
      const pending = finish(request('quit', 'saveAs')); await operateDialog(app, '另存为截图', 'visible')
      void app.invoke('application_quit', {}, page).catch(() => undefined)
      await waitFor(() => app.child.exitCode !== null, 10000); assert.equal(app.child.exitCode, 0)
      await pending.catch(() => undefined)
      assert.ok((await readdir(outputDirectory)).every(name => name.endsWith('.png') || name.endsWith('.jpg')))
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, evidence, errors, pending: ['pin-and-reedit', 'business-capture', 'native-screenshot-drop', 'physical-DPI-IME', 'Release-performance-and-packaging'] }, null, 2))
  } catch (error) {
    failed = true; await writeFile(report, JSON.stringify({ verified: false, productionReady: false, evidence, errors, failure: String(error), root: app?.root }, null, 2)); throw error
  } finally { if (referenceBrowser) await referenceBrowser.close(); if (app) await app.close({ preserve: failed }); await guard.close() }
})
