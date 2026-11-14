import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/lan-ownership')
const executable = path.resolve('src-tauri/target/debug/examples/lan-publication.exe')
const hash = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const processes = new Set(), events = []
async function waitFor(read) {
  const end = Date.now() + 20_000
  while (Date.now() < end) { const value = await read(); if (value) return value; await delay(15) }
  throw Error('ownership fixture timed out')
}
function processFixture(child, native) {
  processes.add(child)
  let closed = false, stderr = '', sequence = 0
  const messages = []
  child.stderr.on('data', value => { stderr += value })
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { closed = true; processes.delete(child); events.push({ event: 'exit', pid: child.pid, code, signal, stderr }); resolve({ code, signal, stderr }) })
  })
  const receive = value => { messages.push(value); events.push({ pid: child.pid, ...value }) }
  if (native) createInterface({ input: child.stdout }).on('line', line => receive(JSON.parse(line)))
  else child.on('message', receive)
  const message = predicate => waitFor(() => { const index = messages.findIndex(predicate); if (index >= 0) return messages.splice(index, 1)[0]; if (closed) throw Error(stderr || 'fixture exited before response') })
  return {
    ended,
    ready() { return message(value => value.event === 'ready') },
    event(name) { return message(value => value.event === name) },
    async call(command, extra = {}) { const id = ++sequence; child.send({ id, command, ...extra }); return message(value => value.id === id) },
    async stop() { if (!closed) child.stdin.end(); const result = await ended; assert.equal(result.code, 0, result.stderr) },
    async dispose() { if (!closed) { const result = await this.call('dispose'); assert.equal(result.ok, true, result.error) }; const exit = await ended; assert.equal(exit.code, 0, exit.stderr) },
    async kill() { if (!closed) child.kill('SIGKILL'); await ended },
  }
}
async function bytes(root) {
  const entries = await fs.readdir(root)
  // The native compatibility lock is deliberately opened without file sharing.
  // Include its presence in the inventory while hashing every data file.
  return Object.fromEntries(await Promise.all(entries.map(async name => [name, name === '.rust-owner.lock' ? 'exclusive-lock-present' : hash(await fs.readFile(path.join(root, name)))])))
}

