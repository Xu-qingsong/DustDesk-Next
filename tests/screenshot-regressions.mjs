import assert from 'node:assert/strict'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'

// One consolidated native smoke run, after all no-window regression checks.
const test = await launchDustDesk(), page = test.window
page.setDefaultTimeout(15_000)
const errors = [], directory = path.join(test.tempRoot, 'data', 'Screenshots')
page.on('pageerror', error => errors.push(error.message))
const exports = () => readdir(directory).catch(() => [])
const ready = target => target.waitForFunction(() => document.querySelector('button[aria-label="复制"]')?.disabled === false)
const closeBy = async (target, action) => {
  const closed = target.waitForEvent('close')
  await action().catch(error => { if (!target.isClosed()) throw error })
  await closed
}
const waitWindow = async kind => {
  const existing = test.electronApp.windows().find(w => w.url().includes(kind + '='))
  if (existing) return existing
  return test.electronApp.waitForEvent('window', { predicate: w => w.url().includes(kind + '=') })
}
const importImage = async (width = 400, height = 200) => {
  const bytes = await page.evaluate(async ({ width, height }) => {
    const c = document.createElement('canvas'); c.width = width; c.height = height
    c.getContext('2d').fillStyle = '#fff'; c.getContext('2d').fillRect(0, 0, width, height)
    return [...new Uint8Array(await (await new Promise(resolve => c.toBlob(resolve))).arrayBuffer())]
  }, { width, height })
  await page.getByLabel('导入截图图片').setInputFiles({ name: 'source.png', mimeType: 'image/png', buffer: Buffer.from(bytes) })
  await ready(page)
}
try {
  await page.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    Object.assign(state.Settings, { ClipboardMonitoringEnabled: false, ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false, ScreenshotAfterAction: 'edit', ScreenshotDelaySeconds: 0 })
    await window.dustdesk.saveWorkspace(state)
    await window.dustdesk.writeClipboard({ text: 'DUSTDESK_SCREENSHOT_CANCEL_SENTINEL' })
  })
  await page.locator('.sidebar').getByRole('button', { name: '截图编辑', exact: true }).click()
  await importImage()
  const image = page.locator('.screenshot-image'), box = await image.boundingBox()
  await page.getByRole('button', { name: '实色遮盖', exact: true }).click()
  await page.getByRole('button', { name: '颜色 #172333', exact: true }).click()
  await page.mouse.move(box.x + 10, box.y + 10); await page.mouse.down(); await page.mouse.move(box.x + 90, box.y + 80); await page.mouse.up()
  await page.getByRole('button', { name: '复制', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.screenshot-feedback').textContent.includes('已复制'))
  const clipboard = await page.evaluate(() => window.dustdesk.readClipboard())
  assert.ok(clipboard.imagePngBase64)
  assert.deepEqual(await exports(), [])
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.screenshot-feedback').textContent.includes('已保存'))
  const png = await readFile(path.join(directory, (await exports())[0]))
  assert.equal(png.readUInt32BE(16), 400); assert.equal(png.readUInt32BE(20), 200)
  await page.getByLabel('导出格式').selectOption('jpg'); await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.screenshot-feedback').textContent.includes('.jpg'))
  const jpg = await readFile(path.join(directory, (await exports()).find(f => f.endsWith('.jpg'))))
  assert.equal(jpg[0], 255); assert.equal(jpg[1], 216)
  // A pin has the identical edited PNG; opacity/scale never re-encode its image.
  await page.getByRole('button', { name: '贴图', exact: true }).click()
  const pin = await waitWindow('pin'), pinId = new URL(pin.url()).searchParams.get('pin')
  pin.on('pageerror', error => errors.push(error.message))
  await pin.locator('img').waitFor(); await pin.waitForFunction(() => document.querySelector('img').naturalWidth === 400)
  const pinned = await pin.evaluate(id => window.dustdesk.readPinnedScreenshot(id), pinId)
  assert.deepEqual(Buffer.from(pinned.png), png)
  const pinJpeg = path.join(test.tempRoot, 'pin-export.jpg')
  await test.electronApp.evaluate(({ dialog }, output) => {
    globalThis.screenshotSaveDialog = dialog.showSaveDialog
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: output })
  }, pinJpeg)
  await pin.evaluate(id => window.dustdesk.controlPinnedScreenshot(id, 'save'), pinId)
  let pinBytes
  for (let attempt = 0; attempt < 150; attempt++) {
    pinBytes = await readFile(pinJpeg).catch(() => null)
    if (pinBytes) break
    await page.waitForTimeout(40)
  }
  assert.ok(pinBytes, 'Pin save must complete JPEG encoding in its worker')
  assert.equal(pinBytes[0], 255); assert.equal(pinBytes[1], 216)
  await test.electronApp.evaluate(({ dialog }) => { dialog.showSaveDialog = globalThis.screenshotSaveDialog })
  await pin.evaluate(id => window.dustdesk.controlPinnedScreenshot(id, 'options', { opacity: 75, topmost: false, locked: true, mouseThrough: true }), pinId)
  const actualOptions = await test.electronApp.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('pin=')); return { opacity: w.getOpacity(), topmost: w.isAlwaysOnTop(), resizable: w.isResizable() }
  })
  assert.equal(actualOptions.opacity, .75); assert.equal(actualOptions.topmost, false); assert.equal(actualOptions.resizable, false)
  await pin.evaluate(id => window.dustdesk.controlPinnedScreenshot(id, 'options', { locked: false, mouseThrough: false }), pinId)
  await pin.evaluate(id => window.dustdesk.controlPinnedScreenshot(id, 'edit'), pinId)
  const editor = await waitWindow('overlay'); await ready(editor)
  await closeBy(editor, () => editor.getByRole('button', { name: '取消截图', exact: true }).click())
  assert.deepEqual(Buffer.from((await pin.evaluate(id => window.dustdesk.readPinnedScreenshot(id), pinId)).png), png)
  await pin.evaluate(id => window.dustdesk.controlPinnedScreenshot(id, 'edit'), pinId)
  const editor2 = await waitWindow('overlay'); await ready(editor2)
  await closeBy(editor2, () => editor2.getByRole('button', { name: '更新贴图', exact: true }).click())
  assert.deepEqual(Buffer.from((await pin.evaluate(id => window.dustdesk.readPinnedScreenshot(id), pinId)).png), png)
  const pinClosed = pin.waitForEvent('close')
  await pin.evaluate(id => window.dustdesk.controlPinnedScreenshot(id, 'close'), pinId).catch(error => { if (!pin.isClosed()) throw error })
  await pinClosed
  // Capture the real cursor display once, then cancel before any output effect.
  await page.evaluate(() => window.dustdesk.writeClipboard({ text: 'DUSTDESK_SCREENSHOT_CANCEL_SENTINEL' }))
  await page.evaluate(() => window.dustdesk.startScreenshot('FullScreen'))
  const screenEditor = await waitWindow('overlay'); await ready(screenEditor)
  const displays = await test.electronApp.evaluate(({ screen }) => ({ all: screen.getAllDisplays().map(d => ({ id: d.id, scale: d.scaleFactor, width: d.size.width, height: d.size.height })), target: screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id }))
  const target = displays.all.find(d => d.id === displays.target)
  const geometry = await screenEditor.locator('canvas').evaluate(c => ({ width: c.width, height: c.height }))
  assert.deepEqual(geometry, { width: Math.round(target.width * target.scale), height: Math.round(target.height * target.scale) })
  await closeBy(screenEditor, () => screenEditor.keyboard.press('Escape'))
  assert.equal((await page.evaluate(() => window.dustdesk.readClipboard())).text, 'DUSTDESK_SCREENSHOT_CANCEL_SENTINEL')
  assert.equal((await exports()).length, 2)
  // A known desktop surface lets us verify the visible overlay is truly excluded
  // from the captured pixels, including its selection border and in-region toolbar.
  await test.electronApp.evaluate(async ({ BrowserWindow, screen }) => {
    const bounds = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds
    globalThis.regionBackdrop = new BrowserWindow({ ...bounds, frame: false, show: false, alwaysOnTop: true, backgroundColor: '#35c47b', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await globalThis.regionBackdrop.loadURL('data:text/html,' + encodeURIComponent('<style>html,body{margin:0;background:#35c47b}</style>'))
    globalThis.regionBackdrop.show()
  })
  // Real region overlay keeps an adjustable selection after releasing the mouse.
  await page.evaluate(() => { window.__region = window.dustdesk.startScreenshot('Region') })
  const region = await waitWindow('overlay'); await region.locator('.region-live-selector').waitFor()
  assert.equal((await region.evaluate(() => window.dustdesk.readScreenshotDocument(''))).ok, false, 'Region shortcuts open a live selector without taking a full-screen screenshot')
  await region.mouse.move(100, 100); await region.mouse.down(); await region.mouse.move(400, 280); await region.mouse.up()
  await region.getByRole('button', { name: '复制', exact: true }).waitFor()
  assert.equal(await region.locator('.selection-handle').count(), 8)
  assert.equal((await region.evaluate(() => window.dustdesk.readScreenshotDocument(''))).ok, false, 'Releasing the mouse must not capture the screen')
  await region.evaluate(() => { window.__tools = document.querySelector('.screenshot-tools'); window.__selection = document.querySelector('.editor-selection') })
  await region.getByRole('button', { name: '箭头', exact: true }).click(); await ready(region)
  assert.equal((await region.evaluate(() => window.dustdesk.readScreenshotDocument(''))).ok, false, 'Choosing a tool keeps the live selector and does not capture pixels')
  assert.equal(await region.locator('.screenshot-image').evaluate(c => c.getContext('2d').getImageData(110 * devicePixelRatio, 110 * devicePixelRatio, 1, 1).data[3]), 0)
  await region.evaluate(() => {
    window.__captureFrames = []; window.__canvasSizes = new Set(); const selection = document.querySelector('.editor-selection'), tools = document.querySelector('.screenshot-tools')
    window.__frameTimes = []; window.__firstInk = 0
    window.__pointerTimes = []
    const viewport = document.querySelector('.screenshot-viewport')
    viewport.addEventListener('pointerdown', () => { window.__inkStart = performance.now() }, { once: true })
    viewport.addEventListener('pointermove', event => { if (window.__inkStart && event.buttons) window.__pointerTimes.push({ t: performance.now() - window.__inkStart, x: event.clientX, y: event.clientY }) })
    const timing = () => {
      if (window.__stopSampling) return
      window.__frameTimes.push(performance.now())
      if (!window.__firstInk && window.__inkStart) { const p = document.querySelector('.screenshot-image').getContext('2d').getImageData(195 * devicePixelRatio, 170 * devicePixelRatio, 1, 1).data; if (p[0] > 200 && p[1] < 150 && p[3] === 255) window.__firstInk = performance.now() - window.__inkStart }
      requestAnimationFrame(timing)
    }; requestAnimationFrame(timing)
    const sample = () => { if (window.__stopSampling) return; const canvas = document.querySelector('.screenshot-image'); if (canvas) window.__canvasSizes.add(`${canvas.width}x${canvas.height}`); window.__captureFrames.push([selection, tools].every(element => element.isConnected && getComputedStyle(element).visibility === 'visible') && !document.querySelector('button[aria-label="箭头"]').disabled); requestAnimationFrame(sample) }; requestAnimationFrame(sample)
  })
  // Drive a continuous stroke within the renderer: separate CDP mouse calls
  // can themselves wait behind Windows native helper startup in the main
  // process and would incorrectly count automation latency as paint latency.
  await region.locator('.screenshot-viewport').evaluate(async element => {
    const capture = element.setPointerCapture; element.setPointerCapture = () => {}
    const pointer = (type, x, y, buttons) => element.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, buttons, clientX: x, clientY: y }))
    try {
      pointer('pointerdown', 140, 140, 1)
      for (let i = 1; i <= 8; i++) { await new Promise(resolve => requestAnimationFrame(resolve)); pointer('pointermove', 140 + 110 * i / 8, 140 + 60 * i / 8, 1) }
      pointer('pointerup', 250, 200, 0)
    } finally { element.setPointerCapture = capture }
  })
  await region.waitForFunction(() => { const canvas = document.querySelector('.screenshot-image'); if (!canvas) return false; const pixel = canvas.getContext('2d').getImageData(195 * devicePixelRatio, 170 * devicePixelRatio, 1, 1).data; return pixel[0] > 200 && pixel[1] < 150 && pixel[3] === 255 })
  const regionGeometry = await region.locator('.screenshot-image').evaluate(c => ({ width: c.width, height: c.height }))
  assert.deepEqual(regionGeometry, { width: Math.round(target.width * target.scale), height: Math.round(target.height * target.scale) })
  // The arrow is already visible while the original pixels are still loading.
  // Wait separately for those pixels before inspecting the native source asset.
  await region.waitForFunction(() => document.querySelector('.screenshot-image').getContext('2d').getImageData(110 * devicePixelRatio, 110 * devicePixelRatio, 1, 1).data[3] === 255)
  const captureFrames = await region.evaluate(() => { window.__stopSampling = true; return window.__captureFrames })
  assert.ok(captureFrames.length > 2 && captureFrames.every(Boolean), 'Real first-stroke capture keeps the selection and toolbar visible and enabled')
  assert.equal(await region.evaluate(() => window.__canvasSizes.size), 1, 'Loading the native source cannot resize and clear the first-stroke canvas')
  const nativeTiming = await region.evaluate(() => ({ feedbackMs: Math.round(window.__firstInk - window.__pointerTimes.find(p => p.x >= 195).t), maxFrameGapMs: Math.round(Math.max(...window.__frameTimes.slice(1).map((n, i) => n - window.__frameTimes[i]))) }))
  assert.ok(nativeTiming.feedbackMs < 150, 'Native capture startup cannot pause first-stroke feedback')
  console.log('Native first-use timing:', nativeTiming)
  const initialPayload = await region.evaluate(() => window.dustdesk.readScreenshotDocument(''))
  assert.deepEqual(initialPayload.payload.document.sourceRect, { x: Math.round(100 * target.scale), y: Math.round(100 * target.scale), width: Math.round(300 * target.scale), height: Math.round(180 * target.scale) })
  const capturedColors = await region.evaluate(async () => {
    const { payload } = await window.dustdesk.readScreenshotDocument(''), bitmap = await createImageBitmap(new Blob([payload.png])), canvas = document.createElement('canvas'); canvas.width = bitmap.width; canvas.height = bitmap.height; const context = canvas.getContext('2d'); context.drawImage(bitmap, 0, 0); bitmap.close()
    return [[0, 0], [1, 1], [canvas.width - 1, canvas.height - 1], [20, 20]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data])
  })
  assert.deepEqual(capturedColors, Array.from({ length: 4 }, () => [53, 196, 123, 255]), 'Visible selection borders must never enter the captured region')
  const regionPixels = await region.locator('.screenshot-image').evaluate(c => c.getContext('2d').getImageData(120 * devicePixelRatio, 120 * devicePixelRatio, 1, 1).data[3])
  assert.equal(regionPixels, 255, 'Native region capture must contain visible pixels')
  await region.getByRole('button', { name: '调整选区', exact: true }).click()
  const se = await region.locator('.editor-selection .se').boundingBox()
  await region.mouse.move(se.x + se.width / 2, se.y + se.height / 2); await region.mouse.down(); await region.mouse.move(500, 320); await region.mouse.up()
  await region.mouse.move(280, 220); await region.mouse.down(); await region.mouse.move(300, 230); await region.mouse.up()
  await region.getByRole('button', { name: '箭头', exact: true }).click()
  await region.mouse.move(320, 230); await region.mouse.down(); await region.mouse.move(380, 260); await region.mouse.up()
  await region.waitForFunction(() => { const pixel = document.querySelector('.screenshot-image').getContext('2d').getImageData(350 * devicePixelRatio, 245 * devicePixelRatio, 1, 1).data; return pixel[0] > 200 && pixel[1] < 150 && pixel[3] === 255 })
  await region.waitForFunction(() => document.querySelector('.screenshot-image').getContext('2d').getImageData(480 * devicePixelRatio, 315 * devicePixelRatio, 1, 1).data[3] === 255)
  const secondPayload = await region.evaluate(() => window.dustdesk.readScreenshotDocument(''))
  assert.deepEqual(secondPayload.payload.document.sourceRect, { x: Math.round(120 * target.scale), y: Math.round(110 * target.scale), width: Math.round(400 * target.scale), height: Math.round(220 * target.scale) })
  assert.equal(await region.evaluate(() => window.__tools === document.querySelector('.screenshot-tools') && window.__selection === document.querySelector('.editor-selection')), true, 'Native recapture cannot recreate the frame or toolbar')
  await closeBy(region, () => region.getByRole('button', { name: '取消截图', exact: true }).click())
  await test.electronApp.evaluate(() => globalThis.regionBackdrop.destroy())
  assert.equal((await page.evaluate(() => window.__region)).message, 'region-capture-canceled')
  assert.equal((await exports()).length, 2)
  await mkdir('test-artifacts', { recursive: true }); await page.screenshot({ path: 'test-artifacts/screenshot-native-editor.png' })
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, nativeDisplays: displays.all, pngJpgExports: 2, pinsSessionOnly: true }))
} finally { await closeDustDesk(test) }
