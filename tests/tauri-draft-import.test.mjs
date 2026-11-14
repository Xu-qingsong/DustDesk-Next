import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl)
const source = (await readFile('src/renderer/src/runtime/draftImport.ts', 'utf8')).replace('../../../shared/draftMigration', draftModuleUrl)
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { runDraftImport } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
class Storage {
  values = new Map()
  failReceipt = false
  get length() { return this.values.size }
  key(index) { return [...this.values.keys()][index] ?? null }
  getItem(key) { return this.values.get(key) ?? null }
  setItem(key, value) { if (this.failReceipt && key === migration.draftMigrationReceiptsKey) throw Error('storage unavailable'); this.values.set(key, value) }
  removeItem(key) { this.values.delete(key) }
}
async function fixture(fault) {
  const storage = new Storage()
  const value = JSON.stringify({ title: '导入草稿', requestId: 'stable-import' })
  const archive = await migration.createDraftArchive([{ key: migration.taskDraftStorageKey, value }], { runtime: 'electron', appVersion: '1.0.2', workspaceFingerprint: 'a'.repeat(64) })
  const verified = await migration.verifyDraftArchive(archive)
  let current = null; let journal; let active = false
  const calls = []; const messages = []; const blocked = []
  const host = {
    storage, active: request => active && request === 'checkpoint', currentRequest: () => active ? 'checkpoint' : undefined, alive: () => true,
    message: text => messages.push(text), block: text => blocked.push(text),
    invoke: async (command, args = {}) => {
      calls.push(command)
      if (command === 'drafts_prepare') { assert.equal(args.refresh, true); active = true; if (fault === 'prepare-reply') throw Error('prepare response lost'); return { requestId: 'checkpoint', workspaceFingerprint: 'a'.repeat(64) } }
      if (command === 'drafts_verify') { if (fault === 'provenance') throw Error('receipt rejected'); return {} }
      if (command === 'drafts_end') { active = false; return true }
      if (command === 'drafts_transaction' && args.serialized) {
        if (fault === 'lease') { active = false; throw Error('lease expired') }
        journal = storage.getItem(migration.draftMigrationJournalKey)
        assert.equal(await migration.draftDigest(journal), args.journalSha256)
        current = { requestId: 'checkpoint', transactionId: 'transaction', archiveSha256: await migration.draftDigest(archive), archiveId: verified.payload.id, payloadSha256: verified.archive.sha256, journalSha256: args.journalSha256, recoveryJournal: journal, completed: false, decision: 'pending' }
        if (fault === 'begin-reply') throw Error('begin response lost')
        return structuredClone(current)
      }
      if (command === 'drafts_transaction') {
        current.decision = 'commit'
        if (fault === 'receipt-write') storage.failReceipt = true
        if (fault === 'commit-reply' || fault === 'unknown-state') throw Error('commit response lost')
        return structuredClone(current)
      }
      if (command === 'drafts_import_state') { if (fault === 'unknown-state') throw Error('native state unavailable'); return structuredClone(current) }
      if (command === 'drafts_recovery') {
        if (!current) return null
        if (current.decision === 'pending') current.decision = 'abort'
        if (args.finish) {
          assert.equal(storage.getItem(migration.draftMigrationJournalKey), null)
          current.completed = true; active = false
          if (fault === 'finish-reply') throw Error('finish response lost')
          return structuredClone(current)
        }
        return current.completed ? null : structuredClone(current)
      }
      throw Error('Unexpected command: ' + command)
    },
  }
  return { archive, host, storage, calls, messages, blocked, value, status: () => current }
}

