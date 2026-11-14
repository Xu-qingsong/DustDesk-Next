import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/lan-legacy-publication')
const executable = path.resolve('src-tauri/target/debug/examples/lan-receiver.exe')
const hash = value => createHash('sha256').update(value).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const events = [], processes = new Set()
async function waitFor(read) {
  const until = Date.now() + 20_000
  while (Date.now() < until) { const value = await read(); if (value) return value; await delay(20) }
  throw Error('fixture condition timed out')
}
function endpoint(child, jsonLines = false) {
  processes.add(child)
  const queue = []; let stderr = '', exited = false
  child.stderr.on('data', value => { stderr += value })
  const ended = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { exited = true; processes.delete(child); events.push({ event: 'exit', pid: child.pid, code, signal, stderr }); resolve({ code, signal }) })
  })
  const receive = value => { events.push({ pid: child.pid, ...value }); queue.push(value) }
  if (jsonLines) createInterface({ input: child.stdout }).on('line', line => receive(JSON.parse(line)))
  else child.on('message', receive)
  return {
    send(value) { child.stdin.write(JSON.stringify(value) + '\n') },
    async event(name) { return waitFor(() => { const index = queue.findIndex(value => value.event === name); if (index >= 0) return queue.splice(index, 1)[0]; if (exited) throw Error(`endpoint ended before ${name}: ${stderr}`) }) },
    async kill() { if (!exited) child.kill('SIGKILL'); await ended },
    async stop() { if (!exited) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); assert.equal((await ended).code, 0, stderr) },
  }
}
async function request(port, identity, pin, route, value) {
  return new Promise((resolve, reject) => {
    const outgoing = https.request({ hostname: '127.0.0.1', port, path: route, method: 'POST', agent: false,
      rejectUnauthorized: false, key: identity.key, cert: identity.cert, headers: { 'Content-Type': 'application/json' } }, async response => {
      try { const bytes = []; for await (const chunk of response) bytes.push(chunk); resolve({ status: response.statusCode, ...JSON.parse(Buffer.concat(bytes).toString()) }) } catch (error) { reject(error) }
    })
    outgoing.on('socket', socket => socket.once('secureConnect', () => { if (hash(socket.getPeerCertificate().raw) !== pin) outgoing.destroy(Error('peer pin changed')) }))
    outgoing.on('error', reject); outgoing.setTimeout(15_000, () => outgoing.destroy(Error('request timeout')))
    outgoing.end(JSON.stringify(value))
  })
}

