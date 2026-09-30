import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'

const test = await launchDustDesk()
const page = test.window
page.setDefaultTimeout(10000)
const errors = []
page.on('pageerror', error => errors.push(error.message))
const screenshotDirectory = path.join(test.tempRoot, 'data', 'Screenshots')
const artifacts = path.resolve('test-artifacts/screenshot-fixes-2026-09-28')
const exports = async () => (await readdir(screenshotDirectory).catch(() => [])).filter(name => name.startsWith('DustDesk-edited-'))
const canvas = page.locator('.canvas-wrap canvas')
const ready = () => page.getByRole('button', { name: '保存截图', exact: true }).waitFor({ state: 'visible' }).then(() => page.waitForFunction(() => {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent === '保存截图')
  return button && !button.disabled
}))
const sidebar = name => page.locator('.sidebar').getByRole('button', { name, exact: true }).click()
const painted = () => canvas.evaluate(c => {
  const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let count = 0
  for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) count++
  return count
})
const overlays = () => test.electronApp.windows().filter(window => window.url().includes('overlay='))
const waitOverlay = async () => {
  for (let i = 0; i < 100; i++) {
    const overlay = overlays()[0]
    if (overlay) {
      await overlay.waitForFunction(() => document.querySelector('.screenshot-overlay img')?.naturalWidth > 0)
      return overlay
    }
    await page.waitForTimeout(50)
  }
  throw new Error('Screenshot overlay did not open')
}
const closeOverlay = async (overlay, method = 'button') => {
  const closed = overlay.waitForEvent('close')
  const action = method === 'escape' ? overlay.keyboard.press('Escape') : overlay.getByRole('button', { name: '取消截图', exact: true }).click()
  await action.catch(error => { if (!overlay.isClosed()) throw error })
  await closed
}

