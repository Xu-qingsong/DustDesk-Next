import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

assert.equal(process.platform, 'win32', 'Runtime ownership requires native Windows handles')
const directory = 'artifacts/tauri-migration/runtime-owned-workspace-native'
const sources = ['package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/ownership.rs', 'src-tauri/src/legacy_source/binding/snapshot.rs', 'src-tauri/src/managed_snapshot/preparation.rs', 'src-tauri/src/managed_snapshot/preparation/runtime.rs', 'src-tauri/src/managed_snapshot/preparation/runtime/ownership.rs', 'src-tauri/src/managed_snapshot/runtime_data.rs', 'src-tauri/src/workspace/mod.rs', 'src-tauri/src/workspace/ownership.rs', 'src-tauri/src/workspace/tests/runtime_ownership.rs', 'tests/runtime-owned-workspace.mjs', 'tests/legacy-source-reference.mjs']
sources.push('src-tauri/src/managed_snapshot/bundle.rs', 'src-tauri/src/managed_snapshot/target.rs', 'src-tauri/src/workspace/draft_lineage.rs', 'src-tauri/src/workspace/draft_transaction.rs')
const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), scope: 'Actual Rust desktop WorkspaceStore adopts a nonserializable live RuntimeOwner from official released-code-bound source and native snapshot/runtime decisions, writes and reopens changed runtime Data while keeping original source/snapshot/record handles, holds the real cross-runtime pipe, and rejects access after cancellation. This is the real native storage implementation in its test executable, not GUI startup, browser import, original LAN service takeover, production cutover or rollback.' }
await fs.mkdir(directory, { recursive: true })
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-owned-workspace-'))
let child
try {
  report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
  const reference = await extractOfficialLegacyReference(root)
  report.reference = reference.release
  const chunks = []
  const test = 'workspace::tests::runtime_ownership::runtime_ownership_actual_workspace_adopts_the_original_native_lease_writes_resumes_and_revokes'
  const code = await new Promise((resolve, reject) => {
    child = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', test, '--', '--exact', '--include-ignored', '--nocapture'], { windowsHide: true, env: { ...process.env, DUSTDESK_LEGACY_REFERENCE: reference.root }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { chunks.push(bytes); process.stdout.write(bytes) })
    child.stderr.on('data', bytes => { chunks.push(bytes); process.stderr.write(bytes) })
    child.once('error', reject); child.once('close', resolve)
  })
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8')
  await fs.writeFile(path.join(directory, 'kernel.log'), bytes)
  assert.equal(code, 0, 'Actual runtime-owned workspace kernel failed')
  assert.match(text, new RegExp(test.replaceAll(':', '\\:') + ' \\.\\.\\. ok'))
  assert.match(text, /test result: ok\. 1 passed; 0 failed; 0 ignored/)
  const binary = /Running unittests src[\\/]main\.rs \(([^)]+)\)/.exec(text)?.[1]
  assert.ok(binary, 'Actual desktop native test executable was not observed')
  report.nativeTestExecutable = { path: binary, sha256: await fileDigest(binary) }
  assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs, 'Runtime-owned workspace source changed during verification')
  report.actualNativeStorageTests = 1
  report.desktopExecutableLaunched = false
  report.verified = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await new Promise(resolve => child.once('close', resolve)) }
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()), 'Cleanup target must remain a direct TEMP child')
  assert.match(path.basename(root), /^dustdesk-owned-workspace-[A-Za-z0-9]+$/)
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false, 'Cleanup target cannot be replaced by a link')
  await fs.rm(root, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ verified: report.verified, reportPath: path.join(directory, 'report.json'), error: report.error }))
}
