import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { readFile, mkdtemp, mkdir, writeFile, symlink, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'
import { draftModuleUrl } from './draft-module.mjs'

async function load(name) {
  const source = ts.transpileModule(await readFile(new URL('./reference/src/main/' + name + '.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll("'../shared/draftMigration'", JSON.stringify(draftModuleUrl)).replaceAll('"../shared/draftMigration"', JSON.stringify(draftModuleUrl))
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}
const { createDraftMaintenance } = await load('draftMaintenance')
const { writeDraftExport } = await load('draftExport')

test('native source loss before publication preserves an existing export and removes the temporary copy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-draft-source-guard-'))
  try {
    const target = path.join(root, 'drafts.json'); await writeFile(target, 'earlier export')
    let checks = 0
    await assert.rejects(writeDraftExport(target, 'new archive', [], async () => { checks++; throw Error('native source lease lost') }), /native source lease lost/)
    assert.equal(checks, 1); assert.equal(await readFile(target, 'utf8'), 'earlier export')
    assert.deepEqual(await readdir(root), ['drafts.json'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
const fingerprint = 'a'.repeat(64)
const entry = { key: 'widget-task-draft:v1:todo', value: JSON.stringify({ title: '未提交任务', requestId: 'stable-request' }) }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function fixture(timeout = 5000) {
  const ipc = new EventEmitter(); const session = {}; const messages = []
  const window = (id, url = 'file:///app/index.html', storage = session) => {
    const sender = Object.assign(new EventEmitter(), { id, session: storage, getURL: () => url, isDestroyed: () => false, send: (channel, request) => messages.push({ sender, channel, request }) })
    return { isDestroyed: () => false, webContents: sender }
  }
  const main = window(1); const widget = window(2, 'file:///app/index.html?widget=todo'); const service = createDraftMaintenance(ipc, timeout, 'file:///app/index.html')
  const ack = (target, request, error) => ipc.emit('drafts:flushed', { sender: target.webContents }, request, error)
  const receive = (target, request, entries = [entry]) => ipc.emit('drafts:collected', { sender: target.webContents }, request, entries)
  const request = () => messages.findLast(message => message.channel === 'drafts:flush')?.request
  return { ipc, service, main, widget, window, messages, ack, receive, request }
}
test('Electron checkpoint requires every actual sender and purpose-bound acknowledgement before sealing and owner-only collection', async () => {
  const harness = fixture(); let sealed = false
  const pending = harness.service.collect(harness.main, [harness.main, harness.widget], async ready => { ready(); sealed = true; return fingerprint })
  const request = harness.request(); assert.ok(request); assert.throws(harness.service.requireInteractive, /迁移维护/); harness.service.requireWritable()
  harness.ack(harness.window(1), request); harness.ack(harness.widget, 'old'); harness.ipc.emit('workspace:flushed', { sender: harness.main.webContents }, request)
  await delay(5); assert.equal(sealed, false)
  harness.ack(harness.main, request); harness.ack(harness.main, request); await delay(5); assert.equal(sealed, false)
  harness.ack(harness.widget, request); await delay(5); assert.equal(sealed, true); assert.throws(harness.service.requireWritable, /迁移维护/)
  harness.receive(harness.widget, request); harness.receive(harness.main, 'old'); await delay(5); assert.equal(harness.service.busy, true)
  harness.receive(harness.main, request); assert.deepEqual(await pending, { workspaceFingerprint: fingerprint, entries: [entry] })
  assert.equal(harness.service.busy, false); assert.equal(harness.messages.filter(message => message.channel === 'drafts:resume').length, 2)
  assert.equal(harness.ipc.listenerCount('drafts:flushed'), 0); assert.equal(harness.main.webContents.listenerCount('did-start-navigation'), 0)
})
test('failed final save, malformed collection and mixed storage sources fail without claiming a checkpoint', async () => {
  const harness = fixture(); let seals = 0
  const seal = async ready => { ++seals; ready(); return fingerprint }
  const first = harness.service.collect(harness.main, [harness.main], seal); harness.ack(harness.main, harness.request(), 'disk failure')
  await assert.rejects(first, /disk failure/); assert.equal(seals, 0); assert.equal(harness.service.busy, false)
  for (const entries of [[entry, entry], [{ key: 'access-token', value: 'secret' }], [{ key: 'widget-note:v9:id', value: '{}' }]]) {
    const pending = harness.service.collect(harness.main, [harness.main], seal); const request = harness.request(); harness.ack(harness.main, request); await delay(1); harness.receive(harness.main, request, entries); await assert.rejects(pending)
  }
  for (const foreign of [harness.window(3, 'file:///other/index.html'), harness.window(4, 'file:///app/index.html', {})]) await assert.rejects(harness.service.collect(harness.main, [harness.main, foreign], seal), /存储来源不一致/)
  const foreignOwner = harness.window(5, 'https://untrusted.example/index.html'); await assert.rejects(harness.service.collect(foreignOwner, [foreignOwner], seal), /不是应用入口/)
  for (const location of ['file://untrusted.example/app/index.html', 'data:/app/index.html']) {
    const owner = harness.window(6, location); await assert.rejects(harness.service.collect(owner, [owner], seal), /不是应用入口/)
    await assert.rejects(harness.service.collect(harness.main, [harness.main, owner], seal), /存储来源不一致/)
  }
  assert.equal(harness.service.busy, false)
})
test('real navigation and renderer loss cancel preparation while subframe or in-place navigation does not', async () => {
  for (const signal of ['destroyed', 'render-process-gone', 'did-start-navigation']) {
    const harness = fixture(); const pending = harness.service.collect(harness.main, [harness.main, harness.widget], async ready => { ready(); return fingerprint })
    harness.widget.webContents.emit('did-start-navigation', {}, 'file:///subframe', false, false); harness.widget.webContents.emit('did-start-navigation', {}, 'file:///app/index.html#same', true, true); await delay(1); assert.equal(harness.service.busy, true)
    harness.widget.webContents.emit(signal, {}, 'file:///app/index.html', false, true); await assert.rejects(pending, /已关闭或重载/); assert.equal(harness.service.busy, false); assert.equal(harness.widget.webContents.listenerCount(signal), 0)
  }
})
test('timeout and late sealing cannot reset or seal a replacement maintenance request', async () => {
  const harness = fixture(30); let oldSeal; const old = harness.service.collect(harness.main, [harness.main], ready => new Promise(resolve => { oldSeal = () => { ready(); resolve(fingerprint) } }))
  harness.ack(harness.main, harness.request()); const rejection = assert.rejects(old, /超时/); await delay(50); await rejection
  const next = harness.service.collect(harness.main, [harness.main], async ready => { ready(); return fingerprint }); const request = harness.request()
  assert.throws(oldSeal, /失效/); assert.equal(harness.service.busy, true); harness.ack(harness.main, request); await delay(1); harness.receive(harness.main, request); await next
})
test('native export writes an exact UTF-8 file, refuses protected roots and junction aliases, and preserves rejected destinations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-draft-export-test-'))
  try {
    const data = path.join(root, 'data'); await mkdir(data); const source = path.join(data, 'workspace.json'); await writeFile(source, 'must remain')
    const target = path.join(root, 'export.json'); await writeFile(target, 'previous export'); const content = '草稿🪶\n'
    assert.equal(await writeDraftExport(target, content, [data]), target); assert.equal(await readFile(target, 'utf8'), content)
    await assert.rejects(writeDraftExport(source, content, [data]), /应用数据目录/); assert.equal(await readFile(source, 'utf8'), 'must remain')
    const alias = path.join(root, 'alias'); await symlink(data, alias, 'junction'); await assert.rejects(writeDraftExport(path.join(alias, 'workspace.json'), content, [data]), /应用数据目录/)
    const directory = path.join(root, 'directory.json'); await mkdir(directory); await assert.rejects(writeDraftExport(directory, content, [data]), /普通文件/)
    await assert.rejects(writeDraftExport(path.join(root, 'export.txt'), content, [data]), /JSON/); assert.equal((await readdir(root)).some(name => name.endsWith('.tmp')), false)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('native maintenance runs only after every editor seals and always revokes the operation context', async () => {
  const harness = fixture(); let context, entered = false
  const pending = harness.service.run(harness.main, [harness.main, harness.widget], async ready => { ready(); return fingerprint }, async (observed, current) => {
    assert.equal(observed, fingerprint); context = current; entered = true
    assert.throws(harness.service.requireWritable, /迁移维护/)
    return 'native-result'
  })
  harness.ack(harness.main, harness.request()); await delay(1); assert.equal(entered, false)
  harness.ack(harness.widget, harness.request()); assert.equal(await pending, 'native-result')
  assert.equal(harness.service.busy, false); assert.equal(context.signal.aborted, true); assert.throws(context.assertActive, /失效/)
  assert.equal(harness.messages.filter(message => message.channel === 'drafts:resume').length, 2)
})

test('durable native operations retain all editor and write gates after success, failure, cancellation and timeout', async () => {
  for (const outcome of ['success', 'failure', 'navigation', 'timeout']) {
    const harness = fixture(outcome === 'timeout' ? 40 : 5000); let context
    const pending = harness.service.run(harness.main, [harness.main, harness.widget], async ready => { ready(); return fingerprint }, async (_fingerprint, current) => {
      context = current; current.holdForRecovery()
      if (outcome === 'failure') throw Error('native persistence failure')
      if (outcome === 'navigation') harness.widget.webContents.emit('destroyed')
      if ((outcome === 'timeout' || outcome === 'navigation') && !current.signal.aborted) await new Promise(resolve => current.signal.addEventListener('abort', resolve, { once: true }))
      return 'saved'
    })
    harness.ack(harness.main, harness.request()); harness.ack(harness.widget, harness.request())
    if (outcome === 'timeout') { const keepAlive = setTimeout(() => {}, 100); try { await assert.rejects(pending, /超时/) } finally { clearTimeout(keepAlive) } }
    else if (outcome === 'success') assert.equal(await pending, 'saved')
    else await assert.rejects(pending, outcome === 'failure' ? /native persistence failure/ : /已关闭或重载/)
    assert.equal(harness.service.busy, true); assert.throws(harness.service.requireWritable, /迁移维护/); assert.throws(harness.service.requireInteractive, /迁移维护/)
    assert.equal(harness.messages.some(message => message.channel === 'drafts:resume'), false)
    assert.equal(context.signal.aborted, true); assert.throws(context.assertActive, /失效/); assert.throws(context.holdForRecovery, /失效/)
    assert.equal(harness.ipc.listenerCount('drafts:flushed'), 0)
  }
})

test('cancelled native work drains its actual cleanup before editors or write gates resume', async () => {
  const harness = fixture(40)
  let releaseCleanup, cleanupStarted = false
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  const pending = harness.service.run(harness.main, [harness.main], async ready => { ready(); return fingerprint }, async (_fingerprint, context) => {
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))
    cleanupStarted = true
    await cleanup
  })
  const rejected = assert.rejects(pending, /超时/)
  harness.ack(harness.main, harness.request())
  try {
    await delay(70)
    assert.equal(cleanupStarted, true)
    assert.equal(harness.service.busy, true)
    assert.throws(harness.service.requireWritable, /迁移维护/)
    assert.equal(harness.messages.some(message => message.channel === 'drafts:resume'), false)
  } finally { releaseCleanup(); await rejected }
  assert.equal(harness.service.busy, false)
  assert.equal(harness.messages.filter(message => message.channel === 'drafts:resume').length, 1)
})

test('explicit source snapshot cancellation is scoped and retains the gate until cleanup finishes', async () => {
  const harness = fixture(), controller = new AbortController()
  let entered, releaseCleanup
  const started = new Promise(resolve => { entered = resolve })
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  const pending = harness.service.run(harness.main, [harness.main], async ready => { ready(); return fingerprint }, async (_fingerprint, context) => {
    entered()
    await new Promise(resolve => context.signal.addEventListener('abort', resolve, { once: true }))
    await cleanup
  }, { signal: controller.signal, timeoutMilliseconds: 300000 })
  const rejected = assert.rejects(pending, /用户取消/)
  harness.ack(harness.main, harness.request()); await started
  controller.abort(); await delay(5)
  assert.equal(harness.service.busy, true)
  releaseCleanup(); await rejected
  assert.equal(harness.service.busy, false)
  await assert.rejects(harness.service.run(harness.main, [harness.main], async ready => { ready(); return fingerprint }, async () => {}, { signal: controller.signal }), /用户取消/)
  for (const timeout of [0, -1, NaN, Infinity, 600001]) {
    await assert.rejects(harness.service.run(harness.main, [harness.main], async ready => { ready(); return fingerprint }, async () => {}, { timeoutMilliseconds: timeout }), /时限无效/)
  }
})
