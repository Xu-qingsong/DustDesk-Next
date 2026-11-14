import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { nativeWindowFixture } from './native-window-fixture.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'

const report = 'artifacts/tauri-migration/window-capture-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native window source tokens capture actual WGC pixels without arbitrary handle authority', { timeout: 180000 }, async suite => {
  let app, page, fixtureWindow, source, retained, failed = false
  const evidence = [], errors = []
  const fixtureTitle = 'DustDesk 捕获参考窗口 🖼️'
  const scenario = async (name, callback) => {
    await suite.test(name, { timeout: 60000 }, async () => { try { await callback(); evidence.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Window capture failed: ' + name)
  }
  const invoke = (command, args = {}, target = page) => app.invoke(command, args, target)
  const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const list = () => invoke('screenshot_windows')
  const capture = id => invoke('screenshot_capture_window', { sourceId: id })
  const fixture = action => fixtureWindow.action(action)
  const pixels = bytes => page.evaluate(async bytes => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d')
    context.drawImage(image, 0, 0); image.close()
    const sample = (horizontal, vertical) => [...context.getImageData(Math.floor(canvas.width * horizontal), Math.floor(canvas.height * vertical), 1, 1).data]
    return { width: canvas.width, height: canvas.height, green: sample(.25, .5), red: sample(.75, .5) }
  }, bytes)
  const sourceBytes = id => page.evaluate(async id => [...new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_source', { id }))], id)
  try {
    let rawHandle, reference
    await scenario('real external WinForms window supplies deterministic native content and an isolated Rust main', async () => {
      fixtureWindow = await nativeWindowFixture({title:fixtureTitle,width:480,height:320,split:true})
      rawHandle = fixtureWindow.handle
      reference = {width:fixtureWindow.width,height:fixtureWindow.height,green:[56,178,100,255],red:[199,70,58,255]}
      app = await launchTauri({ releaseDelayMs: 350 }); await app.invoke('prototype_open_workspace')
      page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
      page.on('pageerror', error => errors.push(error.message))
      await page.getByRole('button', { name: '创建工作区', exact: true }).click(); await page.locator('.app-shell').waitFor()
      await page.evaluate(async () => { const state = await window.dustdesk.loadWorkspace(); const result = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false } }, state); if (!result.ok) throw Error(result.error) })
      for (const id of ['', rawHandle, 'window:' + rawHandle + ':0', 'window:00000000-0000-0000-0000-000000000000']) await assert.rejects(capture(id), /窗口|unavailable|过期/)
    })
    await scenario('prototype and widget roles cannot enumerate desktop titles or capture native sources', async () => {
      assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true)
      const widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html')))
      await widget.getByLabel('桌面新增任务').waitFor()
      for (const target of [app.page, widget]) {
        await assert.rejects(invoke('screenshot_windows', {}, target), /not allowed|权限|不允许/i)
        await assert.rejects(invoke('screenshot_capture_window', { sourceId: rawHandle }, target), /not allowed|权限|不允许/i)
      }
      await api('setWidgetVisibility', 'todo', false)
    })
    await scenario('bounded native enumeration returns opaque exact tokens and real WGC previews', async () => {
      const result = await api('listScreenshotWindows'); assert.equal(result.ok, true, result.message)
      const sources = result.sources
      assert.ok(sources.length > 0 && sources.length <= 128)
      assert.ok(sources.every(source => Object.keys(source).sort().join(',') === 'id,name,thumbnail'))
      assert.ok(sources.every(source => /^window:[\da-f-]{36}$/.test(source.id)))
      assert.ok(sources.reduce((total, source) => total + source.thumbnail.length, 0) <= 4 * 1024 * 1024)
      source = sources.find(source => source.name === fixtureTitle); assert.ok(source, 'Actual reference window must be enumerable')
      assert.match(source.thumbnail, /^data:image\/png;base64,/)
      const thumbnail = await pixels([...Buffer.from(source.thumbnail.split(',')[1], 'base64')])
      const expected = reference
      assert.ok(thumbnail.width <= 320 && thumbnail.height <= 180)
      assert.deepEqual(thumbnail.green, expected.green); assert.deepEqual(thumbnail.red, expected.red)
    })
    await scenario('the main can capture an actual same-process workspace window with its native contents', async () => {
      const sources = await list(), own = sources.find(candidate => candidate.name === 'DustDesk'); assert.ok(own)
      const document = await capture(own.id), result = await pixels(await sourceBytes(document.id))
      assert.ok(result.width >= 960 && result.height >= 640)
      assert.equal(document.width, result.width); assert.equal(document.height, result.height)
      await api('discardScreenshotDocument', document.id)
    })
    await scenario('the unchanged shared window picker displays native sources and cancellation performs no capture', async () => {
      await page.getByRole('button', { name: '截图编辑', exact: true }).click()
      await page.locator('.screenshot-page').waitFor()
      await page.getByRole('button', { name: '窗口', exact: true }).click()
      await page.getByRole('button', { name: '开始捕获', exact: true }).click()
      const picker = page.getByRole('dialog', { name: '选择截图窗口' }); await picker.waitFor()
      await picker.getByRole('button', { name: fixtureTitle, exact: true }).waitFor()
      assert.equal(await picker.locator('.screenshot-window-choice img').evaluateAll(images => images.every(image => image.complete && image.naturalWidth > 0)), true)
      await picker.getByRole('button', { name: '取消', exact: true }).click(); await picker.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.screenshot-editor').count(), 0)
      source = (await list()).find(target => target.name === fixtureTitle); assert.ok(source)
    })
    await scenario('exact source capture produces a normal binary screenshot session without implicit output', async () => {
      const before = await api('loadWorkspace')
      retained = await capture(source.id)
      const result = await pixels(await sourceBytes(retained.id)), expected = reference
      assert.equal(retained.width, result.width); assert.equal(retained.height, result.height)
      assert.deepEqual(result.green, expected.green); assert.deepEqual(result.red, expected.red)
      assert.ok(Math.abs(result.width / result.height - expected.width / expected.height) < .01)
      assert.deepEqual(await api('loadWorkspace'), before)
      for (const id of [rawHandle, 'window:' + rawHandle + ':0', retained.id, source.id.toUpperCase()]) await assert.rejects(capture(id), /unavailable/)
      assert.equal((await api('readScreenshotDocument', retained.id)).ok, true)
    })
    await scenario('hidden minimized protected and closed windows fail revalidation without discarding prior pixels', async () => {
      for (const action of ['hide', 'minimize', 'protect']) {
        await fixture(action)
        await assert.rejects(capture(source.id), /unavailable/)
        assert.equal((await api('readScreenshotDocument', retained.id)).ok, true)
        if (action === 'protect') await fixture('unprotect')
        await fixture('show')
      }
      const next = await capture(source.id); await api('discardScreenshotDocument', next.id)
    })
    await scenario('ordinary owned application dialogs remain capturable instead of being silently omitted', async () => {
      const title = fixtureTitle + ' owned dialog'
      await fixtureWindow.action('owned',{title,width:300,height:200,x:150,y:150,split:false})
      const sources = await list(), owned = sources.find(candidate => candidate.name === title); assert.ok(owned)
      const document = await capture(owned.id), result = await pixels(await sourceBytes(document.id))
      assert.deepEqual(result.green, [56, 178, 100, 255]); assert.deepEqual(result.red, result.green)
      await api('discardScreenshotDocument', document.id)
      await fixtureWindow.action('close',{title})
      source = sources.find(candidate => candidate.name === fixtureTitle); assert.ok(source)
      assert.equal((await api('readScreenshotDocument', retained.id)).ok, true)
    })
    await scenario('refresh replaces all old tokens and maintenance revokes authorization but preserves source sessions', async () => {
      const refreshed = (await list()).find(target => target.name === fixtureTitle); assert.ok(refreshed); assert.notEqual(refreshed.id, source.id)
      await assert.rejects(capture(source.id), /unavailable/)
      source = refreshed
      const checkpoint = await invoke('drafts_prepare')
      await assert.rejects(list(), /迁移|维护|退出|暂停/)
      await assert.rejects(capture(source.id), /迁移|维护|退出|暂停/)
      await invoke('drafts_end', { requestId: checkpoint.requestId }); await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await assert.rejects(capture(source.id), /过期|unavailable/)
      assert.equal((await api('readScreenshotDocument', retained.id)).ok, true)
    })
    await scenario('backup restore and main reload revoke window source tokens as well as captured documents', async () => {
      source = (await list()).find(target => target.name === fixtureTitle); assert.ok(source)
      const backup = await api('createBackup'); assert.equal(backup.ok, true)
      const preview = await api('previewBackup', backup.path); assert.equal((await api('restoreBackup', backup.path, preview.fingerprint)).ok, true)
      await assert.rejects(capture(source.id), /过期|unavailable/)
      assert.equal((await api('readScreenshotDocument', retained.id)).ok, false)
      source = (await list()).find(target => target.name === fixtureTitle); assert.ok(source)
      await page.reload(); await page.locator('.app-shell').waitFor()
      await assert.rejects(capture(source.id), /过期|unavailable/)
      source = (await list()).find(target => target.name === fixtureTitle); assert.ok(source)
      const next = await capture(source.id); await api('discardScreenshotDocument', next.id)
      await fixture('close'); await assert.rejects(capture(source.id), /unavailable/)
    })
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, scope: 'main-only-native-window-capture-backend-not-shared-startScreenshot', evidence, errors, pending: ['business-overlay-region-fullscreen-window-flow', 'shared-window-picker-and-settings-delay-after-action', 'pin-and-reedit', 'physical-DPI-IME-Release-performance-and-packaging'] }, null, 2))
  } catch (error) {
    failed = true
    await writeFile(report, JSON.stringify({ verified: false, productionReady: false, evidence, errors, failure: String(error), root: app?.root }, null, 2))
    throw error
  } finally { if (fixtureWindow) await fixtureWindow.close(); if (app) await app.close({ preserve: failed }) }
})
