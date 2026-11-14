import assert from 'node:assert/strict'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'
import { randomUUID, webcrypto } from 'node:crypto'
import { electronPreloadSource } from './preload-source.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl), source = await electronPreloadSource()
const fingerprint = 'f'.repeat(64), entry = { key: migration.taskDraftStorageKey, value: '{"title":"受控草稿中文🪶","requestId":"same-input"}' }
function fixture(extraArguments = []) {
  const token = randomUUID(), values = new Map(), exposed = new Map(), listeners = new Map(), events = new Map(), messages = []
  const localStorage = { get length() { return values.size }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }
  runInNewContext(source, { process: { platform: 'win32', argv: ['--dustdesk-controlled-drafts', '--dustdesk-draft-token=' + token, ...extraArguments] }, contextBridge: { exposeInMainWorld: (name, value) => exposed.set(name, value) }, ipcRenderer: { on: (name, listener) => listeners.set(name, listener), send: (...args) => messages.push(args) }, document: { addEventListener: (name, listener) => events.set(name, listener) }, localStorage, crypto: webcrypto, TextEncoder })
  return { token, localStorage, exposed, listeners, events, messages, execute: request => listeners.get('draft-control:execute')(null, { token, id: randomUUID(), ...request }) }
}

test('controlled preload has no desktop bridge and stages without a receipt until a native recovery decision arrives', async () => {
  const page = fixture(['--dustdesk-read-only-drafts'])
  assert.equal(page.exposed.size, 0); assert.deepEqual([...page.listeners.keys()], ['draft-control:execute'])
  page.events.get('DOMContentLoaded')(); assert.deepEqual(page.messages[0], ['draft-control:ready', page.token])
  const serialized = await migration.createDraftArchive([entry], { runtime:'tauri',appVersion:'1.0.2',workspaceFingerprint:fingerprint })
  await page.execute({ token: randomUUID(), operation:'stage', serialized, fingerprint }); assert.equal(page.localStorage.length, 0)
  await page.execute({ operation:'stage', serialized, fingerprint })
  assert.equal(page.messages.at(-1).at(-1), null); assert.equal(page.localStorage.getItem(entry.key), entry.value)
  assert.equal(page.localStorage.getItem(migration.draftMigrationReceiptsKey), null)
  const journal = page.localStorage.getItem(migration.draftMigrationJournalKey), verified = await migration.verifyDraftArchive(serialized)
  await page.execute({ operation:'commit' }); assert.match(page.messages.at(-1).at(-1), /无效/)
  assert.equal(page.localStorage.getItem(migration.draftMigrationJournalKey), journal)
  await page.execute({ operation:'recover', decision:{ archiveId:verified.payload.id,payloadSha256:verified.archive.sha256,journalSha256:await migration.draftDigest(journal),recoveryJournal:journal,completed:false,decision:'commit' } })
  assert.equal(page.messages.at(-1).at(-1), null); assert.equal(page.localStorage.getItem(migration.draftMigrationJournalKey), null)
  assert.equal(page.localStorage.getItem(entry.key), entry.value)
  assert.equal(JSON.parse(page.localStorage.getItem(migration.draftMigrationReceiptsKey))[0].id, verified.payload.id)
})

test('controlled preload errors preserve native pending authority and cannot expose an ordinary API', async () => {
  const page = fixture()
  await page.execute({ operation:'stage', serialized:'{broken', fingerprint })
  assert.equal(typeof page.messages.at(-1).at(-1), 'string'); assert.equal(page.localStorage.length, 0)
  const serialized = await migration.createDraftArchive([entry], { runtime:'tauri',appVersion:'1.0.2',workspaceFingerprint:fingerprint })
  await page.execute({ operation:'stage', serialized, fingerprint })
  const journal = page.localStorage.getItem(migration.draftMigrationJournalKey), verified = await migration.verifyDraftArchive(serialized)
  await page.execute({ operation:'recover', decision:{ archiveId:verified.payload.id,payloadSha256:verified.archive.sha256,journalSha256:'a'.repeat(64),completed:false,decision:'abort' } })
  assert.match(page.messages.at(-1).at(-1), /不匹配/)
  assert.equal(page.localStorage.getItem(migration.draftMigrationJournalKey), journal); assert.equal(page.localStorage.getItem(entry.key), entry.value)
  assert.equal(page.exposed.size, 0)
})
