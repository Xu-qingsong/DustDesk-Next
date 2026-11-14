import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportRoot = path.join(repo, 'artifacts/tauri-migration/lan-receive-storage')
const executable = path.join(repo, 'src-tauri/target/debug/examples/lan-publication.exe')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const id = 'a'.repeat(64) + '-storage-crash'
const live = new Set()
const events = []

async function run(command, args) {
  const child = spawn(command, args, { cwd: repo, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value }); child.stderr.on('data', value => { output += value })
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await fs.writeFile(path.join(reportRoot, 'build.log'), output)
  assert.equal(code, 0, output)
}

async function driver(profile, directory) {
  const child = spawn(executable, [profile, directory], { cwd: repo, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  live.add(child)
  const queue = []; const waiters = []
  let stderr = ''; let closed = false
  const ended = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true; live.delete(child); events.push({ event: 'exit', pid: child.pid, code, signal, stderr });
    while (waiters.length) waiters.shift().reject(Error(`driver exited: ${code}; ${stderr}`))
    resolve({ code, signal })
  }))
  child.stderr.on('data', value => { stderr += value })
  child.on('error', error => { while (waiters.length) waiters.shift().reject(error) })
  const lines = readline.createInterface({ input: child.stdout })
  lines.on('line', line => {
    const value = JSON.parse(line); events.push({ pid: child.pid, ...value })
    if (waiters.length) waiters.shift().resolve(value); else queue.push(value)
  })
  async function next() {
    if (queue.length) return queue.shift()
    if (closed) throw Error(`driver already exited: ${stderr}`)
    let timer; let entry
    try {
      return await new Promise((resolve, reject) => {
        entry = { resolve, reject }; waiters.push(entry)
        timer = setTimeout(() => reject(Error(`driver response timeout: ${stderr}`)), 15_000)
      })
    } finally {
      clearTimeout(timer); const index = waiters.indexOf(entry); if (index >= 0) waiters.splice(index, 1)
    }
  }
  assert.deepEqual(await next(), { event: 'ready' })
  return {
    child, ended,
    async command(command, extra = {}) {
      child.stdin.write(JSON.stringify({ command, task: id, index: 0, ...extra }) + '\n')
      return next()
    },
    async kill() { child.kill('SIGKILL'); await ended },
    async close() { child.stdin.end(); assert.equal((await ended).code, 0) }
  }
}

async function fixture(root, name) {
  const directory = path.join(root, name, 'download'); const profile = path.join(root, name, 'profile')
  const staging = path.join(directory, '.dustdesk-part-storage-crash')
  await fs.mkdir(profile, { recursive: true }); await fs.mkdir(staging, { recursive: true })
  const data = Buffer.alloc(2 * 1024 * 1024 + 37, 53)
  const task = {
    view: { id, direction: 'receive', device: 'Old sender', name: '中文文件', total: data.length, done: data.length, speed: 0, status: 'waiting', directory },
    peer: { id: 'old-sender', name: 'Old sender', fingerprint: 'a'.repeat(64), address: '127.0.0.1', port: 12345, lastSeen: 1 },
    manifest: { id: 'storage-crash', name: '中文文件', directories: ['nested', 'empty'], entries: [{ relative: 'nested/中文.bin', size: data.length, mtime: 0.25, hash: sha256(data) }] },
    staging, files: {}, token: 'do-not-persist', futureLocal: { preserved: true }
  }
  await fs.writeFile(path.join(profile, 'state.json'), JSON.stringify({ enabled: true, trusted: ['a'.repeat(64)], tasks: [task], futureRoot: true }))
  await fs.writeFile(path.join(staging, '0.part'), data)
  return { profile, directory, staging, data, task, state: path.join(profile, 'state.json'), target: path.join(directory, 'nested/中文.bin') }
}

