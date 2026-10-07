import assert from 'node:assert/strict'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  const opened = app.electronApp.waitForEvent('window')
  await app.window.evaluate(() => window.dustdesk.toggleWidgets('todo'))
  const widget = await opened
  await widget.locator('.widget-head').waitFor()
  const display = await app.electronApp.evaluate(({ screen }) => screen.getPrimaryDisplay())
  const area = display.workArea
  const bounds = () => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('widget=todo')).getBounds())
  let current = await bounds()
  await widget.evaluate(({ x, y }) => window.dustdesk.moveWidget('todo', x, y, true), { x: area.x + 12, y: area.y + 100 })
  const magnet = widget.getByRole('button', { name: '吸附屏幕边缘', exact: true })
  await magnet.click()
  await widget.waitForFunction(() => document.querySelector('button[title="吸附屏幕边缘"]').getAttribute('aria-pressed') === 'true')
  assert.equal((await bounds()).x, area.x)
  const checks = [
    [area.x + 12, area.y + 100, area.x, area.y + 100],
    [area.x + area.width - current.width - 12, area.y + 100, area.x + area.width - current.width, area.y + 100],
    [area.x + 100, area.y + 12, area.x + 100, area.y],
    [area.x + 100, area.y + area.height - current.height - 12, area.x + 100, area.y + area.height - current.height]
  ]
  for (const [x, y, expectedX, expectedY] of checks) {
    const position = { x, y }
    await widget.evaluate(({ x, y }) => window.dustdesk.moveWidget('todo', x, y), position)
    current = await bounds()
    assert.equal(current.x, expectedX); assert.equal(current.y, expectedY)
    await widget.evaluate(({ x, y }) => window.dustdesk.moveWidget('todo', x, y, true), position)
    const placement = await widget.evaluate(() => window.dustdesk.loadWorkspace().then(state => state.Settings.WidgetPlacements.todo))
    assert.equal(placement.X, expectedX); assert.equal(placement.Y, expectedY)
  }
  await widget.evaluate(({ x, y }) => window.dustdesk.moveWidget('todo', x, y, true), { x: area.x + 100, y: area.y + 100 })
  assert.equal((await bounds()).x, area.x + 100)
  await magnet.click()
  await widget.waitForFunction(() => document.querySelector('button[title="吸附屏幕边缘"]').getAttribute('aria-pressed') === 'false')
  await widget.evaluate(({ x, y }) => window.dustdesk.moveWidget('todo', x, y, true), { x: area.x + 12, y: area.y + 100 })
  assert.equal((await bounds()).x, area.x + 12)
  console.log(JSON.stringify({ nativeWidgetSnapping: 'passed', displayScale: display.scaleFactor, workArea: area, edgesChecked: 4 }))
} finally {
  await closeDustDesk(app)
}
