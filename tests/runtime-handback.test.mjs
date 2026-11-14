import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm, link, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import ts from 'typescript'

async function load() {
  const source = ts.transpileModule(await readFile('tests/reference/src/main/runtimeHandback.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
}
const barrier = await load()
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-whole-fence-')), userData = path.join(root, 'profile')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(userData)
  const id = randomUUID(), identity = { volume: 1, index: '0000000000000001' }
  const fence = { format: 'dustdesk-runtime-handback-fence', version: 1, requestId: randomUUID(), preparationId: randomUUID(), runtimeId: randomUUID(), ownershipId: id,
    installation: root, data: path.join(root, 'data'), userData, workspaceSha256: '1'.repeat(64), runtimePath: path.join(root, 'runtime'), runtimeIdentity: identity,
    browser: { ownershipId: id, path: path.join(root, 'DustDesk-WebView2-' + id), identity, origin: 'http://tauri.localhost' } }
  const receipt = { ownershipId: id, intentSha256: '2'.repeat(64), dataManifestSha256: '3'.repeat(64), workspaceSha256: '4'.repeat(64), browser: fence.browser,
    drafts: { archiveSha256: '5'.repeat(64), archiveBytes: 500, payloadSha256: '6'.repeat(64), archiveId: randomUUID(), entries: 0, browserBinding: '7'.repeat(64) },
    lan: { checkpoint: { format: 'dustdesk-lan-original-checkpoint', version: 1 }, handbackIntentSha256: null }, productionReady: false, migrationComplete: false }
  return { root, fence, receipt, file: path.join(userData, 'RuntimeHandbackPreview.json') }
}
test('whole-runtime barrier survives a fresh reader and cannot be overwritten or released by receipt validation', async t => {
  const f = await fixture(t)
  await barrier.assertRuntimeHandbackReleased(f.fence.userData)
  await barrier.writeRuntimeHandbackFence(f.fence)
  assert.equal((await stat(f.file)).nlink, 1)
  const fresh = await load()
  assert.deepEqual(await fresh.readRuntimeHandbackFence(f.fence.userData), f.fence)
  assert.throws(() => fresh.requireRuntimeHandbackReleased(f.fence.userData), /整体运行交还尚未应用/)
  await assert.rejects(fresh.writeRuntimeHandbackFence({ ...f.fence, requestId: randomUUID() }), { code: 'EEXIST' })
  assert.deepEqual(fresh.verifyRuntimeHandbackReceipt(f.fence, f.receipt), f.receipt)
  await assert.rejects(fresh.assertRuntimeHandbackReleased(f.fence.userData), /保持停止/)
  assert.deepEqual(await readFile(f.file), Buffer.from(JSON.stringify(f.fence)))
})
test('new workspace checkpoint is accepted but ownership, profile, optimistic flags and altered recovered decision are refused', async t => {
  const f = await fixture(t)
  assert.notEqual(f.receipt.workspaceSha256, f.fence.workspaceSha256)
  barrier.verifyRuntimeHandbackReceipt(f.fence, f.receipt, structuredClone(f.receipt))
  for (const mutate of [r => { r.ownershipId = randomUUID() }, r => { r.browser.path += '-replacement' }, r => { r.productionReady = true }, r => { r.drafts.archiveBytes = 64 * 1024 * 1024 + 1 }, r => { r.lan.handbackIntentSha256 = 'bad' }]) {
    const receipt = structuredClone(f.receipt); mutate(receipt)
    assert.throws(() => barrier.verifyRuntimeHandbackReceipt(f.fence, receipt), /无效/)
  }
  assert.throws(() => barrier.verifyRuntimeHandbackReceipt(f.fence, { ...f.receipt, intentSha256: '8'.repeat(64) }, f.receipt), /无效/)
})
test('malformed, oversized and multiply linked barriers remain blocking and cannot authorize recovery', async t => {
  const f = await fixture(t)
  for (const bytes of ['{', JSON.stringify({ ...f.fence, userData: f.root }), ' '.repeat(65537)]) {
    await writeFile(f.file, bytes)
    await assert.rejects(barrier.readRuntimeHandbackFence(f.fence.userData))
    assert.throws(() => barrier.requireRuntimeHandbackReleased(f.fence.userData), /尚未应用/)
  }
  await writeFile(f.file, JSON.stringify(f.fence)); await link(f.file, f.file + '.link')
  await assert.rejects(barrier.readRuntimeHandbackFence(f.fence.userData), /无效/)
})
test('fence creation refuses aliased or non-sibling outputs before publishing a barrier', async t => {
  const f = await fixture(t)
  for (const runtimePath of [f.fence.data, f.fence.userData, path.join(f.root, 'nested', 'runtime')]) {
    await assert.rejects(barrier.writeRuntimeHandbackFence({ ...f.fence, runtimePath }), /无效/)
  }
  await assert.rejects(readFile(f.file), { code: 'ENOENT' })
})
