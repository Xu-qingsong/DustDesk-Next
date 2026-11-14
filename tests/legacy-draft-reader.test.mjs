import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import { runInNewContext } from 'node:vm'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { electronPreloadSource } from './preload-source.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const toUrl = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const mockedElectron = toUrl('export const BrowserWindow=class { constructor(){throw Error("Unexpected native window in unit test")} };export const ipcMain={};')
async function load(name) {
  const source = ts.transpileModule(await readFile(new URL('./reference/src/main/' + name + '.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll("'../shared/draftMigration'", JSON.stringify(draftModuleUrl)).replaceAll('"../shared/draftMigration"', JSON.stringify(draftModuleUrl)).replaceAll("'electron'", JSON.stringify(mockedElectron)).replaceAll('"electron"', JSON.stringify(mockedElectron))
  return import(toUrl(source))
}
const { createDraftMaintenance } = await load('draftMaintenance')
const { legacyInstallationEntry, readLegacyDrafts } = await load('legacyDraftReader')
const entry = { key: 'widget-task-draft:v1:todo', value: JSON.stringify({ title: '旧任务', requestId: 'stable' }) }
const fingerprint = 'b'.repeat(64)
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
function fixture() {
  const ipc = new EventEmitter(); const sent = []; const webContents = Object.assign(new EventEmitter(), { getURL: () => 'file:///app/index.html', session: {}, isDestroyed: () => false, send: (channel, request) => sent.push({ channel, request }) }); const owner = { webContents, isDestroyed: () => false }
  return { ipc, sent, owner, service: createDraftMaintenance(ipc, 5000, 'file:///app/index.html'), ack() { ipc.emit('drafts:flushed', { sender: webContents }, sent.findLast(message => message.channel === 'drafts:flush').request) } }
}
test('the native read-only preload role exposes no desktop API and reads only whitelist values without writing storage', async () => {
  const source = await electronPreloadSource(); const storage = new Map([[entry.key, entry.value], ['access-token', 'must-not-be-read']]); const reads = []
  const execute = role => {
    const exposed = new Map(); const messages = []; const listeners = new Map(); const documentEvents = new Map()
    const context = { process: { platform: 'win32', argv: role ? ['--dustdesk-read-only-drafts'] : [] }, document: { documentElement: { inert: false }, addEventListener: (name, callback) => documentEvents.set(name, callback) }, contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }, ipcRenderer: { on: (name, callback) => listeners.set(name, callback), once: (name, callback) => listeners.set(name, callback), send: (...args) => messages.push(args) }, TextEncoder, localStorage: { get length() { return storage.size }, key: index => [...storage.keys()][index] ?? null, getItem: key => { reads.push(key); return storage.get(key) ?? null }, setItem() { throw Error('Reader must never write') }, removeItem() { throw Error('Reader must never delete') } } }
    runInNewContext(source, context)
    return { exposed, messages, listeners, documentEvents }
  }
  const reader = execute(true); assert.equal(reader.exposed.size, 0); assert.deepEqual([...reader.listeners.keys()], ['draft-reader:collect']); assert.deepEqual([...reader.documentEvents.keys()], ['DOMContentLoaded'])
  reader.documentEvents.get('DOMContentLoaded')(); reader.listeners.get('draft-reader:collect')(null, 'native-token')
  assert.deepEqual(JSON.parse(JSON.stringify(reader.messages)), [['draft-reader:ready'], ['draft-reader:result', 'native-token', [entry]]]); assert.ok(reads.length); assert.ok(reads.every(key => key === entry.key)); assert.equal(storage.get('access-token'), 'must-not-be-read')
  const desktop = execute(false); assert.equal(typeof desktop.exposed.get('dustdesk').saveWorkspace, 'function'); assert.equal(desktop.listeners.has('draft-reader:collect'), false)
})
test('alternate source collection starts only after queue sealing and invalidates its authority before resuming editors', async () => {
  const harness = fixture(); let context
  const pending = harness.service.collect(harness.owner, [harness.owner], async ready => { ready(); return fingerprint }, async authority => { context = authority; assert.throws(harness.service.requireWritable, /迁移维护/); authority.assertActive(); return [entry] })
  assert.equal(context, undefined); harness.ack(); assert.deepEqual(await pending, { workspaceFingerprint: fingerprint, entries: [entry] }); assert.equal(context.signal.aborted, true); assert.throws(context.assertActive, /失效/); assert.equal(harness.sent.some(message => message.channel === 'drafts:collect'), false); assert.equal(harness.service.busy, false)
})
test('participant loss aborts a waiting private reader and late collection cannot revive the cancelled session', async () => {
  const harness = fixture(); let context; let aborts = 0; let release
  const pending = harness.service.collect(harness.owner, [harness.owner], async ready => { ready(); return fingerprint }, authority => { context = authority; authority.signal.addEventListener('abort', () => { ++aborts }); return new Promise(resolve => { release = resolve }) })
  const rejection = assert.rejects(pending, /关闭或重载/); harness.ack(); await delay(1); harness.owner.webContents.emit('did-start-navigation', {}, 'file:///other', false, true)
  try {
    await delay(1)
    assert.equal(context.signal.aborted, true); assert.equal(aborts, 1); assert.throws(context.assertActive, /失效/)
    assert.equal(harness.service.busy, true); assert.equal(harness.sent.some(message => message.channel === 'drafts:resume'), false)
  } finally { release([entry]); await rejection }
  assert.equal(harness.service.busy, false); assert.equal(harness.sent.filter(message => message.channel === 'drafts:resume').length, 1)
})
test('alternate readers cannot bypass archive whitelist validation or leave the native maintenance phase active after error', async () => {
  for (const reader of [async () => [{ key: 'access-token', value: 'secret' }], async () => [entry, entry], async () => { throw Error('private reader failure') }]) {
    const harness = fixture(); const pending = harness.service.collect(harness.owner, [harness.owner], async ready => { ready(); return fingerprint }, reader); harness.ack(); await assert.rejects(pending); assert.equal(harness.service.busy, false); harness.service.requireWritable(); assert.equal(harness.ipc.listenerCount('drafts:flushed'), 0)
  }
})
test('legacy entry selection generates only a fixed local installation URL and refuses nonlocal or already-handled reads', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-legacy-unit-'))
  try {
    assert.equal(await legacyInstallationEntry(root), pathToFileURL(path.join(root, 'resources', 'app.asar', 'out', 'renderer', 'index.html')).href); await assert.rejects(legacyInstallationEntry('https://example.com')); await assert.rejects(legacyInstallationEntry(path.join(root, 'missing')))
    const authority = { signal: new AbortController().signal, assertActive() {} }
    await assert.rejects(readLegacyDrafts({}, 'https://example.com', authority), /本地安装路径/)
    await assert.rejects(readLegacyDrafts({ webContents: { session: { protocol: { isProtocolHandled: () => true } } } }, pathToFileURL(path.join(root, 'index.html')).href, authority), /已有处理器/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
