import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const directory = 'artifacts/tauri-migration/runtime-handback-browser-final'
const reportPath = path.join(directory, 'verification.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = {
  verified: false, productionReady: false, migrationComplete: false, nativeBrowserSealConnected: true, desktopHandbackConnected: false, failures: [],
  startedAt: new Date().toISOString(), commands: [],
  scope: 'Debug TEMP native final read of the actual quarantined WebView2, retained latest Data and exact draft seal, actual original LAN drain, real post-decision kill and read-only cold recovery. Data edits are file fixtures, not ordinary editor saves. Cold recovery does not reread restarted localStorage. No original Electron Data/Session application, desktop maintenance handback, ordinary business activation, production cutover or full rollback.'
}
await fs.mkdir(directory)
const roots = async () => (await fs.readdir(os.tmpdir(), { withFileTypes: true }))
  .filter(entry => entry.isDirectory() && entry.name.startsWith('dustdesk-')).map(entry => entry.name).sort()
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
    child.stdout.on('data', bytes => chunks.push(bytes))
    child.stderr.on('data', bytes => chunks.push(bytes))
    child.once('error', reject)
    child.once('close', resolve)
  })
  const bytes = Buffer.concat(chunks), text = bytes.toString('utf8'), log = path.join(directory, name + '.log')
  await fs.writeFile(log, bytes)
  const step = { name, command, code, startedAt, finishedAt: new Date().toISOString(), log, sha256: digest(bytes), nodeTests: [...text.matchAll(/ℹ tests (\d+)/g)].reduce((sum, match) => sum + Number(match[1]), 0) }
  report.commands.push(step)
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  assert.equal(code, 0, name + ' failed; inspect ' + log)
  assert.equal(/ℹ (?:fail|cancelled|skipped) [1-9]/.test(text), false, name)
  if (name === 'rust-tests') {
    const results = [...text.matchAll(/test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
    assert.equal(results.reduce((sum, match) => sum + Number(match[1]), 0), 542)
    assert.equal(results.reduce((sum, match) => sum + Number(match[2]), 0), 0)
    assert.equal(results.reduce((sum, match) => sum + Number(match[3]), 0), 2)
    assert.equal((text.match(/runtime_handback::runtime_handback_.* \.\.\. ok/g) ?? []).length, 6)
  }
  if (evidence) {
    const source = path.join('artifacts/tauri-migration', evidence), bytes = await fs.readFile(source)
    const parsed = JSON.parse(bytes)
    assert.equal(parsed.verified, true, source)
    if (parsed.startedAt) assert.ok(parsed.startedAt >= report.startedAt, source)
    for (const [file, expected] of Object.entries(parsed.inputs ?? {})) if (report.inputs[file]) assert.equal(expected, report.inputs[file], source + ': ' + file)
    const target = path.join(directory, name + '-evidence.json')
    await fs.writeFile(target, bytes)
    step.evidence = { path: target, sha256: digest(bytes) }
  }
  console.log('Passed ' + name)
}
async function attempt(...args) {
  try { await run(...args) }
  catch (error) {
    report.failures.push({ name: args[0], error: String(error.stack ?? error) })
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
    console.log('Failed ' + args[0] + '; continuing independent checks')
  }
}
try {
  report.inputs = await inputs()
  report.temporaryRootsBefore = await roots()
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
  ]) await attempt(suite, 'node --test --test-concurrency=1 tests/' + suite + '.mjs', evidence)
  assert.equal(report.commands.length, 14)
  assert.equal(report.commands.find(step => step.name === 'check-silent').nodeTests, 239)
  assert.equal(report.commands.filter(step => /^(electron|tauri)-/.test(step.name)).reduce((sum, step) => sum + step.nodeTests, 0), 30)
  assert.deepEqual(await inputs(), report.inputs)
  report.sourceStable = true
  report.temporaryRootsAfter = await roots()
  assert.deepEqual(report.temporaryRootsAfter, report.temporaryRootsBefore)
  report.executables = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.js', 'src-tauri/target/debug/dustdesk-tauri.exe', 'src-tauri/target/debug/examples/original-lan-recovery.exe'].map(async file => [file, digest(await fs.readFile(file))])))
  for (const step of report.commands) {
    assert.equal(digest(await fs.readFile(step.log)), step.sha256)
    if (step.evidence) assert.equal(digest(await fs.readFile(step.evidence.path)), step.evidence.sha256)
  }
  const baseline = 'artifacts/tauri-migration/runtime-handback-kernel-final/verification.json'
  report.baseline = { path: baseline, sha256: digest(await fs.readFile(baseline)) }
  report.verified = report.failures.length === 0
  if (!report.verified) process.exitCode = 1
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ verified: report.verified, reportPath, error: report.error }))
}