test('prepared Electron and Rust LAN services exclude each other by physical directory and release kernel ownership after normal or forced exit', { timeout: 180_000 }, async suite => {
  const cleanup = []; const { root, lanModuleUrl, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const fixtures = [], checks = []
  const report = { verified: false, productionReady: false, migrationComplete: false,
    scope: 'Windows physical LAN profile lease in the current prepared Electron LAN module inside independent Node processes and actual Rust StateStore; no production directories, unaware released binaries, hostile-account or complete migration claim', checks }
  const native = profile => { const fixture = processFixture(spawn(executable, [profile, root], { windowsHide: true, stdio: ['pipe','pipe','pipe'] }), true); fixtures.push(fixture); return fixture }
  const node = async profile => { const fixture = processFixture(spawn(process.execPath, ['tests/lan-ownership-child.mjs', lanModuleUrl, profile, path.join(root, 'downloads')], { windowsHide: true, stdio: ['pipe','pipe','pipe','ipc'] }), false); fixtures.push(fixture); await fixture.ready(); return fixture }
  const blocked = async fixture => { const result = await fixture.ended; assert.notEqual(result.code, 0); assert.match(result.stderr, /另一个进程|锁访问被拒绝/) }
  const success = reply => { assert.equal(reply.ok, true, reply.error); return reply }
  const rejected = reply => { assert.equal(reply.ok, false); assert.match(reply.error, /另一个进程|锁访问被拒绝/); return reply }
  let failed = false
  async function scenario(name, run) { await suite.test(name, async () => { try { await run(); checks.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('ownership scenario failed: ' + name) }
  try {
    await fs.mkdir(artifacts, { recursive: true })
    const build = spawn('cargo', ['build','--manifest-path','src-tauri/Cargo.toml','--example','lan-publication'], { windowsHide: true, stdio: ['ignore','pipe','pipe'] })
    const output = []; build.stdout.on('data', value => output.push(value)); build.stderr.on('data', value => output.push(value))
    const code = await new Promise((resolve, reject) => { build.once('error', reject); build.once('close', resolve) })
    await fs.writeFile(path.join(artifacts, 'build.log'), Buffer.concat(output)); assert.equal(code, 0)
    const sources = ['src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/src/lib.rs','src-tauri/src/lan/mod.rs','src-tauri/src/lan/ownership.rs','src-tauri/src/lan/files.rs','src-tauri/src/lan/state_store.rs','src-tauri/src/lan/storage.rs','src-tauri/examples/lan-publication.rs','tests/reference/src/main/lanTransfer.ts','tests/reference/src/main/workspaceOwnership.ts','tests/toolbox-fixture.mjs','tests/lan-ownership-child.mjs','tests/tauri-lan-ownership.mjs']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await fs.readFile(name))])))
    report.executable = { path: executable, sha256: hash(await fs.readFile(executable)) }
    await scenario('an unused disabled restore creates neither profile, identity nor persistent lock files', async () => {
      const profile = path.join(root, 'absent'), old = await node(profile)
      const restored = success(await old.call('restore')); assert.equal(restored.snapshot.enabled, false); assert.equal(restored.snapshot.port, 0)
      await old.dispose(); assert.equal(await fs.stat(profile).then(() => true, () => false), false)
    })
    await scenario('a live old service excludes Rust and case aliases before any Rust file creation, including after explicit disable', async () => {
      const profile = path.join(root, 'old-first'), old = await node(profile)
      success(await old.call('enable', { enabled: true })); const before = await bytes(profile)
      await blocked(native(profile)); assert.deepEqual(await bytes(profile), before)
      success(await old.call('enable', { enabled: false })); const disabled = await bytes(profile)
      await blocked(native(profile.toUpperCase())); assert.deepEqual(await bytes(profile), disabled)
      await old.dispose(); const rust = native(profile); await rust.ready(); await rust.stop()
      assert.equal((await bytes(profile))['identity.json'], before['identity.json'])
    })
    await scenario('a native owner excludes old restore and initialization without identity or state writes, and forced native exit permits a clean retry', async () => {
      const profile = path.join(root, 'native-first'); await fs.mkdir(profile)
      const rust = native(profile); await rust.ready(); const before = await bytes(profile)
      const old = await node(profile.toUpperCase())
      rejected(await old.call('restore')); rejected(await old.call('enable', { enabled: true })); assert.deepEqual(await bytes(profile), before)
      await rust.kill()
      success(await old.call('enable', { enabled: true })); assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).enabled, true)
      await old.dispose(); assert.ok((await fs.readdir(profile)).includes('.rust-owner.lock'))
    })
    await scenario('forced old-process exit releases kernel ownership while preserving its exact identity and state for native loading', async () => {
      const profile = path.join(root, 'old-crash'), old = await node(profile)
      success(await old.call('enable', { enabled: true })); const before = await bytes(profile); await old.kill()
      const rust = native(profile); await rust.ready()
      const after = await bytes(profile); for (const name of ['identity.json','state.json']) assert.equal(after[name], before[name])
      const retry = await node(profile); rejected(await retry.call('enable', { enabled: true })); await retry.dispose()
      await rust.stop(); const resumed = await node(profile); success(await resumed.call('enable', { enabled: true })); await resumed.dispose()
      assert.equal((await bytes(profile))['identity.json'], before['identity.json'])
    })
    await scenario('simultaneous startup has exactly one writer and the losing runtime never creates its identity or state', async () => {
      report.races = []
      for (let index = 0; index < 4; index++) {
        const profile = path.join(root, 'race-' + index); await fs.mkdir(profile)
        const old = await node(profile)
        let rust, starting
        if (index % 2) { starting = old.call('enable', { enabled: true }); rust = native(profile) }
        else { rust = native(profile); starting = old.call('enable', { enabled: true }) }
        const nativeResult = await rust.ready().then(() => true, () => false), oldResult = await starting
        assert.equal(Number(nativeResult) + Number(oldResult.ok), 1)
        if (nativeResult) { rejected(oldResult); assert.deepEqual(await fs.readdir(profile), ['.rust-owner.lock']); await rust.stop(); await old.dispose() }
        else { success(oldResult); await blocked(rust); assert.deepEqual((await fs.readdir(profile)).sort(), ['identity.json','state.json']); await old.dispose() }
        report.races.push({ nativeWon: nativeResult, oldWon: oldResult.ok })
      }
    })
    await scenario('independent physical directories do not share admission or release each other’s lease', async () => {
      const left = path.join(root, 'left'), right = path.join(root, 'right')
      const a = await node(left), b = await node(right)
      success(await a.call('enable', { enabled: true })); success(await b.call('enable', { enabled: true }))
      await blocked(native(left)); await blocked(native(right)); await a.dispose()
      const rust = native(left); await rust.ready(); await blocked(native(right)); await rust.stop(); await b.dispose()
    })
    await scenario('failed disposal keeps ownership and identity, and permits enable or disposal retry after the actual write fault is repaired', async () => {
      const profile = path.join(root, 'dispose-fault'), old = await node(profile)
      success(await old.call('enable', { enabled: true }))
      const before = await bytes(profile), state = path.join(profile, 'state.json'), backup = path.join(profile, 'saved-state.json')
      await fs.rename(state, backup); await fs.mkdir(state)
      const failed = await old.call('dispose'); assert.equal(failed.ok, false); assert.match(failed.error, /EPERM|EISDIR|EACCES|operation not permitted|directory/i)
      await blocked(native(profile))
      assert.equal(hash(await fs.readFile(path.join(profile, 'identity.json'))), before['identity.json'])
      assert.equal(hash(await fs.readFile(backup)), before['state.json'])
      await fs.rm(state, { recursive: true }); await fs.rename(backup, state)
      success(await old.call('enable', { enabled: true })); await old.dispose()
      const rust = native(profile); await rust.ready(); await rust.stop()
      assert.equal((await bytes(profile))['identity.json'], before['identity.json'])
    })
    await scenario('disposal retains ownership until actual inbound TLS publication and concurrently admitted cleanup have finished', async () => {
      for (const kind of ['publication', 'cleanup', 'confirmation']) {
        const profile = path.join(root, 'drain-' + kind), old = await node(profile)
        success(await old.call('allow-transfers'))
        const receiver = success(await old.call('enable', { enabled: true })).snapshot
        const sender = lan.createLanService({ storage: path.join(root, 'sender-' + kind), downloads: path.join(root, 'sender-downloads'), name: 'ownership sender', host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => false })
        try {
          await sender.enable(true)
          const peer = await sender.connect('127.0.0.1', receiver.port)
          const source = path.join(root, 'source-' + kind + '.txt'); await fs.writeFile(source, 'ownership drain ' + kind)
          if (kind !== 'cleanup') success(await old.call('hold-file-work', { kind }))
          await sender.send(peer.id, [source])
          let control
          if (kind === 'cleanup') {
            await waitFor(() => sender.snapshot().tasks.some(task => task.status === 'completed'))
            const task = success(await old.call('restore')).snapshot.tasks.find(task => task.direction === 'receive')
            success(await old.call('hold-file-work', { kind }))
            control = old.call('control', { task: task.id, action: 'clear' })
          }
          await old.event(kind === 'confirmation' ? 'confirmation-held' : 'file-work-held')
          if (kind === 'confirmation') {
            await old.dispose()
            const rust = native(profile); await rust.ready(); await rust.stop()
            assert.deepEqual(JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).tasks, [])
            continue
          }
          let disposed = false
          const disposing = old.dispose().then(() => { disposed = true })
          await old.event('disposing')
          await blocked(native(profile)); assert.equal(disposed, false)
          success(await old.call('release-file-work'))
          if (control) success(await control)
          await disposing
          const before = await bytes(profile), rust = native(profile); await rust.ready()
          for (const name of ['identity.json', 'state.json']) assert.equal((await bytes(profile))[name], before[name])
          await rust.stop()
        } finally { await sender.dispose() }
      }
    })
    await scenario('directory junction aliases are rejected by both runtimes without mutating the target', async () => {
      const target = path.join(root, 'junction-target'), alias = path.join(root, 'junction-alias'); await fs.mkdir(target); await fs.writeFile(path.join(target, 'keep.txt'), 'keep')
      const before = await bytes(target); await fs.symlink(target, alias, 'junction')
      const old = await node(alias), refused = await old.call('enable', { enabled: true }); assert.equal(refused.ok, false); assert.match(refused.error, /重解析|符号链接/); await old.dispose()
      const result = await native(alias).ended; assert.notEqual(result.code, 0); assert.match(result.stderr, /重解析/)
      assert.deepEqual(await bytes(target), before)
    })
    for (const [name, digest] of Object.entries(report.inputs)) assert.equal(hash(await fs.readFile(name)), digest, name)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const fixture of fixtures) await fixture.kill()
    report.remainingProcesses = processes.size
    await fs.writeFile(path.join(artifacts, 'events.json'), JSON.stringify(events, null, 2))
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup.reverse()) await callback()
  }
})
