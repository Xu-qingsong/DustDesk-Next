import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { pointerDrag, keyboardPickup, keyboardMove } from './pointer-drag.mjs'
import { chooseSelect } from './ui-controls.mjs'

const execute = promisify(execFile)
const report = 'artifacts/tauri-migration/file-drop-native.json'
await mkdir(path.dirname(report), { recursive: true })
await rm(report, { force: true })
await test('real OLE file drops authorize exact native paths and coexist with pointer and keyboard sorting', { timeout: 180000 }, async suite => {
  const app = await launchTauri()
  const evidence = []
  const errors = []
  const outcomes = []
  let failed = false
  let page
  const helper = path.join(app.root, 'ole-source.exe')
  const buildHelper = async () => {
    const vswhere = path.join(process.env['ProgramFiles(x86)'], 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
    const visualStudio = (await execute(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { windowsHide: true })).stdout.trim()
    assert.ok(path.isAbsolute(visualStudio), 'MSVC is required for the native OLE test fixture')
    const compiler = '"' + path.join(visualStudio, 'Common7', 'Tools', 'VsDevCmd.bat') + '" -no_logo -arch=x64 && cl.exe /nologo /std:c++17 /EHsc /W4 /WX /utf-8 "' + path.resolve('tests/tauri-file-drop-native.cpp') + '" /Fe:"' + helper + '" /Fo:"' + path.join(app.root, 'ole-source.obj') + '" /link ole32.lib shell32.lib shlwapi.lib user32.lib'
    await execute('cmd.exe', ['/d', '/s', '/c', '"' + compiler + '"'], { windowsVerbatimArguments: true, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 })
  }
  const scenario = async (name, action) => {
    await suite.test(name, { timeout: 30000 }, async () => {
      try { await action(); evidence.push(name) } catch (error) { failed = true; throw error }
    })
    if (failed) throw Error('Native file drop scenario failed: ' + name)
  }
  const drop = async (paths, target, action = 'drop') => {
    await target.scrollIntoViewIfNeeded()
    const bounds = await target.boundingBox()
    assert.ok(bounds)
    const result = await execute(helper, [app.root, String(app.child.pid), String(bounds.x + bounds.width / 2), String(bounds.y + bounds.height / 2), action, ...paths], { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 })
    const outcome = JSON.parse(result.stdout.trim())
    assert.ok(outcome.queries > 0, 'The real OLE source must receive native continuation callbacks')
    assert.equal(outcome.hresult, action === 'cancel' ? 0x40101 : 0x40100)
    outcomes.push({ action, paths: paths.length, ...outcome })
    return outcome
  }
  const register = paths => page.evaluate(paths => window.dustdesk.toolbox.registerPaths(paths, 'image'), paths)
  const packets = () => page.evaluate(() => window.fileDropPackets)
  try {
    await buildHelper()
    await scenario('initialize isolated workspace and subscribe without accepting renderer-provided native paths', async () => {
      await app.invoke('prototype_open_workspace')
      page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
      page.on('pageerror', error => errors.push(error.message))
      await page.getByRole('button', { name: '创建工作区', exact: true }).click()
      await page.locator('.app-shell').waitFor()
      await page.evaluate(async () => {
        const state = await window.dustdesk.loadWorkspace()
        const result = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, SidebarHidden: [] } }, state)
        if (!result.ok) throw Error(result.error)
        window.fileDropPackets = []
        window.dustdesk.onFilesDropped(packet => { window.fileDropPackets.push(packet); return false })
      })
      for (const command of ['file_drop_attach', 'file_drop_detach']) await assert.rejects(app.invoke(command, {}, app.page), /not allowed|权限|不允许/i)
      for (const target of [{ kind: 'Any' }, { kind: 'WebviewWindow', label: 'workspace-main' }]) {
        await assert.rejects(app.invoke('plugin:event|listen', { event: 'tauri://drag-drop', target, handler: 0 }, app.page), /not allowed|权限|不允许/i)
      }
      await assert.rejects(app.invoke('prototype_event_attach', { event: 'workspace:snapshot', channel: '__CHANNEL__:0' }, app.page), /未授权/)
      await assert.rejects(app.invoke('file_drop_paths', { paths: [path.join(app.root, 'arbitrary.png')] }, page), /not found|not allowed/i)
      assert.equal((await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))).ok, true)
      const widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html')))
      await widget.getByLabel('桌面新增任务').waitFor()
      for (const command of ['file_drop_attach', 'file_drop_detach']) await assert.rejects(app.invoke(command, {}, widget), /not allowed|权限|不允许/i)
      await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', false))
    })
    const source = path.join(app.root, '中文🪶.png')
    const sibling = path.join(app.root, '未拖入.png')
    const bytes = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 24; canvas.height = 20
      const context = canvas.getContext('2d'); context.fillStyle = '#28558a'; context.fillRect(0, 0, 24, 20)
      return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer())]
    })
    await writeFile(source, Buffer.from(bytes)); await writeFile(sibling, Buffer.from(bytes))
    const image = async name => { const target = path.join(app.root, name + '.png'); await writeFile(target, Buffer.from(bytes)); return target }
    await scenario('cancelled OLE drag does not publish or grant a path', async () => {
      await page.locator('.sidebar').getByText('图片工具箱', { exact: true }).click()
      await page.getByRole('button', { name: '导入图片', exact: true }).waitFor()
      await assert.rejects(register([source]), /授权/)
      const result = await drop([source], page.locator('.image-tool-topbar'), 'cancel')
      assert.equal(result.cancelled, true)
      assert.equal(result.effect, 0)
      assert.deepEqual(await packets(), [])
      await assert.rejects(register([source]), /授权/)
    })
    await scenario('real OLE Unicode drop imports once and grants only the exact file', async () => {
      assert.equal((await drop([source, source], page.locator('.image-tool-topbar'))).effect, 1)
      await waitFor(async () => (await packets()).length === 1)
      assert.deepEqual((await packets())[0].paths, [source])
      await page.locator('.image-tool-row').waitFor()
      await page.locator('.image-tool-thumb').waitFor()
      assert.equal(await page.locator('.image-tool-row').count(), 1)
      const assets = await register([source]); assert.equal(assets.length, 1)
      assert.deepEqual(await page.evaluate(async id => [...await window.dustdesk.toolbox.readAsset(id)], assets[0].id), bytes)
      await assert.rejects(register([sibling]), /授权/)
      await assert.rejects(register([app.root]), /授权/)
    })
    await scenario('maintenance ignores drops and resumes the existing private channel', async () => {
      const prepared = await app.invoke('drafts_prepare', {}, page)
      const before = (await packets()).length
      await drop([sibling], page.locator('.image-tool-topbar'))
      assert.equal((await packets()).length, before)
      await app.invoke('drafts_end', { requestId: prepared.requestId }, page)
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await assert.rejects(register([sibling]), /授权/)
      await drop([sibling], page.locator('.image-tool-topbar'))
      await waitFor(async () => (await packets()).length === before + 1)
      await waitFor(async () => await page.locator('.image-tool-row').count() === 2)
    })
    await scenario('synthetic browser or generic Tauri events cannot authorize a native path', async () => {
      const target = await image('未授权伪造')
      await assert.rejects(app.invoke('plugin:event|emit', { event: 'tauri://drag-drop', payload: { paths: [target], position: { x: 400, y: 300 } } }, page), /not allowed|权限|不允许/i)
      await page.evaluate(target => window.dispatchEvent(new CustomEvent('tauri://drag-drop', { detail: { paths: [target], position: { x: 400, y: 300 } } })), target)
      await assert.rejects(register([target]), /授权/)
    })
    await scenario('malformed and junction batches publish errors without partially granting valid siblings', async () => {
      const fresh = await image('批次完整性')
      const missing = path.join(app.root, '不存在.png')
      const before = (await packets()).length; const rows = await page.locator('.image-tool-row').count()
      await drop([fresh, missing], page.locator('.image-tool-topbar'))
      await waitFor(async () => (await packets()).length === before + 1)
      const invalid = (await packets()).at(-1); assert.deepEqual(invalid.paths, []); assert.ok(invalid.error)
      await assert.rejects(register([fresh]), /授权/)
      const junction = path.join(app.root, '拖入链接')
      const real = path.join(app.root, '真实目录'); await mkdir(real); await writeFile(path.join(real, 'source.png'), Buffer.from(bytes))
      await symlink(real, junction, 'junction')
      await drop([fresh, path.join(junction, 'source.png')], page.locator('.image-tool-topbar'))
      await waitFor(async () => (await packets()).length === before + 2)
      const linked = (await packets()).at(-1); assert.deepEqual(linked.paths, []); assert.ok(linked.error)
      await assert.rejects(register([fresh]), /授权/)
      assert.equal(await page.locator('.image-tool-row').count(), rows)
    })
    await scenario('multiple Unicode files import once each with native duplicate elimination', async () => {
      const first = await image('多图一'); const second = await image('多图二🪶')
      const rows = await page.locator('.image-tool-row').count(); const before = (await packets()).length
      await drop([first, second, first], page.locator('.image-tool-topbar'))
      await waitFor(async () => (await packets()).length === before + 1)
      assert.deepEqual((await packets()).at(-1).paths, [first, second])
      await waitFor(async () => await page.locator('.image-tool-row').count() === rows + 2)
      await waitFor(async () => await page.locator('.image-tool-thumb').count() === rows + 2)
    })
    await scenario('inactive pages inputs and real confirmation dialogs do not import dropped images', async () => {
      const target = await image('忽略区域'); const rows = await page.locator('.image-tool-row').count()
      let before = (await packets()).length
      await page.locator('.sidebar').getByText('概览', { exact: true }).click()
      await drop([target], page.locator('h1:visible'))
      await waitFor(async () => (await packets()).length === before + 1)
      await page.locator('.sidebar').getByText('图片工具箱', { exact: true }).click()
      assert.equal(await page.locator('.image-tool-row').count(), rows)
      await chooseSelect(page.getByRole('combobox', { name: '类型', exact: true }), 'text')
      const input = page.getByRole('textbox', { name: '水印文字', exact: true }); const text = await input.inputValue()
      before = (await packets()).length; await drop([target], input)
      await waitFor(async () => (await packets()).length === before + 1)
      assert.equal(await input.inputValue(), text); assert.equal(await page.locator('.image-tool-row').count(), rows)
      await chooseSelect(page.getByRole('combobox', { name: '类型', exact: true }), 'none')
      await page.locator('.image-tool-row').first().getByRole('checkbox').check()
      await page.getByRole('button', { name: '删除选中', exact: true }).click()
      const dialog = page.getByRole('alertdialog'); await dialog.waitFor()
      before = (await packets()).length; await drop([target], dialog)
      await waitFor(async () => (await packets()).length === before + 1)
      assert.equal(await page.locator('.image-tool-row').count(), rows)
      await dialog.getByRole('button', { name: '取消', exact: true }).click()
    })
    await scenario('a slow active import rejects a second physical drop without double importing', async () => {
      const target = await image('慢速导入'); const ignored = await image('忙碌忽略')
      const rows = await page.locator('.image-tool-row').count()
      await page.evaluate(() => {
        const read = window.dustdesk.toolbox.readAsset
        window.releaseDropRead = undefined; window.dropReadWaiting = false
        window.dustdesk.toolbox.readAsset = async id => { window.dropReadWaiting = true; await new Promise(resolve => { window.releaseDropRead = resolve }); return read(id) }
        window.restoreDropRead = () => { window.dustdesk.toolbox.readAsset = read; window.releaseDropRead?.() }
      })
      try {
        await drop([target], page.locator('.image-tool-topbar'))
        await waitFor(() => page.evaluate(() => window.dropReadWaiting))
        const before = (await packets()).length
        await drop([ignored], page.locator('.image-tool-topbar'))
        await waitFor(async () => (await packets()).length === before + 1)
        assert.equal(await page.locator('.image-tool-row').count(), rows + 1)
      } finally { await page.evaluate(() => window.restoreDropRead()) }
      await waitFor(async () => await page.locator('.image-tool-thumb').count() === rows + 1)
      assert.equal(await page.locator('.image-tool-row').count(), rows + 1)
    })
    await scenario('reload revokes native file grants and stale detach cannot remove the replacement channel', async () => {
      const oldToken = (await packets()).find(packet => packet.paths.length)?.token
      assert.equal(typeof oldToken, 'string')
      await page.reload(); await page.locator('.app-shell').waitFor()
      await assert.rejects(register([source]), /授权/)
      assert.equal(await app.invoke('file_drop_detach', { token: oldToken }, page), false)
      await page.evaluate(() => { window.fileDropPackets = []; window.dustdesk.onFilesDropped(packet => { window.fileDropPackets.push(packet); return false }) })
      await page.locator('.sidebar').getByText('图片工具箱', { exact: true }).click()
      await drop([source], page.locator('.image-tool-topbar'))
      await waitFor(async () => (await packets()).length === 1)
      assert.notEqual((await packets())[0].token, oldToken)
      await page.locator('.image-tool-thumb').waitFor()
      assert.equal(await page.locator('.image-tool-row').count(), 1)
    })
    await scenario('successful backup restore revokes exact drop grants and assets but accepts a new native drop', async () => {
      const [asset] = await register([source])
      const backup = await page.evaluate(() => window.dustdesk.createBackup())
      assert.equal(backup.ok, true)
      const preview = await page.evaluate(target => window.dustdesk.previewBackup(target), backup.path)
      const restored = await page.evaluate(({ target, fingerprint }) => window.dustdesk.restoreBackup(target, fingerprint), { target: backup.path, fingerprint: preview.fingerprint })
      assert.equal(restored.ok, true, JSON.stringify(restored))
      await assert.rejects(register([source]), /授权/)
      await assert.rejects(page.evaluate(id => window.dustdesk.toolbox.readAsset(id), asset.id), /授权已失效/)
      const target = await image('恢复后导入'); const before = (await packets()).length
      await drop([target], page.locator('.image-tool-topbar'))
      await waitFor(async () => (await packets()).length === before + 1)
      assert.deepEqual((await packets()).at(-1).paths, [target])
      await page.locator('.image-tool-row').filter({ hasText: '恢复后导入.png' }).locator('.image-tool-thumb').waitFor()
    })
    await scenario('sidebar pointer and keyboard sorting persist in native WebView2', async () => {
      await page.locator('.sidebar').getByText('设置', { exact: true }).click()
      await pointerDrag(page.getByRole('button', { name: '拖动排序：概览', exact: true }), page.locator('[data-menu-id="projects"]'))
      await waitFor(() => page.evaluate(async () => (await window.dustdesk.loadWorkspace()).Settings.SidebarOrder[0] === 'tasks'))
      const handle = page.getByRole('button', { name: '拖动排序：任务', exact: true })
      await keyboardPickup(handle); await keyboardMove(handle, 'ArrowDown'); await handle.press('Space')
      await waitFor(() => page.evaluate(async () => (await window.dustdesk.loadWorkspace()).Settings.SidebarOrder[0] === 'notes'))
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, nativeOle: true, productionReady: false, evidence, outcomes, errors }, null, 2) + '\n')
  } catch (error) {
    failed = true
    await writeFile(report, JSON.stringify({ verified: false, productionReady: false, evidence, outcomes, errors, failure: String(error), root: app.root }, null, 2) + '\n')
    throw error
  } finally { await app.close({ preserve: failed }) }
})
