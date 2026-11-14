import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, readdir, open, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'

const execute = promisify(execFile)
const report = 'artifacts/tauri-migration/screenshot-drop-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
function bitmap() {
  const width = 24; const height = 20; const stride = Math.ceil(width * 3 / 4) * 4
  const output = Buffer.alloc(54 + stride * height)
  output.write('BM'); output.writeUInt32LE(output.length, 2); output.writeUInt32LE(54, 10); output.writeUInt32LE(40, 14)
  output.writeInt32LE(width, 18); output.writeInt32LE(height, 22); output.writeUInt16LE(1, 26); output.writeUInt16LE(24, 28); output.writeUInt32LE(stride * height, 34)
  for (let offset = 54; offset < output.length; offset += 3) { output[offset] = 190; output[offset + 1] = 70; output[offset + 2] = 20 }
  return [...output]
}
await test('real OLE screenshot drops use exact native authorization and retain four-format shared editing', { timeout: 180000 }, async suite => {
  const app = await launchTauri()
  let page; let failed = false; let formats; let files; const evidence = []; const errors = []; const operations = []
  const helper = path.join(app.root, 'screenshot-ole-source.exe')
  const scenario = async (name, callback) => { await suite.test(name, { timeout: 30000 }, async () => { try { await callback(); evidence.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Screenshot drop failed: ' + name) }
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const fromPath = target => api('createScreenshotDocument', { path: target })
  const imports = () => page.evaluate(() => window.screenshotImports)
  const watch = () => page.evaluate(() => {
    window.screenshotImports = []; window.screenshotDrops = []
    window.dustdesk.onFilesDropped(packet => { window.screenshotDrops.push(packet); return false })
    const create = window.dustdesk.createScreenshotDocument
    window.dustdesk.createScreenshotDocument = async source => {
      const result = await create(source)
      window.screenshotImports.push({ source: source instanceof Uint8Array ? 'bytes' : source.path, ok: result.ok, id: result.payload?.document.id, error: result.error })
      return result
    }
  })
  const drop = async (paths, target = page.locator('.screenshot-page .page-header'), action = 'drop') => {
    await target.scrollIntoViewIfNeeded(); const bounds = await target.boundingBox(); assert.ok(bounds)
    const result = await execute(helper, [app.root, String(app.child.pid), String(bounds.x + bounds.width / 2), String(bounds.y + bounds.height / 2), action, ...paths], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    const outcome = JSON.parse(result.stdout.trim()); assert.ok(outcome.queries > 0); assert.equal(outcome.hresult, action === 'cancel' ? 0x40101 : 0x40100)
    operations.push({ action, count: paths.length, ...outcome }); return outcome
  }
  const expectImport = async (target, expected = true) => {
    const count = (await imports()).length
    await drop([target]); await waitFor(async () => (await imports()).length === count + 1)
    const imported = (await imports()).at(-1); assert.equal(imported.source, target); assert.equal(imported.ok, expected, JSON.stringify(imported))
    if (expected) await page.waitForFunction(() => document.querySelector('.screenshot-editor')?.getAttribute('aria-busy') === 'false' && document.querySelector('button[aria-label="矩形"]')?.disabled === false)
    return imported
  }
  const snapshot = async id => page.evaluate(async id => { const result = await window.dustdesk.readScreenshotDocument(id); return result.payload ? { ...result, payload: { ...result.payload, png: [...result.payload.png] } } : result }, id)
  try {
    await scenario('initialize isolated main with a real native OLE source and no arbitrary path import authority', async () => {
      const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
      const visualStudio = (await execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true })).stdout.trim(); assert.ok(path.isAbsolute(visualStudio))
      const compiler = '"' + path.join(visualStudio, 'Common7', 'Tools', 'VsDevCmd.bat') + '" -no_logo -arch=x64 && cl.exe /nologo /std:c++17 /EHsc /W4 /WX /utf-8 "' + path.resolve('tests/tauri-file-drop-native.cpp') + '" /Fe:"' + helper + '" /Fo:"' + path.join(app.root, 'screenshot-ole-source.obj') + '" /link ole32.lib shell32.lib shlwapi.lib user32.lib'
      await execute('cmd.exe', ['/d', '/s', '/c', '"' + compiler + '"'], { windowsVerbatimArguments: true, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
      await app.invoke('prototype_open_workspace')
      page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
      page.on('pageerror', error => errors.push(error.message))
      await page.getByRole('button', { name: '创建工作区', exact: true }).click(); await page.locator('.app-shell').waitFor()
      await page.evaluate(async () => { const state = await window.dustdesk.loadWorkspace(); const saved = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false, SidebarHidden: [] } }, state); if (!saved.ok) throw Error(saved.error) })
      formats = await page.evaluate(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 20; const context = canvas.getContext('2d'); context.fillStyle = '#1446be'; context.fillRect(0, 0, 24, 20)
        const result = {}; for (const format of ['png', 'jpeg', 'webp']) result[format] = [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/' + format, .9))).arrayBuffer())]; return result
      }); formats.bmp = bitmap(); files = {}
      for (const [format, bytes] of Object.entries(formats)) { files[format] = path.join(app.root, '中文🪶-源图.' + format); await writeFile(files[format], Buffer.from(bytes)) }
      await assert.rejects(app.invoke('screenshot_import', { path: files.png }, app.page), /not allowed|权限|不允许/i)
      assert.equal((await fromPath(files.png)).ok, false)
      await api('setWidgetVisibility', 'todo', true)
      const widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html')))
      await assert.rejects(app.invoke('screenshot_import', { path: files.png }, widget), /not allowed|权限|不允许/i)
      await api('setWidgetVisibility', 'todo', false)
      await watch(); await page.locator('.sidebar').getByText('截图编辑', { exact: true }).click(); await page.locator('.screenshot-page').waitFor()
    })
    await scenario('cancelled OLE and forged DOM drops cannot grant a path or create a document', async () => {
      const count = (await imports()).length
      const result = await drop([files.png], undefined, 'cancel'); assert.equal(result.effect, 0)
      await page.evaluate(target => document.querySelector('.screenshot-page').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: new DataTransfer() })), files.png)
      assert.equal((await imports()).length, count)
      assert.deepEqual(await page.evaluate(() => window.screenshotDrops), [])
      assert.equal((await fromPath(files.png)).ok, false)
    })
    await scenario('real BMP PNG JPEG and WebP drops import once and release the prior source without saving raw images', async () => {
      let previous
      for (const format of ['bmp', 'png', 'jpeg', 'webp']) {
        const imported = await expectImport(files[format]); const read = await snapshot(imported.id); assert.equal(read.ok, true); assert.deepEqual([read.payload.document.width, read.payload.document.height], [24, 20])
        if (format === 'png') assert.deepEqual(read.payload.png, formats.png)
        if (previous) assert.equal((await snapshot(previous)).ok, false)
        previous = imported.id
      }
      assert.equal(await page.locator('.selection-size').innerText(), '24 × 20 px')
      assert.equal((await readdir(path.join(app.root, 'user-data', 'tauri-preview', 'Workspace'))).includes('Screenshots'), false)
    })
    await scenario('path import is exact and a dropped directory never authorizes its children or siblings', async () => {
      const sibling = path.join(app.root, '未拖入.png'); await writeFile(sibling, Buffer.from(formats.png))
      assert.equal((await fromPath(sibling)).ok, false)
      const directory = path.join(app.root, '拖入目录'); await mkdir(directory); const child = path.join(directory, '内部.png'); await writeFile(child, Buffer.from(formats.png))
      await expectImport(directory, false); assert.equal((await fromPath(child)).ok, false); assert.equal((await fromPath(sibling)).ok, false)
      await expectImport(files.png)
    })
    await scenario('multiple and duplicate files retain the existing first-image behavior with a single document import', async () => {
      const count = (await imports()).length; await drop([files.bmp, files.bmp, files.png]); await waitFor(async () => (await imports()).length === count + 1)
      assert.equal((await imports()).at(-1).source, files.bmp)
      assert.deepEqual((await page.evaluate(() => window.screenshotDrops)).at(-1).paths, [files.bmp, files.png])
      await page.waitForFunction(() => document.querySelector('button[aria-label="矩形"]')?.disabled === false)
    })
    await scenario('malformed sources report errors while the active edited source survives and retry works', async () => {
      const retained = (await imports()).at(-1).id; const bad = path.join(app.root, '损坏.png'); await writeFile(bad, 'not an image')
      await expectImport(bad, false); assert.equal((await snapshot(retained)).ok, true)
      await page.getByRole('alert').filter({ hasText: /PNG|解码|图片/ }).waitFor()
      await writeFile(bad, Buffer.from(formats.png)); await expectImport(bad)
    })
    await scenario('native path reads retain the full 32 MiB boundary and reject the next byte without discarding the current source', async () => {
      const target = path.join(app.root, '32MiB.png'); await writeFile(target, Buffer.from(formats.png)); const file = await open(target, 'r+'); await file.truncate(32 * 1024 * 1024); await file.close()
      const imported = await expectImport(target)
      const info = await page.evaluate(async id => { const result = await window.dustdesk.readScreenshotDocument(id); return { ok: result.ok, length: result.payload?.png.length } }, imported.id)
      assert.deepEqual(info, { ok: true, length: 32 * 1024 * 1024 })
      const growing = await open(target, 'r+'); await growing.truncate(32 * 1024 * 1024 + 1); await growing.close()
      const rejected = await expectImport(target, false); assert.match(rejected.error, /32 MB/); assert.equal((await app.invoke('screenshot_document', {id:imported.id}, page)).id, imported.id)
      await expectImport(files.png)
    })
    await scenario('junction batches fail before partial authorization and synthetic events still cannot bypass it', async () => {
      const directory = path.join(app.root, '真实目录'); const junction = path.join(app.root, '重解析目录'); await mkdir(directory); await symlink(directory, junction, 'junction')
      const target = path.join(directory, '真实.png'); await writeFile(target, Buffer.from(formats.png)); const count = (await imports()).length
      await drop([target, junction]); await waitFor(() => page.evaluate(() => window.screenshotDrops.at(-1)?.error))
      assert.equal((await imports()).length, count); assert.equal((await fromPath(target)).ok, false)
    })
    await scenario('hidden pages and editable text do not consume drops and actual native Save As can cancel normally', async () => {
      const count = (await imports()).length
      await page.locator('.sidebar').getByText('概览', { exact: true }).click(); await drop([files.png], page.locator('.content-inner').first())
      await page.locator('.sidebar').getByText('截图编辑', { exact: true }).click()
      await page.getByRole('button', { name: '文字', exact: true }).click(); const canvas = page.locator('.screenshot-image'); const bounds = await canvas.boundingBox(); assert.ok(bounds)
      await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      const input = page.locator('.inline-text-editor textarea'); await input.waitFor(); await input.fill('原始文字'); await drop([files.bmp], input); assert.equal(await input.inputValue(), '原始文字'); await input.press('Escape')
      const saving = page.getByRole('button', { name: '另存为', exact: true }).click(); await saving
      await operateDialog(app, '另存为截图', 'visible'); await operateDialog(app, '另存为截图', 'cancel')
      await page.waitForFunction(() => document.querySelector('.screenshot-editor')?.getAttribute('aria-busy') === 'false')
      assert.equal((await imports()).length, count)
    })
    await scenario('a busy source delivery ignores the next physical drop and releases the old source only after completion', async () => {
      await page.evaluate(() => { const create = window.dustdesk.createScreenshotDocument; window.dustdesk.createScreenshotDocument = async source => { const result = await create(source); window.screenshotDropWaiting = true; await new Promise(resolve => { window.screenshotDropRelease = resolve }); return result }; window.screenshotDropRestore = () => { window.dustdesk.createScreenshotDocument = create; window.screenshotDropRelease?.() } })
      const count = (await imports()).length
      try { await drop([files.webp]); await waitFor(() => page.evaluate(() => window.screenshotDropWaiting)); await drop([files.bmp]); assert.equal((await imports()).length, count + 1) } finally { await page.evaluate(() => window.screenshotDropRestore()) }
      await page.waitForFunction(() => !document.querySelector('.screenshot-page [role="status"]'))
      assert.equal((await imports()).at(-1).source, files.webp)
    })
    await scenario('a real color dialog and an editor output in progress reject screenshot imports', async () => {
      const count = (await imports()).length
      await page.getByRole('button', {name:'自定义颜色',exact:true}).click()
      const dialog = page.getByRole('dialog'); await dialog.waitFor(); await drop([files.png],dialog)
      assert.equal((await imports()).length,count)
      await page.getByRole('button', {name:'自定义颜色',exact:true}).click()
      await page.evaluate(() => {const finish = window.dustdesk.finishScreenshot; window.dustdesk.finishScreenshot = async request => {window.screenshotOutputWaiting = true; await new Promise(resolve => {window.screenshotOutputRelease = resolve});return finish(request)}; window.screenshotOutputRestore = () => {window.dustdesk.finishScreenshot = finish;window.screenshotOutputRelease?.()}})
      try {
        await page.getByRole('button', {name:'保存',exact:true}).click(); await waitFor(() => page.evaluate(() => window.screenshotOutputWaiting))
        assert.equal(await page.locator('.screenshot-editor').getAttribute('aria-busy'),'true')
        await drop([files.bmp]); assert.equal((await imports()).length,count)
      } finally {await page.evaluate(() => window.screenshotOutputRestore())}
      await page.locator('.screenshot-feedback').filter({hasText:'已保存：'}).waitFor()
    })
    await scenario('maintenance ignores drops and resumes without leaking native authority across backup restore or reload', async () => {
      const prepared = await app.invoke('drafts_prepare', {}, page); const count = (await imports()).length
      const ignored = path.join(app.root, '维护期间.png'); await writeFile(ignored, Buffer.from(formats.png)); await drop([ignored]); assert.equal((await imports()).length, count)
      await app.invoke('drafts_end', { requestId: prepared.requestId }, page); await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      assert.equal((await fromPath(ignored)).ok, false)
      await expectImport(files.png)
      const backup = await api('createBackup'); const preview = await api('previewBackup', backup.path); assert.equal((await api('restoreBackup', backup.path, preview.fingerprint)).ok, true)
      assert.equal((await fromPath(files.png)).ok, false); await expectImport(files.bmp)
      await page.reload(); await page.locator('.app-shell').waitFor(); assert.equal((await fromPath(files.bmp)).ok, false)
      await watch(); await page.locator('.sidebar').getByText('截图编辑', { exact: true }).click(); await expectImport(files.webp)
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, evidence, errors, operations, pending: ['Explorer-physical-mixed-DPI', 'full-capture-pin-business', 'long-session-release-performance', 'real-packaged-artifacts'] }, null, 2))
  } catch (error) {
    failed = true; await writeFile(report, JSON.stringify({ verified: false, productionReady: false, evidence, errors, operations, failure: String(error), root: app.root }, null, 2)); throw error
  } finally { await app.close({ preserve: failed }) }
})
