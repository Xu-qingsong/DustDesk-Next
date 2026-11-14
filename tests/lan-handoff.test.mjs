import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { toolboxModules } from './toolbox-fixture.mjs'

test('old LAN startup refuses every native publication marker before loading tasks or generating identity, and disposal preserves the original state', async t => {
  const { lan, root } = await toolboxModules(t)
  for (const [index, marker] of [null, false, { index: 0, legacy_link: true }].entries()) {
    const storage = path.join(root, 'pending-' + index); await fs.mkdir(storage)
    const task = { manifest: { id: 'pending', name: 'pending', entries: [], directories: [] }, view: { id: 'pending', direction: 'receive', status: 'completed', speed: 0 }, rustPublicationV1: marker }
    const bytes = JSON.stringify({ enabled: true, trusted: ['a'.repeat(64)], tasks: [{ ...task, rustPublicationV1: undefined }, task], keepUnknown: true })
    await fs.writeFile(path.join(storage, 'state.json'), bytes)
    const service = lan.createLanService({ storage, downloads: path.join(root, 'downloads'), name: 'blocked', host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => { throw Error('must not prompt') }, confirmReceive: async () => { throw Error('must not prompt') } })
    try {
      await assert.rejects(service.restore(), /原生文件发布记录/)
      await assert.rejects(service.enable(true), /原生文件发布记录/)
      assert.equal(service.snapshot().enabled, false); assert.equal(service.snapshot().port, 0); assert.deepEqual(service.snapshot().tasks, [])
    } finally { await service.dispose() }
    assert.equal(await fs.readFile(path.join(storage, 'state.json'), 'utf8'), bytes)
    assert.deepEqual(await fs.readdir(storage), ['state.json'])
  }
})

test('disposing a failed old LAN state load cannot replace malformed task data with an empty service snapshot', async t => {
  const { lan, root } = await toolboxModules(t)
  for (const [index, bytes] of ['{unfinished', 'null', '[]', JSON.stringify({ enabled: true, tasks: [{ manifest: { id: '../invalid' } }], privateFuture: true })].entries()) {
    const storage = path.join(root, 'invalid-' + index); await fs.mkdir(storage); await fs.writeFile(path.join(storage, 'state.json'), bytes)
    const service = lan.createLanService({ storage, downloads: path.join(root, 'downloads'), name: 'invalid', host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => false, confirmReceive: async () => false })
    try { await assert.rejects(service.restore(), /续传状态无法读取/) } finally { await service.dispose() }
    assert.equal(await fs.readFile(path.join(storage, 'state.json'), 'utf8'), bytes)
    assert.deepEqual(await fs.readdir(storage), ['state.json'])
  }
})
