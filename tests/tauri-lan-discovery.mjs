import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import dgram from 'node:dgram'
import https from 'node:https'
import net from 'node:net'
import { Transform } from 'node:stream'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/lan-discovery')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, accept, description) {
  const end = Date.now() + 20_000
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(20) }
  throw Error(description)
}
async function build() {
  const child = spawn('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-receiver'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []; child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => chunks.push(value))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await fs.writeFile(path.join(artifacts, 'build.log'), Buffer.concat(chunks)); assert.equal(code, 0)
}
function driver(profile, downloads) {
  const child = spawn(path.resolve('src-tauri/target/debug/examples/lan-receiver.exe'), [profile, downloads], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = [], replies = new Map(), lines = [], errors = [], waiters = new Set(); let sequence = 0, closed = false
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; for (const notify of waiters) notify(); resolve({ code, signal }) }) })
  child.stderr.on('data', value => errors.push(value.toString()))
  createInterface({ input: child.stdout }).on('line', line => { lines.push(line); const value = JSON.parse(line); if (value.id && replies.has(value.id)) { replies.get(value.id)(value); replies.delete(value.id) } else { events.push(value); for (const notify of waiters) notify() } })
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  return { child, exited, lines, errors,
    call(value) { const id = String(++sequence); const result = new Promise((resolve, reject) => { const timeout = setTimeout(() => { replies.delete(id); reject(Error('native command timeout: ' + value.command)) }, 20_000); replies.set(id, reply => { clearTimeout(timeout); resolve(reply) }) }); result.catch(() => {}); send({ ...value, id }); return result },
    async event(predicate) {
      const end = Date.now() + 20_000
      while (Date.now() < end) { const index = events.findIndex(predicate); if (index >= 0) return events.splice(index, 1)[0]; if (closed) throw Error('native service exited: ' + errors.join('')); await new Promise(resolve => { const notify = () => { clearTimeout(timeout); waiters.delete(notify); resolve() }; const timeout = setTimeout(notify, 500); waiters.add(notify) }) }
      throw Error('native event timeout: ' + predicate)
    },
    approve(request) { send({ command: 'approve', request, accept: true }) },
    async network() { const value = await this.call({ command: 'discovery' }); assert.equal(value.ok, true, value.error); return value.value },
    async state() { const value = await this.call({ command: 'snapshot' }); assert.equal(value.ok, true, value.error); return value.state },
    async views() { const value = await this.call({ command: 'progress' }); assert.equal(value.ok, true, value.error); return value.views },
    async stop() { if (!closed) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
    async kill() { if (!closed) child.kill('SIGKILL'); return exited },
  }
}
async function udp() {
  const socket = dgram.createSocket('udp4'), messages = [], errors = []
  socket.on('error', error => errors.push(error)); socket.on('message', (bytes, remote) => messages.push({ bytes, remote }))
  await new Promise(resolve => socket.bind(0, '127.0.0.1', resolve))
  return { socket, messages, errors, port: socket.address().port, send(bytes, port) { return new Promise((resolve, reject) => socket.send(Buffer.isBuffer(bytes) ? bytes : Buffer.from(JSON.stringify(bytes)), port, '127.0.0.1', error => error ? reject(error) : resolve())) }, close() { return new Promise(resolve => socket.close(resolve)) } }
}
async function helloServer(identity, expectedClient) {
  const sockets = new Set(), pending = [], errors = []
  const peer = { mode: 'normal', name: 'Authenticated old endpoint', calls: 0, pending, errors }
  const server = https.createServer({ key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false }, (request, response) => {
    try {
      assert.equal(hash(request.socket.getPeerCertificate().raw), expectedClient); peer.calls++
      request.resume()
      if (request.url === '/pair') { response.end(JSON.stringify({ ok: true })); return }
      assert.equal(request.url, '/hello')
      const entry = { closed: false, respond() { response.end(JSON.stringify({ protocol: 1, id: peer.mode === 'wrong-id' ? 'changed-id' : identity.id, name: peer.name, port: server.address().port })) } }
      response.once('close', () => { entry.closed = true })
      if (peer.mode === 'hold') pending.push(entry); else entry.respond()
    } catch (error) { errors.push(String(error)); response.destroy(error) }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return Object.assign(peer, { port: server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } })
}
async function slowProxy(target) {
  const sockets = new Set()
  const server = net.createServer(client => {
    const remote = net.connect(target, '127.0.0.1')
    let transferred = 0, blocked
    const slow = new Transform({ transform(bytes, _encoding, done) {
      if (transferred >= 2 * 1024 * 1024) blocked = () => { blocked = undefined; done(Error('test TCP gate closed')) }
      else { transferred += bytes.length; setTimeout(() => done(null, bytes), 10) }
    } })
    const close = () => { blocked?.(); slow.destroy(); client.destroy(); remote.destroy() }
    slow.on('error', close)
    for (const socket of [client, remote]) { sockets.add(socket); socket.on('error', close); socket.on('close', () => { sockets.delete(socket); if (socket === client || blocked) close() }) }
    client.pipe(slow).pipe(remote); remote.pipe(client)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { port: server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } }
}

test('real native UDP hints, pinned heartbeats and endpoint rediscovery remain independent from pairing and task state', { timeout: 240_000 }, async () => {
  const cleanup = []; const { root, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const drivers = [], sockets = [], servers = [], proxies = []; let a, b, old, generator
  const report = { verified: false, productionReady: false, migrationComplete: false, scope: 'Windows service library with actual loopback UDP/HTTPS and configurable short test timing; explicit development approvals; no physical broadcast, firewall or desktop IPC acceptance', checks: [] }
  const check = message => report.checks.push(message)
  try {
    await fs.mkdir(artifacts, { recursive: true }); await build()
    const sources = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/adapters.rs', 'src-tauri/src/lan/peers.rs', 'src-tauri/src/lan/discovery.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/src/lan/files.rs', 'src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs', 'src-tauri/src/lan/sender.rs', 'src-tauri/src/lan/sources.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/src/lan/publication.rs', 'src-tauri/src/lan/publication/legacy.rs', 'src-tauri/src/lan/tls.rs', 'src-tauri/src/lan/transport.rs', 'src-tauri/examples/lan-receiver.rs', 'tests/tauri-lan-discovery.mjs', 'tests/toolbox-fixture.mjs', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/reference/src/main/fileOperations.ts', 'src/shared/toolbox.ts']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async source => [source, hash(await fs.readFile(source))])))
    report.driver = { executable: path.resolve('src-tauri/target/debug/examples/lan-receiver.exe'), sha256: hash(await fs.readFile('src-tauri/target/debug/examples/lan-receiver.exe')) }
    const downloads = path.join(root, 'downloads'); await fs.mkdir(downloads)
    let oldPairs = 0
    const options = name => ({ storage: path.join(root, name), downloads, host: '127.0.0.1', discovery: false, name, changed() {}, confirmPair: async () => { oldPairs++; return true }, confirmReceive: async () => downloads })
    for (const name of ['native-a', 'native-b', 'stranger']) { generator = lan.createLanService(options(name)); await generator.enable(true); await generator.dispose(); generator = undefined }
    old = lan.createLanService(options('old')); await old.enable(true)
    const oldIdentity = JSON.parse(await fs.readFile(path.join(root, 'old/identity.json'), 'utf8'))
    const stranger = JSON.parse(await fs.readFile(path.join(root, 'stranger/identity.json'), 'utf8'))
    a = driver(path.join(root, 'native-a'), downloads); drivers.push(a); let readyA = await a.event(value => value.event === 'ready')
    const sink = await udp(); sockets.push(sink)
    const config = { command: 'discovery-start', bind: '127.0.0.1:0', targets: [`127.0.0.1:${sink.port}`], cadenceMs: 200, timeoutMs: 600, ttlMs: 1200 }
    const started = await a.call(config); assert.equal(started.ok, true, started.error); const udpA = Number(started.value.status.udpAddress.split(':').at(-1))
    const announcement = await waitFor(() => sink.messages[0], Boolean, 'actual native UDP announcement missing')
    assert.deepEqual(JSON.parse(announcement.bytes), { protocol: 'dustdesk-1', id: readyA.device, name: 'Rust receiver fixture', port: readyA.port, fingerprint: readyA.fingerprint })
    assert.equal(announcement.remote.address, '127.0.0.1'); assert.equal(announcement.remote.port, udpA)
    const adapterView = await waitFor(() => a.network(), value => value.status.adapterRefreshes > 0, 'native adapter enumeration never finished')
    const reference = Object.values(os.networkInterfaces()).flat().filter(value => value.family === 'IPv4').map(value => ({ address: value.address, netmask: value.netmask, internal: value.internal }))
    for (const adapter of adapterView.status.adapters) { assert.ok(reference.some(value => value.address === adapter.address && !value.internal)); const parts = adapter.address.split('.').map(Number); const netmask = adapter.prefix === 0 ? 0 : (0xffffffff << (32 - adapter.prefix)) >>> 0; assert.equal(adapter.broadcast, parts.map((value, index) => value | (~(netmask >>> (24 - index * 8)) & 255)).join('.')) }
    report.adapters = { native: adapterView.status.adapters, nodeReference: reference }
    check('native GetAdaptersAddresses data agrees with independent Node interface addresses and prefix-derived broadcasts; actual UDP announcement preserves protocol/identity/HTTPS port without private data')
    const packet = { protocol: 'dustdesk-1', id: oldIdentity.id, name: 'Old UDP hint', port: old.snapshot().port, fingerprint: oldIdentity.fingerprint, address: '8.8.8.8' }
    await sink.send(packet, udpA)
    await waitFor(() => a.network(), value => value.devices.some(device => device.id === packet.id && device.address === '127.0.0.1'), 'old-format UDP hint not listed using actual source address')
    assert.equal((await a.state()).trusted.includes(oldIdentity.fingerprint), false)
    const unpaired = await a.call({ command: 'send', peer: packet.id, paths: [], text: 'not paired' }); assert.equal(unpaired.ok, false); assert.match(unpaired.error, /配对/); assert.equal(oldPairs, 0)
    const invalid = [Buffer.alloc(2049, 32), { ...packet, protocol: 'other' }, { ...packet, id: readyA.device }, { ...packet, port: 0 }, { ...packet, port: 1.5 }, { ...packet, fingerprint: 'invalid' }, { ...packet, name: 'x'.repeat(256) }]
    for (const item of invalid) await sink.send(item, udpA)
    const sentinel = { ...packet, id: 'after-invalid', name: 'sentinel' }; await sink.send(sentinel, udpA)
    const checked = await waitFor(() => a.network(), value => value.devices.some(device => device.id === sentinel.id), 'sentinel UDP packet not processed')
    assert.equal(checked.devices.length, 2); assert.equal(checked.status.activeProbes, 0)
    await waitFor(() => a.network(), value => value.devices.length === 0, 'unpaired UDP hints did not expire')
    check('old-format UDP hints cannot grant trust or start a send/probe; source address is authoritative, malformed/self/oversize packets are ignored and unpaired hints expire')
    const connecting = a.call({ command: 'connect', address: '127.0.0.1', port: old.snapshot().port })
    const pair = await a.event(value => value.event === 'pair'); a.approve(pair.request)
    const connected = await connecting; assert.equal(connected.ok, true, connected.error); assert.equal(oldPairs, 1)
    const pairedSeen = (await a.network()).devices.find(device => device.id === packet.id).lastSeen
    await waitFor(() => a.network(), value => value.devices.some(device => device.id === packet.id && device.lastSeen > pairedSeen + 1400) && value.status.probesCompleted >= 2, 'paired HTTPS peer did not stay visible independently of UDP')
    assert.equal(oldPairs, 1); assert.ok((await a.state()).trusted.includes(oldIdentity.fingerprint))
    check('manual pairing requires explicit native approval and durable trust; pinned HTTPS heartbeats keep the old module online beyond hint TTL without UDP or repeated pairing')
    await old.dispose(); old = undefined
    const stale = await helloServer(oldIdentity, readyA.fingerprint); stale.mode = 'hold'; servers.push(stale)
    await sink.send({ ...packet, port: stale.port, name: 'moving endpoint' }, udpA)
    await waitFor(() => stale.pending[0], Boolean, 'heartbeat did not use UDP-updated paired endpoint')
    const fresh = await helloServer(oldIdentity, readyA.fingerprint); fresh.mode = 'hold'; servers.push(fresh)
    await sink.send({ ...packet, port: fresh.port, name: 'new endpoint hint' }, udpA)
    const beforeCompletion = (await a.network()).status.probesCompleted
    stale.pending[0].respond()
    const afterLate = await waitFor(() => a.network(), value => value.status.probesCompleted > beforeCompletion, 'late old-endpoint heartbeat not settled')
    assert.equal(afterLate.devices.find(device => device.id === packet.id).port, fresh.port)
    const newPending = await waitFor(() => fresh.pending[0], Boolean, 'new endpoint heartbeat not attempted'); fresh.mode = 'normal'; newPending.respond()
    await waitFor(() => a.network(), value => value.devices.some(device => device.id === packet.id && device.port === fresh.port && device.name === fresh.name), 'new endpoint was not authenticated')
    const beforeBadPin = (await a.network()).devices.find(device => device.id === packet.id)
    await sink.send({ ...packet, fingerprint: stranger.fingerprint, port: stale.port, name: 'spoofed pin' }, udpA)
    await sink.send(sentinel, udpA)
    const ignored = await waitFor(() => a.network(), value => value.devices.some(device => device.id === sentinel.id), 'spoof sentinel missing')
    assert.equal(ignored.devices.find(device => device.id === packet.id).port, beforeBadPin.port)
    check('paired broadcasts retain the pinned identity, update endpoint hints for HTTPS, and an actual late heartbeat from the previous endpoint cannot overwrite the new port')
    const wrongCert = await helloServer(stranger, readyA.fingerprint); servers.push(wrongCert)
    const completedBeforeWrong = (await a.network()).status.probesCompleted
    await sink.send({ ...packet, port: wrongCert.port }, udpA)
    await waitFor(() => a.network(), value => value.status.probesCompleted >= completedBeforeWrong + 2 && !value.devices.some(device => device.id === packet.id), 'wrong certificate kept a paired peer alive')
    assert.equal(wrongCert.calls, 0, 'pin mismatch must fail before HTTP')
    fresh.mode = 'wrong-id'; await sink.send({ ...packet, port: fresh.port }, udpA)
    const wrongIdStart = (await a.network()).status.probesCompleted
    await waitFor(() => a.network(), value => value.status.probesCompleted >= wrongIdStart + 2 && !value.devices.some(device => device.id === packet.id), 'changed device ID kept a paired peer alive')
    fresh.mode = 'normal'; await sink.send({ ...packet, port: fresh.port, name: 'fresh hint' }, udpA)
    await waitFor(() => a.network(), value => value.devices.some(device => device.id === packet.id && device.name === fresh.name), 'valid pinned endpoint did not reappear')
    check('wrong certificate fails before HTTP and changed ID under the same certificate fails heartbeat; neither refreshes liveness, and a valid rediscovered endpoint reappears')
    assert.equal((await a.call({ command: 'discovery-stop' })).ok, true)
    const blockedUdp = await udp(); sockets.push(blockedUdp)
    const fallback = await a.call({ ...config, bind: `127.0.0.1:${blockedUdp.port}`, targets: [] }); assert.equal(fallback.ok, true, fallback.error); assert.match(fallback.value.status.error, /发现受阻/); assert.equal(fallback.value.status.udpAddress, null)
    const fallbackSeen = fallback.value.devices.find(device => device.id === packet.id).lastSeen
    await waitFor(() => a.network(), value => value.devices.some(device => device.id === packet.id && device.lastSeen > fallbackSeen + 1400), 'UDP bind failure stopped independently paired HTTPS heartbeat')
    check('actual UDP address-in-use failure is visible, keeps service running for manual connections and does not stop paired HTTPS heartbeat')

    b = driver(path.join(root, 'native-b'), downloads); drivers.push(b); let readyB = await b.event(value => value.event === 'ready')
    const networkB = await b.call({ ...config, targets: [] }); assert.equal(networkB.ok, true, networkB.error)
    const slowB = await slowProxy(readyB.port); proxies.push(slowB)
    const nativePairing = a.call({ command: 'connect', address: '127.0.0.1', port: slowB.port })
    const nativeLocal = await a.event(value => value.event === 'pair'); a.approve(nativeLocal.request)
    const nativeRemote = await b.event(value => value.event === 'pair'); b.approve(nativeRemote.request)
    const peerB = await nativePairing; assert.equal(peerB.ok, true, peerB.error)
    const source = path.join(root, 'rediscovered.bin'); const bytes = Buffer.alloc(8 * 1024 * 1024 + 17, 137); await fs.writeFile(source, bytes)
    const sent = await a.call({ command: 'send', peer: peerB.value.id, paths: [source] }); assert.equal(sent.ok, true, sent.error)
    const incoming = await b.event(value => value.event === 'receive'); b.approve(incoming.request)
    const receiving = await waitFor(async () => (await b.state()).tasks.find(task => task.manifest.id === sent.value.task), task => task?.staging, 'native receiving task not saved')
    await waitFor(() => fs.stat(path.join(receiving.staging, '0.part')).catch(error => { if (error.code === 'ENOENT') return null; throw error }), value => value?.size >= 1024 * 1024 && value.size < bytes.length, 'real upload did not create a partial file')
    await b.kill(); await slowB.close()
    await waitFor(() => a.views(), views => views.some(task => task.id === sent.value.task && task.status === 'failed'), 'native send did not fail when receiver process stopped')
    assert.equal((await a.call({ command: 'discovery-stop' })).ok, true)
    const reopenedA = await a.call({ ...config, bind: `127.0.0.1:${udpA}`, targets: [] }); assert.equal(reopenedA.ok, true, reopenedA.error); assert.equal(reopenedA.value.status.error, null)
    b = driver(path.join(root, 'native-b'), downloads); drivers.push(b); readyB = await b.event(value => value.event === 'ready')
    const restartedB = await b.call({ ...config, targets: [`127.0.0.1:${udpA}`] }); assert.equal(restartedB.ok, true, restartedB.error)
    await waitFor(() => a.network(), value => value.devices.some(device => device.id === readyB.device && device.port === readyB.port), 'restarted receiver endpoint not learned from actual native UDP')
    assert.equal((await a.call({ command: 'control-send', task: sent.value.task, action: 'resume' })).ok, true)
    const resume = await b.event(value => value.event === 'receive'); assert.equal(resume.existing, receiving.view.directory); b.approve(resume.request)
    const finished = await waitFor(() => a.views(), views => views.some(task => task.id === sent.value.task && ['failed', 'completed'].includes(task.status)), 'rediscovered send did not settle'); assert.equal(finished.find(task => task.id === sent.value.task).status, 'completed')
    const final = (await b.state()).tasks.find(task => task.manifest.id === sent.value.task); assert.equal(final.view.status, 'completed'); assert.equal(hash(await fs.readFile(final.files[0])), hash(bytes))
    assert.equal((await a.state()).tasks.find(task => task.view.id === sent.value.task).peer.port, readyB.port)
    check('receiver process dies after a real 1 MiB upload, restarts at new HTTPS/UDP ports, announces itself to the sender, and freshly approved prefix resume finishes without a manual reconnect')
    const udpB = Number(restartedB.value.status.udpAddress.split(':').at(-1))
    assert.equal((await a.call({ command: 'discovery-stop' })).ok, true)
    const both = await a.call({ ...config, bind: `127.0.0.1:${udpA}`, targets: [`127.0.0.1:${udpB}`] }); assert.equal(both.ok, true, both.error)
    await waitFor(() => Promise.all([a.network(), b.network()]), all => all[0].devices.some(device => device.id === readyB.device) && all[1].devices.some(device => device.id === readyA.device), 'native peers did not announce bidirectionally')
    check('both native service processes exchange actual UDP announcements and HTTPS heartbeat independently from the durable transfer state')
    assert.equal((await a.stop()).code, 0, a.errors.join('')); assert.equal((await a.event(value => value.event === 'stopped')).releaseVerified, true)
    a = driver(path.join(root, 'native-a'), downloads); drivers.push(a); readyA = await a.event(value => value.event === 'ready')
    const restored = await a.call({ ...config, udp: false, targets: [] }); assert.equal(restored.ok, true, restored.error); assert.equal(restored.value.status.udpAddress, null)
    await waitFor(() => a.network(), value => value.status.probesCompleted > 0 && value.devices.some(device => device.id === readyB.device && device.name === 'Rust receiver fixture'), 'saved trusted task endpoint did not authenticate after sender restart without UDP or manual reconnect')
    assert.equal((await a.state()).tasks.find(task => task.view.id === sent.value.task).view.status, 'completed')
    check('sender process restarts, seeds only trusted saved-task endpoints as offline candidates, and authenticates a peer over HTTPS with UDP disabled and no manual connect')
    const oldReconnect = await a.call({ command: 'connect', address: '127.0.0.1', port: fresh.port, expected: { ...connected.value, port: fresh.port } }); assert.equal(oldReconnect.ok, true, oldReconnect.error)
    fresh.mode = 'hold'
    const pending = await waitFor(() => fresh.pending.find(value => !value.closed), Boolean, 'no active heartbeat for stop test')
    assert.equal((await a.stop()).code, 0, a.errors.join(''))
    assert.equal((await b.stop()).code, 0, b.errors.join(''))
    await waitFor(() => pending.closed, Boolean, 'stopped native service retained a pending heartbeat connection')
    pending.respond()
    assert.equal((await a.event(value => value.event === 'stopped')).releaseVerified, true)
    assert.equal((await b.event(value => value.event === 'stopped')).releaseVerified, true)
    for (const port of [udpA, udpB]) { const rebound = dgram.createSocket('udp4'); await new Promise((resolve, reject) => { rebound.once('error', reject); rebound.bind(port, '127.0.0.1', resolve) }); await new Promise(resolve => rebound.close(resolve)) }
    for (const server of servers) assert.deepEqual(server.errors, [])
    check('stop joins an actual pending TLS heartbeat and adapter/UDP work, ignores late replies, releases the listening port and native profile/directory ownership')
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const fixture of drivers) if (fixture.child.exitCode === null) await fixture.kill()
    await old?.dispose(); await generator?.dispose()
    for (const socket of sockets) await socket.close()
    for (const server of servers) await server.close()
    for (const proxy of proxies) { try { await proxy.close() } catch {} }
    report.remainingProcesses = drivers.filter(fixture => fixture.child.exitCode === null && fixture.child.signalCode === null).length
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.flatMap((fixture, index) => fixture.lines.map(line => `${index}: ${line}`)).join('\n'))
    await fs.writeFile(path.join(artifacts, 'stderr.log'), drivers.flatMap(fixture => fixture.errors).join('\n'))
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup.reverse()) await callback()
  }
})
