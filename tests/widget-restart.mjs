import assert from 'node:assert/strict'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  const windowPromise = app.electronApp.waitForEvent('window', { timeout: 10000 })
  await app.window.getByTitle('桌面小组件').click()
  const hiddenTaskToggle = app.window.getByRole('button', { name: '显示任务小组件' })
  assert.equal(await hiddenTaskToggle.getAttribute('aria-pressed'), 'false')
  await hiddenTaskToggle.click()
  const visibleTaskToggle = app.window.getByRole('button', { name: '隐藏任务小组件' })
  assert.equal(await visibleTaskToggle.getAttribute('aria-pressed'), 'true')
  const widget = await windowPromise
  await widget.waitForSelector('.widget-head')
  assert.equal(await app.electronApp.windows().length >= 2, true)

  const resizeResult = await widget.evaluate(() => window.dustdesk.resizeWidget('todo', 420, 340, true))
  assert.equal(resizeResult.ok, true)
  await widget.waitForFunction(() => innerWidth === 420 && innerHeight === 340)
  // Keep the virtual gesture away from the OS cursor at the default centered
  // position; native hover events during resize can otherwise steal capture.
  await app.electronApp.evaluate(({ BrowserWindow, screen }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('widget=todo'))
    const area = screen.getPrimaryDisplay().workArea
    const cursor = screen.getCursorScreenPoint()
    const x = cursor.x < area.x + area.width / 2 ? area.x + area.width - 560 : area.x + 20
    const y = cursor.y < area.y + area.height / 2 ? area.y + area.height - 460 : area.y + 20
    window.setPosition(x, y); window.show(); window.focus()
  })
  const compactContent = await widget.locator('.widget-content').boundingBox()
  assert.ok(compactContent && compactContent.width > 0 && compactContent.height > 0)
  const resizeGrip = await widget.locator('.widget-resize-grip').boundingBox()
  assert.ok(resizeGrip)
  await widget.mouse.move(resizeGrip.x + resizeGrip.width / 2, resizeGrip.y + resizeGrip.height / 2)
  await widget.mouse.down()
  await widget.mouse.move(resizeGrip.x + resizeGrip.width / 2 + 120, resizeGrip.y + resizeGrip.height / 2 + 100, { steps: 24 })
  await widget.mouse.up()
  await widget.waitForFunction(() => innerWidth === 540 && innerHeight === 440)
  const layout = await widget.evaluate(() => {
    const shell = document.querySelector('.widget-shell')?.getBoundingClientRect()
    const root = document.querySelector('#root')?.getBoundingClientRect()
    const content = document.querySelector('.widget-content')?.getBoundingClientRect()
    const titleElement = document.querySelector('.widget-head h2')
    const controlElement = document.querySelector('.widget-controls button')
    const title = titleElement?.getBoundingClientRect()
    const control = controlElement?.getBoundingClientRect()
    const head = document.querySelector('.widget-head')
    return {
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      shellHeight: shell?.height,
      rootHeight: root?.height,
      contentWidth: content?.width,
      contentHeight: content?.height,
      titleFontSize: titleElement ? getComputedStyle(titleElement).fontSize : null,
      titleCenter: title ? title.y + title.height / 2 : null,
      controlCenter: control ? control.y + control.height / 2 : null,
      headerCursor: head ? getComputedStyle(head).cursor : null,
      visibleDragIcons: document.querySelectorAll('.widget-drag-handle, .search-drag-handle').length
    }
  })
  assert.equal(layout.shellHeight, layout.viewportHeight)
  assert.equal(layout.rootHeight, layout.viewportHeight)
  assert.ok(layout.contentWidth > 0 && layout.contentWidth < layout.viewportWidth)
  assert.ok(layout.contentHeight > 0)
  assert.ok(layout.contentWidth > compactContent.width)
  assert.ok(layout.contentHeight > compactContent.height)
  assert.equal(await widget.locator('.widget-foot').count(), 0)
  assert.equal(await widget.getByText('打开工作台', { exact: true }).count(), 0)
  assert.equal(layout.titleFontSize, '15px')
  assert.equal(layout.titleCenter, layout.controlCenter)
  assert.equal(layout.headerCursor, 'move')
  assert.equal(layout.visibleDragIcons, 0)

  const collapseButton = widget.locator('.widget-collapse-toggle')
  await collapseButton.click()
  await widget.waitForFunction(() => innerHeight === 34)
  assert.equal(await widget.locator('.widget-head h2').textContent(), '今天的任务')
  await widget.mouse.move(20, 20)
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(await widget.evaluate(() => innerHeight), 34)
  await widget.waitForFunction(() => document.querySelector('.widget-collapse-toggle')?.getAttribute('title') === '展开')
  assert.equal(await collapseButton.getAttribute('title'), '展开')
  await collapseButton.click()
  await widget.waitForFunction(() => innerHeight === 440)

  const getWidgetBounds = () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(item => item.webContents.getURL().includes('widget=todo'))?.getBounds())
  const before = await getWidgetBounds()
  const moveHandle = await widget.locator('[data-widget-drag-handle]').boundingBox()
  assert.ok(before && moveHandle)
  await widget.mouse.move(moveHandle.x + moveHandle.width / 2, moveHandle.y + moveHandle.height / 2)
  await widget.mouse.down()
  await widget.mouse.move(moveHandle.x + moveHandle.width / 2 + 90, moveHandle.y + moveHandle.height / 2 + 60, { steps: 10 })
  await widget.mouse.up()
  await new Promise(resolve => setTimeout(resolve, 1400))
  const after = await getWidgetBounds()
  assert.ok(after && (after.x !== before.x || after.y !== before.y))

  const content = await widget.locator('.widget-todos').boundingBox()
  assert.ok(content)
  await widget.mouse.move(content.x + content.width / 2, content.y + Math.min(content.height / 2, 80))
  await widget.mouse.down()
  await widget.mouse.move(content.x + content.width / 2 + 90, content.y + Math.min(content.height / 2, 80) + 60, { steps: 10 })
  await widget.mouse.up()
  await new Promise(resolve => setTimeout(resolve, 300))
  const afterContentDrag = await getWidgetBounds()
  assert.deepEqual(afterContentDrag, after)

  const placement = await widget.evaluate(() => window.dustdesk.loadWorkspace().then(state => state.Settings.WidgetPlacements.todo))
  assert.equal(placement?.X, after.x)
  assert.equal(placement?.Y, after.y)
  assert.equal(placement?.Width, 540)
  assert.equal(placement?.Height, 440)

  // A canceled gesture has no reliable final coordinates. It must commit the last
  // preview instead of resizing/moving to a native or synthesized cancel position.
  for (const type of ['pointercancel', 'lostpointercapture']) {
    await widget.evaluate(() => document.addEventListener('pointerdown', event => { window.widgetPointerId = event.pointerId }, { once: true, capture: true }))
    const grip = await widget.locator('.widget-resize-grip').boundingBox()
    await widget.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2)
    await widget.mouse.down()
    await widget.mouse.move(grip.x + grip.width / 2 + 20, grip.y + grip.height / 2 + 15, { steps: 3 })
    await widget.waitForFunction(() => innerWidth === 560 && innerHeight === 455)
    await widget.locator('.widget-resize-grip').dispatchEvent(type, { pointerId: await widget.evaluate(() => window.widgetPointerId), screenX: 99999, screenY: 99999, bubbles: true })
    await widget.mouse.up()
    await widget.waitForFunction(async () => { const placement = (await window.dustdesk.loadWorkspace()).Settings.WidgetPlacements.todo; return placement.Width === 560 && placement.Height === 455 })
    assert.deepEqual(await widget.evaluate(() => [innerWidth, innerHeight]), [560, 455])
    await widget.evaluate(() => window.dustdesk.resizeWidget('todo', 540, 440, true))
    await widget.waitForFunction(() => innerWidth === 540 && innerHeight === 440)
  }
  await widget.evaluate(() => document.addEventListener('pointerdown', event => { window.widgetPointerId = event.pointerId }, { once: true, capture: true }))
  const handle = await widget.locator('[data-widget-drag-handle]').boundingBox()
  await widget.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2)
  await widget.mouse.down()
  await widget.mouse.move(handle.x + handle.width / 2 + 10, handle.y + handle.height / 2 + 10, { steps: 3 })
  await widget.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
  const lastDragBounds = await getWidgetBounds()
  await widget.locator('.widget-head').dispatchEvent('lostpointercapture', { pointerId: await widget.evaluate(() => window.widgetPointerId), screenX: 99999, screenY: 99999, bubbles: true })
  await widget.mouse.up()
  await widget.waitForFunction(async ({ x, y }) => { const placement = (await window.dustdesk.loadWorkspace()).Settings.WidgetPlacements.todo; return placement.X === x && placement.Y === y }, lastDragBounds)
  assert.deepEqual(await getWidgetBounds(), lastDragBounds)
  console.log('Canceled resize and move gestures retain their last valid bounds')

  const searchWindowPromise = app.electronApp.waitForEvent('window', { timeout: 10000 })
  await app.window.getByRole('button', { name: '显示搜索小组件' }).click()
  const searchWidget = await searchWindowPromise
  const searchInput = searchWidget.getByPlaceholder('搜索桌面文件')
  await searchInput.fill('dustdesk-no-such-file-result')
  await new Promise(resolve => setTimeout(resolve, 700))
  await searchWidget.waitForFunction(() => innerHeight === 52)
  assert.equal(await searchWidget.locator('.widget-search-results').count(), 0)
  console.log('Widget move, resize, and persistence passed')
} finally {
  await closeDustDesk(app)
}
