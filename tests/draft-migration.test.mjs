import assert from 'node:assert/strict'
import { test } from 'node:test'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl)
const { collectDrafts, createDraftArchive, verifyDraftArchive, importDraftArchive, recoverDraftImport, draftDigest, draftMigrationJournalKey, draftMigrationReceiptsKey, noteDraftStorageKey, taskDraftStorageKey, validateDraftEntry } = migration
const { prepareDraftImport, recoverNativeDraftImport } = migration
const fingerprint = 'a'.repeat(64)
const source = { runtime: 'electron', appVersion: '1.0.2', workspaceFingerprint: fingerprint }
const note = (title = '中文🪶标题') => JSON.stringify({ title, text: '正文\n引号"<>&', previousTitle: '原题', previousText: '旧文' })
const sample = () => [
  { key: 'widget-note:legacy-id', value: note('旧草稿') },
  { key: noteDraftStorageKey('notes', 'note-one'), value: note() },
  { key: noteDraftStorageKey('note:private-note', 'private-note'), value: note('私有窗口') },
  { key: noteDraftStorageKey('notes', 'clean-note'), value: '{"saved":true}' },
  { key: taskDraftStorageKey, value: JSON.stringify({ title: '未提交任务', requestId: 'task-stable' }) },
  { key: 'quick-capture-draft', value: JSON.stringify({ kind: 'note', title: '捕获草稿', text: '补充', requestId: 'capture-stable' }) },
  { key: 'widget-notes:selected', value: 'private-note' },
]
function storage(initial = []) {
  const values = new Map(initial.map(entry => [entry.key, entry.value])); let failWrite = () => false; let failRemove = () => false; const writes = []
  return { values, writes, blockWrite: callback => { failWrite = callback }, blockRemove: callback => { failRemove = callback },
    get length() { return values.size }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes.push(key); if (failWrite(key)) throw Error('quota fixture'); values.set(key, value) },
    removeItem: key => { if (failRemove(key)) throw Error('remove fixture'); values.delete(key) },
  }
}
async function rewrite(serialized, callback) {
  const archive = JSON.parse(serialized); const payload = JSON.parse(archive.payload); callback(payload); archive.payload = JSON.stringify(payload); archive.sha256 = await draftDigest(archive.payload); return JSON.stringify(archive)
}

test('archive includes exactly the whitelisted raw drafts and source identity, not cookies, tokens or import journals', async () => {
  const disk = storage([...sample(), { key: 'access-token', value: 'not-exported' }, { key: draftMigrationReceiptsKey, value: 'private-history' }, { key: 'unrelated-cache', value: 'private-cache' }])
  const entries = collectDrafts(disk); assert.equal(entries.length, 7); const serialized = await createDraftArchive(entries, source); const verified = await verifyDraftArchive(serialized)
  assert.deepEqual(verified.payload.entries, entries); assert.deepEqual(verified.payload.source, source); assert.ok(!serialized.includes('not-exported') && !serialized.includes('private-history') && !serialized.includes('private-cache'))
  const imported = storage(); const reply = await importDraftArchive(imported, serialized, fingerprint); assert.equal(reply.importedKeys.length, 7); assert.deepEqual(collectDrafts(imported), entries); assert.equal(imported.getItem(draftMigrationJournalKey), null)
})

test('Tauri export imports back into Electron without changing Unicode, raw JSON, stable request ids or legacy records', async () => {
  const electron = storage(sample()); const first = await createDraftArchive(collectDrafts(electron), source); const tauri = storage(); await importDraftArchive(tauri, first, fingerprint)
  const key = noteDraftStorageKey('notes', 'note-one'); tauri.setItem(key, note('在 Tauri 修改后的草稿'))
  const reverse = await createDraftArchive(collectDrafts(tauri), { ...source, runtime: 'tauri' }); const restored = storage(); await importDraftArchive(restored, reverse, fingerprint)
  assert.deepEqual(collectDrafts(restored), collectDrafts(tauri)); assert.equal(JSON.parse(restored.getItem(taskDraftStorageKey)).requestId, 'task-stable'); assert.equal(restored.getItem('widget-note:legacy-id'), electron.getItem('widget-note:legacy-id'))
})

