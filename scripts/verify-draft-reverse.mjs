import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'

assert.equal(process.platform, 'win32', 'Native draft verification requires Windows')
const directory = 'artifacts/tauri-migration/draft-reverse-final'
const reportPath = path.join(directory, 'verification.json')
const digest = value => createHash('sha256').update(value).digest('hex')
const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), commands: [], scope: 'Source-frozen Node/headless and Rust checks plus the named isolated native regressions: both actual runtimes in draft handoff, shared record readers, native Data and composed browser/LAN-original-profile snapshots, official v1.0.2 code identification, private Rust source leases across actual prepared-Electron Session/Data/profile-bound draft export, real LAN service/ownership, actual Electron menu/maintenance collection and original LAN drain/resume, chunked upload, durable source-bound preparation, helper loss, scoped cancellation and committed-but-client-cancelled preservation. Source verifyPrepared re-enumerates and hashes every current live-source asset against the native decided manifest and retains original asset/empty-directory handles. The same native successful session now retains the complete target bundle/Data/object/manifest/browser/LAN-state and actual catalog/intent/decision handles, rehashes the original handles for repeat verification, rejects late source or target entries, and releases handles on normal/error/forced process exit without changing the durable decision. Actual Electron probes source and every target/record write-open immediately at the native verified response and verifies release after helper closure. Runtime-shaped Data is materialized from the original retained snapshot object handles into a fresh-only tree with original bytes/timestamps/readonly attributes, a write-ahead native intent, complete external inventory, durable decision, and retained output/record handles. Native RPC tests cover repeated verification, metadata-only paginated status and lost-response recovery; Rust tests additionally cover interruption at intent/partial-data/inventory/decision, stale/tampered output, cancellation and final live-source revalidation. Long local-path exact-handle publication has a native regression. The native runtime ownership kernel now acquires the same real cross-runtime Data pipe before releasing prepared output file pins, keeps original source/snapshot/native-record custody, persists a separate ownership intent/grant, resumes legitimately changed Data only through the original physical grant, and rejects replay of the old readonly inventory. An explicit official-code Rust desktop WorkspaceStore gate adopts that nonserializable owner, performs real load/save/reopen and verifies cancellation without reacquiring its own pipe. Rust child-process tests cover intent/grant/post-write exit and real two-process pipe exclusion. This is output Data ownership, not GUI startup, original source/LAN service takeover, browser import, a complete production cutover or rollback. These guards are not a production cutover transaction or continued freshness after helper closure; real ownership transfer and persistent cutover/recovery/rollback remain incomplete. Native folder dialogs are substituted only inside isolated test processes; test LAN sockets are loopback-only and discovery announcements suppressed. No historical-profile authentication, production takeover, whole-installation execution safety, frozen production LAN checkpoint, identity-key backup, external transfer-file restore, full rollback, physical network/IME, Release memory or installer/green ZIP acceptance.' }
await fs.mkdir(directory, { recursive: true })

async function inputs() {
  const files = ['package.json', 'package-lock.json', 'electron.vite.config.ts', 'vite.tauri.config.ts', 'tsconfig.json', 'tsconfig.node.json']
  const visit = async location => {
    for (const entry of await fs.readdir(location, { withFileTypes: true })) {
      if (['target', 'gen', 'node_modules', '.git'].includes(entry.name)) continue
      const target = path.join(location, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile()) files.push(target.replaceAll('\\', '/'))
    }
  }
  for (const location of ['src', 'src-tauri', 'tests', 'scripts']) await visit(location)
  return Object.fromEntries(await Promise.all([...new Set(files)].sort().map(async location => [location, digest(await fs.readFile(location))])))
}
async function run(name, command) {
  const log = path.join(directory, name + '.log'), chunks = [], startedAt = new Date().toISOString()
  console.log('Starting ' + name)
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes)); child.on('error', reject); child.on('exit', resolve)
  })
  const bytes = Buffer.concat(chunks); await fs.writeFile(log, bytes)
  const text = bytes.toString('utf8'), tests = [...text.matchAll(/ℹ tests (\d+)/g)].map(match => Number(match[1]))
  const result = { name, command, code, startedAt, finishedAt: new Date().toISOString(), log, sha256: digest(bytes), nodeTests: tests.reduce((total, count) => total + count, 0) }
  report.commands.push(result); await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  assert.equal(code, 0, name + ' failed; inspect ' + log)
  assert.equal(/ℹ (?:fail|cancelled|skipped) [1-9]/.test(text), false, name + ' did not fully pass')
  console.log('Passed ' + name + (tests.length ? ': ' + result.nodeTests + ' tests' : ''))
}

try {
  report.inputs = await inputs()
  await run('check-silent', 'npm run check:silent')
  await run('rust-tests', 'cargo test --manifest-path src-tauri/Cargo.toml --all-targets')
  await run('runtime-owned-workspace', 'node tests/runtime-owned-workspace.mjs')
  await run('clippy', 'cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings')
  await run('release-check', 'cargo check --manifest-path src-tauri/Cargo.toml --release --all-targets')
  await run('rust-fmt', 'cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check')
  await run('debug-build', 'npm run build:tauri -- --debug')
  const suites = [
    'electron-controlled-drafts', 'electron-draft-import', 'electron-draft-export', 'electron-legacy-drafts', 'electron-source-snapshot',
    'tauri-electron-draft-reverse', 'tauri-electron-draft-handoff', 'tauri-draft-transaction',
    'tauri-draft-import', 'tauri-draft-export', 'tauri-draft-maintenance', 'tauri-main-release', 'workspace-ownership-native', 'tauri-data-snapshot', 'tauri-handoff-snapshot', 'tauri-legacy-source', 'legacy-source-lease-native', 'legacy-source-snapshot-native', 'tauri-lan-host', 'tauri-lan-ownership'
  ]
  for (const suite of suites) await run(suite, 'node --test --test-concurrency=1 tests/' + suite + '.mjs')
  await run('toolbox-lifecycle', 'node tests/toolbox-native.mjs')
  assert.deepEqual(await inputs(), report.inputs, 'Source inputs changed during verification')
  report.sourceStable = true; report.nativeSuites = suites.length
  report.nativeTests = report.commands.filter(command => suites.includes(command.name)).reduce((total, command) => total + command.nodeTests, 0)
  report.executables = Object.fromEntries(await Promise.all(['out/main/index.js', 'out/preload/index.js', 'src-tauri/target/debug/dustdesk-tauri.exe'].map(async file => [file, digest(await fs.readFile(file))])))
  report.verified = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally { report.finishedAt = new Date().toISOString(); await fs.writeFile(reportPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ verified: report.verified, nativeSuites: report.nativeSuites, nativeTests: report.nativeTests, reportPath, error: report.error })) }
