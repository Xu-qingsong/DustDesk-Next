import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mainFixture } from './main-headless-harness.mjs'

async function setup(t) {
  const f = await mainFixture(t, { widgetWindows: true })
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  f.electron.screen.getAllDisplays = () => [display]
  f.electron.screen.getDisplayNearestPoint = () => display
  const state = await f.load()
  const projectId = crypto.randomUUID()
  await f.invoke('workspace:save', { ...state, Projects: [{ Id: projectId, Name: 'Pinned project', ProjectPath: '', Phases: [] }] }, state)
  return { f, keys: [`project:${projectId}`, `note:${state.Notes[0].Id}`, `organizer-group:${state.DesktopCategories[0].Id}`] }
}

test('project, note and group visibility share explicit controls, workspace state and saved layouts', async t => {
  const { f, keys } = await setup(t)
  for (const key of keys) {
    assert.equal((await f.invoke('widgets:visibility:set', key, true)).visible, true)
    assert.equal((await f.invoke('widgets:visibility:set', key, true)).visible, true, 'Show is idempotent')
    assert.equal((await f.invoke('widgets:visibility', keys))[key], true)
    await f.invoke('widgets:move', key, 125, 175, true)
    await f.invoke('widgets:options', key, { topMost: true })
    await f.invoke('widgets:hide', key)
    assert.equal((await f.load()).Settings.WidgetPlacements[key].Visible, false)
    assert.equal((await f.invoke('widgets:visibility', keys))[key], false)
    const placement = (await f.load()).Settings.WidgetPlacements[key]
    assert.equal(placement.X, 125); assert.equal(placement.Y, 175); assert.equal(placement.TopMost, true)
    await f.invoke('widgets:visibility:set', key, true)
  }
  assert.equal(f.windows.filter(window => window.options).length, keys.length, 'All entrances reuse the same native windows')
  await f.invoke('widgets:presets:save', 'pins')
  await Promise.all(keys.map(key => f.invoke('widgets:visibility:set', key, false)))
  await f.invoke('widgets:presets:apply', 'pins')
  assert.ok(Object.values(await f.invoke('widgets:visibility', keys)).every(Boolean))
  const state = await f.load()
  await f.invoke('workspace:save', { ...state, Notes: [], Projects: [], DesktopCategories: [] }, state)
  assert.ok(Object.values(await f.invoke('widgets:visibility', keys)).every(visible => !visible), 'Deleting the source hides dependent widgets')
  for (const key of keys) assert.equal((await f.invoke('widgets:visibility:set', key, true)).ok, false)
})

test('failed visibility saves preserve native visibility and existing placement', async t => {
  const { f, keys: [key] } = await setup(t)
  const write = f.fileSystem.writeFile
  f.fileSystem.writeFile = async () => { throw Error('Disk is full') }
  assert.equal((await f.invoke('widgets:visibility:set', key, true)).ok, false)
  assert.equal(f.windows.filter(window => window.options).length, 0, 'Failed pin does not create a window')
  f.fileSystem.writeFile = write
  await f.invoke('widgets:visibility:set', key, true)
  f.fileSystem.writeFile = async () => { throw Error('Disk is full') }
  assert.deepEqual(await f.invoke('widgets:visibility:set', key, false), { ok: false, visible: true, error: 'Disk is full' })
  assert.equal((await f.invoke('widgets:visibility', [key]))[key], true)
  f.fileSystem.writeFile = write
  assert.equal((await f.load()).Settings.WidgetPlacements[key].Visible, true)
})

test('native close updates every entrance and concurrent legacy toggles stay ordered', { timeout: 10_000 }, async t => {
  const { f, keys: [key] } = await setup(t)
  const results = await Promise.all([f.invoke('widgets:toggle', key), f.invoke('widgets:toggle', key)])
  assert.deepEqual(results, [{ visible: true }, { visible: false }])
  await f.invoke('widgets:visibility:set', key, true)
  let notify
  const closed = new Promise(resolve => { notify = resolve })
  f.client((channel, state) => { if (channel === 'workspace:changed' && state.Settings.WidgetPlacements[key].Visible === false) notify() })
  f.windows.find(window => window.options).close()
  await closed
  assert.equal((await f.load()).Settings.WidgetPlacements[key].Visible, false)
  assert.equal((await f.invoke('widgets:visibility', [key]))[key], false)
})