try {
  await mkdir(artifacts, { recursive: true })
  const images = await page.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    Object.assign(state.Settings, { ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false, ScreenshotAfterAction: 'edit', ScreenshotDelaySeconds: 0 })
    await window.dustdesk.saveWorkspace(state)
    return ['white', 'blue'].map(color => {
      const c = document.createElement('canvas'); c.width = 400; c.height = 200
      const context = c.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 400, 200)
      return c.toDataURL()
    })
  })
  await test.electronApp.evaluate(({ desktopCapturer, nativeImage, BrowserWindow, screen }, images) => {
    globalThis.screenshotTestCalls = []
    globalThis.screenshotTestMode = 'normal'
    desktopCapturer.getSources = async options => {
      globalThis.screenshotTestCalls.push(options)
      await new Promise(resolve => setTimeout(resolve, 100))
      if (globalThis.screenshotTestMode === 'fail') throw new Error('simulated capture failure')
      if (options.types.includes('window')) return [
        { id: 'window:101:0', name: 'First window', thumbnail: nativeImage.createFromDataURL(images[0]) },
        ...(globalThis.screenshotTestMode === 'missing' ? [] : [{ id: 'window:202:0', name: 'Target window', thumbnail: nativeImage.createFromDataURL(images[1]) }])
      ]
      return screen.getAllDisplays().map(display => ({ id: 'screen:' + display.id + ':0', display_id: String(display.id), name: 'Test screen', thumbnail: nativeImage.createFromDataURL(images[0]) }))
    }
    const fs = process.getBuiltinModule('fs')
    const write = fs.promises.writeFile
    globalThis.screenshotFailSave = false
    fs.promises.writeFile = async (...args) => {
      if (String(args[0]).includes('DustDesk-edited-')) {
        await new Promise(resolve => setTimeout(resolve, 180))
        if (globalThis.screenshotFailSave) throw new Error('simulated export failure')
      }
      return write(...args)
    }
    BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('widget=')).webContents.send('screenshot:captured', images[0])
  }, images)
  await ready()

  await page.getByRole('button', { name: '文字', exact: true }).click()
  await canvas.click({ position: { x: 70, y: 70 } })
  await page.getByLabel('标注文字', { exact: true }).fill('截图标注')
  await page.screenshot({ path: path.join(artifacts, 'text-dialog.png') })
  await page.getByRole('button', { name: '添加文字', exact: true }).click()
  const annotated = await painted()
  assert.ok(annotated > 0)
  await page.getByTitle('撤销', { exact: true }).click(); await ready()
  assert.equal(await painted(), 0)
  await page.getByTitle('重做', { exact: true }).click(); await ready()
  assert.equal(await painted(), annotated)
  await canvas.click({ position: { x: 100, y: 100 } })
  await page.getByLabel('标注文字', { exact: true }).fill('取消的文字')
  await page.keyboard.press('Escape')
  assert.equal(await painted(), annotated)
  await sidebar('概览'); await sidebar('截图编辑'); await ready()
  assert.equal(await painted(), annotated)
  await page.getByTitle('撤销', { exact: true }).click(); await ready()
  assert.equal(await painted(), 0)
  await page.getByTitle('重做', { exact: true }).click(); await ready()
  assert.equal(await painted(), annotated)
  console.log('Text annotation, cancel, undo/redo and cross-page draft retention passed')

  await page.getByRole('button', { name: '裁剪', exact: true }).click()
  const cropBounds = await canvas.boundingBox()
  await page.mouse.move(cropBounds.x + 40, cropBounds.y + 30); await page.mouse.down()
  await page.mouse.move(cropBounds.x + 300, cropBounds.y + 150, { steps: 4 }); await page.mouse.up(); await ready()
  assert.equal(await canvas.evaluate(c => c.width), 260)
  await sidebar('概览'); await sidebar('截图编辑'); await ready()
  assert.equal(await canvas.evaluate(c => c.width), 260)
  await page.getByTitle('撤销', { exact: true }).click(); await ready()
  assert.equal(await canvas.evaluate(c => c.width), 400)
  assert.equal(await painted(), annotated)
  console.log('Crop dimensions and undo history survive navigation')

  const beforeSave = (await exports()).length
  await page.getByRole('button', { name: '保存截图', exact: true }).evaluate(button => { button.click(); button.click() })
  await page.getByRole('button', { name: '保存中…', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '贴到桌面', exact: true }).isDisabled(), true)
  await ready()
  assert.equal((await exports()).length, beforeSave + 1)
  await test.electronApp.evaluate(() => { globalThis.screenshotFailSave = true })
  await page.getByRole('button', { name: '保存截图', exact: true }).click(); await ready()
  await page.getByText('simulated export failure', { exact: true }).waitFor()
  await test.electronApp.evaluate(() => { globalThis.screenshotFailSave = false })
  await page.getByRole('button', { name: '保存截图', exact: true }).click(); await ready()
  assert.equal((await exports()).length, beforeSave + 2)
  console.log('Duplicate export protection and failed-save retry passed')

  const invalid = await page.evaluate(async () => ({
    pin: await window.dustdesk.pinScreenshot('data:image/png;base64,AAAA'),
    save: await window.dustdesk.saveScreenshot('data:image/png;base64,AAAA')
  }))
  assert.equal(invalid.pin.ok, false); assert.equal(invalid.save.ok, false)
  assert.equal(test.electronApp.windows().filter(window => window.url().startsWith('data:text/html')).length, 0)
  await page.getByRole('button', { name: '贴到桌面', exact: true }).evaluate(button => { button.click(); button.click() })
  await ready()
  const pinned = test.electronApp.windows().filter(window => window.url().startsWith('data:text/html'))
  assert.equal(pinned.length, 1)
  const pinStyles = await pinned[0].evaluate(() => ({
    image: getComputedStyle(document.querySelector('img')).getPropertyValue('-webkit-app-region'),
    close: getComputedStyle(document.querySelector('button')).getPropertyValue('-webkit-app-region'),
    width: document.querySelector('img').naturalWidth
  }))
  assert.equal(pinStyles.image, 'drag'); assert.equal(pinStyles.close, 'no-drag'); assert.equal(pinStyles.width, 400)
  const pinClosed = pinned[0].waitForEvent('close')
  await pinned[0].getByRole('button', { name: '关闭贴图', exact: true }).click().catch(error => { if (!pinned[0].isClosed()) throw error })
  await pinClosed
  console.log('Pinned-image validation, duplicate protection and drag region passed')

  await sidebar('设置')
  await page.getByRole('button', { name: '全屏', exact: true }).click(); await ready()
  assert.equal(await painted(), 0, 'A new capture identical to the old base must clear its old annotations')
  assert.equal(await page.getByTitle('撤销', { exact: true }).isDisabled(), true)
  console.log('Identical new capture resets annotations without reusing a stale draft')

  const concurrent = await page.evaluate(() => Promise.all([window.dustdesk.startScreenshot('FullScreen'), window.dustdesk.startScreenshot('FullScreen')]))
  assert.equal(concurrent.filter(result => result.ok).length, 1)
  assert.equal(concurrent.filter(result => result.message === 'screenshot-in-progress').length, 1)
  await ready()
  await page.evaluate(() => {
    window.captureResults = []
    for (let i = 0; i < 2; i++) void window.dustdesk.startScreenshot('Region').then(result => window.captureResults.push(result))
  })
  let overlay = await waitOverlay()
  const displayCount = await test.electronApp.evaluate(({ screen }) => screen.getAllDisplays().length)
  assert.equal(overlays().length, displayCount)
  const rejected = await overlay.evaluate(() => window.dustdesk.submitScreenshotOverlay('data:image/png;base64,AAAA'))
  assert.equal(rejected.ok, false)
  assert.equal(overlays().length, displayCount)
  await closeOverlay(overlay)
  await page.waitForFunction(() => window.captureResults.length === 2)
  const regionResults = await page.evaluate(() => window.captureResults)
  assert.equal(regionResults.filter(result => result.message === 'screenshot-in-progress').length, 1)
  assert.equal(regionResults.filter(result => result.message === 'region-capture-canceled').length, 1)
  assert.equal(overlays().length, 0)
  console.log('Capture serialization, invalid region rejection and cancellation cleanup passed')

  await test.electronApp.evaluate(({ BrowserWindow }) => {
    const loadFile = BrowserWindow.prototype.loadFile
    globalThis.screenshotOriginalLoadFile = loadFile
    BrowserWindow.prototype.loadFile = function (...args) {
      if (args[1]?.query?.overlay === '1') return Promise.reject(new Error('simulated overlay load failure'))
      return loadFile.apply(this, args)
    }
  })
  const loadFailure = await page.evaluate(() => window.dustdesk.startScreenshot('Region'))
  assert.equal(loadFailure.ok, false); assert.match(loadFailure.message, /simulated overlay load failure/)
  assert.equal(await test.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => !window.webContents.getURL()).length), 0)
  await test.electronApp.evaluate(({ BrowserWindow }) => { BrowserWindow.prototype.loadFile = globalThis.screenshotOriginalLoadFile })
  console.log('Overlay load failure cleans up windows and releases capture lock')

  await page.evaluate(() => {
    window.captureResult = null
    void window.dustdesk.startScreenshot('Region').then(result => { window.captureResult = result })
  })
  overlay = await waitOverlay()
  const region = await overlay.locator('.screenshot-overlay').boundingBox()
  await overlay.mouse.move(region.x + 50, region.y + 140); await overlay.mouse.down()
  await overlay.mouse.move(region.x + 250, region.y + 260, { steps: 5 })
  await overlay.mouse.up().catch(error => { if (!overlay.isClosed()) throw error })
  await page.waitForFunction(() => window.captureResult !== null)
  assert.equal((await page.evaluate(() => window.captureResult)).ok, true)
  await ready()
  assert.ok(await canvas.evaluate(c => c.width > 0 && c.height > 0))
  console.log('Successful region selection and editor delivery passed')

  for (const location of ['设置', '截图编辑']) {
    await sidebar(location)
    await page.getByRole('button', { name: '区域', exact: true }).click()
    if (location === '截图编辑') await page.getByRole('button', { name: '捕获', exact: true }).click()
    overlay = await waitOverlay(); await closeOverlay(overlay, 'escape')
    await page.waitForTimeout(200)
    assert.equal(await page.getByText('截图桥接暂时不可用', { exact: true }).count(), 0)
    assert.equal(await page.getByText('region-capture-canceled', { exact: true }).count(), 0)
  }
  await sidebar('设置')
  const callsBeforePicker = await test.electronApp.evaluate(() => globalThis.screenshotTestCalls.length)
  await page.getByRole('button', { name: '窗口', exact: true }).click()
  await page.getByRole('dialog', { name: '选择截图窗口' }).waitFor()
  await page.screenshot({ path: path.join(artifacts, 'window-picker-light.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
  await page.screenshot({ path: path.join(artifacts, 'window-picker-dark.png') })
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await test.electronApp.evaluate(() => globalThis.screenshotTestCalls.length), callsBeforePicker + 1)
  await page.getByRole('button', { name: '窗口', exact: true }).click()
  await page.getByRole('button', { name: 'Target window', exact: true }).click()
  await ready()
  const selectedPixel = await page.locator('.canvas-wrap img').evaluate(async img => {
    await img.decode()
    const c = document.createElement('canvas'); c.width = 1; c.height = 1
    const context = c.getContext('2d'); context.drawImage(img, 0, 0)
    return Array.from(context.getImageData(0, 0, 1, 1).data)
  })
  assert.deepEqual(selectedPixel, [0, 0, 255, 255])
  await page.getByRole('button', { name: '窗口', exact: true }).click()
  await page.getByRole('button', { name: '捕获', exact: true }).click()
  await page.getByRole('dialog', { name: '选择截图窗口' }).waitFor()
  await test.electronApp.evaluate(() => { globalThis.screenshotTestMode = 'missing' })
  await page.getByRole('button', { name: 'Target window', exact: true }).click()
  await page.getByText('所选窗口已关闭或不可用，请重新选择', { exact: true }).waitFor()
  await ready()
  console.log('Window picker selection, dismissal and stale-target rejection passed')

  await test.electronApp.evaluate(() => { globalThis.screenshotTestMode = 'fail' })
  await page.getByRole('button', { name: '全屏', exact: true }).click()
  await page.getByRole('button', { name: '捕获', exact: true }).click()
  await page.getByText('截图失败：simulated capture failure。请重试', { exact: true }).waitFor()
  await ready()
  await test.electronApp.evaluate(() => { globalThis.screenshotTestMode = 'normal' })
  await page.getByRole('button', { name: '捕获', exact: true }).click(); await ready()
  await page.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace(); state.Settings.ScreenshotFormat = 'jpg'
    await window.dustdesk.saveWorkspace(state)
  })
  const jpeg = await page.evaluate(image => window.dustdesk.saveScreenshot(image), images[0])
  assert.equal(jpeg.ok, true); assert.ok(jpeg.path.endsWith('.jpg'))
  assert.equal((await readFile(jpeg.path)).subarray(0, 2).toString('hex'), 'ffd8')
  assert.deepEqual(errors, [])
  console.log('Capture error feedback, retry, JPEG export and renderer error checks passed')
} finally { await closeDustDesk(test) }
