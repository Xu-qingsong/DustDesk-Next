import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

const directory = 'artifacts/tauri-migration/runtime-bootstrap-final'
const reportPath = path.join(directory, 'verification.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), commands: [], scope: 'Frozen source checks and the explicitly listed isolated native regressions for Debug-only same-process runtime Data ownership, durable fresh browser profile binding, native archive import/readback, real interrupted processes and conservative restart. Does not start regular business services, take over original LAN or production data, prove physical power loss, complete cutover/rollback, Release performance or installer/green ZIP acceptance.' }
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
  report.commands.push({ name, command, code, startedAt, finishedAt: new Date().toISOString(), log, sha256: digest(bytes), nodeTests: [...text.matchAll(/ℹ tests (\d+)/g)].reduce((count, match) => count + Number(match[1]), 0) })
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
  await run('clippy', 'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings')
  await run('release-check', 'cargo check --manifest-path src-tauri/Cargo.toml --release --all-targets')
  await run('rust-fmt', 'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check')
  await run('debug-build', 'npm run build:tauri -- --debug')
  for (const suite of ['tauri-runtime-bootstrap', 'legacy-source-snapshot-native', 'tauri-draft-transaction', 'tauri-draft-import']) {
    await run(suite, 'node --test --test-concurrency=1 tests/' + suite + '.mjs')
    const evidence = { 'tauri-runtime-bootstrap': 'runtime-bootstrap-native/verification.json', 'legacy-source-snapshot-native': 'live-source-snapshot-native/report.json', 'tauri-draft-transaction': 'draft-transaction-native.json', 'tauri-draft-import': 'draft-import-product-native.json' }[suite]
    const source = path.join('artifacts/tauri-migration', evidence)
    const bytes = await fs.readFile(source)
    const parsed = JSON.parse(bytes)
    if (['tauri-runtime-bootstrap', 'legacy-source-snapshot-native'].includes(suite)) assert.equal(parsed.verified, true, suite + ' did not publish successful evidence')
    else assert.ok(parsed.evidence.length > 0, suite + ' did not publish native evidence')
    await fs.writeFile(path.join(directory, suite + '-evidence.json'), bytes)
  }
  await run('ordinary-background', 'node tests/tauri-background.mjs')
  assert.deepEqual(await inputs(), report.inputs, 'Source inputs changed during verification')
  report.sourceStable = true
  report.executables = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.js', 'src-tauri/target/debug/dustdesk-tauri.exe'].map(async file => [file, digest(await fs.readFile(file))])))
  report.verified = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ verified: report.verified, reportPath, error: report.error })) }
