import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/original-lan-recovery-process')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, accept, description) {
  const end = Date.now() + 15_000
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(20) }
  throw Error(description)
}
async function build() {
  const child = spawn('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'original-lan-recovery'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []; child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => chunks.push(value))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await fs.writeFile(path.join(artifacts, 'build.log'), Buffer.concat(chunks)); assert.equal(code, 0)
}
function driver(root, reference, ids) {
  const executable = path.resolve('src-tauri/target/debug/examples/original-lan-recovery.exe')
  const child = spawn(executable, [root, reference, ...(ids ? ['--resume', ids.preparationId, ids.runtimeId, ids.ownershipId] : ['--prepare'])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = [], waiters = new Set(), replies = new Map(), lines = [], errors = []
  let closed = false, sequence = 0
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; for (const notify of waiters) notify(); resolve({ code, signal }) }) })
  child.stdin.on('error', () => {})
  child.stderr.on('data', value => errors.push(value.toString()))
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line); const value = JSON.parse(line)
    if (value.id && replies.has(value.id)) { replies.get(value.id)(value); replies.delete(value.id) }
    else { events.push(value); for (const notify of waiters) notify() }
  })
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  return { child, exited, lines, errors, send,
    async call(command) {
      const id = String(++sequence)
      const value = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { replies.delete(id); reject(Error(command + ' timeout')) }, 120_000)
        replies.set(id, result => { clearTimeout(timeout); resolve(result) })
      })
      send({ command, id }); const result = await value; assert.equal(result.ok, true, result.error); return result
    },
    async snapshot() { return (await this.call('snapshot')).state },
    async event(predicate) {
      const end = Date.now() + 120_000
      while (Date.now() < end) {
        const index = events.findIndex(predicate); if (index >= 0) return events.splice(index, 1)[0]
        if (closed) throw Error('receiver exited: ' + errors.join(''))
        await new Promise(resolve => { const ready = () => { clearTimeout(timeout); waiters.delete(ready); resolve() }; const timeout = setTimeout(ready, 500); waiters.add(ready) })
      }
      throw Error('receiver event timed out: ' + predicate)
    },
    approve(request, accept = true, extra = {}) { send({ command: 'approve', request, accept, ...extra }) },
    async stop() { if (!closed) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
    async kill() { if (!closed) child.kill('SIGKILL'); return exited },
  }
}
function request(ready, identity, route, { method = 'POST', value = {}, stream } = {}) {
  let outgoing
  const result = new Promise((resolve, reject) => {
    outgoing = https.request({ hostname: '127.0.0.1', port: ready.port, path: route, method, rejectUnauthorized: false, agent: false,
      key: identity.key, cert: identity.cert, headers: { 'Content-Type': stream ? 'application/octet-stream' : 'application/json' } }, async response => {
      try { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) } catch (error) { reject(error) }
    })
    outgoing.on('socket', socket => socket.once('secureConnect', () => { if (digest(socket.getPeerCertificate().raw) !== ready.fingerprint) outgoing.destroy(Error('peer pin changed')) }))
    outgoing.on('error', reject); outgoing.setTimeout(15_000, () => outgoing.destroy(Error('request timeout')))
    if (stream) stream(outgoing); else outgoing.end(method === 'GET' ? undefined : Buffer.isBuffer(value) ? value : JSON.stringify(value))
  })
  // Every pending network result is observed immediately, including deliberate
  // disconnect tests; assertions still inspect the original promise/result.
  result.catch(() => {})
  return { outgoing, result }
}
async function offer(fixture, ready, identity, manifest, { accept = true, directory } = {}) {
  const sent = request(ready, identity, '/offer', { value: manifest })
  const prompt = await fixture.event(value => value.event === 'receive')
  fixture.approve(prompt.request, accept, directory ? { directory } : {})
  return { response: await sent.result, prompt }
}
const route = (action, manifest, token, index, offset) => `/${action}?id=${manifest.id}&token=${token}${index === undefined ? '' : `&index=${index}&offset=${offset}`}`