test('existing destination drafts and clean tombstones are never overwritten and repeated import cannot resurrect consumed records', async () => {
  const serialized = await createDraftArchive(sample(), source); const key = noteDraftStorageKey('notes', 'note-one'); const disk = storage([{ key, value: '{"saved":true}' }])
  const reply = await importDraftArchive(disk, serialized, fingerprint); assert.ok(reply.existingKeys.includes(key)); assert.equal(disk.getItem(key), '{"saved":true}')
  disk.setItem(taskDraftStorageKey, JSON.stringify({ title: '新的输入', requestId: 'new-task' })); disk.removeItem('quick-capture-draft'); const before = [...disk.values]
  assert.equal((await importDraftArchive(disk, serialized, fingerprint)).alreadyImported, true); assert.deepEqual([...disk.values], before)
  const changed = await rewrite(serialized, payload => { payload.entries[0].value = note('同编号不同内容') }); await assert.rejects(importDraftArchive(disk, changed, fingerprint), /同一迁移编号/); assert.deepEqual([...disk.values], before)
})

test('legacy and scoped aliases cannot replace a newer destination draft but separate note windows remain independent', async () => {
  const scoped = noteDraftStorageKey('notes', 'same-note'); const pinned = noteDraftStorageKey('note:same-note', 'same-note'); const legacy = 'widget-note:same-note'
  for (const [existing, incoming] of [[scoped, legacy], [legacy, scoped], [pinned, legacy], [legacy, pinned]]) {
    const disk = storage([{ key: existing, value: note('new destination') }]); const reply = await importDraftArchive(disk, await createDraftArchive([{ key: incoming, value: note('source') }], source), fingerprint)
    assert.deepEqual(reply.importedKeys, []); assert.deepEqual(reply.existingKeys, [incoming]); assert.equal(disk.getItem(incoming), null)
  }
  const disk = storage([{ key: scoped, value: note('generic') }]); await importDraftArchive(disk, await createDraftArchive([{ key: pinned, value: note('private') }], source), fingerprint); assert.equal(disk.getItem(pinned), note('private'))
})

test('every write failure before receipt commit rolls back only imported values and can be retried', async () => {
  const entries = sample(); const serialized = await createDraftArchive(entries, source)
  for (const failing of [draftMigrationJournalKey, ...entries.map(entry => entry.key), draftMigrationReceiptsKey]) {
    const disk = storage([{ key: 'unrelated', value: 'keep' }]); disk.blockWrite(key => key === failing); await assert.rejects(importDraftArchive(disk, serialized, fingerprint), /quota fixture/)
    assert.deepEqual([...disk.values], [['unrelated', 'keep']]); disk.blockWrite(() => false); assert.equal((await importDraftArchive(disk, serialized, fingerprint)).importedKeys.length, entries.length)
  }
})

test('failed rollback retains a recovery journal and later recovery preserves a subsequently edited draft', async () => {
  const entries = sample(); const serialized = await createDraftArchive(entries, source); const disk = storage(); disk.blockWrite(key => key === entries[2].key); disk.blockRemove(key => key === entries[0].key)
  await assert.rejects(importDraftArchive(disk, serialized, fingerprint), /回滚未完成/); assert.ok(disk.getItem(draftMigrationJournalKey)); assert.equal(disk.getItem(entries[0].key), entries[0].value)
  disk.blockWrite(() => false); disk.blockRemove(() => false); disk.setItem(entries[0].key, note('导入失败之后的新输入')); recoverDraftImport(disk)
  assert.equal(disk.getItem(entries[0].key), note('导入失败之后的新输入')); assert.equal(disk.getItem(entries[1].key), null); assert.equal(disk.getItem(draftMigrationJournalKey), null)
  const retry = await importDraftArchive(disk, serialized, fingerprint); assert.ok(retry.existingKeys.includes(entries[0].key)); assert.equal(disk.getItem(entries[0].key), note('导入失败之后的新输入'))
})

test('interruption before or after the receipt boundary recovers deterministically without reapplying a committed archive', async () => {
  const serialized = await createDraftArchive(sample(), source); const { archive, payload } = await verifyDraftArchive(serialized)
  for (const committed of [false, true]) {
    const disk = storage(sample().slice(0, 3)); disk.setItem(draftMigrationJournalKey, JSON.stringify({ id: payload.id, sha256: archive.sha256, writes: sample() }))
    if (committed) disk.setItem(draftMigrationReceiptsKey, JSON.stringify([{ id: payload.id, sha256: archive.sha256 }]))
    recoverDraftImport(disk); assert.equal(collectDrafts(disk).length, committed ? 3 : 0)
    const reply = await importDraftArchive(disk, serialized, fingerprint); assert.equal(reply.alreadyImported, committed)
  }
})

