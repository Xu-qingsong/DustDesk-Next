import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, accept, description) {
  const end = Date.now() + 10000
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(20) }
  throw Error(description)
}
async function build() {
  const child = spawn('cargo', ['build', '--example', 'lan-transport'], { cwd: path.resolve('src-tauri'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []; child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => chunks.push(value))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  await fs.writeFile(path.join(artifacts, 'lan-transport-driver-build.log'), Buffer.concat(chunks))
  assert.equal(code, 0, 'Rust transport driver failed to build')
}
function driver(root) {
  const child = spawn(path.resolve('src-tauri/target/debug/examples/lan-transport.exe'), [root], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const waiting = new Map(), events = [], eventWaiters = new Set(), lines = [], errors = []
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })) })
  child.stderr.on('data', value => errors.push(value.toString()))
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line); const value = JSON.parse(line)
    if (value.id && waiting.has(value.id)) { waiting.get(value.id)(value); waiting.delete(value.id) }
    else { events.push(value); for (const notify of eventWaiters) notify() }
  })
  let sequence = 0
  const start = value => {
    const id = String(++sequence)
    const result = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiting.delete(id); reject(Error('driver command timed out: ' + value.command)) }, 15000)
      waiting.set(id, reply => { clearTimeout(timeout); resolve(reply) })
    })
    child.stdin.write(JSON.stringify({ ...value, id }) + '\n'); return { id, result }
  }
  return { child, exited, lines, errors, start, call: value => start(value).result,
    event: async predicate => {
      const end = Date.now() + 15000
      while (Date.now() < end) {
        const index = events.findIndex(predicate); if (index >= 0) return events.splice(index, 1)[0]
        await new Promise(resolve => { const ready = () => { clearTimeout(timeout); eventWaiters.delete(ready); resolve() }; const timeout = setTimeout(ready, 1000); eventWaiters.add(ready) })
      }
      throw Error('Rust driver event timeout')
    },
    stop: async () => { if (child.exitCode === null) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
  }
}

function request(port, identity, fp, route, { method = 'POST', body = {}, version, stream } = {}) {
  let secure
  const options = { hostname: '127.0.0.1', port, path: route, method, rejectUnauthorized: false, agent: false,
    ...(identity ? { key: identity.key, cert: identity.cert } : {}),
    ...(version ? { minVersion: version, maxVersion: version } : {}),
    headers: { 'Content-Type': stream ? 'application/octet-stream' : 'application/json' } }
  let outgoing
  const result = new Promise((resolve, reject) => {
    outgoing = https.request(options, async response => {
      try { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), secure }) } catch (error) { reject(error) }
    })
    outgoing.on('socket', socket => socket.once('secureConnect', () => {
      if (hash(socket.getPeerCertificate().raw) !== fp) outgoing.destroy(Error('fixture peer pin mismatch'))
      secure = { protocol: socket.getProtocol(), reused: socket.isSessionReused() }
    }))
    outgoing.setTimeout(10000, () => outgoing.destroy(Error('fixture socket timeout')))
    outgoing.on('error', reject)
    if (stream) void stream(outgoing).catch(error => outgoing.destroy(error))
    else outgoing.end(method === 'GET' ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body))
  })
  return { outgoing, result }
}

async function signatureProxy(port, direction, messageType) {
  const sockets = new Set(); let changed = false
  const proxy = net.createServer(downstream => {
    const upstream = net.connect(port, '127.0.0.1')
    for (const socket of [downstream, upstream]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => { downstream.destroy(); upstream.destroy() }) }
    const source = direction === 'server' ? upstream : downstream
    const target = direction === 'server' ? downstream : upstream
    const plainSource = direction === 'server' ? downstream : upstream
    const plainTarget = direction === 'server' ? upstream : downstream
    plainSource.pipe(plainTarget)
    let buffered = Buffer.alloc(0)
    source.on('data', bytes => {
      buffered = Buffer.concat([buffered, bytes])
      while (buffered.length >= 5 && buffered.length >= 5 + buffered.readUInt16BE(3)) {
        const length = 5 + buffered.readUInt16BE(3), record = Buffer.from(buffered.subarray(0, length))
        buffered = buffered.subarray(length)
        if (!changed && record[0] === 22) {
          for (let offset = 5; offset + 4 <= record.length;) {
            const end = offset + 4 + record.readUIntBE(offset + 1, 3)
            if (end > record.length) break
            if (record[offset] === messageType && end > offset + 4) { record[end - 1] ^= 1; changed = true; break }
            offset = end
          }
        }
        target.write(record)
      }
    })
    source.on('end', () => target.end())
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  return { port: proxy.address().port, changed: () => changed, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)) } }
}

