import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const browserPath = [process.env.DUSTDESK_HEADLESS_BROWSER, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value))

test('shared editor renders native pixels, previews and edits objects, protects IME and flattens exports', { timeout: 120_000, skip: !browserPath }, async t => {
  const assets = path.resolve('out/renderer')
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
      const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname))
      if (!file.startsWith(assets + path.sep)) { res.writeHead(403); res.end(); return }
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] || 'application/octet-stream')
      res.end(await fs.readFile(file))
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu', '--disable-background-networking'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1000, height: 800 } })
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort())
  await context.addInitScript(() => {
    const listeners = new Set()
    window.__previewRegions = []
    const workers = new WeakSet(), post = Worker.prototype.postMessage
    Worker.prototype.postMessage = function (...args) {
      if (!workers.has(this)) { workers.add(this); this.addEventListener('message', event => { if (event.data.rect) window.__previewRegions.push(event.data.rect) }) }
      if (args[0].source && window.__holdSource) {
        window.__sourceHeld = true
        window.__releaseSource = () => { window.__sourceHeld = false; return post.apply(this, args) }
        return
      }
      return post.apply(this, args)
    }
    window.__outputs = []; window.__canceled = 0; window.__delay = 0; window.__fail = false
    window.__regionRequests = []; window.__dpi = 1; window.__captureDelay = 0; window.__capturePending = false
    const source = async (width = 400, height = 200, annotations = []) => {
      const c = document.createElement('canvas'); c.width = width; c.height = height
      const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height)
      for (let x = 0; x < width; x += 8) { ctx.fillStyle = x % 16 ? '#fff' : '#ddd'; ctx.fillRect(x, 0, 4, height) }
      const png = new Uint8Array(await (await new Promise(resolve => c.toBlob(resolve))).arrayBuffer())
      return { png, document: { id: crypto.randomUUID(), sourceAssetId: crypto.randomUUID(), width, height, crop: { x: 0, y: 0, width, height }, annotations, revision: 0, nextNumber: 1 } }
    }
    let payload
    window.__replace = async (w, h, annotations) => { payload = await source(w, h, annotations); for (const fn of listeners) fn(payload) }
    window.dustdesk = {
      onScreenshotDocument: fn => { listeners.add(fn); return () => listeners.delete(fn) },
      readScreenshotDocument: async () => { if (new URLSearchParams(location.search).has('region') && !payload) return { ok: false }; payload ||= await source(); return { ok: true, payload } },
      selectScreenshotRegion: async (rect, action, tool) => {
        window.__capturePending = true
        window.__regionRequests.push({ rect, action, tool })
        if (window.__captureDelay) await new Promise(resolve => setTimeout(resolve, window.__captureDelay))
        const scale = window.__dpi, nativeRect = Object.fromEntries(Object.entries(rect).map(([k, v]) => [k, Math.round(v * scale)]))
        payload = await source(nativeRect.width, nativeRect.height)
        Object.assign(payload.document, { width: Math.round(innerWidth * scale), height: Math.round(innerHeight * scale), crop: nativeRect, sourceRect: nativeRect })
        Object.assign(payload, { placement: { x: 0, y: 0, width: innerWidth, height: innerHeight }, initialAction: action === 'edit' ? undefined : action, initialTool: tool })
        window.__capturePending = false
        return { ok: true, payload }
      },
      loadWorkspace: async () => ({ Settings: { ScreenshotAfterAction: 'edit' } }),
      cancelScreenshotOverlay: async () => { window.__canceled++; return { ok: true } },
      finishScreenshot: async request => {
        window.__outputs.push(request)
        if (window.__delay) await new Promise(resolve => setTimeout(resolve, window.__delay))
        return window.__fail ? { ok: false, error: '模拟保存失败，可重试' } : { ok: true }
      }
    }
  })
  const page = await context.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin + '/?overlay=1&selected=1')
  await page.waitForFunction(() => document.querySelector('button[aria-label="箭头"]')?.disabled === false)
  const choose = async name => {
    const prior = await page.evaluate(() => window.__outputs.length)
    await page.getByRole('button', { name, exact: true }).click()
    if (['复制', '保存', '贴图'].includes(name)) {
      await page.waitForFunction(n => window.__outputs.length > n, prior)
      if (!await page.evaluate(() => window.__fail)) await page.waitForFunction(() => document.querySelector('.screenshot-editor').getAttribute('aria-busy') === 'false')
    }
  }
  const coords = async (x, y) => page.locator('.screenshot-image').evaluate((c, p) => { const r = c.getBoundingClientRect(); return { x: r.left + p.x * r.width / c.width, y: r.top + p.y * r.height / c.height } }, { x, y })
  const move = async (x, y) => { const p = await coords(x, y); await page.mouse.move(p.x, p.y) }
  const stroke = async (x1, y1, x2, y2) => { await move(x1, y1); await page.mouse.down(); await move(x2, y2); await page.mouse.up() }
  const pixel = (x, y) => page.locator('.screenshot-image').evaluate((c, p) => [...c.getContext('2d').getImageData(p.x, p.y, 1, 1).data], { x, y })
  // Check actual cursor inheritance, SVG decoding and gesture transitions in
  // the shared editor. Toolbar/textarea cursors must keep their own semantics.
  const cursors = new Set()
  for (const name of ['选择标注', '调整选区', '画笔', '高亮', '直线', '箭头', '矩形', '椭圆', '文字', '序号', '马赛克', '模糊', '实色遮盖', '删除标注']) {
    await choose(name)
    const cursor = await page.locator('.screenshot-viewport').evaluate(element => getComputedStyle(element).cursor)
    assert.ok(!cursors.has(cursor), `${name} must have a distinct cursor`); cursors.add(cursor)
    if (cursor.startsWith('url(')) {
      const decoded = await page.evaluate(async cursor => {
        const url = /url\("([^"]+)"\)/.exec(cursor)[1], image = new Image(); image.src = url; await image.decode(); return { width: image.naturalWidth, height: image.naturalHeight }
      }, cursor)
      assert.deepEqual(decoded, { width: 32, height: 32 })
    }
  }
  await choose('箭头'); await move(60, 40)
  const arrowCursor = await page.locator('.screenshot-viewport').evaluate(element => getComputedStyle(element).cursor)
  await page.keyboard.down('Space')
  assert.equal(await page.locator('.screenshot-viewport').evaluate(element => getComputedStyle(element).cursor), 'grab')
  await page.mouse.down()
  assert.equal(await page.locator('.screenshot-viewport').evaluate(element => getComputedStyle(element).cursor), 'grabbing')
  await page.mouse.up(); await page.keyboard.up('Space')
  assert.equal(await page.locator('.screenshot-viewport').evaluate(element => getComputedStyle(element).cursor), arrowCursor)
  assert.equal(await page.getByRole('button', { name: '箭头', exact: true }).evaluate(element => getComputedStyle(element).cursor), 'pointer')
  await choose('箭头'); await move(60, 40); await page.mouse.down(); await move(110, 70)
  await page.waitForFunction(() => { const p = document.querySelector('canvas').getContext('2d').getImageData(85, 55, 1, 1).data; return p[0] > 200 && p[1] < 150 })
  assert.equal(await page.evaluate(() => window.__outputs.length), 0, 'Pointer movement must never encode/export images')
  await page.mouse.up(); await choose('复制')
  assert.equal(await page.evaluate(() => window.__outputs[0].document.annotations.length), 1)
  await choose('撤销'); await choose('复制')
  assert.equal(await page.evaluate(() => window.__outputs.at(-1).document.annotations.length), 0)
  await choose('重做'); await choose('选择标注')
  await move(85, 55)
  assert.equal(await page.locator('.screenshot-viewport').evaluate(element => getComputedStyle(element).cursor), 'move')
  await stroke(85, 55, 95, 65); await choose('颜色 #1689ff'); await choose('复制')
  const arrow = await page.evaluate(() => window.__outputs.at(-1).document.annotations[0])
  assert.equal(arrow.style.color, '#1689ff')
  assert.ok(Math.abs(arrow.points[0].x - 70) < 1)
  assert.equal(await page.locator('.annotation-selection .se').evaluate(element => getComputedStyle(element).cursor), 'nwse-resize')
  const handle = await page.locator('.annotation-selection .se').boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down(); await page.mouse.move(handle.x + 20, handle.y + 20); await page.mouse.up()
  await choose('文字'); await move(150, 40); await page.mouse.click((await coords(150, 40)).x, (await coords(150, 40)).y)
  const input = page.getByLabel('标注文字', { exact: true })
  assert.equal(await input.evaluate(element => getComputedStyle(element).cursor), 'text')
  await input.fill('中文输入\n第二行')
  await input.evaluate(el => { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true })) })
  assert.equal(await input.count(), 1, 'IME confirmation cannot finish screenshot/text')
  await input.press('Control+Enter'); await choose('复制')
  assert.equal(await page.evaluate(() => window.__outputs.at(-1).document.annotations.find(a => a.kind === 'text').text), '中文输入\n第二行')
  await choose('选择标注'); const textPoint = await coords(160, 50); await page.mouse.dblclick(textPoint.x, textPoint.y)
  await input.fill('修改后的文字'); await input.press('Control+Enter'); await choose('复制')
  assert.equal(await page.evaluate(() => window.__outputs.at(-1).document.annotations.find(a => a.kind === 'text').text), '修改后的文字')
  await choose('序号'); const p = await coords(50, 120); await page.mouse.click(p.x, p.y); const q = await coords(95, 120); await page.mouse.click(q.x, q.y)
  await choose('复制'); assert.deepEqual(await page.evaluate(() => window.__outputs.at(-1).document.annotations.filter(a => a.kind === 'number').map(a => a.number)), [1, 2])
  await choose('实色遮盖'); await choose('颜色 #172333'); await stroke(10, 10, 130, 90)
  await choose('复制')
  const flattened = await page.evaluate(async () => {
    const request = window.__outputs.at(-1), blob = new Blob([request.png], { type: 'image/png' }), bitmap = await createImageBitmap(blob)
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; c.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
    return { pixel: [...c.getContext('2d').getImageData(30, 30, 1, 1).data], width: c.width, height: c.height, annotations: request.document.annotations.length }
  })
  assert.deepEqual(flattened.pixel, [23, 35, 51, 255]); assert.equal(flattened.width, 400); assert.equal(flattened.height, 200)
  await page.getByLabel('导出格式').selectOption('jpg'); await choose('保存')
  assert.deepEqual(await page.evaluate(() => [...window.__outputs.at(-1).jpeg.slice(0, 2)]), [255, 216], 'JPEG encoding also runs in the worker')
  // Arrow pixels may reach the tip but cannot continue beyond it. Verify the
  // actual flattened PNG across all directions, thick shafts and short arrows.
  for (const [width, angle, length] of [[4, 0, 70], [12, Math.PI / 2, 50], [24, Math.PI, 50], [12, -Math.PI / 2, 6], [8, -.3, 70], [16, 2.4, 70]]) {
    await page.evaluate(() => window.__replace(400, 200, []))
    await page.waitForFunction(() => document.querySelector('button[aria-label="箭头"]').disabled === false)
    await choose('箭头'); await page.getByLabel('粗细', { exact: true }).fill(String(width))
    await stroke(200, 100, 200 + Math.cos(angle) * length, 100 + Math.sin(angle) * length)
    await choose('复制')
    const result = await page.evaluate(async () => {
      const request = window.__outputs.at(-1), annotation = request.document.annotations[0], [start, end] = annotation.points, dx = end.x - start.x, dy = end.y - start.y, length = Math.hypot(dx, dy), bitmap = await createImageBitmap(new Blob([request.png]))
      const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; c.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
      const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let beyond = 0, center = 0
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4
        if (pixels[i] > 230 && pixels[i + 1] < 130 && pixels[i + 2] < 150) {
          const projection = ((x + .5 - end.x) * dx + (y + .5 - end.y) * dy) / length
          if (projection > 1.1) beyond++
          const fromStart = ((x + .5 - start.x) * dx + (y + .5 - start.y) * dy) / length
          const distance = Math.abs((x + .5 - start.x) * dy - (y + .5 - start.y) * dx) / length
          if (fromStart > 1 && fromStart < length - 1 && distance < 1) center++
        }
      }
      return { beyond, center }
    })
    assert.equal(result.beyond, 0, `Arrow width=${width} angle=${angle} cannot leak beyond the tip`)
    assert.ok(result.center > 0, 'Shaft and head must remain connected')
  }
  // Failed saves leave editable objects intact and allow one retry, without repeated clicks.
  await page.evaluate(() => { window.__fail = true; window.__delay = 200 })
  const prior = await page.evaluate(() => window.__outputs.length)
  await choose('保存'); await page.keyboard.press('Control+s'); await page.getByRole('alert').waitFor()
  assert.equal(await page.evaluate(() => window.__outputs.length), prior + 1)
  await page.evaluate(() => { window.__fail = false; window.__delay = 0 }); await choose('保存')
  await page.waitForFunction(() => document.querySelector('.screenshot-editor').getAttribute('aria-busy') === 'false')
  // Replacement cancels old worker work; 4K + 50 objects renders/exports without blocking input.
  await page.evaluate(async () => {
    const style = { color: '#ff4d57', width: 4, fontSize: 24, filled: false, strength: 12, mode: 'rectangle' }
    await window.__replace(3840, 2160, Array.from({ length: 50 }, (_, i) => ({ id: 'a' + i, kind: 'rectangle', points: [{ x: i * 30 + 10, y: i * 20 + 10 }, { x: i * 30 + 160, y: i * 20 + 100 }], style })))
  })
  await page.waitForFunction(() => document.querySelector('canvas')?.width === 3840 && document.querySelector('button[aria-label="复制"]')?.disabled === false)
  await choose('100%'); await choose('适应窗口'); await choose('复制')
  await page.waitForFunction(() => window.__outputs.at(-1).document.width === 3840)
  const performance = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(new Blob([window.__outputs.at(-1).png])); const result = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return result
  })
  assert.deepEqual(performance, { width: 3840, height: 2160 })
  await choose('画笔')
  await page.evaluate(() => {
    window.__toolbarMutations = 0; window.__previewRegions = []
    window.__observer = new MutationObserver(records => { window.__toolbarMutations += records.length })
    window.__observer.observe(document.querySelector('.screenshot-tools'), { attributes: true, childList: true, subtree: true })
    window.__longTasks = []; window.__perfObserver = new PerformanceObserver(list => { window.__longTasks.push(...list.getEntries().map(e => e.duration)) }); window.__perfObserver.observe({ entryTypes: ['longtask'] })
  })
  await move(2300, 1500); await page.mouse.down()
  for (let i = 0; i < 25; i++) await move(2300 + i * 8, 1500 + (i % 3) * 15)
  await page.waitForFunction(() => window.__previewRegions.some(r => r.width * r.height < 3840 * 2160 / 4))
  assert.equal(await page.evaluate(() => window.__toolbarMutations), 0, 'Pointer previews cannot reconcile toolbar controls')
  assert.equal(await page.evaluate(() => window.__longTasks.filter(duration => duration > 150).length), 0, '4K pointer previews must not stall the UI thread')
  await page.evaluate(() => { window.__observer.disconnect(); window.__perfObserver.disconnect() })
  await page.mouse.up(); await choose('复制')
  // The cached dirty preview must have exactly the same pixels as final composition.
  await page.waitForFunction(() => document.querySelector('button[aria-label="撤销"]').disabled === false)
  const matching = await page.evaluate(async () => {
    const bitmap = await createImageBitmap(new Blob([window.__outputs.at(-1).png])), c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; c.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
    const preview = document.querySelector('canvas').getContext('2d').getImageData(2280, 1480, 250, 80).data, exported = c.getContext('2d').getImageData(2280, 1480, 250, 80).data
    return preview.every((value, i) => value === exported[i])
  })
  assert.equal(matching, true)
  await choose('撤销'); await choose('复制')
  assert.equal(await page.evaluate(() => window.__outputs.at(-1).document.annotations.length), 50)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: 'test-artifacts/screenshot-editor-headless.png' })
  await page.evaluate(async () => { await window.__replace(3840, 2160, []); await window.__replace(120, 80, []) })
  await page.waitForFunction(() => document.querySelector('canvas')?.width === 120 && document.querySelector('button[aria-label="复制"]')?.disabled === false)
  await choose('复制')
  assert.equal(await page.evaluate(() => window.__outputs.at(-1).document.width), 120, 'Cancelled worker results cannot replace a new document')
  assert.equal(await page.getByRole('alert').count(), 0)

  // Cold 4K first stroke must keep repainting while the source worker initializes.
  // Hold its initial request deterministically instead of relying on machine speed.
  const cold = await context.newPage()
  await cold.setViewportSize({ width: 960, height: 540 })
  await cold.addInitScript(() => { Object.defineProperty(window, 'devicePixelRatio', { value: 4 }); window.__dpi = 4; window.__holdSource = true })
  await cold.goto(origin + '/?overlay=1&region=1')
  await cold.locator('.region-live-selector').waitFor()
  await cold.mouse.move(100, 100); await cold.mouse.down(); await cold.mouse.move(850, 330); await cold.mouse.up()
  await cold.getByRole('button', { name: '箭头', exact: true }).click()
  await cold.evaluate(() => {
    window.__coldTasks = []; window.__coldObserver = new PerformanceObserver(list => { window.__coldTasks.push(...list.getEntries().map(e => e.duration)) }); window.__coldObserver.observe({ entryTypes: ['longtask'] })
  })
  await cold.mouse.move(150, 150); await cold.mouse.down(); await cold.mouse.move(180, 150)
  await cold.waitForFunction(() => window.__sourceHeld)
  const feedbackTimes = []
  for (const x of [240, 310, 380]) {
    const start = Date.now()
    await cold.mouse.move(x, 150)
    await cold.waitForFunction(x => { const c = document.querySelector('.screenshot-image'); const p = c?.getContext('2d').getImageData((x - 15) * 4, 600, 1, 1).data; return p && p[0] > 200 && p[1] < 150 && p[3] === 255 }, x, { timeout: 1000 })
    feedbackTimes.push(Date.now() - start)
    assert.ok(feedbackTimes.at(-1) < 250, 'First-stroke previews cannot wait for source initialization')
  }
  await cold.evaluate(() => { window.__holdSource = false; window.__releaseSource() })
  await cold.mouse.move(460, 150); await cold.mouse.up()
  await cold.getByRole('button', { name: '复制', exact: true }).click()
  await cold.waitForFunction(() => window.__outputs.length === 1)
  assert.deepEqual(await cold.evaluate(() => window.__outputs[0].document.annotations[0].points), [{ x: 600, y: 600 }, { x: 1840, y: 600 }])
  const coldTasks = await cold.evaluate(() => { window.__coldObserver.disconnect(); return window.__coldTasks })
  assert.ok(coldTasks.every(duration => duration < 150), `Cold first use blocked the UI: ${JSON.stringify(coldTasks)}`)
  t.diagnostic(`Cold 4K feedback (ms): ${JSON.stringify(feedbackTimes)}; long tasks (ms): ${JSON.stringify(coldTasks.map(n => Math.round(n)))}`)
  // Recapture uses a separate preview surface, preserving the existing image.
  await cold.getByRole('button', { name: '调整选区', exact: true }).click()
  const coldHandle = await cold.locator('.editor-selection .se').boundingBox()
  await cold.mouse.move(coldHandle.x + coldHandle.width / 2, coldHandle.y + coldHandle.height / 2); await cold.mouse.down(); await cold.mouse.move(890, 340); await cold.mouse.up()
  await cold.getByRole('button', { name: '箭头', exact: true }).click()
  await cold.evaluate(() => { window.__holdSource = true })
  await cold.mouse.move(500, 300); await cold.mouse.down(); await cold.mouse.move(540, 300)
  await cold.waitForFunction(() => window.__sourceHeld)
  await cold.mouse.move(630, 300)
  await cold.waitForFunction(() => { const p = document.querySelector('.screenshot-loading-preview').getContext('2d').getImageData(600 * 4, 300 * 4, 1, 1).data; return p[0] > 200 && p[1] < 150 && p[3] === 255 }, undefined, { timeout: 1000 })
  assert.equal(await cold.locator('.screenshot-image').evaluate(c => c.getContext('2d').getImageData(440, 440, 1, 1).data[3]), 255, 'Loading a larger selection must preserve the existing source pixels')
  await cold.mouse.up()
  await cold.evaluate(() => { window.__holdSource = false; window.__releaseSource() })
  await cold.getByRole('button', { name: '复制', exact: true }).click(); await cold.waitForFunction(() => window.__outputs.length === 2)
  const coldMatch = await cold.evaluate(async () => {
    const { document: doc, png } = window.__outputs.at(-1), bitmap = await createImageBitmap(new Blob([png]))
    const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; c.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close()
    const actual = document.querySelector('.screenshot-image').getContext('2d').getImageData(2390, 1190, 20, 20).data
    const exported = c.getContext('2d').getImageData(2390 - doc.crop.x, 1190 - doc.crop.y, 20, 20).data
    return actual.every((n, i) => n === exported[i])
  })
  assert.equal(coldMatch, true, 'Source handoff must present all current pixels, including worker dirty updates')
  await cold.close()

  // Real DOM mapping at each DPI factor; release preserves selection and eight handles.
  for (const dpi of [1, 1.25, 1.5, 2]) {
    const selectionPage = await context.newPage()
    await selectionPage.addInitScript(scale => { Object.defineProperty(window, 'devicePixelRatio', { value: scale }); window.__dpi = scale }, dpi)
    await selectionPage.goto(origin + '/?overlay=1&region=1')
    await selectionPage.locator('.region-live-selector').waitFor()
    await selectionPage.evaluate(scale => { window.__dpi = scale }, dpi)
    assert.equal(await selectionPage.evaluate(() => window.__regionRequests.length), 0, 'The initial live selector cannot capture desktop pixels')
    assert.equal(await selectionPage.locator('.screenshot-image').evaluate(c => c.getContext('2d').getImageData(110, 110, 1, 1).data[3]), 0, 'The preallocated preview must remain transparent before drawing')
    await selectionPage.mouse.move(100, 100); await selectionPage.mouse.down(); await selectionPage.mouse.move(300, 250); await selectionPage.mouse.up()
    await selectionPage.getByRole('button', { name: '复制', exact: true }).waitFor()
    assert.equal(await selectionPage.locator('.editor-selection .selection-handle').count(), 8)
    assert.equal(await selectionPage.evaluate(() => window.__outputs.length), 0)
    assert.equal(await selectionPage.evaluate(() => window.__regionRequests.length), 0, 'Releasing a selection must not capture any pixels')
    await selectionPage.evaluate(() => { window.__toolbar = document.querySelector('.screenshot-tools'); window.__selection = document.querySelector('.editor-selection'); window.__viewport = document.querySelector('.screenshot-viewport') })
    await selectionPage.getByRole('button', { name: '箭头', exact: true }).click()
    assert.equal(await selectionPage.evaluate(() => window.__regionRequests.length), 0, 'Tool choice must not capture or replace the editor')
    assert.equal(await selectionPage.evaluate(() => window.__toolbar === document.querySelector('.screenshot-tools') && window.__selection === document.querySelector('.editor-selection') && window.__viewport === document.querySelector('.screenshot-viewport')), true)
    await selectionPage.getByRole('button', { name: '复制', exact: true }).click()
    await selectionPage.waitForFunction(() => window.__outputs.length > 0)
    const crop = await selectionPage.evaluate(() => window.__outputs[0].document.crop)
    assert.deepEqual(crop, { x: Math.round(100 * dpi), y: Math.round(100 * dpi), width: Math.round(200 * dpi), height: Math.round(150 * dpi) })
    assert.deepEqual(await selectionPage.evaluate(() => window.__regionRequests[0].rect), { x: 100, y: 100, width: 200, height: Math.round(150 * dpi) / dpi })
    const box = await selectionPage.locator('.screenshot-tools').boundingBox()
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1001 && box.y + box.height <= 801)
    // Editing and then enlarging/moving the crop reuses the frame and preserves annotations.
    await selectionPage.mouse.move(140, 140); await selectionPage.mouse.down(); await selectionPage.mouse.move(220, 180); await selectionPage.mouse.up()
    await selectionPage.getByRole('button', { name: '调整选区', exact: true }).click()
    const se = await selectionPage.locator('.editor-selection .se').boundingBox()
    await selectionPage.mouse.move(se.x + se.width / 2, se.y + se.height / 2); await selectionPage.mouse.down(); await selectionPage.mouse.move(400, 300); await selectionPage.mouse.up()
    await selectionPage.mouse.move(250, 210); await selectionPage.mouse.down(); await selectionPage.mouse.move(260, 220); await selectionPage.mouse.up()
    await selectionPage.getByRole('button', { name: '复制', exact: true }).click()
    await selectionPage.waitForFunction(() => window.__outputs.length === 2)
    const changed = await selectionPage.evaluate(() => ({ crop: window.__outputs.at(-1).document.crop, annotations: window.__outputs.at(-1).document.annotations, rect: window.__regionRequests.at(-1).rect, requests: window.__regionRequests.length }))
    assert.deepEqual(changed.rect, { x: Math.round(110 * dpi) / dpi, y: Math.round(110 * dpi) / dpi, width: 300, height: 200 })
    assert.deepEqual(changed.crop, { x: Math.round(110 * dpi), y: Math.round(110 * dpi), width: Math.round(300 * dpi), height: Math.round(200 * dpi) })
    assert.equal(changed.requests, 2); assert.equal(changed.annotations.length, 1)
    assert.deepEqual(changed.annotations[0].points.at(-1), { x: 220 * dpi, y: 180 * dpi })
    const exported = await selectionPage.evaluate(async () => { const bitmap = await createImageBitmap(new Blob([window.__outputs.at(-1).png])); const c = document.createElement('canvas'); c.width = bitmap.width; c.height = bitmap.height; c.getContext('2d').drawImage(bitmap, 0, 0); bitmap.close(); return { width: c.width, height: c.height, alpha: c.getContext('2d').getImageData(0, 0, 1, 1).data[3] } })
    assert.deepEqual(exported, { width: 300 * dpi, height: 200 * dpi, alpha: 255 })
    assert.equal(await selectionPage.evaluate(() => window.__toolbar === document.querySelector('.screenshot-tools') && window.__selection === document.querySelector('.editor-selection')), true)
    // Pointer release carries the final coordinates even when no intervening React render occurs.
    await selectionPage.locator('.screenshot-viewport').evaluate(element => {
      const capture = element.setPointerCapture; element.setPointerCapture = () => {}
      element.dispatchEvent(new PointerEvent('pointerdown', { clientX: 200, clientY: 200, button: 0, pointerId: 1, bubbles: true }))
      element.dispatchEvent(new PointerEvent('pointerup', { clientX: 220, clientY: 215, button: 0, pointerId: 1, bubbles: true }))
      element.setPointerCapture = capture
    })
    await selectionPage.getByRole('button', { name: '复制', exact: true }).click()
    await selectionPage.waitForFunction(() => window.__outputs.length === 3)
    assert.deepEqual(await selectionPage.evaluate(() => window.__regionRequests.at(-1).rect), { x: Math.round(Math.round(110 * dpi) + 20 * dpi) / dpi, y: Math.round(Math.round(110 * dpi) + 15 * dpi) / dpi, width: 300, height: 200 })
    if (dpi === 1) {
      // A quick first stroke can finish while region capture is still in flight.
      const lazy = await context.newPage(); await lazy.goto(origin + '/?overlay=1&region=1')
      await lazy.locator('.region-live-selector').waitFor(); await lazy.evaluate(() => { window.__captureDelay = 700 })
      await lazy.mouse.move(100, 100); await lazy.mouse.down(); await lazy.mouse.move(300, 250); await lazy.mouse.up()
      await lazy.getByRole('button', { name: '箭头', exact: true }).click()
      await lazy.evaluate(() => {
        window.__flashFrames = []; const tools = document.querySelector('.screenshot-tools'), selection = document.querySelector('.editor-selection')
        const sample = () => {
          if (window.__stopSampling) return
          window.__flashFrames.push({ visible: [tools, selection].every(element => getComputedStyle(element).visibility === 'visible' && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().width > 0), disabled: document.querySelector('button[aria-label="箭头"]').disabled, same: tools === document.querySelector('.screenshot-tools') && selection === document.querySelector('.editor-selection') })
          requestAnimationFrame(sample)
        }; requestAnimationFrame(sample)
      })
      await lazy.mouse.move(140, 140); await lazy.mouse.down(); await lazy.mouse.move(220, 180); await lazy.mouse.up()
      await lazy.waitForFunction(() => { const canvas = document.querySelector('.screenshot-image'); if (!canvas) return false; const pixel = canvas.getContext('2d').getImageData(180, 160, 1, 1).data; return pixel[0] > 200 && pixel[1] < 150 && pixel[3] === 255 })
      assert.equal(await lazy.evaluate(() => window.__capturePending), true, 'First-stroke feedback must appear before native pixels finish loading')
      await lazy.waitForFunction(() => { const c = document.querySelector('.screenshot-image'); return !window.__capturePending && c?.getContext('2d').getImageData(110, 110, 1, 1).data[3] === 255 })
      const frames = await lazy.evaluate(() => { window.__stopSampling = true; return window.__flashFrames })
      assert.ok(frames.length > 2, 'The first native capture must be sampled across multiple visible frames')
      assert.ok(frames.every(frame => frame.visible && frame.same && !frame.disabled), 'The first stroke must never hide, replace or gray out the frame and toolbar')
      await lazy.getByRole('button', { name: '复制', exact: true }).click(); await lazy.waitForFunction(() => window.__outputs.length === 1)
      assert.deepEqual(await lazy.evaluate(() => window.__outputs[0].document.annotations[0].points), [{ x: 140, y: 140 }, { x: 220, y: 180 }])
      assert.equal(await lazy.getByRole('alert').count(), 0)
      await lazy.close()
      const penPage = await context.newPage(); await penPage.goto(origin + '/?overlay=1&region=1')
      await penPage.locator('.region-live-selector').waitFor(); await penPage.evaluate(() => { window.__captureDelay = 700 })
      await penPage.mouse.move(100, 100); await penPage.mouse.down(); await penPage.mouse.move(300, 250); await penPage.mouse.up()
      await penPage.getByRole('button', { name: '画笔', exact: true }).click()
      await penPage.mouse.move(120, 120); await penPage.mouse.down(); await penPage.mouse.move(150, 200); await penPage.mouse.move(200, 140); await penPage.mouse.up()
      assert.equal(await penPage.evaluate(() => window.__capturePending), true)
      await penPage.mouse.move(130, 130); await penPage.mouse.down(); await penPage.mouse.move(170, 190); await penPage.mouse.up()
      await penPage.mouse.move(160, 160); await penPage.mouse.down(); await penPage.mouse.move(190, 180)
      await penPage.keyboard.press('Escape'); await penPage.mouse.up()
      assert.equal(await penPage.evaluate(() => window.__canceled), 0, 'Esc cancels the active stroke while source loading continues')
      await penPage.getByRole('button', { name: '矩形', exact: true }).click()
      await penPage.mouse.move(150, 150); await penPage.mouse.down(); await penPage.mouse.move(180, 180); await penPage.mouse.up()
      await penPage.getByRole('button', { name: '撤销', exact: true }).click()
      await penPage.getByRole('button', { name: '复制', exact: true }).click(); await penPage.waitForFunction(() => window.__outputs.length === 1)
      const pens = await penPage.evaluate(() => window.__outputs[0].document.annotations)
      assert.equal(pens.length, 2, 'Multiple strokes and undo must survive asynchronous source loading')
      assert.ok(pens.every(annotation => annotation.kind === 'pen'))
      assert.ok(pens[0].points.some(point => Math.hypot(point.x - 150, point.y - 200) < .1), 'The first freehand stroke must retain its intermediate curve')
      assert.deepEqual(pens[1].points.at(-1), { x: 170, y: 190 })
      assert.equal(await penPage.evaluate(() => window.__regionRequests.length), 1)
      assert.equal(await penPage.getByRole('alert').count(), 0)
      // Source replacement may complete in the middle of a subsequent stroke.
      await penPage.getByRole('button', { name: '调整选区', exact: true }).click()
      const expandedHandle = await penPage.locator('.editor-selection .se').boundingBox()
      await penPage.mouse.move(expandedHandle.x + expandedHandle.width / 2, expandedHandle.y + expandedHandle.height / 2); await penPage.mouse.down(); await penPage.mouse.move(400, 300); await penPage.mouse.up()
      await penPage.getByRole('button', { name: '箭头', exact: true }).click()
      await penPage.mouse.move(240, 220); await penPage.mouse.down(); await penPage.mouse.move(260, 230)
      await penPage.waitForFunction(() => !window.__capturePending && document.querySelector('.screenshot-image').getContext('2d').getImageData(350, 290, 1, 1).data[3] === 255)
      await penPage.mouse.move(340, 260); await penPage.mouse.up()
      await penPage.getByRole('button', { name: '复制', exact: true }).click(); await penPage.waitForFunction(() => window.__outputs.length === 2)
      const resumed = await penPage.evaluate(async () => { const request = window.__outputs.at(-1), source = await window.dustdesk.readScreenshotDocument(''); return { id: request.document.id, sourceId: request.document.sourceAssetId, capturedId: source.payload.document.id, capturedSourceId: source.payload.document.sourceAssetId, annotations: request.document.annotations } })
      assert.equal(resumed.id, resumed.capturedId); assert.equal(resumed.sourceId, resumed.capturedSourceId)
      assert.equal(resumed.annotations.length, 3)
      assert.deepEqual(resumed.annotations.at(-1).points, [{ x: 240, y: 220 }, { x: 340, y: 260 }])
      assert.equal(await penPage.getByRole('alert').count(), 0)
      await penPage.close()
    }
    await selectionPage.close()
  }
})
