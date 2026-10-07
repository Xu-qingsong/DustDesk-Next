import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

async function loader(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-icon-queue-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'loader.mjs')
  const source = await fs.readFile('src/shared/iconLoader.ts', 'utf8')
  await fs.writeFile(file, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
  return (await import(pathToFileURL(file).href)).createIconLoader
}
const turn = () => new Promise(resolve => setImmediate(resolve))

test('large icon grids yield to the event loop, bound concurrency and share repeated paths', async t => {
  const create = await loader(t)
  let active = 0; let maximum = 0; let calls = 0
  const pending = []
  const icons = create(file => new Promise(resolve => {
    calls++; maximum = Math.max(maximum, ++active)
    pending.push(() => { active--; resolve({ dataUrl: file }) })
  }), { concurrency: 3 })
  const reads = Array.from({ length: 90 }, (_, i) => icons.read(`D:\\app${i % 30}.exe`))
  assert.equal(calls, 0, 'Rendering must finish before extraction begins')
  await turn()
  assert.equal(calls, 3)
  while (calls < 30 || pending.length) { pending.splice(0).forEach(release => release()); await turn() }
  const values = await Promise.all(reads)
  assert.equal(maximum, 3)
  assert.equal(calls, 30)
  assert.equal(values[0].dataUrl, values[30].dataUrl)
  assert.equal((await icons.read('d:/APP0.exe')).dataUrl, values[0].dataUrl)
  assert.equal(calls, 30)
})

test('cancelled offscreen tiles never start queued work; another tile can share the same icon', async t => {
  const create = await loader(t)
  const calls = []
  let release
  const icons = create(file => {
    calls.push(file)
    return file === 'first' ? new Promise(resolve => { release = resolve }) : Promise.resolve({ dataUrl: file })
  }, { concurrency: 1 })
  const first = icons.read('first')
  await turn()
  const removed = new AbortController()
  const cancelled = icons.read('removed', removed.signal)
  const rejection = assert.rejects(cancelled, { name: 'AbortError' })
  removed.abort()
  const shared = new AbortController()
  const aborted = icons.read('shared', shared.signal)
  const sharedRejection = assert.rejects(aborted, { name: 'AbortError' })
  const survivor = icons.read('shared')
  shared.abort()
  release({ dataUrl: 'first' })
  await Promise.all([first, rejection, sharedRejection])
  assert.equal((await survivor).dataUrl, 'shared')
  assert.deepEqual(calls, ['first', 'shared'])
})

test('hung and throwing providers release queue slots and retain a fallback', async t => {
  const create = await loader(t)
  const icons = create(async file => {
    if (file === 'hung') return new Promise(() => {})
    if (file === 'broken') throw Error('Access denied')
    if (file === 'malformed') return null
    return { dataUrl: 'ok' }
  }, { concurrency: 1, timeoutMs: 25 })
  assert.deepEqual(await Promise.all(['hung', 'broken', 'malformed', 'working'].map(file => icons.read(file))), [{}, {}, {}, { dataUrl: 'ok' }])
})

test('failure caches expire so transient errors recover, and success caches are bounded', async t => {
  const create = await loader(t)
  let healthy = false; let calls = 0
  const icons = create(async file => { calls++; return healthy ? { dataUrl: file } : { isDirectory: true } }, { failureTtlMs: 10, capacity: 2 })
  assert.deepEqual(await icons.read('folder'), { isDirectory: true })
  healthy = true
  assert.deepEqual(await icons.read('folder'), { isDirectory: true })
  assert.equal(calls, 1)
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.equal((await icons.read('folder')).dataUrl, 'folder')
  await icons.read('two'); await icons.read('three'); await icons.read('folder')
  assert.equal(calls, 5, 'Old icons are evicted rather than growing memory without limit')
  icons.invalidate('folder')
  await icons.read('folder')
  assert.equal(calls, 6)
})
