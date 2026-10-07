import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mainFixture } from './main-headless-harness.mjs'

test('widgets snap during dragging, on enable, and persist the final edge across displays', { timeout: 15_000 }, async t => {
  const f = await mainFixture(t, { widgetWindows: true })
  const primary = { workArea: { x: 0, y: 0, width: 1536, height: 824 }, scaleFactor: 1.25 }
  const secondary = { workArea: { x: -1280, y: -100, width: 1280, height: 680 }, scaleFactor: 2 }
  f.electron.screen.getAllDisplays = () => [primary, secondary]
  f.electron.screen.getDisplayNearestPoint = point => point.x < 0 ? secondary : primary
  await f.invoke('widgets:toggle', 'todo')
  const win = f.windows.find(w => w.options)
  await f.invoke('widgets:options', 'todo', { snapToEdges: false })
  await f.invoke('widgets:move', 'todo', 12, 130, true)
  assert.equal(win.bounds.x, 12)
  await f.invoke('widgets:options', 'todo', { snapToEdges: true })
  assert.equal(win.bounds.x, 0, 'Enabling beside an edge should snap immediately')
  assert.equal((await f.load()).Settings.WidgetPlacements.todo.X, 0)

  let writes = 0
  const writeFile = f.fileSystem.writeFile
  f.fileSystem.writeFile = async (...args) => { writes++; return writeFile(...args) }
  await f.invoke('widgets:move', 'todo', 100, 150)
  assert.equal(win.bounds.x, 100, 'Dragging away must release the edge')
  await f.invoke('widgets:move', 'todo', 1536 - win.bounds.width - 20, 150)
  assert.equal(win.bounds.x + win.bounds.width, 1536, 'Right edge snaps during preview')
  await new Promise(resolve => setTimeout(resolve, 180))
  assert.equal(writes, 0, 'Drag previews must not write state, even after the native move debounce')
  await f.invoke('widgets:move', 'todo', 1536 - win.bounds.width - 20, 150, true)
  let placement = (await f.load()).Settings.WidgetPlacements.todo
  assert.equal(placement.X, win.bounds.x)
  assert.equal(placement.DockEdge, 'Right')
  assert.equal(placement.Y, 150)

  for (const [x, y, expectedX, expectedY, edge] of [
    [150, 10, 150, 0, 'Top'],
    [150, 824 - win.bounds.height - 10, 150, 824 - win.bounds.height, 'Bottom'],
    [-1268, -88, -1280, -100, 'Left'],
    [-win.bounds.width - 10, 580 - win.bounds.height - 10, -win.bounds.width, 580 - win.bounds.height, 'Right']
  ]) {
    await f.invoke('widgets:move', 'todo', x, y, true)
    assert.equal(win.bounds.x, expectedX)
    assert.equal(win.bounds.y, expectedY)
    placement = (await f.load()).Settings.WidgetPlacements.todo
    assert.equal(placement.DockEdge, edge)
    assert.equal(placement.X, expectedX); assert.equal(placement.Y, expectedY)
  }
  await f.invoke('widgets:move', 'todo', 100, 100, true)
  assert.equal((await f.load()).Settings.WidgetPlacements.todo.DockEdge, 'None')
  await f.invoke('widgets:options', 'todo', { snapToEdges: false })
  await f.invoke('widgets:move', 'todo', 10, 10, true)
  assert.equal(win.bounds.x, 10); assert.equal(win.bounds.y, 10)
  await f.invoke('widgets:options', 'todo', { locked: true, snapToEdges: true })
  assert.equal((await f.invoke('widgets:move', 'todo', 100, 100, true)).ok, false)
})

test('legacy launcher snapping works until explicitly disabled by its own switch', { timeout: 15_000 }, async t => {
  const f = await mainFixture(t, { widgetWindows: true })
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  f.electron.screen.getAllDisplays = () => [display]
  f.electron.screen.getDisplayNearestPoint = () => display
  const state = await f.load()
  await f.invoke('workspace:save', { ...state, Settings: { ...state.Settings, LauncherWidgetSnapToEdges: true } }, state)
  await f.invoke('widgets:toggle', 'launcher')
  const win = f.windows.find(w => w.options)
  await f.invoke('widgets:move', 'launcher', 10, 140, true)
  assert.equal(win.bounds.x, 0)
  await f.invoke('widgets:options', 'launcher', { snapToEdges: false })
  await f.invoke('widgets:move', 'launcher', 10, 140, true)
  assert.equal(win.bounds.x, 10)
  // Native movement uses the same setting and saves the snapped position.
  await f.invoke('widgets:options', 'launcher', { snapToEdges: true })
  await new Promise(resolve => setTimeout(resolve, 280))
  const broadcast = new Promise(resolve => {
    win.webContents.send = channel => { if (channel === 'workspace:changed') resolve() }
  })
  win.setPosition(12, 150)
  await broadcast
  assert.equal(win.bounds.x, 0)
  assert.equal((await f.load()).Settings.WidgetPlacements.launcher.X, 0)
})