test('Rust resumes actual old-module hard-link publication gaps and returns compatible completed tasks to that module', { timeout: 180_000 }, async () => {
  const cleanup = []; const { root, lan, lanModuleUrl } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const report = { verified: false, productionReady: false, migrationComplete: false,
    scope: 'isolated old LAN module forcibly ended in Node at actual publication boundaries; native receiver with explicit stdin approval, actual TLS resume and old-module reread; no production takeover or physical two-machine proof', checks: [] }
  let sender, legacy, native, returned
  try {
    await fs.mkdir(artifacts, { recursive: true })
    const build = spawn('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-receiver'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks = []; build.stdout.on('data', value => chunks.push(value)); build.stderr.on('data', value => chunks.push(value))
    const code = await new Promise((resolve, reject) => { build.once('error', reject); build.once('close', resolve) })
    await fs.writeFile(path.join(artifacts, 'build.log'), Buffer.concat(chunks)); assert.equal(code, 0)
    const sources = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lan/files.rs', 'src-tauri/src/lan/publication.rs', 'src-tauri/src/lan/publication/legacy.rs', 'src-tauri/src/lan/publication_tests.rs', 'src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/transport.rs', 'src-tauri/src/lan/tls.rs', 'src-tauri/examples/lan-receiver.rs', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/reference/src/main/fileOperations.ts', 'tests/toolbox-fixture.mjs', 'tests/tauri-lan-legacy-endpoint.mjs', 'tests/tauri-lan-legacy-publication.mjs']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await fs.readFile(name))])))
    report.executable = { path: executable, sha256: hash(await fs.readFile(executable)) }
    for (const phase of ['before-save', 'after-save']) {
      const directory = path.join(root, phase), profile = path.join(directory, 'receiver'), downloads = path.join(directory, 'downloads'), source = path.join(directory, 'source')
      await fs.mkdir(downloads, { recursive: true }); await fs.mkdir(path.join(source, '空目录'), { recursive: true })
      const first = Buffer.alloc(2 * 1024 * 1024 + 17, 47), next = Buffer.from('后续文件 😀\n')
      await fs.writeFile(path.join(source, 'a.bin'), first); await fs.writeFile(path.join(source, 'b.txt'), next)
      const options = name => ({ storage: path.join(directory, name), downloads, name, host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => downloads })
      legacy = endpoint(spawn(process.execPath, ['tests/tauri-lan-legacy-endpoint.mjs', lanModuleUrl, profile, downloads, phase], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }))
      const ready = await legacy.event('ready')
      sender = lan.createLanService(options('sender')); await sender.enable(true)
      const peer = await sender.connect('127.0.0.1', ready.port)
      await sender.send(peer.id, [source])
      const gap = await legacy.event('publication-gap')
      await legacy.kill(); legacy = undefined
      await waitFor(() => sender.snapshot().tasks[0]?.status === 'failed')
      const senderId = sender.snapshot().tasks[0].id
      await sender.dispose(); sender = undefined
      const statePath = path.join(profile, 'state.json'), identityPath = path.join(profile, 'identity.json')
      const identityBytes = await fs.readFile(identityPath), original = JSON.parse(await fs.readFile(statePath, 'utf8'))
      const oldTask = original.tasks.find(task => task.manifest.id === senderId)
      assert.equal(Object.keys(oldTask.files).length, phase === 'after-save' ? 1 : 0)
      assert.equal((await fs.stat(gap.part)).nlink, 2); assert.equal((await fs.stat(gap.target)).nlink, 2)
      assert.equal(hash(await fs.readFile(gap.target)), hash(first))
      native = endpoint(spawn(executable, [profile, downloads], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }), true)
      const rust = await native.event('ready')
      assert.equal(rust.fingerprint, JSON.parse(identityBytes).fingerprint)
      sender = lan.createLanService(options('sender')); await sender.enable(true); await sender.connect('127.0.0.1', rust.port)
      await sender.control(senderId, 'resume')
      const declined = await native.event('receive'); assert.equal(declined.existing, oldTask.view.directory)
      assert.deepEqual(await fs.readFile(identityPath), identityBytes)
      assert.equal((await fs.stat(gap.part)).nlink, 2)
      native.send({ command: 'approve', request: declined.request, accept: false })
      await waitFor(() => sender.snapshot().tasks.find(task => task.id === senderId)?.status === 'failed')
      assert.equal((await fs.stat(gap.part)).nlink, 2)
      assert.equal(JSON.parse(await fs.readFile(statePath, 'utf8')).tasks.find(task => task.view.id === oldTask.view.id).rustPublicationV1, undefined)
      await sender.control(senderId, 'resume')
      const accepted = await native.event('receive'); assert.equal(accepted.existing, oldTask.view.directory)
      native.send({ command: 'approve', request: accepted.request, accept: true })
      await waitFor(() => sender.snapshot().tasks.find(task => task.id === senderId)?.status === 'completed')
      await sender.dispose(); sender = undefined
      await native.stop(); native = undefined
      const finished = JSON.parse(await fs.readFile(statePath, 'utf8')).tasks.find(task => task.view.id === oldTask.view.id)
      assert.equal(finished.view.status, 'completed'); assert.equal(finished.files[0], gap.target); assert.equal(finished.rustPublicationV1, undefined)
      assert.equal((await fs.stat(gap.target)).nlink, 1)
      assert.equal(await fs.stat(gap.part).then(() => true, () => false), false)
      assert.equal(hash(await fs.readFile(gap.target)), hash(first))
      assert.deepEqual(await fs.readFile(path.join(oldTask.view.directory, 'source/b.txt')), next)
      assert.deepEqual((await fs.readdir(path.join(oldTask.view.directory, 'source'))).sort(), ['a.bin', 'b.txt', '空目录'].sort())
      assert.deepEqual(await fs.readdir(path.join(oldTask.view.directory, 'source/空目录')), [])
      assert.deepEqual(await fs.readFile(identityPath), identityBytes)
      // Reconstruct the real old receiver after native shutdown. Its actual
      // offer/complete handlers must accept the recovered state unchanged.
      returned = lan.createLanService({ ...options('receiver'), storage: profile }); await returned.enable(true)
      const identity = JSON.parse(await fs.readFile(path.join(directory, 'sender/identity.json'), 'utf8'))
      const offered = await request(returned.snapshot().port, identity, rust.fingerprint, '/offer', oldTask.manifest)
      assert.equal(offered.status, 200, JSON.stringify(offered)); assert.equal(offered.offsets.length, 2)
      assert.ok(offered.offsets.every(offset => offset.complete))
      assert.equal((await request(returned.snapshot().port, identity, rust.fingerprint, `/complete?id=${senderId}&token=${offered.token}`, {})).status, 200)
      await returned.dispose(); returned = undefined
      assert.equal((await fs.stat(gap.target)).nlink, 1)
      report.checks.push({ phase, verified: true, originalMappingSaved: phase === 'after-save', firstSha256: hash(first), nextSha256: hash(next), resumedAfterFreshApproval: true, oldReceiverReconstructed: true })
    }
    for (const [name, digest] of Object.entries(report.inputs)) assert.equal(hash(await fs.readFile(name)), digest, name)
    report.verified = true
  } catch (error) {
    report.error = String(error.stack ?? error); throw error
  } finally {
    await legacy?.kill(); await native?.kill(); await sender?.dispose(); await returned?.dispose()
    report.remainingProcesses = processes.size
    await fs.writeFile(path.join(artifacts, 'events.json'), JSON.stringify(events, null, 2))
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup.reverse()) await callback()
  }
})