test('receipt cleanup failure is retried without rolling back an already committed archive', async () => {
  const disk = storage(); const serialized = await createDraftArchive(sample(), source); disk.blockRemove(key => key === draftMigrationJournalKey)
  await assert.rejects(importDraftArchive(disk, serialized, fingerprint), /remove fixture/); assert.equal(collectDrafts(disk).length, 7); assert.ok(disk.getItem(draftMigrationReceiptsKey)); disk.blockRemove(() => false)
  assert.equal((await importDraftArchive(disk, serialized, fingerprint)).alreadyImported, true); assert.equal(collectDrafts(disk).length, 7); assert.equal(disk.getItem(draftMigrationJournalKey), null)
})

test('bad checksum, wrong lineage, unsupported schemas, unknown data and duplicate keys fail before touching destination storage', async () => {
  const serialized = await createDraftArchive(sample(), source); const corrupt = JSON.parse(serialized); corrupt.sha256 = '0'.repeat(64)
  const values = [JSON.stringify(corrupt), JSON.stringify({ ...JSON.parse(serialized), version: 2 }), JSON.stringify({ ...JSON.parse(serialized), cookie: 'not allowed' }),
    await rewrite(serialized, payload => { payload.entries.push(payload.entries[0]) }), await rewrite(serialized, payload => { payload.entries.push({ key: 'access-token', value: 'secret' }) }),
    await rewrite(serialized, payload => { payload.source.runtime = 'unknown' }), await rewrite(serialized, payload => { payload.createdAt = '2026-02-30T00:00:00.000Z' }),
    await rewrite(serialized, payload => { payload.entries[0].value = '{invalid' }), await rewrite(serialized, payload => { payload.entries[0].value = JSON.stringify({ title: '', text: '', previousTitle: '', previousText: '', injected: 'value' }) }),
  ]
  for (const value of values) { const disk = storage(); await assert.rejects(importDraftArchive(disk, value, fingerprint)); assert.equal(disk.writes.length, 0) }
  const disk = storage(); await assert.rejects(importDraftArchive(disk, serialized, 'b'.repeat(64)), /来源工作区/); assert.equal(disk.writes.length, 0)
})

test('malformed destination data, poisoned recovery logs and receipt history are preserved instead of overwritten', async () => {
  const serialized = await createDraftArchive(sample(), source)
  for (const entry of [{ key: taskDraftStorageKey, value: '{broken' }, { key: draftMigrationJournalKey, value: JSON.stringify({ id: 'bad', sha256: fingerprint, writes: [{ key: 'access-token', value: 'never-delete' }] }) }, { key: draftMigrationReceiptsKey, value: '{broken' }]) {
    const disk = storage([entry]); const before = [...disk.values]; await assert.rejects(importDraftArchive(disk, serialized, fingerprint)); assert.deepEqual([...disk.values], before); assert.equal(disk.writes.length, 0)
  }
})

test('field limits are UTF-16 compatible and malformed percent-encoded owners and unrelated roles are rejected', () => {
  const key = noteDraftStorageKey('notes', 'note-one'); assert.doesNotThrow(() => validateDraftEntry({ key, value: note('😀'.repeat(150)) }))
  assert.throws(() => validateDraftEntry({ key, value: note('😀'.repeat(151)) }))
  for (const invalid of ['widget-note:v2:%zz:note-one', 'widget-note:v2:launcher:note-one', noteDraftStorageKey('note:other', 'note-one'), 'widget-note:v2:note%3aone:one', 'widget-note:v3:notes:one']) assert.throws(() => validateDraftEntry({ key: invalid, value: note() }))
  assert.doesNotThrow(() => validateDraftEntry({ key: 'quick-capture-draft', value: JSON.stringify({ kind: 'task', title: '旧快速记录', text: '' }) }))
})