test('original LAN grant survives real process death and resumes current state with the old sender', { timeout: 240_000 }, async () => {
  const cleanup = [], drivers = []
  const { root: toolsRoot, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-runtime-preview-'))
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [],
    scope: 'Debug TEMP native source/snapshot/runtime ownership and original LAN cold recovery; official release bytes authenticate source. Explicit stdin approvals and loopback HTTPS. Current Electron LAN module runs in Node. No desktop activation, production cutover, physical power failure or two-PC acceptance.' }
  let fixture, sender, generator
  const check = name => report.checks.push(name)
  const launch = async ids => {
    fixture = driver(root, report.referencePath, ids); drivers.push(fixture)
    return fixture.event(value => value.event === 'ready')
  }
  const stored = async () => JSON.parse(await fs.readFile(path.join(root, 'Profile/LanTransfers/state.json'), 'utf8'))
  const hashes = async directory => {
    const result = {}
    const visit = async (folder, prefix = '') => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const relative = prefix + entry.name, file = path.join(folder, entry.name)
        if (entry.isDirectory()) await visit(file, relative + '/')
        else if (entry.isFile()) result[relative] = await fileDigest(file)
        else throw Error('unexpected fixture entry')
      }
    }
    await visit(directory); return result
  }
  try {
    await fs.mkdir(artifacts, { recursive: true })
    const sources = ['src-tauri/examples/original-lan-recovery.rs', 'src-tauri/src/lan/migration.rs', 'src-tauri/src/lan/migration/handover.rs', 'src-tauri/src/legacy_source/binding/snapshot.rs', 'src-tauri/src/managed_snapshot/bundle.rs', 'src-tauri/src/managed_snapshot/preparation.rs', 'src-tauri/src/managed_snapshot/preparation/runtime/ownership.rs', 'tests/tauri-original-lan-recovery.mjs', 'tests/reference/src/main/lanTransfer.ts', 'tests/toolbox-fixture.mjs', 'tests/legacy-source-reference.mjs']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    await build()
    report.executableSha256 = await fileDigest('src-tauri/target/debug/examples/original-lan-recovery.exe')
    const reference = await extractOfficialLegacyReference(root)
    report.reference = reference.release; report.referencePath = reference.root
    const dataRoot = path.join(root, 'Data'), downloads = path.join(root, 'Downloads')
    const profile = path.join(root, 'Profile/LanTransfers')
    await fs.mkdir(path.join(dataRoot, 'Assets'), { recursive: true }); await fs.mkdir(downloads)
    await fs.writeFile(path.join(dataRoot, 'workspace.json'), '{"SchemaVersion":3,"Notes":[],"Todos":[],"QuickNote":"冷恢复"}\r\n')
    await fs.writeFile(path.join(dataRoot, 'Assets/raw.bin'), Buffer.from([0, 255, 13, 10]))
    const dataBefore = await hashes(dataRoot)
    const options = name => ({ storage: name === 'original' ? profile : path.join(toolsRoot, name), downloads, host: '127.0.0.1', name, discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => downloads })
    generator = lan.createLanService(options('original')); await generator.enable(true); await generator.dispose(); generator = undefined
    const originalIdentity = await fs.readFile(path.join(profile, 'identity.json'))
    const originalState = await fs.readFile(path.join(profile, 'state.json'))
    sender = lan.createLanService(options('old-sender')); await sender.enable(true)
    const identity = JSON.parse(await fs.readFile(path.join(toolsRoot, 'old-sender/identity.json'), 'utf8'))
    let ready = await launch(), ids = { preparationId: ready.preparationId, runtimeId: ready.runtimeId, ownershipId: ready.ownershipId }
    const nativeIdentity = JSON.parse(originalIdentity)
    assert.equal(ready.deviceId, nativeIdentity.id); assert.equal(ready.fingerprint, nativeIdentity.fingerprint)
    assert.equal(ready.productionReady, false); assert.equal(ready.migrationComplete, false)
    generator = lan.createLanService(options('original'))
    await assert.rejects(generator.enable(true), /占用|运行|锁|lock|owned|owner/i)
    await generator.dispose(); generator = undefined
    await assert.rejects(fs.writeFile(path.join(profile, 'identity.json'), 'must remain pinned'))
    let connecting = sender.connect('127.0.0.1', ready.port); connecting.catch(() => {})
    const pair = await fixture.event(value => value.event === 'pair')
    assert.equal(pair.peer.fingerprint, identity.fingerprint); fixture.approve(pair.request)
    let device = await connecting
    assert.ok((await stored()).trusted.includes(identity.fingerprint))
    check('actual official-byte bound source grants original identity with cross-runtime exclusive LAN ownership and explicit TLS pairing')

    const source = path.join(toolsRoot, '冷恢复.bin')
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 17)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 43 + (i >>> 16)) & 255
    await fs.writeFile(source, bytes)
    await sender.send(device.id, [source])
    const held = await fixture.event(value => value.event === 'receive')
    const senderId = sender.snapshot().tasks[0].id
    await sender.control(senderId, 'pause')
    await fixture.event(value => value.event === 'decisionClosed' && value.request === held.request)
    const senderState = JSON.parse(await fs.readFile(path.join(toolsRoot, 'old-sender/state.json'), 'utf8'))
    const original = senderState.tasks.find(task => task.view.id === senderId)
    const manifest = { ...original.manifest, entries: original.manifest.entries.map(({ source: ignored, ...entry }) => entry) }
    const offered = await offer(fixture, ready, identity, manifest)
    assert.equal(offered.response.status, 200, JSON.stringify(offered.response))
    const token = offered.response.body.token, taskId = identity.fingerprint + '-' + manifest.id
    const active = (await fixture.snapshot()).tasks.find(task => task.view.id === taskId)
    const prefix = bytes.subarray(0, 1024 * 1024)
    const interrupted = request(ready, identity, route('file', manifest, token, 0, 0), { stream: outgoing => outgoing.write(prefix) })
    const part = path.join(active.staging, '0.part')
    await waitFor(() => fs.stat(part).catch(() => null), value => value?.size === prefix.length, 'native prefix not written')
    await fixture.call('verify')
    report.forcedExit = await fixture.kill(); await interrupted.result.catch(() => null)
    assert.equal(digest(await fs.readFile(part)), digest(prefix))
    await sender.dispose(); sender = undefined
    report.partial = { bytes: prefix.length, sha256: digest(prefix) }
    assert.equal((await stored()).tasks.find(task => task.view.id === taskId).token, undefined)
    const snapshotBefore = await hashes(path.join(root, 'Snapshot'))
    assert.deepEqual(await fs.readFile(path.join(root, 'Snapshot/lan-state.json')), originalState)
    check('real native SIGKILL during active HTTPS upload preserves a nonzero hashed prefix; old sender is disposed and restarted')

    ready = await launch(ids)
    assert.equal(ready.deviceId, nativeIdentity.id); assert.equal(ready.fingerprint, nativeIdentity.fingerprint)
    assert.deepEqual({ preparationId: ready.preparationId, runtimeId: ready.runtimeId, ownershipId: ready.ownershipId }, ids)
    assert.ok((await fixture.snapshot()).trusted.includes(identity.fingerprint))
    assert.ok((await fixture.snapshot()).tasks.some(task => task.view.id === taskId))
    assert.equal((await request(ready, identity, route('file', manifest, token, 0, prefix.length), { value: bytes.subarray(prefix.length) }).result).status, 400)
    const probe = await offer(fixture, ready, identity, manifest)
    assert.equal(probe.response.status, 200)
    assert.equal(probe.response.body.offsets[0].size, prefix.length)
    assert.equal(probe.response.body.offsets[0].hash, digest(prefix))
    assert.equal((await request(ready, identity, route('pause', manifest, probe.response.body.token)).result).status, 200)
    sender = lan.createLanService(options('old-sender')); await sender.enable(true)
    device = await sender.connect('127.0.0.1', ready.port)
    await sender.control(senderId, 'resume')
    const resumed = await fixture.event(value => value.event === 'receive')
    assert.equal(resumed.existing, active.view.directory); fixture.approve(resumed.request)
    const completed = await waitFor(() => sender.snapshot().tasks.find(task => task.id === senderId), task => ['completed', 'failed'].includes(task?.status), 'old sender did not complete')
    assert.equal(completed.status, 'completed', completed.error)
    const final = (await fixture.snapshot()).tasks.find(task => task.view.id === taskId)
    assert.equal(final.view.status, 'completed'); assert.equal(final.view.done, bytes.length)
    assert.equal(digest(await fs.readFile(final.files[0])), digest(bytes))
    assert.equal(await fs.stat(active.staging).then(() => true, () => false), false)
    await fixture.call('verify')
    assert.equal((await fixture.stop()).code, 0, fixture.errors.join(''))
    assert.deepEqual(await hashes(path.join(root, 'Snapshot')), snapshotBefore)
    assert.deepEqual(await hashes(dataRoot), dataBefore)
    assert.deepEqual(await fs.readFile(path.join(profile, 'identity.json')), originalIdentity)
    check('cold recovery retains latest trust/tasks and original ownership IDs, rejects old token, freshly approves verified-prefix resume through actual old sender and verifies final hash')

    ready = await launch(ids)
    assert.equal((await fixture.snapshot()).tasks.find(task => task.view.id === taskId).view.status, 'completed')
    await fixture.call('verify'); assert.equal((await fixture.stop()).code, 0)
    assert.deepEqual(await hashes(path.join(root, 'Snapshot')), snapshotBefore)
    check('second cold recovery keeps completed current state while immutable original snapshot, grant journal, source and identity remain unchanged')
    await sender.dispose(); sender = undefined

    const findDecision = async folder => {
      for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
        const file = path.join(folder, entry.name)
        if (entry.isDirectory()) { const found = await findDecision(file); if (found) return found }
        else if (entry.name === 'decision.json' && path.basename(folder) === 'OriginalLan') return file
      }
    }
    const decisionPath = await findDecision(root); assert.ok(decisionPath)
    const decision = await fs.readFile(decisionPath), currentState = await fs.readFile(path.join(profile, 'state.json'))
    await fs.writeFile(decisionPath, JSON.stringify({ ...JSON.parse(decision), productionReady: true }))
    fixture = driver(root, report.referencePath, ids); drivers.push(fixture)
    assert.notEqual((await fixture.exited).code, 0)
    assert.equal(fixture.lines.some(line => JSON.parse(line).event === 'ready'), false)
    assert.deepEqual(await fs.readFile(path.join(profile, 'state.json')), currentState)
    assert.deepEqual(await fs.readFile(path.join(profile, 'identity.json')), originalIdentity)
    await fs.writeFile(decisionPath, decision)
    ready = await launch(ids); await fixture.call('verify'); assert.equal((await fixture.stop()).code, 0)
    assert.deepEqual(await hashes(path.join(root, 'Snapshot')), snapshotBefore)
    check('actual cold process rejects tampered grant without publishing a service or changing state; restoring exact journal permits fresh recovery')
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const d of drivers) if (d.child.exitCode === null && d.child.signalCode === null) await d.kill()
    await sender?.dispose(); await generator?.dispose()
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.flatMap((d, index) => d.lines.map(line => `${index}: ${line}`)).join('\n'))
    await fs.writeFile(path.join(artifacts, 'stderr.log'), drivers.flatMap(d => d.errors).join('\n'))
    report.remainingProcesses = drivers.filter(d => d.child.exitCode === null && d.child.signalCode === null).length
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.match(path.basename(root), /^dustdesk-runtime-preview-[A-Za-z0-9]+$/)
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
    await fs.rm(root, { recursive: true, force: true })
    for (const callback of cleanup.reverse()) await callback()
    report.cleanup = { rootRemoved: await fs.access(root).then(() => false, () => true) }
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
  }
})
