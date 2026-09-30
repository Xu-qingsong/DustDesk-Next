import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')
const paths = moduleUrl(await readFile(new URL('../src/main/fileOperations.ts', import.meta.url), 'utf8'))
const { createNoteBackgroundManager } = await import(moduleUrl((await readFile(new URL('../src/main/noteBackgrounds.ts', import.meta.url), 'utf8')).replace("'./fileOperations'", JSON.stringify(paths))))

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-backgrounds-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'); await mkdir(data)
  const external = path.join(root, 'source.png'); await writeFile(external, 'fixture image bytes')
  let state = { Notes: [{ Id: 'note', Title: 'Original', Text: 'keep me', BackgroundImagePath: null, BackgroundImageFileName: '' }], RecycleBin: [] }
  let fail = false; let queue = Promise.resolve()
  const manager = createNoteBackgroundManager({
    read: async () => structuredClone(state), directory: () => data, broadcast: () => {},
    write: async next => { if (fail) throw Error('SIMULATED_DISK_FAILURE'); state = structuredClone(next); return '' },
    enqueue: operation => { const pending = queue.then(operation, operation); queue = pending.catch(() => {}); return pending }
  })
  return { root, data, external, manager, read: () => state, fail: value => { fail = value } }
}

test('background import copies external files into managed storage without modifying the source', async t => {
  const f = await fixture(t)
  const result = await f.manager.importBackground('note', f.external, null)
  assert.equal(path.dirname(result.path), path.join(f.data, 'NoteBackgrounds'))
  assert.equal(f.read().Notes[0].BackgroundImagePath, result.path)
  assert.equal(await readFile(f.external, 'utf8'), 'fixture image bytes')
  assert.equal(await readFile(result.path, 'utf8'), 'fixture image bytes')
  assert.equal(f.read().Notes[0].Text, 'keep me')
})

test('failed metadata writes preserve the old background and roll back a newly imported file', async t => {
  const f = await fixture(t)
  const first = await f.manager.importBackground('note', f.external)
  f.fail(true)
  await assert.rejects(f.manager.clearBackground('note', first.path), /SIMULATED_DISK_FAILURE/)
  assert.equal(f.read().Notes[0].BackgroundImagePath, first.path)
  await access(first.path)
  await assert.rejects(f.manager.importBackground('note', f.external, first.path), /SIMULATED_DISK_FAILURE/)
  assert.deepEqual(await readdir(path.dirname(first.path)), [path.basename(first.path)])
  f.fail(false)
  await f.manager.clearBackground('note', first.path)
  assert.equal(f.read().Notes[0].BackgroundImagePath, null)
  await assert.rejects(access(first.path), { code: 'ENOENT' })
})

test('clearing one note cannot remove images still referenced by a live or recycled note', async t => {
  const f = await fixture(t)
  const first = await f.manager.importBackground('note', f.external)
  f.read().Notes.push({ ...f.read().Notes[0], Id: 'shared' })
  await f.manager.clearBackground('note', first.path); await access(first.path)
  f.read().RecycleBin.push({ kind: 'note', value: { ...f.read().Notes[1], Id: 'recycled' } })
  await f.manager.clearBackground('shared', first.path); await access(first.path)
})

test('stale background operations fail safely and clearing legacy external references never deletes external files', async t => {
  const f = await fixture(t)
  const first = await f.manager.importBackground('note', f.external)
  await assert.rejects(f.manager.clearBackground('note', null), /其他窗口/)
  await assert.rejects(f.manager.importBackground('note', f.external, null), /其他窗口/)
  assert.equal(f.read().Notes[0].BackgroundImagePath, first.path)
  f.read().Notes[0].BackgroundImagePath = f.external
  await f.manager.clearBackground('note', f.external)
  await access(f.external)
})

test('background import rejects managed-directory junction escapes', async t => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside'); await mkdir(outside)
  await symlink(outside, path.join(f.data, 'NoteBackgrounds'), process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(f.manager.importBackground('note', f.external))
  assert.deepEqual(await readdir(outside), [])
  assert.equal(f.read().Notes[0].BackgroundImagePath, null)
})