test('bounded archive, entry and receipt limits fail explicitly instead of truncating or forgetting import history', async () => {
  await assert.rejects(verifyDraftArchive(' '.repeat(migration.maxDraftArchiveBytes + 1)), /64 MiB/)
  const entries = Array.from({ length: 5001 }, (_, index) => ({ key: 'widget-note:' + index, value: '{"saved":true}' })); await assert.rejects(createDraftArchive(entries, source))
  const disk = storage(); const history = Array.from({ length: 4096 }, (_, index) => ({ id: 'archive-' + index, sha256: fingerprint })); disk.setItem(draftMigrationReceiptsKey, JSON.stringify(history)); const before = [...disk.values]
  await assert.rejects(importDraftArchive(disk, await createDraftArchive(sample(), source), fingerprint), /迁移记录已满/); assert.deepEqual([...disk.values], before)
})

test('storage enumeration and value changes cannot silently produce an incomplete export', () => {
  const entries = sample(); const disk = storage(entries); let reads = 0
  const changed = { get length() { return disk.length }, key: index => disk.key(index), getItem: key => { if (++reads === 3) disk.values.delete(entries[0].key); return disk.getItem(key) } }
  assert.throws(() => collectDrafts(changed), /发生变化/)
  const raw = storage(entries); let changedOnce = false
  assert.throws(() => collectDrafts({ get length() { return raw.length }, key: index => raw.key(index), getItem: key => { const value = raw.getItem(key); if (!changedOnce) { changedOnce = true; raw.values.set(key, note('new input')) } return value } }), /发生变化/)
})

test('preparation verifies immutable bytes without storage authority and an inactive stage never writes or recovers', async () => {
  const serialized = await createDraftArchive(sample(), source); const prepared = await prepareDraftImport(serialized, fingerprint)
  assert.ok(Object.isFrozen(prepared)); assert.equal(prepared.workspaceFingerprint, fingerprint)
  assert.throws(() => { prepared.workspaceFingerprint = 'b'.repeat(64) }, TypeError)
  const disk = storage([{ key: draftMigrationJournalKey, value: '{unreadable-prior-journal' }]); const before = [...disk.values]
  assert.throws(() => prepared.stage(disk, () => { throw Error('native maintenance expired') }), /maintenance expired/)
  assert.deepEqual([...disk.values], before); assert.deepEqual(disk.writes, [])
})

test('staged writes have no committed receipt until an explicitly active synchronous commit', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); let checks = 0
  const transaction = prepared.stage(disk, () => { checks++; return true })
  assert.equal(transaction.result.importedKeys.length, 7); assert.equal(collectDrafts(disk).length, 7)
  assert.equal(disk.getItem(draftMigrationReceiptsKey), null); assert.ok(disk.getItem(draftMigrationJournalKey))
  const prior = checks; const result = transaction.commit()
  assert.ok(!(result instanceof Promise)); assert.ok(checks > prior); assert.equal(result.alreadyImported, false)
  assert.equal(disk.getItem(draftMigrationJournalKey), null); assert.equal(JSON.parse(disk.getItem(draftMigrationReceiptsKey))[0].id, prepared.id)
  assert.throws(() => transaction.rollback(), /事务已失效/); assert.equal(collectDrafts(disk).length, 7)
})

test('lease cancellation between staging and commit rolls back only imported values without granting a receipt', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage([{ key: 'unrelated', value: 'keep' }]); let active = true
  const transaction = prepared.stage(disk, () => { if (!active) throw Error('native lease cancelled'); return true })
  disk.setItem(taskDraftStorageKey, JSON.stringify({ title: 'later user input', requestId: 'later-id' })); active = false
  assert.throws(() => transaction.commit(), /lease cancelled/)
  assert.equal(disk.getItem('unrelated'), 'keep'); assert.equal(JSON.parse(disk.getItem(taskDraftStorageKey)).requestId, 'later-id')
  assert.equal(collectDrafts(disk).length, 1); assert.equal(disk.getItem(draftMigrationJournalKey), null); assert.equal(disk.getItem(draftMigrationReceiptsKey), null)
})

test('stage checks the guard at each write boundary and rolls back a lease lost during materialization', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); let checks = 0
  assert.throws(() => prepared.stage(disk, () => { if (++checks === 5) throw Error('expired during writes'); return true }), /expired during writes/)
  assert.ok(disk.writes.length > 1); assert.deepEqual([...disk.values], [])
  const retry = prepared.stage(disk, () => true); retry.rollback(); assert.deepEqual([...disk.values], [])
})