test('native Rust HTTPS transport pins both sides, streams to the legacy module, cancels requests and drains its listener', { timeout: 180000 }, async () => {
  const cleanup = [], { root, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const report = { verified: false, productionReady: false, migrationComplete: false, scope: 'Rust HTTPS transport library; desktop service, task persistence and native confirmation UI not connected', peers: 'Rust development driver and Node test process executing the existing Electron LAN module', checks: [] }
  const check = name => report.checks.push(name)
  let fixture, legacy, identityService, strangerService, mock
  const proxies = []
  try {
    await fs.mkdir(artifacts, { recursive: true }); await build()
    const sourcePaths = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/src/lan/tls.rs', 'src-tauri/src/lan/transport.rs', 'src-tauri/examples/lan-transport.rs', 'tests/tauri-lan-transport.mjs', 'tests/toolbox-fixture.mjs', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/reference/src/main/fileOperations.ts', 'src/shared/toolbox.ts']
    const inputs = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(file))])))
    report.inputs = await inputs()
    let pairs = 0, receivePending = false, holdReceive = false, heldResponseClosed = false, releaseReceive
    const downloads = path.join(root, 'downloads')
    const options = name => ({ storage: path.join(root, name), downloads, name, host: '127.0.0.1', discovery: false, changed() {},
      confirmPair: async () => { pairs++; return true },
      confirmReceive: async () => { if (holdReceive) { receivePending = true; return new Promise(resolve => { releaseReceive = resolve }) } return downloads },
    })
    identityService = lan.createLanService(options('rust-identity')); await identityService.enable(true); await identityService.dispose(); identityService = undefined
    strangerService = lan.createLanService(options('stranger')); await strangerService.enable(true); await strangerService.dispose(); strangerService = undefined
    legacy = lan.createLanService(options('legacy'))
    // Observe the real server's response-close event without changing its
    // routing or callbacks; local cancellation is not a remote-close ack.
    const createServer = https.createServer
    try {
      https.createServer = function (...args) {
        const server = createServer.apply(this, args)
        server.on('request', (incoming, response) => {
          if (holdReceive && incoming.url === '/offer') response.once('close', () => { heldResponseClosed = true })
        })
        return server
      }
      await legacy.enable(true)
    } finally { https.createServer = createServer }
    const [own, old, stranger] = await Promise.all(['rust-identity', 'legacy', 'stranger'].map(async name => JSON.parse(await fs.readFile(path.join(root, name, 'identity.json'), 'utf8'))))
    fixture = driver(path.join(root, 'rust-identity'))
    const ready = await fixture.event(value => value.event === 'ready')
    assert.equal(ready.fingerprint, own.fingerprint)
    const port = ready.port, oldPort = legacy.snapshot().port
    const found = await fixture.call({ command: 'discover', address: '127.0.0.1', port: oldPort })
    assert.equal(found.ok, true, found.error); const device = found.value
    assert.equal(device.id, old.id); assert.equal(device.fingerprint, old.fingerprint); assert.equal(pairs, 0)
    assert.equal(legacy.snapshot().devices.length, 0)
    check('unpaired Rust bootstrap observes only /hello and the actual TLS peer fingerprint without pairing or adding trust')

    const unpaired = await fixture.call({ command: 'json', device, path: '/offer', body: { id: 'unpaired', name: 'text', directories: [], entries: [], text: 'denied' } })
    assert.equal(unpaired.ok, false); assert.match(unpaired.error, /先配对/)
    const paired = await fixture.call({ command: 'json', device, path: '/pair', body: { id: own.id, name: 'Rust', port } })
    assert.equal(paired.ok, true, paired.error); assert.equal(pairs, 1)
    const text = await fixture.call({ command: 'json', device, path: '/offer', body: { id: 'rust-text', name: '文本', directories: [], entries: [], text: '来自 Rust HTTPS 😀' } })
    assert.equal(text.ok, true, text.error); assert.match(text.value.token, /^[a-f0-9]{64}$/)
    assert.equal(legacy.snapshot().tasks.find(task => task.name === '文本').text, '来自 Rust HTTPS 😀')
    check('Rust client pins the observed certificate, pairs through the real legacy module callback and offers text over mutual TLS')

    const data = Buffer.alloc(8 * 1024 * 1024); for (let i = 0; i < data.length; i++) data[i] = (i * 37 + (i >>> 16)) & 255
    const source = path.join(root, 'outgoing.bin'); await fs.writeFile(source, data)
    const manifest = { id: 'rust-file', name: '文件夹', directories: ['发送目录', '发送目录/empty'], entries: [{ relative: '发送目录/file.bin', size: data.length, mtime: (await fs.stat(source)).mtimeMs, hash: hash(data) }] }
    const offer = await fixture.call({ command: 'json', device, path: '/offer', body: manifest })
    assert.equal(offer.ok, true, offer.error)
    const token = offer.value.token
    const upload = await fixture.call({ command: 'upload', device, path: `/file?id=rust-file&token=${token}&index=0&offset=0`, file: source })
    assert.equal(upload.ok, true, upload.error)
    assert.equal((await fixture.call({ command: 'json', device, path: `/complete?id=rust-file&token=${token}`, body: {} })).ok, true)
    const received = legacy.snapshot().tasks.find(task => task.name === '文件夹')
    assert.equal(received.status, 'completed'); assert.equal(hash(await fs.readFile(path.join(received.directory, '发送目录/file.bin'))), hash(data))
    assert.ok((await fs.stat(path.join(received.directory, '发送目录/empty'))).isDirectory())
    check('Rust streams an 8 MiB source with bounded frames to the actual legacy /file endpoint; receiver verifies SHA-256 and publishes file and empty directory')

    const before = (await fixture.call({ command: 'stats' })).value.calls
    const missing = request(port, undefined, own.fingerprint, '/hello', { method: 'GET' })
    await assert.rejects(missing.result)
    assert.equal((await fixture.call({ command: 'stats' })).value.calls, before)
    const refused = await request(port, stranger, own.fingerprint, '/file', { body: Buffer.from('no access') }).result
    assert.equal(refused.status, 400); assert.match(refused.body.error, /先配对/)
    assert.equal((await fixture.call({ command: 'stats' })).value.calls, before)
    for (const version of ['TLSv1.2', 'TLSv1.3']) {
      const hello = await request(port, old, own.fingerprint, '/hello', { method: 'GET', version }).result
      assert.equal(hello.status, 200); assert.equal(hello.secure.protocol, version); assert.equal(hello.secure.reused, false)
    }
    check('Rust server requires client-certificate proof of possession in TLS 1.2 and 1.3; missing and untrusted certificates never reach protected handlers')

    const connecting = legacy.connect('127.0.0.1', port)
    const pairing = await fixture.event(value => value.event === 'pair' && value.fingerprint === old.fingerprint)
    assert.equal((await fixture.call({ command: 'decision', request: pairing.request, accepted: true })).value, true)
    const rustPeer = await connecting; assert.equal(rustPeer.id, own.id); assert.equal(rustPeer.fingerprint, own.fingerprint)
    const slow = await request(port, old, own.fingerprint, '/file', { stream: async outgoing => {
      for (let i = 0; i < 5; i++) { outgoing.write(Buffer.alloc(32 * 1024, i)); await delay(400) }
      outgoing.end()
    } }).result
    assert.equal(slow.status, 200); assert.equal(slow.body.size, 5 * 32 * 1024)
    assert.equal(slow.body.sha256, hash(Buffer.concat(Array.from({ length: 5 }, (_, i) => Buffer.alloc(32 * 1024, i)))))
    check('legacy module connects to Rust with explicit fixture pairing approval; an inbound stream lasting longer than the idle limit succeeds while data keeps progressing')

    await fixture.call({ command: 'trust', fingerprint: old.fingerprint, enabled: false })
    const revoked = await request(port, old, own.fingerprint, '/file', { body: Buffer.from('denied after revoke') }).result
    assert.equal(revoked.status, 400); assert.match(revoked.body.error, /先配对/)
    await fixture.call({ command: 'trust', fingerprint: old.fingerprint, enabled: true })
    const invalidMethod = await request(port, old, own.fingerprint, '/cancel', { method: 'GET' }).result
    assert.equal(invalidMethod.status, 400)
    const tooLarge = await request(port, stranger, own.fingerprint, '/pair', { body: Buffer.alloc(4097, 32) }).result
    assert.equal(tooLarge.status, 400); assert.match(tooLarge.body.error, /内容过大/)
    check('each request rechecks live trust and exact method/route; oversized pair JSON is rejected with a bounded read')

    const canceled = request(port, stranger, own.fingerprint, '/pair', { body: { id: stranger.id, name: 'stranger', port: 12345 } })
    const canceledResult = canceled.result.catch(error => error)
    const canceledPair = await fixture.event(value => value.event === 'pair' && value.fingerprint === stranger.fingerprint)
    canceled.outgoing.destroy(Error('fixture canceled'))
    await canceledResult
    await waitFor(async () => (await fixture.call({ command: 'stats' })).value.pending, value => value === 0, 'disconnect did not cancel pair handler')
    assert.equal((await fixture.call({ command: 'decision', request: canceledPair.request, accepted: true })).value, false)
    assert.match((await request(port, stranger, own.fingerprint, '/file', { body: Buffer.alloc(0) }).result).body.error, /先配对/)
    check('client disconnect drops the pending server request; an approval for that closed request cannot add fixture trust')

    holdReceive = true
    const held = fixture.start({ command: 'json', device, path: '/offer', body: { id: 'cancel-outgoing', name: 'cancel', entries: [], directories: [], text: 'must not be received' } })
    await waitFor(() => receivePending, Boolean, 'legacy receive callback not reached')
    assert.equal((await fixture.call({ command: 'cancel', target: held.id })).value, true)
    const heldReply = await held.result; assert.equal(heldReply.ok, false); assert.match(heldReply.error, /取消/)
    await waitFor(() => heldResponseClosed, Boolean, 'canceled Rust request did not close the remote response')
    holdReceive = false; releaseReceive(downloads); await delay(80)
    assert.equal(legacy.snapshot().tasks.some(task => task.name === 'cancel'), false)
    check('canceling a Rust client request closes its connection; the actual legacy module ignores late receive confirmation')

    let mockCalls = 0, mode = 'hello'
    mock = https.createServer({ key: old.key, cert: old.cert, requestCert: true, rejectUnauthorized: false, maxVersion: 'TLSv1.2' }, (incoming, response) => {
      mockCalls++
      if (mode === 'stall') { response.writeHead(200); response.write('{'); return }
      if (mode === 'redirect') { response.writeHead(302, { Location: 'https://127.0.0.1:' + port + '/hello' }); response.end('{}'); return }
      response.end(mode === 'malformed' ? '{' : JSON.stringify({ protocol: 1, id: mode === 'wrong-id' ? 'changed-id' : old.id, name: 'mock', port: oldPort }))
    })
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve))
    const mockDevice = { ...device, port: mock.address().port }
    const wrongPin = await fixture.call({ command: 'hello', device: { ...mockDevice, fingerprint: stranger.fingerprint } })
    assert.equal(wrongPin.ok, false); assert.match(wrongPin.error, /身份已变化/); assert.equal(mockCalls, 0)
    const serverProxy = await signatureProxy(mock.address().port, 'server', 12); proxies.push(serverProxy)
    const tamperedServer = await fixture.call({ command: 'hello', device: { ...device, port: serverProxy.port } })
    assert.equal(serverProxy.changed(), true, 'the actual TLS 1.2 server-key-exchange signature was altered')
    assert.equal(tamperedServer.ok, false); assert.match(tamperedServer.error, /TLS/); assert.equal(mockCalls, 0)
    const clientProxy = await signatureProxy(port, 'client', 15); proxies.push(clientProxy)
    const beforeTamper = (await fixture.call({ command: 'stats' })).value.calls
    await assert.rejects(request(clientProxy.port, old, own.fingerprint, '/hello', { method: 'GET', version: 'TLSv1.2' }).result)
    assert.equal(clientProxy.changed(), true, 'the actual client CertificateVerify signature was altered')
    assert.equal((await fixture.call({ command: 'stats' })).value.calls, beforeTamper)
    check('altering actual TLS 1.2 server and client signatures rejects both connections before any HTTP handler despite unchanged certificate bytes')
    mode = 'wrong-id'; const wrongId = await fixture.call({ command: 'hello', device: mockDevice }); assert.equal(wrongId.ok, false); assert.match(wrongId.error, /身份已变化/)
    mode = 'redirect'; const redirect = await fixture.call({ command: 'hello', device: mockDevice }); assert.equal(redirect.ok, false); assert.match(redirect.error, /重定向/)
    mode = 'malformed'; assert.match((await fixture.call({ command: 'hello', device: mockDevice })).error, /JSON/)
    mode = 'stall'; assert.equal((await fixture.call({ command: 'hello', device: mockDevice })).ok, false)
    check('wrong server pin fails before HTTP bytes, pinned hello rejects changed device ID, redirects are not followed, malformed JSON and stalled response fail')

    const stalled = net.connect(port, '127.0.0.1'); stalled.on('error', () => {})
    await once(stalled, 'connect'); await new Promise(resolve => stalled.once('close', resolve))
    const headerSocket = tls.connect({ host: '127.0.0.1', port, key: old.key, cert: old.cert, rejectUnauthorized: false }); headerSocket.on('error', () => {})
    await once(headerSocket, 'secureConnect'); headerSocket.write('GET /hello HTTP/1.1\r\nHost: localhost\r\n')
    await new Promise(resolve => headerSocket.once('close', resolve))
    assert.equal((await request(port, old, own.fingerprint, '/hello', { method: 'GET' }).result).status, 200)
    check('stalled TLS handshakes and partial headers time out and release capacity; subsequent valid requests still succeed')

    const stopping = request(port, stranger, own.fingerprint, '/pair', { body: { id: stranger.id, name: 'stop pending', port: 12345 } })
    const stoppedRequest = stopping.result.catch(error => error)
    await fixture.event(value => value.event === 'pair' && value.fingerprint === stranger.fingerprint)
    assert.deepEqual(await fixture.stop(), { code: 0, signal: null })
    await stoppedRequest
    const drained = await fixture.event(value => value.event === 'stopped'); assert.equal(drained.pending, 0)
    check('server stop cancels pending approval handlers, joins all connections and exits the isolated Rust driver cleanly')
    assert.deepEqual(await inputs(), report.inputs)
    report.driverSha256 = hash(await fs.readFile('src-tauri/target/debug/examples/lan-transport.exe'))
    report.verified = true
  } catch (error) { report.error = error.stack; throw error }
  finally {
    if (fixture?.child.exitCode === null) { fixture.child.kill(); await fixture.exited }
    if (fixture) { await fs.writeFile(path.join(artifacts, 'lan-transport-driver-events.log'), fixture.lines.join('\n')); await fs.writeFile(path.join(artifacts, 'lan-transport-driver-stderr.log'), fixture.errors.join('')) }
    if (mock) { mock.closeAllConnections(); await new Promise(resolve => mock.close(resolve)) }
    for (const proxy of proxies) await proxy.close()
    await Promise.allSettled([identityService?.dispose(), strangerService?.dispose(), legacy?.dispose()])
    await fs.writeFile(path.join(artifacts, 'lan-transport-verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup) await callback()
  }
})
