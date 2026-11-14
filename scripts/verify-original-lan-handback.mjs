import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

const directory = 'artifacts/tauri-migration/original-lan-handback-final'
const reportPath = path.join(directory, 'verification.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), commands: [], scope: 'Frozen-source Debug TEMP original LAN terminal handback with actual joined service drain, latest-state compatibility, pinned original identity and immutable snapshot. Includes official-byte real-process active upload handback and SIGKILL after durable intent/decision, cold upload/resume, all-target Rust, explicit ignored supplements, Clippy, Release check, Debug build and existing Electron/browser/LAN regressions. No desktop original LAN activation, overall workspace/browser handback, production cutover, full rollback, physical two-PC or packaging acceptance.' }
await fs.mkdir(directory, { recursive: true })
async function inputs() {
  const files = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'vite.tauri.config.ts', 'tsconfig.json', 'tsconfig.node.json']
  const visit = async directory => {
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
async function run(name, command) {
  console.log('Starting ' + name)
  const chunks = [], startedAt = new Date().toISOString()
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
    child.once('error', reject); child.once('close', resolve)
  })
  const bytes = Buffer.concat(chunks), log = path.join(directory, name + '.log'), text = bytes.toString('utf8')
  await fs.writeFile(log, bytes)
  report.commands.push({ name, command, code, startedAt, finishedAt: new Date().toISOString(), log, sha256: digest(bytes), nodeTests: [...text.matchAll(/ℹ tests (\d+)/g)].reduce((n, match) => n + Number(match[1]), 0) })
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  assert.equal(code, 0, name + ' failed; inspect ' + log)
  assert.equal(/ℹ (?:fail|cancelled|skipped) [1-9]/.test(text), false, name + ' did not fully pass')
  console.log('Passed ' + name)
}
try {
  report.inputs = await inputs()
  await run('check-silent', 'npm run check:silent')
  await run('main-typecheck', 'npx tsc --noEmit -p tsconfig.node.json')
  await run('rust-tests', 'cargo test --manifest-path src-tauri/Cargo.toml --all-targets')
  await run('runtime-owned-workspace', 'node tests/runtime-owned-workspace.mjs')
  await run('official-reference', 'node tests/official-source-kernel.mjs')
  await run('clippy', 'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings')
  await run('release-check', 'cargo check --manifest-path src-tauri/Cargo.toml --release --all-targets')
  await run('rust-fmt', 'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check')
  await run('debug-build', 'npm run build:tauri -- --debug')
  for (const [suite, evidence] of [
    ['tauri-original-lan-handback', 'original-lan-handback-process/verification.json'],
    ['tauri-original-lan-recovery', 'original-lan-recovery-process/verification.json'],
    ['tauri-runtime-bootstrap', 'runtime-bootstrap-native/verification.json'],
    ['tauri-lan-compat', 'lan-core-compat-verification.json'],
    ['tauri-lan-receiver', 'lan-receiver/verification.json'],
    ['tauri-lan-sender', 'lan-sender/verification.json'],
    ['tauri-lan-ownership', 'lan-ownership/verification.json'],
    ['tauri-lan-identity', 'lan-identity/verification.json'],
    ['electron-runtime-bootstrap', 'electron-runtime-bootstrap-native/verification.json'],
    ['electron-source-snapshot', 'electron-source-snapshot-native/report.json'],
    ['electron-legacy-drafts', 'electron-legacy-drafts-native.json'],
  ]) {
    await run(suite, 'node --test --test-concurrency=1 tests/' + suite + '.mjs')
    const bytes = await fs.readFile(path.join('artifacts/tauri-migration', evidence)), parsed = JSON.parse(bytes)
    if (parsed.verified !== undefined) assert.equal(parsed.verified, true, suite)
    else assert.ok(parsed.scenarios?.length > 0, suite)
    const copy = path.join(directory, suite + '-evidence.json')
    await fs.writeFile(copy, bytes)
    report.commands.at(-1).evidence = { path: copy, sha256: digest(bytes) }
  }
  assert.deepEqual(await inputs(), report.inputs, 'Source inputs changed during verification')
  report.sourceStable = true
  for (const [suite, evidence] of [['runtime-owned-workspace', 'runtime-owned-workspace-native/report.json'], ['official-reference', 'official-source-kernel/verification.json']]) {
    const file = path.join('artifacts/tauri-migration', evidence)
    const bytes = await fs.readFile(file); assert.equal(JSON.parse(bytes).verified, true)
    const copy = path.join(directory, suite + '-evidence.json'); await fs.writeFile(copy, bytes)
    report.commands.find(step => step.name === suite).evidence = { path: copy, sha256: digest(bytes) }
  }
  report.executables = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.js', 'src-tauri/target/debug/dustdesk-tauri.exe', 'src-tauri/target/debug/examples/original-lan-recovery.exe'].map(async file => [file, digest(await fs.readFile(file))])))
  for (const command of report.commands) {
    assert.equal(digest(await fs.readFile(command.log)), command.sha256, command.name)
    if (command.evidence) assert.equal(digest(await fs.readFile(command.evidence.path)), command.evidence.sha256, command.name)
  }
  report.verified = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ verified: report.verified, reportPath, error: report.error })) }