test('a live staged transaction cannot be implicitly rolled back by a second import in the same context', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); const first = prepared.stage(disk, () => true); const before = [...disk.values]
  assert.throws(() => prepared.stage(disk, () => true), /已有草稿导入/); assert.deepEqual([...disk.values], before)
  first.commit(); assert.equal(prepared.stage(disk, () => true).commit().alreadyImported, true)
})

test('recovery invalidates stale handles even if a later stage reuses exactly the same serialized journal', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); const old = prepared.stage(disk, () => true); const journal = disk.getItem(draftMigrationJournalKey)
  recoverDraftImport(disk); assert.deepEqual([...disk.values], [])
  const current = prepared.stage(disk, () => true); assert.equal(disk.getItem(draftMigrationJournalKey), journal); const before = [...disk.values]
  assert.throws(() => old.commit(), /事务或恢复日志已改变/); assert.throws(() => old.rollback(), /事务已失效/); assert.deepEqual([...disk.values], before)
  current.commit(); assert.equal(collectDrafts(disk).length, 7)
})

test('new legacy aliases and changed receipt history veto finalization while preserving external additions', async () => {
  const entry = { key: noteDraftStorageKey('notes', 'one'), value: note('incoming') }; const prepared = await prepareDraftImport(await createDraftArchive([entry], source), fingerprint)
  const aliases = storage(); const pendingAlias = prepared.stage(aliases, () => true); aliases.setItem('widget-note:one', note('external legacy'))
  assert.throws(() => pendingAlias.commit(), /兼容别名/); assert.equal(aliases.getItem(entry.key), null); assert.equal(aliases.getItem('widget-note:one'), note('external legacy')); assert.equal(aliases.getItem(draftMigrationJournalKey), null)
  const history = storage(); const pendingHistory = prepared.stage(history, () => true); const other = JSON.stringify([{ id: 'another-import', sha256: 'b'.repeat(64) }]); history.setItem(draftMigrationReceiptsKey, other)
  assert.throws(() => pendingHistory.commit(), /回执.*发生变化/); assert.equal(history.getItem(draftMigrationReceiptsKey), other); assert.equal(history.getItem(entry.key), null)
})

test('a replaced recovery journal is never discarded or used to roll back an unowned transaction', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); const pending = prepared.stage(disk, () => true)
  disk.setItem(draftMigrationJournalKey, '{external-journal'); const before = [...disk.values]
  assert.throws(() => pending.commit(), /回滚未完成/); assert.deepEqual([...disk.values], before); assert.equal(disk.getItem(draftMigrationReceiptsKey), null)
  assert.throws(() => pending.rollback(), /事务已失效/); assert.throws(() => recoverDraftImport(disk)); assert.deepEqual([...disk.values], before)
})

test('false, missing and asynchronous guards cannot grant a synchronous stage or commit', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint)
  for (const guard of [() => false, () => undefined, () => 'true', async () => true]) {
    const disk = storage(); assert.throws(() => prepared.stage(disk, guard), /维护屏障已失效/); assert.deepEqual(disk.writes, [])
  }
  const disk = storage(); let guard = () => true; const pending = prepared.stage(disk, () => guard()); guard = async () => true
  assert.throws(() => pending.commit(), /维护屏障已失效/); assert.deepEqual([...disk.values], [])
})

test('a receipt published during the final pre-stage guard is retained and never overwritten', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); let checks = 0
  const external = JSON.stringify([{ id: 'concurrent', sha256: 'b'.repeat(64) }])
  assert.throws(() => prepared.stage(disk, () => { if (++checks === 2) disk.setItem(draftMigrationReceiptsKey, external); return true }), /出现另一事务/)
  assert.deepEqual([...disk.values], [[draftMigrationReceiptsKey, external]])
})

test('legacy and scoped drafts already present together in the source remain lossless in a staged import', async () => {
  const entries = [{ key: 'widget-note:one', value: note('legacy source') }, { key: noteDraftStorageKey('notes', 'one'), value: note('scoped source') }]
  const prepared = await prepareDraftImport(await createDraftArchive(entries, source), fingerprint); const disk = storage()
  assert.equal(prepared.stage(disk, () => true).commit().importedKeys.length, 2)
  for (const entry of entries) assert.equal(disk.getItem(entry.key), entry.value)
})

