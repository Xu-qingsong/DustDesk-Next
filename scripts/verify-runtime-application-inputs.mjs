import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const directory = 'artifacts/tauri-migration/runtime-application-inputs-final'
const reportPath = path.join(directory, 'verification.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = {
  verified: false, productionReady: false, migrationComplete: false, desktopSealConnected: true, applicationInputsConnected: true, originalDataSessionApplicationConnected: false,
  startedAt: new Date().toISOString(), commands: [], failures: [],
  scope: 'Debug TEMP durable complete application inputs, pinned-handle Data copy and exact overwrite/deletion draft plan. Actual WebView2 final read, terminal host exit and native receiver re-acquisition, real post-preparation SIGKILL and two immutable cold recoveries for each closure. Includes Electron persisted admission barrier and original LAN regressions. Runtime Data edits remain file fixtures; original Electron archive is a test fixture in this browser suite. No original Data/Session application, control-record rebinding, ordinary Tauri business activation, production cutover or full rollback.'
}
await fs.mkdir(directory)
const roots = async () => (await fs.readdir(os.tmpdir(), { withFileTypes: true })).filter(e => e.isDirectory() && e.name.startsWith('dustdesk-')).map(e => e.name).sort()
async function inputs() {
  const files = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'vite.tauri.config.ts', 'tsconfig.json', 'tsconfig.node.json']
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['target', 'gen', 'node_modules', '.git'].includes(entry.name)) continue
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(file)
      else if (entry.isFile()) files.push(file.replaceAll('\\', '/'))
    }
  }
  for (const directory of ['src', 'src-tauri', 'tests', 'scripts']) await visit(directory)
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async file => [file, digest(await fs.readFile(file))])))
}
async function run(name, command, evidence) {
  console.log('Starting ' + name)
  const chunks = [], startedAt = new Date().toISOString()
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
    child.once('error', reject); child.once('close', resolve)
  })
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'), log = path.join(directory, name + '.log')
  await fs.writeFile(log, bytes)
  const step = { name, command, code, startedAt, finishedAt: new Date().toISOString(), log, sha256: digest(bytes), nodeTests: [...text.matchAll(/ℹ tests (\d+)/g)].reduce((sum, m) => sum + Number(m[1]), 0) }
  report.commands.push(step)
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  assert.equal(code, 0, name + ' failed; inspect ' + log)
  assert.equal(/ℹ (?:fail|cancelled|skipped) [1-9]/.test(text), false, name)
  if (name === 'rust-tests') {
    const results = [...text.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
    assert.equal(results.reduce((n, m) => n + Number(m[1]), 0), 549)
    assert.equal(results.reduce((n, m) => n + Number(m[2]), 0), 0)
    assert.equal(results.reduce((n, m) => n + Number(m[3]), 0), 2)
  }
  if (evidence) {
    const source = path.join('artifacts/tauri-migration', evidence), bytes = await fs.readFile(source), parsed = JSON.parse(bytes)
    assert.equal(parsed.verified, true, source)
    if (parsed.startedAt) assert.ok(parsed.startedAt >= report.startedAt, source)
    for (const [file, expected] of Object.entries(parsed.inputs ?? {})) if (report.inputs[file]) assert.equal(expected, report.inputs[file], source + ': ' + file)
    if (name === 'tauri-runtime-bootstrap') {
      assert.equal(parsed.applications.length, 2)
      assert.deepEqual(parsed.applications.map(item => item.killedAfterPreparation), [false, true])
      for (const item of parsed.applications) {
        assert.equal(item.coldRecoveries, 2)
        assert.equal(item.applicationApplied, false)
        for (const flag of ['applicationReady', 'originalDataApplied', 'sessionApplied', 'productionReady', 'migrationComplete']) assert.equal(item.receipt[flag], false)
        assert.deepEqual(item.plan.find(change => change.key === 'widget-note:removed'), { key: 'widget-note:removed', before: '{"saved":true}', after: null })
      }
    }
    if (name === 'electron-runtime-handback') {
      assert.equal(parsed.checks.length, 3)
      assert.equal(parsed.normal.listenerClosed, true)
      assert.notEqual(parsed.normal.hostPid, parsed.normal.independentReceiverPid)
      assert.equal(parsed.restart.ordinaryWindowsAtPrompt, 0)
      assert.ok(parsed.changedAssetRejection)
    }
    const target = path.join(directory, name + '-evidence.json')
    await fs.writeFile(target, bytes); step.evidence = { path: target, sha256: digest(bytes) }
    if (parsed.log) {
      const bytes = await fs.readFile(parsed.log.path)
      assert.equal(digest(bytes), parsed.log.sha256)
      const target = path.join(directory, name + '-native.log')
      await fs.writeFile(target, bytes); step.supportingEvidence = { path: target, sha256: digest(bytes) }
    }
    if (name === 'electron-runtime-handback') {
      step.events = []
      for (const event of parsed.events) {
        const bytes = await fs.readFile(event.path), target = path.join(directory, path.basename(event.path))
        assert.equal(digest(bytes), event.sha256)
        await fs.writeFile(target, bytes); step.events.push({ path: target, sha256: digest(bytes) })
      }
      assert.equal(step.events.length, 3)
    }
  }
  console.log('Passed ' + name)
}
async function attempt(...args) {
  try { await run(...args) }
  catch (error) { report.failures.push({ name: args[0], error: String(error.stack ?? error) }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log('Failed ' + args[0] + '; continuing independent checks') }
}
try {
  const historyFiles = (await fs.readdir('artifacts/tauri-migration', { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.startsWith('runtime-application-') && entry.name.endsWith('.log') && !entry.name.includes('-final'))
    .map(entry => path.join('artifacts/tauri-migration', entry.name))
  for (const attempt of ['attempt-1', 'attempt-2']) for (const file of ['browser.log', 'verification.json', 'fixture.mjs']) historyFiles.push(path.join('artifacts/tauri-migration/runtime-application-inputs-development', attempt, file))
  for (const file of ['runtime-application-directory-probe.ps1', 'runtime-application-directory-probe.json']) historyFiles.push(path.join('artifacts/tauri-migration', file))
  const history = { scope: 'Development failures, corrected browser fixture and native directory probe; these do not replace the frozen verification below.', records: await Promise.all(historyFiles.sort().map(async file => ({ path: file, sha256: digest(await fs.readFile(file)) }))) }
  const historyPath = path.join(directory, 'history.json'), historyBytes = Buffer.from(JSON.stringify(history, null, 2))
  await fs.writeFile(historyPath, historyBytes); report.history = { path: historyPath, sha256: digest(historyBytes) }
  report.inputs = await inputs(); report.temporaryRootsBefore = await roots()
  await attempt('check-silent', 'npm run check:silent')
  await attempt('main-typecheck', 'npx tsc --noEmit -p tsconfig.node.json')
  await attempt('rust-tests', 'cargo test --manifest-path src-tauri/Cargo.toml --all-targets')
  await attempt('runtime-owned-workspace', 'node tests/runtime-owned-workspace.mjs', 'runtime-owned-workspace-native/report.json')
  await attempt('official-reference', 'node tests/official-source-kernel.mjs', 'official-source-kernel/verification.json')
  await attempt('clippy', 'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings')
  await attempt('release-check', 'cargo check --manifest-path src-tauri/Cargo.toml --release --all-targets')
  await attempt('rust-fmt', 'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check')
  await attempt('debug-build', 'npm run build:tauri -- --debug')
  for (const [suite, evidence] of [
    ['electron-original-lan-runtime', 'electron-original-lan-runtime/verification.json'],
    ['tauri-original-lan-handback', 'original-lan-handback-process/verification.json'],
    ['tauri-original-lan-recovery', 'original-lan-recovery-process/verification.json'],
    ['tauri-runtime-bootstrap', 'runtime-bootstrap-native/verification.json'],
    ['electron-runtime-bootstrap', 'electron-runtime-bootstrap-native/verification.json'],
    ['electron-runtime-handback', 'electron-runtime-handback/verification.json']
  ]) await attempt(suite, 'node --test --test-concurrency=1 tests/' + suite + '.mjs', evidence)
  assert.equal(report.commands.length, 15)
  assert.equal(report.commands.find(s => s.name === 'check-silent').nodeTests, 243)
  assert.deepEqual(report.commands.filter(s => /^(electron|tauri)-/.test(s.name)).map(s => s.nodeTests), [7, 4, 1, 11, 7, 4])
  assert.deepEqual(await inputs(), report.inputs); report.sourceStable = true
  report.temporaryRootsAfter = await roots(); assert.deepEqual(report.temporaryRootsAfter, report.temporaryRootsBefore)
  report.executables = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.js', 'src-tauri/target/debug/dustdesk-tauri.exe', 'src-tauri/target/debug/examples/original-lan-recovery.exe'].map(async file => [file, digest(await fs.readFile(file))])))
  for (const step of report.commands) for (const item of [{ path: step.log, sha256: step.sha256 }, step.evidence, step.supportingEvidence, ...(step.events ?? [])].filter(Boolean)) assert.equal(digest(await fs.readFile(item.path)), item.sha256)
  const baseline = 'artifacts/tauri-migration/runtime-handback-desktop-final/verification.json'
  report.baseline = { path: baseline, sha256: digest(await fs.readFile(baseline)) }
  report.verified = report.failures.length === 0
  if (!report.verified) process.exitCode = 1
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ verified: report.verified, reportPath, error: report.error })) }
