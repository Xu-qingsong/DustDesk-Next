import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mainFixture } from './main-headless-harness.mjs'

test('real screenshot IPC defers output, owns sessions, retries saves and manages independent pins', async t => {
  const f = await mainFixture(t, { screenshotWindows: true })
  const invoke = f.client(() => {}, true)
  let clipboardImage = null
  // PNG geometry is the native boundary in this headless test. Renderer tests check real pixels.
  const image = bytes => ({ isEmpty: () => !bytes.length, getSize: () => ({ width: bytes[0] || 400, height: bytes[1] || 200 }), toPNG: () => Buffer.from(bytes), toDataURL: () => 'data:image/png;base64,' + Buffer.from(bytes).toString('base64'), toJPEG: () => Buffer.from(bytes) })
  f.electron.nativeImage.createFromBuffer = bytes => image(bytes)
  f.electron.clipboard.writeImage = value => { clipboardImage = value }
  f.electron.screen.getCursorScreenPoint = () => ({ x: 10, y: 20 })
  f.electron.screen.getDisplayNearestPoint = f.electron.screen.getDisplayMatching = () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { width: 1920, height: 1040 } })
  const state = await invoke('workspace:load')
  Object.assign(state.Settings, { ScreenshotAutoCopy: false, ScreenshotAutoAddToClipboardHistory: false })
  await invoke('workspace:save', state)
  const original = await invoke('screenshot:document:create', new Uint8Array([200, 100, 1]))
  assert.equal(original.ok, true); assert.equal(clipboardImage, null)
  const directory = path.join(f.data, 'Screenshots')
  assert.equal(await fs.stat(directory).catch(() => null), null)
  assert.equal((await f.invoke('screenshot:document:read', original.payload.document.id)).ok, false)
  const request = { requestId: 'save', document: original.payload.document, action: 'save', png: new Uint8Array([200, 100, 2]) }
  const write = f.fileSystem.writeFile
  f.fileSystem.writeFile = async (...args) => { if (String(args[0]).endsWith('.tmp') && String(args[0]).includes('DustDesk-edited')) throw Error('ENOSPC'); return write(...args) }
  assert.equal((await invoke('screenshot:finish', request)).ok, false)
  assert.deepEqual(await fs.readdir(directory), [])
  f.fileSystem.writeFile = write
  const [saved, duplicate] = await Promise.all([invoke('screenshot:finish', request), invoke('screenshot:finish', request)])
  assert.equal(saved.ok, true); assert.deepEqual(saved, duplicate); assert.equal((await fs.readdir(directory)).length, 1)
  assert.deepEqual([...await fs.readFile(saved.path)], [200, 100, 2])
  await invoke('screenshot:finish', { ...request, requestId: 'copy', action: 'copy' })
  assert.deepEqual([...clipboardImage.toPNG()], [200, 100, 2])
  const pin = await invoke('screenshot:finish', { ...request, requestId: 'pin', action: 'pin' })
  assert.equal(pin.ok, true); assert.equal((await fs.readdir(directory)).length, 1)
  const window = f.windows.find(w => w.options)
  original.payload.document.revision = 1
  original.payload.document.annotations = [{ id: 'later', kind: 'rectangle', points: [{ x: 1, y: 1 }, { x: 20, y: 20 }], style: { color: '#ff4d57', width: 4, fontSize: 24, filled: false, strength: 12, mode: 'rectangle' } }]
  await invoke('screenshot:finish', { ...request, requestId: 'later-editor-copy', action: 'copy' })
  const control = (action, value) => f.handlers.get('screenshot:pin:control')({ sender: window.webContents }, pin.pinId, action, value)
  assert.equal((await f.invoke('screenshot:pin:control', pin.pinId, 'close')).ok, false)
  await control('options', { opacity: 70, topmost: false, locked: true, mouseThrough: true })
  assert.equal(window.opacity, .7); assert.equal(window.mouseThrough, true)
  await control('move', { x: 10, y: 10 }); assert.equal(window.bounds.x, 0)
  await control('options', { locked: false }); await control('move', { x: -1000, y: 10 }); assert.equal(window.bounds.x, -1000)
  await control('resize', { width: 400, height: 200 }); assert.equal(window.bounds.width, 400)
  await control('edit')
  const overlay = f.windows.filter(w => w.options).at(-1)
  const edited = await f.handlers.get('screenshot:document:read')({ sender: overlay.webContents }, '')
  assert.equal(edited.payload.document.targetPinId, pin.pinId)
  assert.equal(edited.payload.document.annotations.length, 0, 'A later editor copy must not change the pinned document')
  const cancel = f.handlers.get('screenshot:overlay-cancel')
  await cancel({ sender: overlay.webContents })
  const readPin = () => f.handlers.get('screenshot:pin:read')({ sender: window.webContents }, pin.pinId)
  assert.deepEqual([...readPin().png], [200, 100, 2])
  await control('edit')
  const overlay2 = f.windows.filter(w => w.options).at(-1)
  const fork = await f.handlers.get('screenshot:document:read')({ sender: overlay2.webContents }, '')
  const updated = await f.handlers.get('screenshot:finish')({ sender: overlay2.webContents }, { requestId: 'update', document: fork.payload.document, action: 'updatePin', png: new Uint8Array([200, 100, 3]) })
  assert.equal(updated.ok, true); assert.deepEqual([...readPin().png], [200, 100, 3]); assert.equal(overlay2.destroyed, true)
  await control('close'); assert.equal(window.destroyed, true)
  assert.equal((await invoke('screenshot:document:read', original.payload.document.id)).ok, true, 'Closing or re-editing a pin must preserve its active application editor')
  const updatedState = await invoke('workspace:load'); updatedState.Settings.ScreenshotAutoCopy = true; await invoke('workspace:save', updatedState)
  f.electron.clipboard.writeImage = () => { throw Error('clipboard busy') }
  const partialRequest = { ...request, requestId: 'saved-with-warning' }
  const partial = await invoke('screenshot:finish', partialRequest)
  assert.equal(partial.ok, true); assert.ok(partial.warning.includes('自动复制失败'))
  assert.equal((await fs.readdir(directory)).length, 2)
  await invoke('screenshot:finish', partialRequest)
  assert.equal((await fs.readdir(directory)).length, 2, 'A clipboard failure after saving must not duplicate the file on retry')
})
