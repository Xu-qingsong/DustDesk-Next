import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, link, symlink, rm, readdir } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'
import { recordDraftProvenance, verifyDraftProvenance } from './draft-lineage-module.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const { createDraftArchive } = await import(draftModuleUrl)
const fingerprint = 'a'.repeat(64)
const makeArchive = () => createDraftArchive([{ key: 'widget-task-draft:v1:todo', value: JSON.stringify({ title: '持久原生草稿🪶', requestId: 'stable-native-request' }) }], { runtime: 'electron', appVersion: '1.0.2', workspaceFingerprint: fingerprint })
const options = { skip: process.platform !== 'win32' }
async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-lineage-test-'))
  const ownership = await acquireWorkspaceOwnership(path.join(root, 'Data'))
  const location = path.join(ownership.root, 'MigrationLineage', 'lineage.json')
  try { await callback({ root, ownership, location }) } finally { await ownership.release(); await rm(root, { recursive: true, force: true }) }
}
test('native export receipts persist exact archive bytes, native checkpoint and workspace identity across re-acquisition', options, async () => fixture(async ({ ownership, location }) => {
  const serialized = await makeArchive()
  await assert.rejects(verifyDraftProvenance(ownership, serialized, fingerprint), /谱系/)
  const provenance = await recordDraftProvenance(ownership, serialized, fingerprint)
  assert.equal(provenance.archiveSha256, createHash('sha256').update(serialized).digest('hex'))
  assert.equal(provenance.workspaceFingerprint, fingerprint)
  assert.deepEqual(await recordDraftProvenance(ownership, serialized, fingerprint), provenance)
  const ledger = JSON.parse(await readFile(location, 'utf8'))
  assert.equal(ledger.exports.length, 1); assert.deepEqual(ledger.root, ownership.identity)
  assert.equal(JSON.stringify(ledger).includes('持久原生草稿'), false)
  await ownership.release()
  const restarted = await acquireWorkspaceOwnership(ownership.root)
  try { assert.deepEqual(await verifyDraftProvenance(restarted, serialized, fingerprint), provenance) } finally { await restarted.release() }
}))
test('valid archive digests cannot self-authorize, reformat, forge an existing id or change the native checkpoint', options, async () => fixture(async ({ ownership }) => {
  const serialized = await makeArchive(); await recordDraftProvenance(ownership, serialized, fingerprint)
  await assert.rejects(verifyDraftProvenance(ownership, await makeArchive(), fingerprint), /谱系/)
  await assert.rejects(verifyDraftProvenance(ownership, JSON.stringify(JSON.parse(serialized), null, 2), fingerprint), /谱系/)
  const archive = JSON.parse(serialized); const payload = JSON.parse(archive.payload); payload.entries[0].value = JSON.stringify({ title: 'forged', requestId: 'stable-native-request' })
  archive.payload = JSON.stringify(payload); archive.sha256 = createHash('sha256').update(archive.payload).digest('hex')
  await assert.rejects(recordDraftProvenance(ownership, JSON.stringify(archive), fingerprint), /谱系/)
  await assert.rejects(verifyDraftProvenance(ownership, JSON.stringify(archive), fingerprint), /谱系/)
  await assert.rejects(recordDraftProvenance(ownership, serialized, 'b'.repeat(64)), /谱系/)
}))
test('copying a native receipt to another directory does not transfer its authority', options, async () => fixture(async ({ root, ownership, location }) => {
  const serialized = await makeArchive(); await recordDraftProvenance(ownership, serialized, fingerprint)
  const other = await acquireWorkspaceOwnership(path.join(root, 'Other'))
  try {
    await mkdir(path.join(other.root, 'MigrationLineage')); await copyFile(location, path.join(other.root, 'MigrationLineage', 'lineage.json'))
    await assert.rejects(verifyDraftProvenance(other, serialized, fingerprint), /谱系/)
    await assert.rejects(recordDraftProvenance(other, await makeArchive(), fingerprint), /谱系/)
  } finally { await other.release() }
}))
test('concurrent native exports serialize without losing receipts and retain one workspace id', options, async () => fixture(async ({ ownership, location }) => {
  const archives = await Promise.all(Array.from({ length: 12 }, makeArchive))
  const receipts = await Promise.all(archives.map(serialized => recordDraftProvenance(ownership, serialized, fingerprint)))
  assert.equal(new Set(receipts.map(receipt => receipt.workspaceId)).size, 1)
  assert.equal(JSON.parse(await readFile(location, 'utf8')).exports.length, 12)
  for (const [index, serialized] of archives.entries()) assert.deepEqual(await verifyDraftProvenance(ownership, serialized, fingerprint), receipts[index])
  assert.deepEqual((await readdir(path.dirname(location))).sort(), ['lineage.json'])
}))
test('corrupt, future, unknown and duplicate native receipts are preserved rather than reset', options, async () => fixture(async ({ ownership, location }) => {
  const serialized = await makeArchive(); await recordDraftProvenance(ownership, serialized, fingerprint)
  const original = JSON.parse(await readFile(location, 'utf8'))
  for (const changed of ['not json', JSON.stringify({ ...original, version: 2 }), JSON.stringify({ ...original, unknown: true }), JSON.stringify({ ...original, exports: [original.exports[0], original.exports[0]] })]) {
    await writeFile(location, changed)
    await assert.rejects(recordDraftProvenance(ownership, serialized, fingerprint))
    assert.equal(await readFile(location, 'utf8'), changed)
  }
}))
test('native receipt links and junctions cannot redirect writes or authorize another file', options, async () => fixture(async ({ root, ownership, location }) => {
  const serialized = await makeArchive(); await recordDraftProvenance(ownership, serialized, fingerprint)
  const original = await readFile(location, 'utf8'); const external = path.join(root, 'external.json'); await writeFile(external, original)
  await rm(location); await link(external, location)
  await assert.rejects(verifyDraftProvenance(ownership, serialized, fingerprint), /谱系/)
  await rm(location)
  await rm(path.dirname(location), { recursive: true }); const redirected = path.join(root, 'redirected'); await mkdir(redirected); await symlink(redirected, path.dirname(location), 'junction')
  await assert.rejects(recordDraftProvenance(ownership, serialized, fingerprint), /链接/)
  assert.equal(await readFile(external, 'utf8'), original); assert.deepEqual(await readdir(redirected), [])
}))
test('released ownership and an obstructed ledger fail without introducing temporary files', options, async () => fixture(async ({ ownership, location }) => {
  const serialized = await makeArchive(); await mkdir(location, { recursive: true })
  await assert.rejects(recordDraftProvenance(ownership, serialized, fingerprint))
  assert.deepEqual(await readdir(path.dirname(location)), ['lineage.json'])
  await ownership.release()
  await assert.rejects(recordDraftProvenance(ownership, serialized, fingerprint), /独占/)
}))
test('receipt capacity is explicit and never silently prunes trusted history', options, async () => fixture(async ({ ownership, location }) => {
  await recordDraftProvenance(ownership, await makeArchive(), fingerprint)
  const ledger = JSON.parse(await readFile(location, 'utf8')); const template = ledger.exports[0]
  ledger.exports = Array.from({ length: 4096 }, () => ({ ...template, archiveId: randomUUID() }))
  const full = JSON.stringify(ledger); await writeFile(location, full)
  await assert.rejects(recordDraftProvenance(ownership, await makeArchive(), fingerprint), /4096/)
  assert.equal(await readFile(location, 'utf8'), full)
}))
