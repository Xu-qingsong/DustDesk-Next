import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

const directory = path.resolve('artifacts/tauri-migration/original-lan-runtime-final')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const hash = async file => digest(await fs.readFile(file))
const audit = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString() }
try {
  const reportFile = path.join(directory, 'verification.json'), report = JSON.parse(await fs.readFile(reportFile, 'utf8'))
  assert.equal(report.verified, true); assert.equal(report.sourceStable, true)
  assert.equal(report.productionReady, false); assert.equal(report.migrationComplete, false)
  const actual = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'vite.tauri.config.ts', 'tsconfig.json', 'tsconfig.node.json']
  async function visit(root) {
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (['target', 'gen', 'node_modules', '.git'].includes(entry.name)) continue
      const file = path.join(root, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) actual.push(file.replaceAll('\\', '/'))
    }
  }
  for (const root of ['src', 'src-tauri', 'tests', 'scripts']) await visit(root)
  assert.deepEqual([...new Set(actual)].sort(), Object.keys(report.inputs).sort())
  for (const [file, expected] of Object.entries(report.inputs)) assert.equal(await hash(file), expected, file)
  audit.inputCount = actual.length
  assert.equal(report.commands.length, 21)
  let rust = 0, ignored = 0
  for (const command of report.commands) {
    assert.equal(command.code, 0, command.name)
    const text = await fs.readFile(command.log, 'utf8')
    assert.equal(await hash(command.log), command.sha256, command.name)
    assert.equal(/ℹ (?:fail|cancelled|skipped) [1-9]/.test(text), false, command.name)
    if (command.name === 'rust-tests') {
      for (const result of text.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) {
        rust += Number(result[1]); assert.equal(Number(result[2]), 0); ignored += Number(result[3])
      }
      assert.equal((text.match(/original_lan_release_.* \.\.\. ok/g) ?? []).length, 5)
    }
    if (command.evidence) {
      assert.equal(await hash(command.evidence.path), command.evidence.sha256, command.name)
      const evidence = JSON.parse(await fs.readFile(command.evidence.path, 'utf8'))
      if (evidence.verified !== undefined) assert.equal(evidence.verified, true)
      for (const [file, expected] of Object.entries(evidence.inputs ?? {})) if (report.inputs[file]) assert.equal(expected, report.inputs[file], command.name + ': ' + file)
    }
  }
  assert.equal(rust, 536); assert.equal(ignored, 2)
  const integrations = report.commands.filter(c => c.name.startsWith('tauri-') || c.name.startsWith('electron-'))
  assert.equal(integrations.length, 12); assert.equal(integrations.reduce((n, c) => n + c.nodeTests, 0), 57)
  assert.equal(report.commands.find(c => c.name === 'check-silent').nodeTests, 239)
  audit.tests = { node: 235, headless: 4, rust, ignored, integrationSuites: integrations.length, integrationTests: 57 }
  for (const [name, kernel] of [['runtime-owned-workspace', 'artifacts/tauri-migration/runtime-owned-workspace-native/kernel.log'], ['official-reference', 'artifacts/tauri-migration/official-source-kernel/official-reference.log']]) {
    const command = report.commands.find(c => c.name === name), evidence = JSON.parse(await fs.readFile(command.evidence.path, 'utf8'))
    assert.equal(evidence.verified, true)
    if (evidence.startedAt) assert.ok(evidence.startedAt >= report.startedAt)
    const bytes = await fs.readFile(kernel); assert.match(bytes.toString(), /test result: ok\. 1 passed; 0 failed; 0 ignored/)
    await fs.writeFile(path.join(directory, name + '-kernel-copy.log'), bytes)
  }
  for (const [file, expected] of Object.entries(report.executables)) assert.equal(await hash(file), expected, file)
  for (const file of report.processLogs) assert.equal(await hash(file.path), file.sha256)
  assert.deepEqual(report.temporaryRootsAfter, report.temporaryRootsBefore)
  audit.historicalTemporaryRoots = report.temporaryRootsBefore.length
  const native = JSON.parse(await fs.readFile(path.join(directory, 'electron-original-lan-runtime-evidence.json'), 'utf8'))
  assert.equal(native.verified, true); assert.equal(native.scenarios.length, 6)
  assert.equal(native.executableSha256, report.executables['src-tauri/target/debug/dustdesk-tauri.exe'])
  assert.equal(native.activeUpload.prefixBytes, 1024 * 1024); assert.ok(native.activeUpload.bytes > native.activeUpload.prefixBytes)
  const messages = native.sessions.flatMap(s => s.messages ?? [])
  assert.ok(messages.some(m => m.event === 'runtimeOriginalLanReady' && m.enabled === true))
  assert.ok(messages.some(m => m.event === 'runtimeOriginalLanReady' && m.enabled === false))
  assert.ok(messages.some(m => m.event === 'runtimeOriginalLanHandedBack' && m.proof.kind === 'handback'))
  assert.ok(messages.some(m => m.event === 'runtimeOriginalLanHandedBack' && m.proof.kind === 'notStarted'))
  assert.ok(messages.some(m => m.event === 'originalLanReleased' && m.proof.kind === 'handback'))
  assert.ok(native.sessions.some(s => s.notices?.some(n => n.kind === 'startup' && n.windows === 0)))
  audit.activeUpload = native.activeUpload
  const baselinePath = 'artifacts/tauri-migration/original-lan-handback-final/verification.json'
  const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8'))
  assert.equal(report.executables['out/preload/index.js'], baseline.executables['out/preload/index.js'])
  const changes = Object.keys({ ...baseline.inputs, ...report.inputs }).sort().flatMap(file => baseline.inputs[file] === report.inputs[file] ? [] : [{ file, previous: baseline.inputs[file], current: report.inputs[file] }])
  await fs.writeFile(path.join(directory, 'change-scope.json'), JSON.stringify({ baseline: baselinePath, baselineSha256: await hash(baselinePath), changes }, null, 2))
  audit.changeCount = changes.length; audit.verificationSha256 = await hash(reportFile)
  audit.verified = true
} catch (error) { audit.error = String(error.stack ?? error); process.exitCode = 1 }
finally { audit.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, 'evidence-audit.json'), JSON.stringify(audit, null, 2)); console.log(JSON.stringify(audit, null, 2)) }
