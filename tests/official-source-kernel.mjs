import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

const directory = 'artifacts/tauri-migration/official-source-kernel'
await fs.mkdir(directory, { recursive: true })
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-lan-grant-reference-'))
const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString() }
try {
  const reference = await extractOfficialLegacyReference(root)
  report.reference = reference.release
  const name = 'legacy_source::tests::official_release_bytes_match_compiled_trust_without_reading_production_data'
  const chunks = []
  const code = await new Promise((resolve, reject) => {
    const child = spawn('cargo', ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', name, '--', '--exact', '--include-ignored', '--nocapture'], { windowsHide: true, env: { ...process.env, DUSTDESK_LEGACY_REFERENCE: reference.root }, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
    child.once('error', reject); child.once('close', resolve)
  })
  const bytes = Buffer.concat(chunks), log = path.join(directory, 'official-reference.log')
  await fs.writeFile(log, bytes)
  assert.equal(code, 0)
  assert.match(bytes.toString('utf8'), /test result: ok\. 1 passed; 0 failed; 0 ignored/)
  report.log = { path: log, sha256: await fileDigest(log) }
  report.tests = 1
  report.verified = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
  assert.match(path.basename(root), /^dustdesk-lan-grant-reference-[A-Za-z0-9]+$/)
  assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
  await fs.rm(root, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
}