test('native receive storage survives process termination and refuses redirected or misattributed files', { timeout: 180_000 }, async () => {
  await fs.mkdir(reportRoot, { recursive: true })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-lan-receive-storage-'))
  const groups = []
  const inputs = {}
  const report = { verified: false, productionReady: false, migrationComplete: false, scope: 'receiver filesystem and durable publication only; no HTTP task service or desktop confirmation UI', groups }
  try {
    await run('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-publication'])
    for (const source of ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/src/lan/files.rs', 'src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs', 'src-tauri/src/lan/publication.rs', 'src-tauri/src/lan/publication/legacy.rs', 'src-tauri/examples/lan-publication.rs', 'tests/tauri-lan-receive-storage.mjs']) {
      inputs[source] = sha256(await fs.readFile(path.join(repo, source)))
    }
    report.inputs = inputs; report.driver = { executable, sha256: sha256(await fs.readFile(executable)) }
    for (const afterRename of [false, true]) {
      const f = await fixture(root, afterRename ? 'after-rename' : 'before-rename')
      let process = await driver(f.profile, f.directory)
      assert.equal((await process.command('begin')).ok, true)
      if (afterRename) assert.equal((await process.command('rename')).ok, true)
      await process.kill()
      let state = JSON.parse(await fs.readFile(f.state, 'utf8'))
      assert.ok(state.tasks[0].rustPublicationV1); assert.equal(state.tasks[0].token, undefined)
      assert.match(state.tasks[0].rustPublicationV1.identity.index, /^[a-f0-9]{16}$/)
      assert.equal(state.tasks[0].view.status, 'paused')
      process = await driver(f.profile, f.directory)
      const resumed = await process.command('recover'); assert.equal(resumed.ok, true, resumed.error)
      assert.equal(resumed.value.path, f.target)
      assert.equal((await process.command('recover')).value.path, null)
      await process.close()
      assert.equal(sha256(await fs.readFile(f.target)), sha256(f.data))
      assert.deepEqual(await fs.readdir(path.dirname(f.target)), ['中文.bin'])
      assert.equal(await fs.stat(path.join(f.staging, '0.part')).then(() => true, () => false), false)
      state = JSON.parse(await fs.readFile(f.state, 'utf8'))
      assert.equal(state.tasks[0].files[0], f.target); assert.equal(state.tasks[0].rustPublicationV1, undefined)
      assert.deepEqual(state.tasks[0].futureLocal, { preserved: true }); assert.equal(state.futureRoot, true)
      groups.push({ name: afterRename ? 'hard-process-stop-after-rename' : 'hard-process-stop-after-durable-intent', verified: true, sha256: sha256(f.data) })
    }
    {
      const f = await fixture(root, 'collision')
      await fs.mkdir(path.dirname(f.target)); await fs.writeFile(f.target, 'keep original')
      await fs.writeFile(path.join(path.dirname(f.target), '中文-1.bin'), 'keep numbered')
      const process = await driver(f.profile, f.directory)
      assert.equal((await process.command('begin')).ok, true)
      assert.equal((await process.command('rename')).ok, true)
      const intent = JSON.parse(await fs.readFile(f.state, 'utf8')).tasks[0].rustPublicationV1
      assert.equal(intent.collision, 2); assert.equal(intent.candidate, 'nested/中文-2.bin')
      await process.kill()
      const restarted = await driver(f.profile, f.directory)
      assert.equal((await restarted.command('recover')).ok, true); await restarted.close()
      assert.equal(await fs.readFile(f.target, 'utf8'), 'keep original')
      assert.equal(await fs.readFile(path.join(path.dirname(f.target), '中文-1.bin'), 'utf8'), 'keep numbered')
      assert.equal(sha256(await fs.readFile(path.join(path.dirname(f.target), '中文-2.bin'))), sha256(f.data))
      groups.push({ name: 'collision-intent-survives-process-stop', verified: true })
    }
    {
      const f = await fixture(root, 'identity')
      const process = await driver(f.profile, f.directory)
      assert.equal((await process.command('begin')).ok, true); assert.equal((await process.command('rename')).ok, true)
      await process.kill()
      const retained = f.target + '.retained'; await fs.rename(f.target, retained); await fs.writeFile(f.target, f.data)
      const restarted = await driver(f.profile, f.directory)
      assert.equal((await restarted.command('recover')).ok, false); await restarted.close()
      assert.ok(JSON.parse(await fs.readFile(f.state, 'utf8')).tasks[0].rustPublicationV1)
      assert.equal(sha256(await fs.readFile(retained)), sha256(f.data))
      groups.push({ name: 'same-hash-different-native-identity-refused', verified: true })
    }
    {
      const f = await fixture(root, 'junction')
      const outside = path.join(root, 'outside'); await fs.mkdir(outside)
      await fs.symlink(outside, path.join(f.directory, 'nested'), 'junction')
      const process = await driver(f.profile, f.directory)
      assert.equal((await process.command('begin')).ok, true)
      assert.equal((await process.command('rename')).ok, false); await process.kill()
      assert.deepEqual(await fs.readdir(outside), [])
      await fs.unlink(path.join(f.directory, 'nested'))
      const restarted = await driver(f.profile, f.directory)
      assert.equal((await restarted.command('recover')).ok, true); await restarted.close()
      assert.equal(sha256(await fs.readFile(f.target)), sha256(f.data))
      groups.push({ name: 'real-windows-directory-junction-rejected-and-retryable', verified: true })
    }
    {
      const f = await fixture(root, 'hardlink')
      const alias = path.join(root, 'outside-alias'); await fs.link(path.join(f.staging, '0.part'), alias)
      const process = await driver(f.profile, f.directory)
      assert.equal((await process.command('begin')).ok, false); await process.close()
      assert.equal(sha256(await fs.readFile(alias)), sha256(f.data))
      assert.equal(JSON.parse(await fs.readFile(f.state, 'utf8')).tasks[0].rustPublicationV1, undefined)
      groups.push({ name: 'existing-hardlink-part-refused-without-writes', verified: true })
    }
    {
      const f = await fixture(root, 'canceled')
      const before = await fs.readFile(f.state)
      const process = await driver(f.profile, f.directory)
      assert.equal((await process.command('begin', { canceled: true })).ok, false)
      assert.deepEqual(await fs.readFile(f.state), before)
      assert.equal((await process.command('begin')).ok, true)
      assert.equal((await process.command('rename', { canceled: true })).ok, false)
      await process.kill()
      const restarted = await driver(f.profile, f.directory)
      assert.equal((await restarted.command('recover')).ok, true); await restarted.close()
      groups.push({ name: 'cancellation-before-intent-and-before-rename', verified: true })
    }
    report.verified = true
  } catch (error) {
    report.error = String(error.stack ?? error); throw error
  } finally {
    await Promise.all([...live].map(async child => { const ended = new Promise(resolve => child.once('close', resolve)); child.kill('SIGKILL'); await ended }))
    report.remainingProcesses = live.size
    await fs.writeFile(path.join(reportRoot, 'events.json'), JSON.stringify(events, null, 2))
    await fs.writeFile(path.join(reportRoot, 'verification.json'), JSON.stringify(report, null, 2))
    await fs.rm(root, { recursive: true, force: true })
  }
})
