import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { browserReference } from './browser-reference.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'

const report = 'artifacts/tauri-migration/screenshot-documents-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
const decodePixels = (page, bytes) => page.evaluate(async bytes => {
  const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)]))
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height); const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0); const pixels = [...context.getImageData(0, 0, bitmap.width, bitmap.height).data]
  const result = { width: bitmap.width, height: bitmap.height, pixels }; bitmap.close(); return result
}, bytes)
function bmp() {
  const width = 24; const height = 20; const stride = Math.ceil(width * 3 / 4) * 4
  const output = Buffer.alloc(54 + stride * height)
  output.write('BM'); output.writeUInt32LE(output.length, 2); output.writeUInt32LE(54, 10); output.writeUInt32LE(40, 14)
  output.writeInt32LE(width, 18); output.writeInt32LE(height, 22); output.writeUInt16LE(1, 26); output.writeUInt16LE(24, 28)
  output.writeUInt32LE(stride * height, 34)
  for (let offset = 54; offset < output.length; offset += 3) { output[offset] = 190; output[offset + 1] = 70; output[offset + 2] = 20 }
  return [...output]
}
await test('native screenshot document sessions preserve shared editor sources without filesystem or cross-role authority', { timeout: 120000 }, async suite => {
  let referenceBrowser; let app; let page; let failed = false
  const evidence = []; const errors = []; let formats; const references = {}; const legacyFormatLimitations = []; let retained
  const scenario = async (name, action) => {
    await suite.test(name, { timeout: 25000 }, async () => { try { await action(); evidence.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Screenshot document scenario failed: ' + name)
  }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const create = bytes => page.evaluate(async bytes => {
    const result = await window.dustdesk.createScreenshotDocument(new Uint8Array(bytes))
    return result.payload ? { ...result, payload: { ...result.payload, png: [...result.payload.png] } } : result
  }, bytes)
  const read = id => page.evaluate(async id => {
    const result = await window.dustdesk.readScreenshotDocument(id)
    return result.payload ? { ...result, payload: { ...result.payload, png: [...result.payload.png] } } : result
  }, id)
  try {
    await scenario('independent browser supplies PNG JPEG WebP BMP decoding references', async () => {
      referenceBrowser = await browserReference()
      formats = await referenceBrowser.page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 20
        const context = canvas.getContext('2d'); context.fillStyle = '#1446be'; context.fillRect(0, 0, 24, 20); context.clearRect(0, 0, 3, 3)
        const result = {}
        for (const format of ['png', 'jpeg', 'webp']) result[format] = [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/' + format, .9))).arrayBuffer())]
        return result
      })
      formats.bmp = bmp()
      for (const [format, bytes] of Object.entries(formats)) {
        references[format] = {
          document: {id:'',sourceAssetId:'',width:24,height:20,crop:{x:0,y:0,width:24,height:20},annotations:[],revision:0,nextNumber:1},
          image: await decodePixels(referenceBrowser.page, bytes)
        }
      }
      await referenceBrowser.close(); referenceBrowser = undefined
    })
    await scenario('prototype and desktop widgets cannot access main screenshot documents or binary sources', async () => {
      app = await launchTauri({ releaseDelayMs: 400 }); await app.invoke('prototype_open_workspace')
      page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
      page.on('pageerror', error => errors.push(error.message))
      await page.getByRole('button', { name: '创建工作区', exact: true }).click(); await page.locator('.app-shell').waitFor()
      await page.evaluate(async () => {
        const state = await window.dustdesk.loadWorkspace()
        const result = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false } }, state)
        if (!result.ok) throw Error(result.error)
      })
      assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true)
      const widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html')))
      await widget.getByLabel('桌面新增任务').waitFor()
      for (const target of [app.page, widget]) for (const command of ['screenshot_create', 'screenshot_import', 'screenshot_document', 'screenshot_source', 'screenshot_discard', 'screenshot_finish']) await assert.rejects(app.invoke(command, {}, target), /not allowed|权限|不允许/i)
      await api('setWidgetVisibility', 'todo', false)
    })
    await scenario('all four import formats preserve dimensions and PNG BMP WebP pixels against independent browser decoding', async () => {
      for (const [format, bytes] of Object.entries(formats)) {
        const result = await create(bytes); assert.equal(result.ok, true, JSON.stringify(result))
        const document = result.payload.document
        const expected = references[format].document
        assert.deepEqual({ ...document, id: '', sourceAssetId: '' }, { ...expected, id: '', sourceAssetId: '' })
        assert.match(document.id, /^[\da-f-]{36}$/); assert.notEqual(document.id, document.sourceAssetId)
        const decoded = await decodePixels(page, result.payload.png)
        assert.deepEqual([decoded.width, decoded.height], [24, 20])
        if (format === 'png') assert.deepEqual(result.payload.png, bytes, 'Native PNG sources must retain their original bytes and metadata')
        if (format !== 'jpeg') assert.deepEqual(decoded, references[format].image)
        assert.deepEqual((await read(document.id)).payload, result.payload)
        for (const id of [document.sourceAssetId, path.join(app.root, 'arbitrary.png'), '']) assert.equal((await read(id)).ok, false)
        await api('discardScreenshotDocument', document.id); await api('discardScreenshotDocument', document.id)
        assert.equal((await read(document.id)).ok, false)
      }
      retained = (await create(formats.png)).payload
    })
    await scenario('failed source delivery releases only a new unclaimed document and a retained read can retry', async () => {
      const outcome = await page.evaluate(async ({ bytes, retainedId }) => {
        const original = window.fetch
        let createdId
        const failNextRead = () => {
          let pending = true
          window.fetch = async (input, options) => {
            const url = typeof input === 'string' ? input : input.url
            if (url.endsWith('/screenshot_source') && pending) {
              pending = false
              return new Response(JSON.stringify('source delivery interrupted'), { status: 400, headers: { 'Content-Type': 'application/json', 'Tauri-Response': 'error' } })
            }
            const response = await original.call(window, input, options)
            if (url.endsWith('/screenshot_create')) createdId = (await response.clone().json()).id
            return response
          }
        }
        try {
          failNextRead()
          const failedCreate = await window.dustdesk.createScreenshotDocument(new Uint8Array(bytes))
          window.fetch = original
          failNextRead()
          const failedRead = await window.dustdesk.readScreenshotDocument(retainedId)
          return { createdId, failedCreate, failedRead }
        } finally { window.fetch = original }
      }, { bytes: formats.png, retainedId: retained.document.id })
      assert.equal(outcome.failedCreate.ok, false); assert.match(outcome.failedCreate.error, /source delivery interrupted/)
      assert.equal(outcome.failedRead.ok, false); assert.match(outcome.failedRead.error, /source delivery interrupted/)
      assert.ok(outcome.createdId)
      await waitFor(async () => !(await read(outcome.createdId)).ok)
      assert.deepEqual((await read(retained.document.id)).payload, retained)
    })
    await scenario('malformed raw inputs and JSON bodies fail without discarding an existing source', async () => {
      for (const bytes of [[], [1, 2, 3], [...Buffer.from('GIF89a')], formats.png.slice(0, 20)]) assert.equal((await create(bytes)).ok, false)
      await assert.rejects(app.invoke('screenshot_create', { bytes: formats.png }, page), /二进制/)
      const oversized = await page.evaluate(() => window.dustdesk.createScreenshotDocument(new Uint8Array(32 * 1024 * 1024 + 1)))
      assert.equal(oversized.ok, false); assert.match(oversized.error, /32 MB/)
      assert.equal((await read(retained.document.id)).ok, true)
      const protectedRoot = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace')
      assert.equal((await readdir(protectedRoot)).includes('Screenshots'), false, 'Import must not implicitly save or capture a screen')
    })
    await scenario('the native session cap refuses growth without evicting a retained source and explicit discard frees it', async () => {
      const ids = await page.evaluate(async bytes => {
        const ids = []
        for (let index = 0; index < 63; index++) ids.push((await window.__TAURI_INTERNALS__.invoke('screenshot_create', new Uint8Array(bytes))).id)
        return ids
      }, formats.png)
      try {
        const excess = await create(formats.png); assert.equal(excess.ok, false); assert.match(excess.error, /较多内存/)
        assert.deepEqual((await read(retained.document.id)).payload, retained)
        await api('discardScreenshotDocument', ids.pop())
        const replacement = await create(formats.png); assert.equal(replacement.ok, true); ids.push(replacement.payload.document.id)
      } finally { for (const id of ids) await api('discardScreenshotDocument', id) }
      assert.deepEqual((await read(retained.document.id)).payload, retained)
    })
    await scenario('native screenshot sessions veto main reclamation independently of renderer tracked work', async () => {
      await api('hideMainWindow')
      await new Promise(resolve => setTimeout(resolve, 1800))
      assert.equal(page.isClosed(), false)
      await app.invoke('prototype_open_workspace')
      assert.equal((await read(retained.document.id)).ok, true)
    })
    await scenario('maintenance pauses imports but preserves existing sources for resume', async () => {
      const prepared = await app.invoke('drafts_prepare', {}, page)
      assert.equal((await create(formats.png)).ok, false)
      await assert.rejects(app.invoke('screenshot_document', { id: retained.document.id }, page), /恢复|退出|迁移|维护/)
      await app.invoke('drafts_end', { requestId: prepared.requestId }, page)
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      assert.deepEqual((await read(retained.document.id)).payload, retained)
    })
    await scenario('shared screenshot page imports BMP and edits with the existing real Worker undo and redo', async () => {
      await page.locator('.sidebar').getByText('截图编辑', { exact: true }).click()
      await page.getByLabel('导入截图图片').setInputFiles({ name: '源图.bmp', mimeType: 'image/bmp', buffer: Buffer.from(formats.bmp) })
      await page.waitForFunction(() => document.querySelector('button[aria-label="矩形"]')?.disabled === false)
      assert.equal(await page.locator('.selection-size').innerText(), '24 × 20 px')
      await page.getByRole('button', { name: '矩形', exact: true }).click()
      const canvas = page.locator('.screenshot-image'); await canvas.scrollIntoViewIfNeeded(); const bounds = await canvas.boundingBox(); assert.ok(bounds)
      await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height * .2); await page.mouse.down()
      await page.mouse.move(bounds.x + bounds.width * .8, bounds.y + bounds.height * .8, { steps: 8 }); await page.mouse.up()
      await page.getByRole('button', { name: '撤销', exact: true }).click(); await page.getByRole('button', { name: '重做', exact: true }).click()
      await page.getByRole('button', { name: '保存', exact: true }).click()
      await page.locator('.screenshot-feedback').filter({ hasText: '已保存：' }).waitFor()
      const directory = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace', 'Screenshots')
      const outputs = await readdir(directory); assert.equal(outputs.length, 1)
      const saved = await readFile(path.join(directory, outputs[0]))
      assert.deepEqual([saved.readUInt32BE(16),saved.readUInt32BE(20)],[24,20])
      const backup = await api('createBackup'); assert.equal(backup.ok, true)
      const preview = await api('previewBackup', backup.path)
      assert.equal((await api('restoreBackup', backup.path, preview.fingerprint)).ok, true)
      assert.equal((await read(retained.document.id)).ok, false)
    })
    await scenario('reload revokes old source IDs and the next binary import works without leaking old sessions', async () => {
      const before = (await create(formats.png)).payload
      await page.reload(); await page.locator('.app-shell').waitFor()
      assert.equal((await read(before.document.id)).ok, false)
      const next = (await create(formats.webp)).payload; assert.notEqual(next.document.id, before.document.id)
      await api('discardScreenshotDocument', next.document.id)
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, evidence, errors, legacyFormatLimitations, pending: ['pin-and-reedit', 'native-capture-business', 'external-screenshot-drop', 'physical-DPI-IME-sleep', 'Release-memory-and-packaging'] }, null, 2))
  } catch (error) {
    failed = true
    await writeFile(report, JSON.stringify({ verified: false, productionReady: false, evidence, errors, legacyFormatLimitations, failure: String(error), root: app?.root }, null, 2))
    throw error
  } finally { if (referenceBrowser) await referenceBrowser.close(); if (app) await app.close({ preserve: failed }) }
})