test('storage becoming unreadable during a write retains recovery data without leaving a permanent in-memory transaction lock', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage()
  const originalGet = disk.getItem; const originalSet = disk.setItem; let unreadable = false
  disk.getItem = key => { if (unreadable) throw Error('storage now unavailable'); return originalGet(key) }
  disk.setItem = (key, value) => { originalSet(key, value); if (key === sample()[0].key) { unreadable = true; throw Error('storage now unavailable') } }
  assert.throws(() => prepared.stage(disk, () => true), /回滚未完成/); assert.ok(originalGet(draftMigrationJournalKey)); assert.equal(originalGet(draftMigrationReceiptsKey), null)
  unreadable = false; disk.setItem = originalSet
  assert.equal(prepared.stage(disk, () => true).commit().importedKeys.length, 7); assert.equal(disk.getItem(draftMigrationJournalKey), null)
})

test('an already-imported staged result is not reusable after its receipt or recovery state is changed', async () => {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint); const disk = storage(); prepared.stage(disk, () => true).commit()
  const repeated = prepared.stage(disk, () => true); assert.equal(repeated.result.alreadyImported, true); disk.removeItem(draftMigrationReceiptsKey)
  assert.throws(() => repeated.commit(), /回执或恢复状态发生变化/); assert.equal(collectDrafts(disk).length, 7)
})

test('large staged batches do not copy the full journal or receipt history once per imported key', async () => {
  const entries = Array.from({ length: 5000 }, (_, index) => ({ key: 'widget-note:batch-' + index, value: '{"saved":true}' }))
  const prepared = await prepareDraftImport(await createDraftArchive(entries, source), fingerprint); const disk = storage(); const original = disk.getItem; const reads = new Map()
  disk.getItem = key => { reads.set(key, (reads.get(key) ?? 0) + 1); return original(key) }
  assert.equal(prepared.stage(disk, () => true).commit().importedKeys.length, 5000)
  assert.ok(reads.get(draftMigrationJournalKey) < 15); assert.ok(reads.get(draftMigrationReceiptsKey) < 15)
})

async function nativeStage(disk = storage()) {
  const prepared = await prepareDraftImport(await createDraftArchive(sample(), source), fingerprint)
  const transaction = prepared.stage(disk, () => true)
  const decision = { archiveId: prepared.id, payloadSha256: prepared.sha256, journalSha256: await draftDigest(disk.getItem(draftMigrationJournalKey)), decision: 'commit' }
  return { disk, transaction, decision }
}

test('native commit recovery preserves staged values, records completion and never replays a consumed draft', async () => {
  const { disk, transaction, decision } = await nativeStage()
  await recoverNativeDraftImport(disk, decision); assert.equal(collectDrafts(disk).length, 7); assert.equal(disk.getItem(draftMigrationJournalKey), null)
  assert.equal(JSON.parse(disk.getItem(draftMigrationReceiptsKey))[0].id, decision.archiveId)
  assert.throws(() => transaction.commit(), /事务或恢复日志已改变/)
  disk.removeItem(taskDraftStorageKey); await recoverNativeDraftImport(disk, decision); assert.equal(disk.getItem(taskDraftStorageKey), null)
})

test('native abort recovery removes only unchanged staged values and cannot reverse a committed receipt', async () => {
  const { disk, decision } = await nativeStage(); const later = JSON.stringify({ title: 'later', requestId: 'later' }); disk.setItem(taskDraftStorageKey, later)
  await recoverNativeDraftImport(disk, { ...decision, decision: 'abort' }); assert.deepEqual(collectDrafts(disk), [{ key: taskDraftStorageKey, value: later }]); assert.equal(disk.getItem(draftMigrationReceiptsKey), null)
  const committed = await nativeStage(); await recoverNativeDraftImport(committed.disk, committed.decision); const before = [...committed.disk.values]
  await assert.rejects(recoverNativeDraftImport(committed.disk, { ...committed.decision, decision: 'abort' }), /中止冲突/); assert.deepEqual([...committed.disk.values], before)
})

