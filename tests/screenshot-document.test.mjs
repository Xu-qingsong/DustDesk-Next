import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

async function modules(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-screenshot-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  for (const [name, file] of [['model', 'src/shared/screenshotDocument.ts'], ['sessions', 'src/main/screenshotSessions.ts']]) {
    const source = ts.transpileModule(await fs.readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('../shared/screenshotDocument', './model.mjs')
    await fs.writeFile(path.join(root, name + '.mjs'), source)
  }
  return { model: await import(pathToFileURL(path.join(root, 'model.mjs'))), sessions: await import(pathToFileURL(path.join(root, 'sessions.mjs'))) }
}

test('object history restores edits, delete order, crop and sequence without bitmap snapshots', async t => {
  const { model: m } = await modules(t)
  const initial = m.newScreenshotDocument('doc', 'source', 400, 200)
  const annotations = ['a', 'b', 'c'].map((id, i) => ({ id, kind: 'rectangle', points: [{ x: 10 + i * 50, y: 20 }, { x: 40 + i * 50, y: 50 }], style: { ...m.defaultAnnotationStyle } }))
  const before = { ...initial, annotations }
  const after = { ...before, annotations: [annotations[1]], crop: { x: 10, y: 10, width: 100, height: 80 }, nextNumber: 4 }
  const edit = m.documentEdit(before, after)
  const undo = m.applyDocumentEdit(after, edit, true)
  assert.deepEqual(undo.annotations, annotations)
  assert.deepEqual(undo.crop, before.crop)
  assert.equal(undo.nextNumber, 1)
  assert.deepEqual(m.applyDocumentEdit(undo, edit, false).annotations, after.annotations)
  const moved = m.transformAnnotation(annotations[0], m.annotationBounds(annotations[0]), { x: 100, y: 100, width: 60, height: 60 })
  assert.deepEqual(moved.points, [{ x: 100, y: 100 }, { x: 160, y: 160 }])
  assert.ok(m.hitAnnotation(moved, { x: 100, y: 130 }, 3))
  assert.equal(m.hitAnnotation(moved, { x: 130, y: 130 }, 3), false)
  assert.equal(JSON.stringify(edit).includes('data:image'), false)
})

test('geometry keeps native pixel crops and Shift constraints valid at all display scales', async t => {
  const { model: m } = await modules(t)
  for (const dpi of [1, 1.25, 1.5, 2]) {
    const native = { x: 120, y: 80, width: 400, height: 240 }
    const css = { x: native.x / dpi, y: native.y / dpi, width: native.width / dpi, height: native.height / dpi }
    assert.deepEqual(m.clampRect({ x: css.x * dpi, y: css.y * dpi, width: css.width * dpi, height: css.height * dpi }, 3840, 2160), native)
  }
  assert.deepEqual(m.constrainedPoint({ x: 0, y: 0 }, { x: 30, y: 12 }, 'rectangle', true), { x: 30, y: 30 })
  assert.ok(Math.abs(m.constrainedPoint({ x: 0, y: 0 }, { x: 30, y: 12 }, 'arrow', true).y) < .001)
  assert.deepEqual(m.clampRect({ x: -5, y: 199, width: 999, height: 4 }, 400, 200), { x: 0, y: 199, width: 400, height: 1 })
  const doc = m.newScreenshotDocument('a', 'b', 400, 200)
  assert.equal(m.validScreenshotDocument(doc), true)
  assert.equal(m.validScreenshotDocument({ ...doc, crop: { x: 0, y: 0, width: 401, height: 200 } }), false)
})

test('session creation and cancellation never export raw captures; output retries and deduplicates', async t => {
  const { sessions } = await modules(t)
  let effects = 0, fail = true, release
  const manager = sessions.createScreenshotSessions({ decode: bytes => { if (!bytes.length || bytes[0] === 255) throw Error('broken'); return { png: bytes, width: 40, height: 20 } }, output: async () => { effects++; if (fail) throw Error('disk full'); await new Promise(resolve => { release = resolve }); return { ok: true } } })
  const payload = manager.create(new Uint8Array([1]))
  assert.equal(effects, 0)
  manager.remove(payload.document.id)
  assert.throws(() => manager.read(payload.document.id))
  const next = manager.create(new Uint8Array([2]))
  const request = { requestId: 'same', document: next.document, action: 'copy', png: new Uint8Array([3]) }
  assert.equal((await manager.finish(request)).ok, false)
  fail = false
  const first = manager.finish(request), duplicate = manager.finish(request)
  await new Promise(resolve => setImmediate(resolve)); release()
  assert.equal((await first).ok, true)
  assert.deepEqual(await duplicate, await first)
  assert.equal(effects, 2)
  await manager.finish(request)
  assert.equal(effects, 2)
  assert.equal((await manager.finish({ ...request, requestId: 'bad', png: new Uint8Array([255]) })).ok, false)
  // Synchronous decode failures must not remain cached and block retry.
  const retry = manager.finish({ ...request, requestId: 'bad' })
  await new Promise(resolve => setImmediate(resolve)); release(); assert.equal((await retry).ok, true)
  assert.equal((await manager.finish({ ...request, requestId: 'oversize', document: { ...next.document, crop: { x: 0, y: 0, width: 20, height: 20 } } })).ok, false)
})

test('re-editing a pin forks its objects and cancellation leaves the original unchanged', async t => {
  const { sessions } = await modules(t)
  const manager = sessions.createScreenshotSessions({ decode: png => ({ png, width: 40, height: 20 }), output: async () => ({ ok: true }) })
  const original = manager.create(new Uint8Array([1]))
  manager.retainPin('pin', original.document.id)
  const fork = manager.editPin('pin')
  assert.notEqual(fork.document.id, original.document.id)
  assert.equal(fork.document.targetPinId, 'pin')
  fork.document.crop.width = 10
  manager.remove(fork.document.id)
  assert.equal(manager.read(original.document.id).document.crop.width, 40)
  manager.remove(original.document.id)
  assert.ok(manager.read(original.document.id))
  manager.releasePin('pin'); manager.remove(original.document.id)
  assert.throws(() => manager.read(original.document.id))
})


test('region assets use screen coordinates live and local coordinates in editors and pins', async t => {
  const { sessions, model } = await modules(t)
  const store = sessions.createScreenshotSessions({ decode: bytes => ({ png: bytes, width: 300, height: 200 }), output: async () => ({ ok: true }) })
  const region = store.create(new Uint8Array([1]), { width: 1920, height: 1080, rect: { x: 120, y: 80, width: 300, height: 200 } })
  region.document.annotations.push({ id: 'arrow', kind: 'arrow', points: [{ x: 150, y: 110 }, { x: 210, y: 150 }], style: { ...model.defaultAnnotationStyle } })
  region.document.crop = { x: 130, y: 90, width: 280, height: 180 }
  const pin = store.snapshot(region.document)
  assert.equal(pin.sourceRect, undefined)
  assert.equal(pin.width, 300); assert.equal(pin.height, 200)
  assert.deepEqual(pin.crop, { x: 10, y: 10, width: 280, height: 180 })
  assert.deepEqual(pin.annotations[0].points, [{ x: 30, y: 30 }, { x: 90, y: 70 }])
  assert.deepEqual(store.read(pin.id).png, region.png)
  assert.equal(model.validScreenshotDocument({ ...region.document, sourceRect: { x: 1900, y: 0, width: 300, height: 200 } }), false)
})
