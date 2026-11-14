import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm, chmod, copyFile, link } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'
import { recordDraftProvenance } from './draft-lineage-module.mjs'
import { createElectronDraftTransactions, electronDraftTransactionFile } from './draft-transaction-module.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl)
const digest = value => createHash('sha256').update(value).digest('hex')
const binding = 'b'.repeat(64), active = () => {}, options = { skip: process.platform !== 'win32' }
function storage() {
  const values = new Map()
  return { get length() { return values.size }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
}
const observed = (target, keys = []) => ({ journal: target.getItem(migration.draftMigrationJournalKey), receipts: target.getItem(migration.draftMigrationReceiptsKey), values: Object.fromEntries([...new Set([...Array.from({ length: target.length }, (_, index) => target.key(index)).filter(key => key.startsWith('widget-') || key === migration.quickCaptureDraftStorageKey), ...keys])].map(key => [key, target.getItem(key)])) })
async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-transaction-'))
  let ownership = await acquireWorkspaceOwnership(path.join(root, 'Data'))
  try {
    const workspace = path.join(ownership.root, 'workspace.json'), bytes = '{"SchemaVersion":3}', fingerprint = digest(bytes)
    await writeFile(workspace, bytes)
    const entries = [{ key: migration.taskDraftStorageKey, value: JSON.stringify({ title: '原生反向草稿中文🪶', requestId: 'stable-reverse-request' }) }, { key: 'widget-note:v2:notes:deleted-note', value: JSON.stringify({ title:'',text:'rollback text',previousTitle:'',previousText:'' }) }]
    const serialized = await migration.createDraftArchive(entries, { runtime: 'tauri', appVersion: '1.0.2', workspaceFingerprint: fingerprint })
    await recordDraftProvenance(ownership, serialized, fingerprint)
    const target = storage(), request = randomUUID(), keys = entries.map(entry => entry.key), location = path.join(ownership.root, electronDraftTransactionFile)
    const api = createElectronDraftTransactions(ownership)
    await run({ root, ownership, workspace, bytes, entries, fingerprint, serialized, target, request, keys, location, api,
      begin: () => api.begin(request, serialized, fingerprint, binding, observed(target), active),
      stage: async () => (await migration.prepareDraftImport(serialized, fingerprint)).stage(target, () => true),
      reopen: async () => { await ownership.release(); ownership = await acquireWorkspaceOwnership(path.join(root, 'Data')); return createElectronDraftTransactions(ownership) }
    })
  } finally { await ownership.release(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}
async function finish(api, target, keys) {
  const recovery = await api.recover(binding, observed(target, keys))
  assert.ok(recovery)
  await migration.recoverNativeDraftImport(target, recovery.decision)
  return recovery.complete(observed(target, keys))
}

test('native write-ahead plan precedes browser staging and an unobserved stage cannot commit', options, async () => fixture(async context => {
  const { api, begin, stage, target, keys, request, location, entries } = context
  const pending = (await begin()).record
  assert.equal(pending.decision, 'pending'); assert.equal(pending.completed, false)
  assert.equal(target.getItem(migration.draftMigrationJournalKey), null)
  const raw = await readFile(path.join(context.ownership.root, 'ElectronMigrationJournals', pending.transactionId + '.json'), 'utf8')
  assert.equal(digest(raw), pending.journalSha256); assert.deepEqual(JSON.parse(raw).writes, entries)
  const before = await readFile(location)
  await assert.rejects(api.decide(request, pending.transactionId, true, binding, observed(target, keys), active), /尚未暂存/)
  assert.deepEqual(await readFile(location), before)
  await stage()
  const committed = await api.decide(request, pending.transactionId, true, binding, observed(target, keys), active)
  assert.equal(committed.decision, 'commit'); assert.equal(target.getItem(migration.draftMigrationReceiptsKey), null)
  assert.deepEqual(await api.decide(request, pending.transactionId, false, binding, observed(target, keys), active), committed)
  const completed = await finish(api, target, keys)
  assert.equal(completed.completed, true); assert.equal(target.getItem(migration.draftMigrationJournalKey), null)
  const duplicate = await begin(); assert.equal(duplicate.result.alreadyImported, true); assert.equal(duplicate.record, undefined)
}))

test('restart before any browser stage aborts the durable plan without creating missing drafts', options, async () => fixture(async ({ begin, target, keys, reopen, location }) => {
  const pending = (await begin()).record, restarted = await reopen()
  const completed = await finish(restarted, target, keys)
  assert.equal(completed.transactionId, pending.transactionId); assert.equal(completed.decision, 'abort'); assert.equal(completed.completed, true)
  for (const key of keys) assert.equal(target.getItem(key), null)
  assert.equal(JSON.parse(await readFile(location)).decision, 'abort')
}))

test('queued native decisions retain the browser observations captured at invocation', options, async () => fixture(async ({ api, serialized, fingerprint, target, keys, request, stage, entries }) => {
  const before = observed(target, keys)
  const beginning = api.begin(request, serialized, fingerprint, binding, before, active)
  before.journal = 'later-mutated-journal'; before.values[keys[0]] = '{"saved":true}'
  const pending = (await beginning).record
  assert.equal(pending.writes.length, entries.length)
  await stage()
  const staged = observed(target, keys)
  const deciding = api.decide(request, pending.transactionId, true, binding, staged, active)
  staged.journal = null; staged.values[keys[0]] = null
  assert.equal((await deciding).decision, 'commit')
  const recovering = observed(target, keys), recoveryPromise = api.recover(binding, recovering)
  recovering.journal = 'later-mutated-journal'; recovering.values[keys[0]] = '{"saved":true}'
  const recovery = await recoveryPromise
  await migration.recoverNativeDraftImport(target, recovery.decision)
  const after = observed(target, keys), completing = recovery.complete(after)
  after.journal = 'later-mutated-journal'; after.receipts = null; after.values[keys[0]] = null
  assert.equal((await completing).completed, true)
  assert.equal(target.getItem(keys[0]), entries[0].value)
}))

test('committed recovery uses the immutable native journal after browser journal and values disappear and preserves consumed inputs later', options, async () => fixture(async ({ api, begin, stage, request, target, keys, reopen, entries }) => {
  const pending = (await begin()).record; await stage()
  await api.decide(request, pending.transactionId, true, binding, observed(target, keys), active)
  for (const key of [...keys, migration.draftMigrationJournalKey]) target.removeItem(key)
  const restarted = await reopen(); await finish(restarted, target, keys)
  for (const entry of entries) assert.equal(target.getItem(entry.key), entry.value)
  target.removeItem(keys[0]); target.setItem(keys[1], JSON.stringify({ saved:true }))
  await finish(restarted, target, keys)
  assert.equal(target.getItem(keys[0]), null); assert.equal(target.getItem(keys[1]), '{"saved":true}')
}))

test('expiry and pending restart only choose abort while later changed drafts survive rollback', options, async () => fixture(async ({ api, begin, stage, request, target, keys, reopen, entries }) => {
  const pending = (await begin()).record; await stage()
  const stopped = () => { throw Error('expired native Ready') }
  const aborted = await api.decide(request, pending.transactionId, true, binding, observed(target, keys), stopped)
  assert.equal(aborted.decision, 'abort')
  const later = JSON.stringify({ title:'后来输入',requestId:'later' }); target.setItem(keys[0], later)
  const restarted = await reopen(); await finish(restarted, target, keys)
  assert.equal(target.getItem(keys[0]), later); assert.equal(target.getItem(keys[1]), null)
  // Once an abort is completed, subsequent legitimate identical text is not
  // retroactively treated as an unrolled-back write.
  target.setItem(keys[1], entries[1].value); await finish(restarted, target, keys)
  assert.equal(target.getItem(keys[1]), entries[1].value)
}))

test('native plan shares exact alias and empty/saved protection and rejects concurrent transactions', options, async () => fixture(async ({ api, begin, target, keys, entries }) => {
  target.setItem('widget-note:deleted-note', '{"saved":true}')
  target.setItem(keys[0], JSON.stringify({ title:'',requestId:'keep-empty' }))
  const first = await begin(); assert.deepEqual(first.result.importedKeys, []); assert.deepEqual(first.result.existingKeys, keys)
  assert.deepEqual(first.record.writes, [])
  await assert.rejects(begin(), /尚未.*恢复/)
  await finish(api, target, keys)
  assert.equal(target.getItem('widget-note:deleted-note'), '{"saved":true}')
  assert.notEqual(target.getItem(keys[0]), entries[0].value)
}))

test('wrong browser, changed native workspace, foreign pending, orphan journals and damaged native copies cannot authorize writes', options, async () => fixture(async ({ api, begin, stage, target, keys, request, workspace, bytes, location, ownership }) => {
  await assert.rejects(api.recover(binding, { journal:'orphan',receipts:null,values:{} }), /没有原生决定/)
  const pending = (await begin()).record, original = await readFile(location)
  await assert.rejects(api.recover('c'.repeat(64), observed(target, keys)), /浏览器配置/)
  assert.deepEqual(await readFile(location), original)
  await stage(); await writeFile(workspace, bytes + ' ')
  await assert.rejects(api.decide(request, pending.transactionId, true, binding, observed(target, keys), active), /工作区已变化/)
  assert.deepEqual(await readFile(location), original); await writeFile(workspace, bytes)
  const copy = path.join(ownership.root, 'ElectronMigrationJournals', pending.transactionId + '.json'), originalCopy = await readFile(copy)
  await writeFile(copy, '{}'); await assert.rejects(api.recover(binding, observed(target, keys)), /副本.*不匹配/)
  assert.deepEqual(await readFile(location), original); await writeFile(copy, originalCopy)
  const peer = { ...pending, format:'dustdesk-draft-transaction' }; await writeFile(path.join(ownership.root, 'MigrationTransaction.json'), JSON.stringify(peer))
  await assert.rejects(api.requirePeerCompleted(), /Tauri.*受控恢复/)
  assert.deepEqual(await readFile(location), original)
}))

test('actual read-only record failure preserves pending decision and permits explicit recovery after repair', options, async () => fixture(async ({ api, begin, stage, target, keys, request, location }) => {
  const pending = (await begin()).record; await stage(); const original = await readFile(location)
  await chmod(location, 0o444)
  try {
    await assert.rejects(api.decide(request, pending.transactionId, true, binding, observed(target, keys), active), /持久化.*EPERM|持久化.*EACCES/)
    assert.deepEqual(await readFile(location), original)
    assert.ok(target.getItem(migration.draftMigrationJournalKey))
    assert.equal((await readdir(path.dirname(location))).some(name => name.startsWith('.electron-draft-')), false)
  } finally { await chmod(location, 0o666) }
  const completed = await finish(api, target, keys); assert.equal(completed.decision, 'abort')
}))

test('copied, hardlinked, corrupt and future transaction records are preserved and rejected', options, async () => fixture(async ({ api, begin, ownership, root, location }) => {
  await begin(); const original = await readFile(location), parsed = JSON.parse(original)
  for (const value of ['{broken', JSON.stringify({ ...parsed,version:2 }), JSON.stringify({ ...parsed,unknown:true }), JSON.stringify({ ...parsed,writes:[parsed.writes[0],parsed.writes[0]] }), JSON.stringify({ ...parsed,completed:true,decision:'pending' }), JSON.stringify({ ...parsed,browserBinding:null })]) {
    await writeFile(location, value); await assert.rejects(api.read()); assert.equal(await readFile(location,'utf8'), value)
  }
  await writeFile(location, original)
  const alias = path.join(ownership.root, 'alias.json'); await link(location, alias); await assert.rejects(api.read()); await rm(alias)
  const other = await acquireWorkspaceOwnership(path.join(root, 'Other'))
  try { await copyFile(location, path.join(other.root, electronDraftTransactionFile)); await assert.rejects(createElectronDraftTransactions(other).read()); assert.deepEqual(await readFile(location), original) } finally { await other.release() }
}))
