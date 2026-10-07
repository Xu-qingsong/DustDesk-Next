import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mainFixture } from './main-headless-harness.mjs'

const waitFor = async predicate => { for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)) } throw Error('Timed out waiting for region selection') }
test('region hotkey flow selects live desktop before native capture and reads only the confirmed rectangle', async t => {
  const f = await mainFixture(t, { screenshotWindows: true }), invoke = f.client(() => {}, true)
  const displays = [
    { id: 1, bounds: { x: -1280, y: 0, width: 1280, height: 800 }, size: { width: 1280, height: 800 }, scaleFactor: 1.25 },
    { id: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, size: { width: 1920, height: 1080 }, scaleFactor: 2 }
  ]
  Object.assign(f.electron.screen, {
    getAllDisplays: () => displays, getCursorScreenPoint: () => ({ x: 20, y: 20 }), getDisplayNearestPoint: () => displays[1],
    dipToScreenRect: (window, rect) => { const scale = window.options.x < 0 ? 1.25 : 2; return Object.fromEntries(Object.entries(rect).map(([key, value]) => [key, Math.round(value * scale)])) }
  })
  let expectedRect = { x: -1500, y: 100, width: 250, height: 125 }
  let calls = 0, fail = false, hold = false, pendingCallback
  f.childProcess.execFile = (_command, args, options, callback) => {
    calls++
    assert.ok(f.windows.filter(w => w.options && !w.destroyed).every(w => w.visible && w.contentProtected), 'All region overlays stay visible and are excluded from native capture')
    const script = Buffer.from(args.at(-1), 'base64').toString('utf16le'), match = /::Capture\((-?\d+), (-?\d+), (\d+), (\d+)\)/.exec(script)
    assert.ok(match); assert.deepEqual(match.slice(1).map(Number), Object.values(expectedRect))
    const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.writeUInt32BE(expectedRect.width, 16); png.writeUInt32BE(expectedRect.height, 20)
    if (hold) { pendingCallback = callback; options.signal.addEventListener('abort', () => callback(Error('cancelled'), '')); return }
    callback(fail ? Error('failed') : null, png.toString('base64'))
  }
  f.electron.nativeImage.createFromBuffer = bytes => ({ isEmpty: () => bytes.length < 24, getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }), toPNG: () => bytes, toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64') })
  f.electron.clipboard.writeImage = () => {}
  const state = await invoke('workspace:load'); Object.assign(state.Settings, { ScreenshotAfterAction: 'edit', ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false }); await invoke('workspace:save', state)
  const rect = { x: 80, y: 80, width: 200, height: 100 }
  const region = async () => {
    const completion = invoke('screenshot:start', 'Region')
    await waitFor(() => f.windows.filter(w => w.options && !w.destroyed).length === 2)
    const window = f.windows.find(w => w.options && !w.destroyed && w.options.x < 0)
    return { completion, window, event: { sender: window.webContents } }
  }
  const initial = await region()
  assert.equal(calls, 0); assert.equal(initial.window.options.transparent, true)
  assert.equal((await f.handlers.get('screenshot:document:read')(initial.event, '')).ok, false, 'There is no captured image in a fresh selection session')
  assert.equal((await f.handlers.get('screenshot:region-select')(initial.event, { ...rect, x: -1 })).ok, false); assert.equal(calls, 0)
  const selected = await f.handlers.get('screenshot:region-select')(initial.event, rect, 'edit', 'pen')
  assert.equal(selected.ok, true); assert.equal(calls, 1)
  assert.deepEqual(selected.payload.placement, { x: 0, y: 0, width: 1280, height: 800 }); assert.equal(selected.payload.document.width, 1600); assert.equal(selected.payload.document.height, 1000); assert.deepEqual(selected.payload.document.sourceRect, { x: 100, y: 100, width: 250, height: 125 }); assert.equal(selected.payload.initialTool, 'pen')
  assert.equal(await fs.stat(path.join(f.data, 'Screenshots')).catch(() => null), null)
  expectedRect = { x: -1450, y: 125, width: 400, height: 250 }
  const adjusted = await f.handlers.get('screenshot:region-select')(initial.event, { x: 120, y: 100, width: 320, height: 200 })
  assert.equal(adjusted.ok, true, 'An active editor must allow a second region capture beyond its first image')
  assert.equal(calls, 2)
  assert.deepEqual(adjusted.payload.document.crop, { x: 150, y: 125, width: 400, height: 250 })
  fail = true
  assert.equal((await f.handlers.get('screenshot:region-select')(initial.event, { x: 120, y: 100, width: 320, height: 200 })).ok, false)
  assert.equal((await f.handlers.get('screenshot:document:read')(initial.event, '')).payload.document.id, adjusted.payload.document.id, 'Failed recapture preserves the last usable asset')
  fail = false
  await f.handlers.get('screenshot:finish')(initial.event, { requestId: 'copy', document: adjusted.payload.document, png: adjusted.payload.png, action: 'copy' })
  expectedRect = { x: -1500, y: 100, width: 250, height: 125 }
  assert.equal((await initial.completion).ok, true)
  const retry = await region(); fail = true
  assert.equal((await f.handlers.get('screenshot:region-select')(retry.event, rect)).ok, false)
  assert.equal(retry.window.visible, true)
  fail = false
  assert.equal((await f.handlers.get('screenshot:region-select')(retry.event, rect)).ok, true)
  await f.handlers.get('screenshot:overlay-cancel')(retry.event); assert.equal((await retry.completion).message, 'region-capture-canceled')
  const cancel = await region(), previousCalls = calls
  await f.handlers.get('screenshot:overlay-cancel')(cancel.event); await cancel.completion
  assert.equal(calls, previousCalls, 'Esc before capture cannot read the desktop')
  const inFlight = await region(); hold = true
  const pending = f.handlers.get('screenshot:region-select')(inFlight.event, rect)
  await waitFor(() => pendingCallback)
  await f.handlers.get('screenshot:overlay-cancel')(inFlight.event)
  assert.equal((await pending).ok, false); await inFlight.completion
  assert.equal(await fs.stat(path.join(f.data, 'Screenshots')).catch(() => null), null)
})