test('native commit failures preserve the irreversible decision journal instead of applying generic rollback', async () => {
  for (const failure of ['receipt', 'cleanup']) {
    const { disk, decision } = await nativeStage()
    if (failure === 'receipt') disk.blockWrite(key => key === draftMigrationReceiptsKey)
    else disk.blockRemove(key => key === draftMigrationJournalKey)
    await assert.rejects(recoverNativeDraftImport(disk, decision), /fixture/)
    assert.equal(collectDrafts(disk).length, 7); assert.ok(disk.getItem(draftMigrationJournalKey))
    assert.equal(Boolean(disk.getItem(draftMigrationReceiptsKey)), failure === 'cleanup')
    disk.blockWrite(() => false); disk.blockRemove(() => false); await recoverNativeDraftImport(disk, decision)
    assert.equal(disk.getItem(draftMigrationJournalKey), null); assert.equal(collectDrafts(disk).length, 7)
  }
})

test('unknown native decisions, changed raw journals and missing committed data cannot authorize recovery', async () => {
  for (const change of ['pending', 'hash', 'payload', 'changed-value', 'missing-journal']) {
    const { disk, decision } = await nativeStage()
    if (change === 'pending') decision.decision = 'pending'
    if (change === 'hash') decision.journalSha256 = 'b'.repeat(64)
    if (change === 'payload') decision.payloadSha256 = 'c'.repeat(64)
    if (change === 'changed-value') disk.setItem(taskDraftStorageKey, JSON.stringify({ title: 'later', requestId: 'changed' }))
    if (change === 'missing-journal') disk.removeItem(draftMigrationJournalKey)
    const before = [...disk.values]; await assert.rejects(recoverNativeDraftImport(disk, decision)); assert.deepEqual([...disk.values], before)
  }
})

test('native recovery rejects a journal replaced during asynchronous digest verification', async () => {
  const { disk, decision } = await nativeStage(); const recovering = recoverNativeDraftImport(disk, decision)
  disk.setItem(draftMigrationJournalKey, '{replaced'); const before = [...disk.values]
  await assert.rejects(recovering, /校验期间发生变化/); assert.deepEqual([...disk.values], before)
})

test('a native durable journal restores browser data lost before disk flush without overwriting later inputs', async () => {
  const { disk, decision } = await nativeStage(); decision.recoveryJournal = disk.getItem(draftMigrationJournalKey)
  disk.values.clear(); await recoverNativeDraftImport(disk, decision)
  assert.equal(collectDrafts(disk).length, 7); assert.ok(disk.getItem(draftMigrationReceiptsKey)); assert.equal(disk.getItem(draftMigrationJournalKey), null)
  const changed = storage([{ key: taskDraftStorageKey, value: JSON.stringify({ title: 'new', requestId: 'newer' }) }]); const before = [...changed.values]
  await assert.rejects(recoverNativeDraftImport(changed, decision), /目标新内容冲突/); assert.deepEqual([...changed.values], before)
  const aborted = storage(sample()); await recoverNativeDraftImport(aborted, { ...decision, decision: 'abort' }); assert.deepEqual([...aborted.values], [])
})

test('a browser receipt cannot hide missing values before native completion, while completed consumption remains idempotent', async () => {
  const { disk, decision } = await nativeStage(); decision.recoveryJournal = disk.getItem(draftMigrationJournalKey)
  disk.values.clear(); disk.setItem(draftMigrationReceiptsKey, JSON.stringify([{ id: decision.archiveId, sha256: decision.payloadSha256 }]))
  await recoverNativeDraftImport(disk, { ...decision, completed: false }); assert.equal(collectDrafts(disk).length, 7)
  disk.removeItem(taskDraftStorageKey); await recoverNativeDraftImport(disk, { ...decision, completed: true }); assert.equal(disk.getItem(taskDraftStorageKey), null)
})

test('a completed native abort never replays its recovery copy over later identical input', async () => {
  const { disk, decision } = await nativeStage()
  const original = disk.getItem(taskDraftStorageKey)
  decision.recoveryJournal = disk.getItem(draftMigrationJournalKey)
  await recoverNativeDraftImport(disk, { ...decision, decision:'abort' })
  disk.setItem(taskDraftStorageKey, original)
  const before = [...disk.values]
  await recoverNativeDraftImport(disk, { ...decision, decision:'abort', completed:true })
  assert.deepEqual([...disk.values], before)
  await recoverNativeDraftImport(disk, { ...decision, decision:'abort', completed:true })
  assert.deepEqual([...disk.values], before)
})
