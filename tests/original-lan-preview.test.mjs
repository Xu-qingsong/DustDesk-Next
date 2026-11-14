import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, stat, rename, rm, truncate } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import ts from 'typescript'
import { draftModuleUrl } from './draft-module.mjs'

async function load(name) {
  const source = ts.transpileModule(await readFile(new URL('./reference/src/main/' + name + '.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll("'../shared/draftMigration'", JSON.stringify(draftModuleUrl))
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}
const barrier = await load('originalLanPreview')
const { createDraftMaintenance } = await load('draftMaintenance')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const identity = async file => { const s = await stat(file, { bigint: true }); return { volume: Number(s.dev), index: s.ino.toString(16).padStart(16, '0') } }
async function fixture(initialized = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-lan-fence-')), userData = path.join(root, 'profile')
  await mkdir(userData)
  const fence = { format: 'dustdesk-original-lan-preview-fence', version: 1, requestId: randomUUID(), preparationId: randomUUID(), runtimeId: randomUUID(), ownershipId: randomUUID(), installation: root, data: path.join(root, 'data'), userData, workspaceSha256: hash('workspace') }
  const checkpoint = { format: 'dustdesk-lan-original-checkpoint', version: 1, appProfile: await identity(userData), lanProfile: null, state: null, originalIdentity: null }
  const lan = path.join(userData, 'LanTransfers')
  if (initialized) {
    await mkdir(lan); checkpoint.lanProfile = await identity(lan)
    for (const name of ['state.json', 'identity.json']) await writeFile(path.join(lan, name), name)
    const proof = async name => { const file = path.join(lan, name), bytes = await readFile(file); return { stamp: { identity: await identity(file), size: bytes.length }, sha256: hash(bytes) } }
    checkpoint.state = await proof('state.json'); checkpoint.originalIdentity = { file: await proof('identity.json') }
  }
  const proof = { kind: 'handback', checkpoint, receipt: { ownershipId: fence.ownershipId, intentSha256: hash('intent'), compatibleRuntime: 'dustdesk-electron-lan-protocol-1', productionReady: false, migrationComplete: false, checkpoint } }
  const cleanup = () => rm(root, { recursive: true, force: true })
  return { root, fence, proof, lan, cleanup }
}

test('persistent fence survives a fresh reader and blocks all maintenance write admission until authenticated release', async () => {
  const f = await fixture()
  try {
    barrier.requireOriginalLanReleased(f.fence.userData)
    await barrier.writeOriginalLanFence(f.fence)
    const fresh = await load('originalLanPreview')
    assert.deepEqual(await fresh.readOriginalLanFence(f.fence.userData), f.fence)
    await assert.rejects(fresh.assertOriginalLanReleased(f.fence.userData), /尚未完成原生交还/)
    const service = createDraftMaintenance(new EventEmitter(), 5000, 'file:///app/index.html', () => fresh.requireOriginalLanReleased(f.fence.userData))
    assert.throws(service.requireInteractive, /尚未完成原生交还/)
    assert.throws(service.requireWritable, /尚未完成原生交还/)
    await assert.rejects(barrier.writeOriginalLanFence({ ...f.fence, ownershipId: randomUUID() }), /EEXIST/)
    await fresh.clearOriginalLanFence(f.fence, f.proof)
    service.requireInteractive(); service.requireWritable()
  } finally { await f.cleanup() }
})

test('wrong ownership, checkpoint, optimistic flags and changed fence keep the restart barrier', async () => {
  const f = await fixture()
  try {
    await barrier.writeOriginalLanFence(f.fence)
    for (const mutate of [p => { p.receipt.ownershipId = randomUUID() }, p => { p.receipt.productionReady = true }, p => { p.receipt.checkpoint.state.sha256 = hash('foreign') }, p => { p.kind = 'unknown' }]) {
      const proof = structuredClone(f.proof); mutate(proof)
      await assert.rejects(barrier.clearOriginalLanFence(f.fence, proof))
      assert.deepEqual(await barrier.readOriginalLanFence(f.fence.userData), f.fence)
    }
    await assert.rejects(barrier.clearOriginalLanFence({ ...f.fence, requestId: randomUUID() }, f.proof), /记录已改变/)
  } finally { await f.cleanup() }
})

test('same content replacement, altered bytes and oversized current file all preserve the fence', async () => {
  for (const change of ['replacement', 'bytes', 'oversize']) {
    const f = await fixture()
    try {
      await barrier.writeOriginalLanFence(f.fence)
      const state = path.join(f.lan, 'state.json')
      if (change === 'replacement') { await rename(state, state + '.old'); await writeFile(state, 'state.json') }
      else if (change === 'bytes') await writeFile(state, 'STATE.json')
      else await truncate(state, 65 * 1024 * 1024)
      await assert.rejects(barrier.clearOriginalLanFence(f.fence, f.proof), /身份不匹配|大小已变化|文件已变化/)
      await assert.rejects(barrier.assertOriginalLanReleased(f.fence.userData))
    } finally { await f.cleanup() }
  }
})

test('not-started proof leaves absent LAN absent and rejects an unexpected directory', async () => {
  const f = await fixture(false)
  try {
    const proof = { kind: 'notStarted', checkpoint: f.proof.checkpoint }
    await barrier.writeOriginalLanFence(f.fence); await mkdir(f.lan)
    await assert.rejects(barrier.clearOriginalLanFence(f.fence, proof), /目录在交还后出现/)
    await rm(f.lan, { recursive: true }); await barrier.clearOriginalLanFence(f.fence, proof)
    await barrier.assertOriginalLanReleased(f.fence.userData)
  } finally { await f.cleanup() }
})

test('malformed fence is never treated as an absent barrier', async () => {
  const f = await fixture(false)
  try {
    await writeFile(path.join(f.fence.userData, 'OriginalLanPreview.json'), '{')
    await assert.rejects(barrier.readOriginalLanFence(f.fence.userData))
    assert.throws(() => barrier.requireOriginalLanReleased(f.fence.userData), /尚未完成原生交还/)
  } finally { await f.cleanup() }
})