test('product import verifies provenance, uses native irreversible decisions and confirms the actual browser before completion', async () => {
  const sample = await fixture(); const result = await runDraftImport(sample.archive, sample.host)
  assert.deepEqual(result.importedKeys, [migration.taskDraftStorageKey]); assert.equal(sample.status().completed, true)
  assert.equal(sample.storage.getItem(migration.taskDraftStorageKey), sample.value)
  assert.equal(sample.storage.getItem(migration.draftMigrationJournalKey), null)
  assert.equal(sample.blocked.length, 0); assert.ok(sample.calls.indexOf('drafts_verify') < sample.calls.indexOf('drafts_transaction'))
})
test('provenance rejection ends maintenance before any browser journal or writes exist', async () => {
  const sample = await fixture('provenance'); await assert.rejects(runDraftImport(sample.archive, sample.host), /receipt rejected/)
  assert.equal(sample.storage.length, 0); assert.equal(sample.status(), null); assert.equal(sample.calls.at(-1), 'drafts_end')
})
test('lost prepare response releases only the maintenance request observed through the native flush event', async () => {
  const sample = await fixture('prepare-reply'); await assert.rejects(runDraftImport(sample.archive, sample.host), /prepare response lost/)
  assert.equal(sample.storage.length, 0); assert.equal(sample.status(), null)
  assert.equal(sample.calls.at(-1), 'drafts_end'); assert.deepEqual(sample.blocked, [])
})
test('optional result notification failure cannot veto or roll back a verified native commit', async () => {
  const sample = await fixture(); sample.host.message = () => { throw Error('session storage unavailable') }
  const result = await runDraftImport(sample.archive, sample.host)
  assert.equal(result.importedKeys.length, 1); assert.equal(sample.status().completed, true); assert.deepEqual(sample.blocked, [])
})
test('an expired native begin with authoritative absence rolls back only this staged import', async () => {
  const sample = await fixture('lease'); await assert.rejects(runDraftImport(sample.archive, sample.host), /lease expired/)
  assert.equal(sample.storage.length, 0); assert.equal(sample.status(), null); assert.deepEqual(sample.blocked, [])
})
test('a staging exception with incomplete local rollback retains the maintenance barrier and blocks editors', async () => {
  const sample = await fixture()
  const setItem = sample.storage.setItem.bind(sample.storage)
  sample.storage.setItem = (key, value) => { if (key === migration.taskDraftStorageKey) throw Error('draft write failed'); setItem(key, value) }
  sample.storage.removeItem = () => { throw Error('journal removal failed') }
  await assert.rejects(runDraftImport(sample.archive, sample.host), /恢复日志/)
  assert.equal(sample.status(), null); assert.ok(sample.storage.getItem(migration.draftMigrationJournalKey))
  assert.equal(sample.blocked.length, 1); assert.ok(!sample.calls.includes('drafts_end'))
})
test('lost begin response consults the durable record and recovers pending as abort without guessing commit', async () => {
  const sample = await fixture('begin-reply'); await assert.rejects(runDraftImport(sample.archive, sample.host), /原生决定中止/)
  assert.equal(sample.status().decision, 'abort'); assert.equal(sample.status().completed, true)
  assert.equal(sample.storage.length, 0); assert.deepEqual(sample.blocked, [])
})
for (const fault of ['commit-reply', 'finish-reply']) test(fault + ' never rolls back a native commit or invents a new transaction', async () => {
  const sample = await fixture(fault); const result = await runDraftImport(sample.archive, sample.host)
  assert.equal(result.importedKeys.length, 1); assert.equal(sample.status().decision, 'commit'); assert.equal(sample.status().completed, true)
  assert.equal(sample.storage.getItem(migration.taskDraftStorageKey), sample.value); assert.deepEqual(sample.blocked, [])
})
for (const fault of ['unknown-state', 'receipt-write']) test(fault + ' retains staged content and logs rather than assuming a reversible failure', async () => {
  const sample = await fixture(fault); await assert.rejects(runDraftImport(sample.archive, sample.host))
  assert.equal(sample.status().decision, 'commit'); assert.equal(sample.status().completed, false)
  assert.equal(sample.storage.getItem(migration.taskDraftStorageKey), sample.value)
  assert.ok(sample.storage.getItem(migration.draftMigrationJournalKey)); assert.equal(sample.blocked.length, 1)
  assert.ok(!sample.calls.includes('drafts_end'))
})
test('existing input is preserved and duplicate import never resurrects a consumed input', async () => {
  const sample = await fixture(); sample.storage.setItem(migration.taskDraftStorageKey, JSON.stringify({ title: '目标现有草稿', requestId: 'existing' }))
  const result = await runDraftImport(sample.archive, sample.host)
  assert.equal(result.importedKeys.length, 0); assert.deepEqual(result.existingKeys, [migration.taskDraftStorageKey])
  sample.storage.removeItem(migration.taskDraftStorageKey)
  const repeated = await runDraftImport(sample.archive, sample.host)
  assert.equal(repeated.alreadyImported, true); assert.equal(sample.storage.getItem(migration.taskDraftStorageKey), null)
  assert.equal(sample.calls.filter(command => command === 'drafts_transaction').length, 2)
})
