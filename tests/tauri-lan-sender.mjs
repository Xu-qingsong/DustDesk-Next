import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import { Transform } from 'node:stream'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/lan-sender')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, accept, description) {
  const end = Date.now() + 20_000
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(20) }
  throw Error(description)
}
async function build() {
  const child = spawn('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-receiver'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const chunks = []; child.stdout.on('data', bytes => chunks.push(bytes)); child.stderr.on('data', bytes => chunks.push(bytes))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  await fs.writeFile(path.join(artifacts, 'build.log'), Buffer.concat(chunks)); assert.equal(code, 0)
}
function driver(profile, downloads) {
  const child = spawn(path.resolve('src-tauri/target/debug/examples/lan-receiver.exe'), [profile, downloads], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const replies = new Map(), events = [], waiters = new Set(), lines = [], errors = []
  let sequence = 0, closed = false
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; for (const notify of waiters) notify(); resolve({ code, signal }) }) })
  child.stderr.on('data', value => errors.push(value.toString()))
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line); const value = JSON.parse(line)
    if (value.id && replies.has(value.id)) { replies.get(value.id)(value); replies.delete(value.id) }
    else { events.push(value); for (const notify of waiters) notify() }
  })
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  return { child, exited, lines, errors, send,
    call(value) {
      const id = String(++sequence)
      const result = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { replies.delete(id); reject(Error('native command timeout: ' + value.command)) }, 20_000)
        replies.set(id, reply => { clearTimeout(timeout); resolve(reply) })
      })
      result.catch(() => {}); send({ ...value, id }); return result
    },
    async event(predicate) {
      const end = Date.now() + 20_000
      while (Date.now() < end) {
        const index = events.findIndex(predicate); if (index >= 0) return events.splice(index, 1)[0]
        if (closed) throw Error('native driver exited: ' + errors.join(''))
        await new Promise(resolve => { const ready = () => { clearTimeout(timeout); waiters.delete(ready); resolve() }; const timeout = setTimeout(ready, 500); waiters.add(ready) })
      }
      throw Error('native event timeout: ' + predicate)
    },
    async views() { const reply = await this.call({ command: 'progress' }); assert.equal(reply.ok, true, reply.error); return reply.views },
    async snapshot() { const reply = await this.call({ command: 'snapshot' }); assert.equal(reply.ok, true, reply.error); return reply.state },
    approve(request, accept = true) { send({ command: 'approve', request, accept }) },
    async stop() { if (!closed) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
    async kill() { if (!closed) child.kill('SIGKILL'); return exited },
  }
}
async function proxy(target) {
  const sockets = new Set()
  const control = { pauseAfter: Infinity, held: 0 }
  const server = net.createServer(client => {
    const remote = net.connect(target, '127.0.0.1')
    let transferred = 0, blocked
    const slow = new Transform({ transform(bytes, _encoding, done) {
      if (transferred >= control.pauseAfter) {
        control.held++; blocked = () => { control.held--; blocked = undefined; done(Error('test TCP gate closed')) }
      } else { transferred += bytes.length; setTimeout(() => done(null, bytes), 10) }
    } })
    const close = () => { blocked?.(); slow.destroy(); client.destroy(); remote.destroy() }
    slow.on('error', close)
    for (const socket of [client, remote]) { sockets.add(socket); socket.on('close', () => { sockets.delete(socket); if (socket === client || blocked) close() }); socket.on('error', close) }
    client.pipe(slow).pipe(remote); remote.pipe(client)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return Object.assign(control, { port: server.address().port, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } })
}
async function finished(driver, id) {
  const task = await waitFor(() => driver.views(), views => views.some(task => task.id === id && ['completed', 'failed'].includes(task.status)), 'native send did not settle')
  const view = task.find(task => task.id === id); assert.equal(view.status, 'completed', view.error)
  return view
}
// A deliberately faulty peer still uses a real pinned certificate and checks
// the native client's TLS identity. Its replies exercise sender validation.
async function faultyPeer(identity, clientFingerprint) {
  const calls = [], uploads = [], sockets = new Set()
  const peer = { reply: undefined, pending: undefined, complete: undefined, holdComplete: false, holdUpload: false }
  const server = https.createServer({ key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false }, async (request, response) => {
    try {
      assert.equal(hash(request.socket.getPeerCertificate().raw), clientFingerprint)
      const route = new URL(request.url, 'https://fixture'); calls.push(route.pathname)
      response.setHeader('Content-Type', 'application/json')
      const answer = value => response.end(JSON.stringify(value))
      if (route.pathname === '/hello') { request.resume(); answer({ protocol: 1, id: identity.id, name: 'Faulty fixture', port: server.address().port }); return }
      if (route.pathname === '/file' && peer.holdUpload) { peer.pendingUpload = request; return }
      const chunks = []; for await (const bytes of request) chunks.push(bytes)
      if (route.pathname === '/pause' && peer.controlInvalid) answer({ ok: false })
      else if (route.pathname === '/pair') answer({ ok: true })
      else if (route.pathname === '/offer') {
        const manifest = JSON.parse(Buffer.concat(chunks)); peer.manifest = manifest
        const valid = { token: 'b'.repeat(64), offsets: manifest.entries.map(() => ({ size: 0, hash: hash(Buffer.alloc(0)), complete: false })) }
        if (peer.reply) answer(peer.reply(valid, manifest))
        else peer.pending = () => answer(valid)
      } else if (route.pathname === '/file') { uploads.push({ route: Object.fromEntries(route.searchParams), bytes: Buffer.concat(chunks) }); answer({ ok: true }) }
      else if (route.pathname === '/complete' && peer.holdComplete) peer.complete = () => answer({ ok: true })
      else answer({ ok: true })
    } catch (error) { peer.error = error; response.destroy(error) }
  })
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return Object.assign(peer, { port: server.address().port, calls, uploads, async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) } })
}

test('native sender prepares pinned files, resumes through old receiver restart, and exchanges files concurrently with native receiver', { timeout: 240_000 }, async () => {
  const cleanup = []; const { root, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const report = { verified: false, productionReady: false, migrationComplete: false, scope: 'native send/receive library via explicit development decisions; old receiver is its real Electron LAN module inside Node; no desktop UI/IPC', checks: [] }
  const drivers = [], proxies = [], servers = []; let a, b, old, generator, returnedReceiver
  const check = value => report.checks.push(value)
  try {
    await fs.mkdir(artifacts, { recursive: true }); await build()
    const inputs = ['src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/src/lib.rs','src-tauri/src/lan/mod.rs','src-tauri/src/lan/protocol.rs','src-tauri/src/lan/storage.rs','src-tauri/src/lan/files.rs','src-tauri/src/lan/sources.rs','src-tauri/src/lan/sender.rs','src-tauri/src/lan/receiver.rs','src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs','src-tauri/src/lan/publication.rs', 'src-tauri/src/lan/publication/legacy.rs','src-tauri/src/lan/tls.rs','src-tauri/src/lan/transport.rs','src-tauri/examples/lan-receiver.rs','tests/tauri-lan-sender.mjs','tests/toolbox-fixture.mjs','tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts','tests/reference/src/main/fileOperations.ts','src/shared/toolbox.ts']
    report.inputs = Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await fs.readFile(file))])))
    report.driver = { executable: path.resolve('src-tauri/target/debug/examples/lan-receiver.exe'), sha256: hash(await fs.readFile('src-tauri/target/debug/examples/lan-receiver.exe')) }
    const downloadsA = path.join(root, 'downloads-a'), downloadsB = path.join(root, 'downloads-b'), downloadsOld = path.join(root, 'downloads-old')
    await Promise.all([downloadsA, downloadsB, downloadsOld].map(directory => fs.mkdir(directory)))
    let hold = false, held, release, responseClosed = false, confirmations = 0
    const options = name => ({ storage: path.join(root, name), downloads: downloadsOld, name, host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => true,
      confirmReceive: async () => { confirmations++; if (hold) { held = true; return new Promise(resolve => { release = resolve }) } return downloadsOld } })
    for (const name of ['native-a','native-b']) { generator = lan.createLanService(options(name)); await generator.enable(true); await generator.dispose(); generator = undefined }
    const originalCreateServer = https.createServer
    try {
      https.createServer = function (...args) {
        const server = originalCreateServer.apply(this, args)
        server.on('request', (incoming, response) => { if (hold && incoming.url === '/offer') response.once('close', () => { responseClosed = true }) })
        return server
      }
      old = lan.createLanService(options('old')); await old.enable(true)
    } finally { https.createServer = originalCreateServer }
    a = driver(path.join(root, 'native-a'), downloadsA); drivers.push(a); let readyA = await a.event(value => value.event === 'ready')
    let oldProxy = await proxy(old.snapshot().port); proxies.push(oldProxy)
    const connecting = a.call({ command: 'connect', address: '127.0.0.1', port: oldProxy.port })
    const pairing = await a.event(value => value.event === 'pair'); a.approve(pairing.request)
    const connected = await connecting; assert.equal(connected.ok, true, connected.error); let oldDevice = connected.value
    const text = await a.call({ command: 'send', peer: oldDevice.id, paths: [], text: '原生发送 😀 中文' }); assert.equal(text.ok, true, text.error)
    await finished(a, text.value.task)
    assert.equal(old.snapshot().tasks.find(task => task.text === '原生发送 😀 中文')?.status, 'completed')
    check('native outbound discovery uses actual fingerprint, local and remote pair approval, then sends Unicode text through the old receiver')

    const source = path.join(root, '发送😀'); await fs.mkdir(path.join(source, 'empty'), { recursive: true })
    await fs.writeFile(path.join(source, '0-small.txt'), '完整文件😀'); await fs.writeFile(path.join(source, '1-zero'), [])
    const bytes = Buffer.alloc(8 * 1024 * 1024 + 9); for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 23 + (index >>> 16)) & 255
    await fs.writeFile(path.join(source, '2-large.bin'), bytes)
    hold = true
    const submitted = await a.call({ command: 'send', peer: oldDevice.id, paths: [source] }); assert.equal(submitted.ok, true, submitted.error); const id = submitted.value.task
    await waitFor(() => held, Boolean, 'old receive decision not held')
    let native = (await a.snapshot()).tasks.find(task => task.view.id === id)
    assert.equal(native.prepared, true)
    for (const entry of native.manifest.entries) {
      assert.equal(entry.mtime, (await fs.stat(entry.source)).mtimeMs, 'mtime must be exactly compatible with old sender checks')
      assert.match(entry.rustSourceV1.identity.index, /^[a-f0-9]{16}$/)
    }
    const paused = await a.call({ command: 'control-send', task: id, action: 'pause' }); assert.equal(paused.ok, true, paused.error)
    await waitFor(() => responseClosed, Boolean, 'remote close was not observed before late approval')
    hold = false; release(downloadsOld)
    assert.equal((await a.views()).find(task => task.id === id).status, 'paused')
    assert.equal(old.snapshot().tasks.some(task => task.id.endsWith(id)), false)
    check('native preparation preserves exact old mtime, lossless file identity, and actual pause joins a pending offer before its late decision is released')
    oldProxy.pauseAfter = 2 * 1024 * 1024
    assert.equal((await a.call({ command: 'control-send', task: id, action: 'resume' })).ok, true)
    const stateOld = () => fs.readFile(path.join(root, 'old/state.json'), 'utf8').then(JSON.parse)
    let oldTask = await waitFor(async () => (await stateOld()).tasks.find(task => task.view.id.endsWith(id)), task => task?.staging && task.manifest?.entries.length, 'old receive task was not durably saved')
    const largeIndex = oldTask.manifest.entries.findIndex(entry => entry.relative.endsWith('2-large.bin'))
    try {
      await waitFor(() => oldProxy.held > 0, Boolean, 'encrypted TCP upload did not reach the explicit partial-transfer gate')
      await waitFor(async () => {
        const current = (await a.views()).find(task => task.id === id)
        if (current?.status === 'failed') throw Error(`native upload failed before partial checkpoint: ${current.error}`)
        if (current?.status === 'completed') throw Error('native upload completed before the test observed its partial checkpoint')
        return fs.stat(path.join(oldTask.staging, `${largeIndex}.part`)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
      }, info => info?.size >= 1024 * 1024 && info.size < bytes.length, 'real native upload did not produce a partial old receiver file')
    } catch (error) {
      report.partialCheckpointFailure = { native: await a.snapshot(), old: old.snapshot(), disk: await stateOld(), expectedPart: path.join(oldTask.staging, `${largeIndex}.part`), stagingFiles: await fs.readdir(oldTask.staging).catch(failure => ({ error: String(failure) })) }
      throw error
    }
    await a.kill(); await old.dispose(); old = undefined; await oldProxy.close()
    const before = JSON.parse(await fs.readFile(path.join(root, 'native-a/state.json'), 'utf8'))
    assert.equal(before.tasks.find(task => task.view.id === id).token, undefined)
    old = lan.createLanService(options('old')); await old.enable(true); oldProxy = await proxy(old.snapshot().port); proxies.push(oldProxy)
    a = driver(path.join(root, 'native-a'), downloadsA); drivers.push(a); readyA = await a.event(value => value.event === 'ready')
    const reconnected = await a.call({ command: 'connect', address: '127.0.0.1', port: oldProxy.port, expected: oldDevice }); assert.equal(reconnected.ok, true, reconnected.error); oldDevice = reconnected.value
    assert.equal((await a.call({ command: 'control-send', task: id, action: 'resume' })).ok, true)
    await finished(a, id)
    const final = await waitFor(() => old.snapshot().tasks.find(task => task.id.endsWith(id)), task => task?.status === 'completed', 'old receiver did not complete restarted native send')
    oldTask = (await stateOld()).tasks.find(task => task.view.id.endsWith(id))
    assert.equal(hash(await fs.readFile(oldTask.files[largeIndex])), hash(bytes)); assert.equal(final.done, final.total)
    assert.equal(await fs.stat(path.join(final.directory, '发送😀/empty')).then(info => info.isDirectory()), true)
    assert.equal(await fs.stat(oldTask.staging).then(() => true, () => false), false)
    assert.ok(confirmations >= 3)
    assert.equal(native.manifest.entries.filter(entry => entry.size === 0).length, 1)
    check('real native sender is killed mid-upload, old receiver module is restarted, same identities reconnect at new endpoint and freshly approved prefix hashes resume all files/empty directories to matching SHA256')

    b = driver(path.join(root, 'native-b'), downloadsB); drivers.push(b); let readyB = await b.event(value => value.event === 'ready')
    let proxyB = await proxy(readyB.port); proxies.push(proxyB)
    const nativeConnect = a.call({ command: 'connect', address: '127.0.0.1', port: proxyB.port })
    const local = await a.event(value => value.event === 'pair'); a.approve(local.request)
    const remote = await b.event(value => value.event === 'pair'); b.approve(remote.request)
    const peerB = await nativeConnect; assert.equal(peerB.ok, true, peerB.error)
    let proxyA = await proxy(readyA.port); proxies.push(proxyA)
    const peerA = await b.call({ command: 'connect', address: '127.0.0.1', port: proxyA.port, expected: { id: readyA.device, fingerprint: readyA.fingerprint, name: 'Rust', address: '127.0.0.1', port: proxyA.port, lastSeen: 0 } }); assert.equal(peerA.ok, true, peerA.error)
    const sourceB = path.join(root, 'from-b.bin'); const bytesB = Buffer.alloc(2 * 1024 * 1024, 81); await fs.writeFile(sourceB, bytesB)
    const sourceA = path.join(root, 'from-a.bin'); const bytesA = Buffer.alloc(2 * 1024 * 1024, 97); await fs.writeFile(sourceA, bytesA)
    const [sendA, sendB] = await Promise.all([a.call({ command: 'send', peer: peerB.value.id, paths: [sourceA] }), b.call({ command: 'send', peer: peerA.value.id, paths: [sourceB] })])
    assert.equal(sendA.ok, true, sendA.error); assert.equal(sendB.ok, true, sendB.error)
    const [offerA, offerB] = await Promise.all([a.event(value => value.event === 'receive'), b.event(value => value.event === 'receive')])
    for (const offer of [offerA, offerB]) for (const entry of offer.manifest.entries) { assert.equal(entry.source, undefined); assert.equal(entry.rustSourceV1, undefined) }
    a.approve(offerA.request); b.approve(offerB.request)
    await waitFor(() => Promise.all([a.views(), b.views()]), all => all.every(views => views.some(task => task.direction === 'send' && task.status === 'transferring') && views.some(task => task.direction === 'receive' && task.status === 'transferring')), 'native peers never showed overlapping send and receive progress')
    await Promise.all([finished(a, sendA.value.task), finished(b, sendB.value.task)])
    const receivedA = (await a.snapshot()).tasks.find(task => task.view.direction === 'receive' && task.manifest.id === sendB.value.task)
    const receivedB = (await b.snapshot()).tasks.find(task => task.view.direction === 'receive' && task.manifest.id === sendA.value.task)
    assert.equal(hash(await fs.readFile(receivedA.files[0])), hash(bytesB)); assert.equal(hash(await fs.readFile(receivedB.files[0])), hash(bytesA))
    check('two actual Rust processes concurrently send and receive through one state owner each; public offers omit source paths/metadata, both directions overlap and publish matching files without mutual waiting')

    const restarting = await a.call({ command: 'send', peer: peerB.value.id, paths: [path.join(source, '2-large.bin')] }); assert.equal(restarting.ok, true, restarting.error)
    const restartOffer = await b.event(value => value.event === 'receive'); b.approve(restartOffer.request)
    const incoming = await waitFor(async () => (await b.snapshot()).tasks.find(task => task.manifest.id === restarting.value.task), task => task?.staging, 'native incoming task not saved')
    await waitFor(() => fs.stat(path.join(incoming.staging, '0.part')).catch(error => { if (error.code === 'ENOENT') return null; throw error }), stat => stat?.size >= 1024 * 1024 && stat.size < bytes.length, 'native pair did not transfer a real partial file')
    await a.kill(); await b.kill()
    await proxyA.close(); await proxyB.close()
    a = driver(path.join(root, 'native-a'), downloadsA); drivers.push(a); readyA = await a.event(value => value.event === 'ready')
    b = driver(path.join(root, 'native-b'), downloadsB); drivers.push(b); readyB = await b.event(value => value.event === 'ready')
    proxyB = await proxy(readyB.port); proxies.push(proxyB)
    const reconnectNative = await a.call({ command: 'connect', address: '127.0.0.1', port: proxyB.port, expected: peerB.value }); assert.equal(reconnectNative.ok, true, reconnectNative.error); peerB.value = reconnectNative.value
    assert.equal((await a.views()).find(task => task.id === restarting.value.task).status, 'paused')
    assert.equal((await a.call({ command: 'control-send', task: restarting.value.task, action: 'resume' })).ok, true)
    const freshApproval = await b.event(value => value.event === 'receive'); assert.equal(freshApproval.existing, incoming.view.directory); b.approve(freshApproval.request)
    await finished(a, restarting.value.task)
    const resumed = (await b.snapshot()).tasks.find(task => task.manifest.id === restarting.value.task)
    assert.equal(resumed.view.status, 'completed'); assert.equal(hash(await fs.readFile(resumed.files[0])), hash(bytes))
    assert.equal(await fs.stat(incoming.staging).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false)
    check('both actual native processes are killed with a real partial file, restarted with stable identities and new endpoint, and resume only after a fresh directory approval to matching SHA256')

    const wrong = await a.call({ command: 'connect', address: '127.0.0.1', port: proxyB.port, expected: { ...peerB.value, id: 'changed-id' } }); assert.equal(wrong.ok, false)
    const pausedSource = path.join(root, 'changed.bin'); await fs.writeFile(pausedSource, 'abc')
    const changing = await a.call({ command: 'send', peer: peerB.value.id, paths: [pausedSource] }); assert.equal(changing.ok, true)
    const awaiting = await b.event(value => value.event === 'receive')
    await fs.writeFile(pausedSource, 'bad'); b.approve(awaiting.request)
    const failure = await waitFor(() => a.views(), views => views.some(task => task.id === changing.value.task && task.status === 'failed'), 'changed source was not rejected')
    assert.match(failure.find(task => task.id === changing.value.task).error, /发送源/)
    const cleared = await a.call({ command: 'control-send', task: changing.value.task, action: 'clear' }); assert.equal(cleared.ok, true, cleared.error)
    assert.equal((await a.views()).some(task => task.id === changing.value.task), false)
    check('fixed-certificate device ID change fails, file changed while receive decision is pending fails before upload, and local clear settles the owned job')

    for (const [name, make] of [
      ['missing.bin', async () => path.join(root, 'missing.bin')],
      ['linked.bin', async () => { const link = path.join(root, 'linked.bin'); await fs.link(sourceA, link); return link }],
      ['junction', async () => { const link = path.join(root, 'junction'); await fs.symlink(source, link, 'junction'); return link }],
    ]) {
      const file = await make(); const rejected = await a.call({ command: 'send', peer: peerB.value.id, paths: [file] }); assert.equal(rejected.ok, true, rejected.error)
      const failed = await waitFor(() => a.views(), views => views.some(task => task.id === rejected.value.task && task.status === 'failed'), `${name} source not rejected`)
      assert.ok(failed.find(task => task.id === rejected.value.task).error)
      assert.equal((await a.call({ command: 'control-send', task: rejected.value.task, action: 'clear' })).ok, true)
      if (name === 'linked.bin') await fs.unlink(file)
    }
    check('actual missing file, hardlink and directory junction fail safe preparation and remain explicitly clearable')

    generator = lan.createLanService(options('faulty')); await generator.enable(true); await generator.dispose(); generator = undefined
    const faultyIdentity = JSON.parse(await fs.readFile(path.join(root, 'faulty/identity.json'), 'utf8'))
    const faulty = await faultyPeer(faultyIdentity, readyA.fingerprint); servers.push(faulty)
    const connectFaulty = a.call({ command: 'connect', address: '127.0.0.1', port: faulty.port })
    const approveFaulty = await a.event(value => value.event === 'pair'); a.approve(approveFaulty.request)
    const target = await connectFaulty; assert.equal(target.ok, true, target.error)
    const small = path.join(root, 'fault-cases.bin'); await fs.writeFile(small, 'native sender fault cases')
    for (const [name, reply] of [
      ['invalid token', valid => ({ ...valid, token: 'invalid' })],
      ['offset count', valid => ({ ...valid, offsets: [] })],
      ['offset overflow', valid => ({ ...valid, offsets: [{ size: 9999, hash: hash(Buffer.alloc(0)), complete: false }] })],
      ['fractional offset', valid => ({ ...valid, offsets: [{ size: 0.5, hash: hash(Buffer.alloc(0)), complete: false }] })],
      ['complete prefix mismatch', valid => ({ ...valid, offsets: [{ size: 3, hash: hash('nat'), complete: true }] })],
      ['nonempty prefix mismatch', valid => ({ ...valid, offsets: [{ size: 3, hash: hash('bad'), complete: false }] })],
      ['empty prefix mismatch', valid => ({ ...valid, offsets: [{ size: 0, hash: hash('bad'), complete: false }] })],
    ]) {
      faulty.reply = reply
      const submitted = await a.call({ command: 'send', peer: target.value.id, paths: [small] }); assert.equal(submitted.ok, true, submitted.error)
      const failed = await waitFor(() => a.views(), views => views.some(task => task.id === submitted.value.task && task.status === 'failed'), `${name} not rejected`)
      assert.match(failed.find(task => task.id === submitted.value.task).error, /续传/, name)
      assert.equal(faulty.uploads.length, 0, `${name} must fail before /file`)
      assert.equal((await a.call({ command: 'control-send', task: submitted.value.task, action: 'clear' })).ok, true)
    }
    check('real pinned HTTPS rejects seven malformed token/offset/completion/prefix replies before any upload')

    const diskBefore = await fs.readFile(path.join(root, 'native-a/state.json'))
    const tasksBefore = (await a.views()).length
    assert.equal((await a.call({ command: 'state-lock' })).ok, true)
    const blocked = await a.call({ command: 'send', peer: target.value.id, paths: [small] }); assert.equal(blocked.ok, false); assert.match(blocked.error, /保存局域网状态/)
    assert.equal((await a.views()).length, tasksBefore)
    assert.deepEqual(await fs.readFile(path.join(root, 'native-a/state.json')), diskBefore)
    assert.equal((await a.call({ command: 'state-unlock' })).ok, true)
    check('real Windows state sharing violation rejects new submission without phantom tasks or changing prior durable bytes')

    faulty.reply = undefined; faulty.holdComplete = true
    const checkpoint = await a.call({ command: 'send', peer: target.value.id, paths: [small] }); assert.equal(checkpoint.ok, true, checkpoint.error)
    await waitFor(() => faulty.pending, Boolean, 'checkpoint offer not held'); faulty.pending(); faulty.pending = undefined
    await waitFor(() => faulty.complete, Boolean, 'completion request not held')
    const terminalBefore = await fs.readFile(path.join(root, 'native-a/state.json'))
    assert.equal((await a.call({ command: 'state-lock' })).ok, true)
    faulty.complete(); faulty.complete = undefined
    const failedCheckpoint = await waitFor(() => a.views(), views => views.some(task => task.id === checkpoint.value.task && task.status === 'failed'), 'terminal save failure was not visible')
    assert.match(failedCheckpoint.find(task => task.id === checkpoint.value.task).error, /保存局域网状态/)
    assert.equal((await a.snapshot()).tasks.find(task => task.view.id === checkpoint.value.task).view.status, 'transferring')
    const terminalFailure = await a.call({ command: 'control-send', task: checkpoint.value.task, action: 'pause' }); assert.equal(terminalFailure.ok, false); assert.match(terminalFailure.error, /保存局域网状态/)
    assert.deepEqual(await fs.readFile(path.join(root, 'native-a/state.json')), terminalBefore)
    assert.equal((await a.call({ command: 'state-unlock' })).ok, true)
    assert.equal((await a.call({ command: 'control-send', task: checkpoint.value.task, action: 'pause' })).ok, true)
    assert.equal((await a.views()).find(task => task.id === checkpoint.value.task).status, 'paused')
    faulty.holdComplete = false
    assert.equal((await a.call({ command: 'control-send', task: checkpoint.value.task, action: 'resume' })).ok, true)
    await waitFor(() => faulty.pending, Boolean, 'retry offer not held'); faulty.pending(); faulty.pending = undefined
    await finished(a, checkpoint.value.task)
    assert.equal(hash(faulty.uploads.at(-1).bytes), hash(await fs.readFile(small)))
    check('terminal/local-control checkpoint sharing violations preserve prior state; one retry after unlock settles paused state and a fresh offer completes')

    faulty.holdUpload = true; faulty.controlInvalid = true
    const controlRetry = await a.call({ command: 'send', peer: target.value.id, paths: [path.join(source, '2-large.bin')] }); assert.equal(controlRetry.ok, true, controlRetry.error)
    await waitFor(() => faulty.pending, Boolean, 'remote-control test offer not held'); faulty.pending(); faulty.pending = undefined
    await waitFor(() => faulty.pendingUpload, Boolean, 'remote-control test upload not active')
    const unacknowledged = await a.call({ command: 'control-send', task: controlRetry.value.task, action: 'pause' }); assert.equal(unacknowledged.ok, true, unacknowledged.error); assert.match(unacknowledged.value.remoteError, /未确认/)
    assert.equal((await a.views()).find(task => task.id === controlRetry.value.task).status, 'paused')
    faulty.controlInvalid = false
    const acknowledged = await a.call({ command: 'control-send', task: controlRetry.value.task, action: 'pause' }); assert.equal(acknowledged.ok, true, acknowledged.error); assert.equal(acknowledged.value.remoteError, null)
    assert.equal(faulty.calls.filter(route => route === '/pause').length, 3)
    assert.equal((await a.call({ command: 'control-send', task: controlRetry.value.task, action: 'clear' })).ok, true)
    faulty.holdUpload = false
    check('invalid remote pause acknowledgement is returned separately from durable local pause, and retained runtime credentials allow the same action to be retried successfully')

    const startActive = async () => {
      const sent = await a.call({ command: 'send', peer: peerB.value.id, paths: [path.join(source, '2-large.bin')] }); assert.equal(sent.ok, true, sent.error)
      const prompt = await b.event(value => value.event === 'receive'); b.approve(prompt.request)
      const receive = await waitFor(async () => (await b.snapshot()).tasks.find(task => task.manifest.id === sent.value.task), task => task?.staging, 'active receive not saved')
      await waitFor(() => fs.stat(path.join(receive.staging, '0.part')).catch(error => { if (error.code === 'ENOENT') return null; throw error }), stat => stat?.size > 0 && stat.size < bytes.length, 'actual upload not active')
      return { id: sent.value.task, receive }
    }
    const activePause = await startActive()
    const pauseStream = await a.call({ command: 'control-send', task: activePause.id, action: 'pause' }); assert.equal(pauseStream.ok, true, pauseStream.error); assert.equal(pauseStream.value.remoteError, null)
    assert.equal((await a.views()).find(task => task.id === activePause.id).status, 'paused')
    assert.equal((await b.views()).find(task => task.id === activePause.receive.view.id).status, 'paused')
    const heldPart = await fs.stat(path.join(activePause.receive.staging, '0.part')); assert.ok(heldPart.size > 0 && heldPart.size < bytes.length)
    assert.equal((await a.call({ command: 'control-send', task: activePause.id, action: 'resume' })).ok, true)
    const approveResume = await b.event(value => value.event === 'receive'); b.approve(approveResume.request)
    await finished(a, activePause.id)
    const activeCancel = await startActive()
    const canceled = await a.call({ command: 'control-send', task: activeCancel.id, action: 'cancel' }); assert.equal(canceled.ok, true, canceled.error); assert.equal(canceled.value.remoteError, null)
    assert.equal((await a.views()).find(task => task.id === activeCancel.id).status, 'canceled')
    assert.equal((await b.views()).find(task => task.id === activeCancel.receive.view.id).status, 'canceled')
    assert.equal(await fs.stat(activeCancel.receive.staging).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }), false)
    check('pause and cancel during actual uploads join the stream, acknowledge remote control, preserve resumable parts on pause, freshly approve resume, and remove staging on cancel')

    const handback = await startActive()
    assert.equal((await a.stop()).code, 0, a.errors.join('')); assert.equal((await b.stop()).code, 0, b.errors.join(''))
    assert.equal((await a.event(value => value.event === 'stopped')).releaseVerified, true)
    assert.equal((await b.event(value => value.event === 'stopped')).releaseVerified, true)
    // The source can be renamed only after all exclusive readers and ancestor
    // pins are released by the service stop, even while transfer was active.
    await fs.rename(source, source + '-released'); await fs.rename(source + '-released', source)
    assert.equal(faulty.error, undefined)
    check('service stop during an actual upload joins outgoing/incoming work, releases source/destination/profile handles and leaves no test process')
    const nativeState = JSON.parse(await fs.readFile(path.join(root, 'native-a/state.json'), 'utf8'))
    generator = lan.createLanService({ ...options('native-a'), downloads: downloadsA }); await generator.enable(true); await generator.dispose(); generator = undefined
    const oldRoundtrip = JSON.parse(await fs.readFile(path.join(root, 'native-a/state.json'), 'utf8'))
    for (const task of nativeState.tasks.filter(task => task.view.direction === 'send')) {
      assert.deepEqual(oldRoundtrip.tasks.find(saved => saved.view.id === task.view.id).manifest, task.manifest)
    }
    check('after native stop, the old module reads and rewrites native sending manifests with exact fractional mtime/native metadata; structural roundtrip only, no claim of production rollback')
    const offers = [], originalServer = https.createServer
    try {
      https.createServer = function (...args) {
        const server = originalServer.apply(this, args)
        server.on('request', incoming => {
          if (incoming.url !== '/offer') return
          const chunks = []; incoming.on('data', chunk => chunks.push(chunk)); incoming.on('end', () => offers.push(JSON.parse(Buffer.concat(chunks).toString())))
        })
        return server
      }
      returnedReceiver = lan.createLanService({ ...options('native-b'), downloads: downloadsB }); await returnedReceiver.enable(true)
    } finally { https.createServer = originalServer }
    generator = lan.createLanService({ ...options('native-a'), downloads: downloadsA }); await generator.enable(true)
    await generator.connect('127.0.0.1', returnedReceiver.snapshot().port)
    await generator.control(handback.id, 'resume')
    const handbackView = await waitFor(() => generator.snapshot().tasks.find(task => task.id === handback.id), task => task && ['failed','completed'].includes(task.status), 'old sender did not settle the native paused task')
    assert.equal(handbackView.status, 'completed', handbackView.error)
    const offeredBack = offers.find(manifest => manifest.id === handback.id); assert.ok(offeredBack)
    assert.deepEqual(Object.keys(offeredBack).sort(), ['id','name','entries','directories'].sort())
    for (const entry of offeredBack.entries) assert.deepEqual(Object.keys(entry).sort(), ['relative','size','mtime','hash'].sort())
    const savedBack = JSON.parse(await fs.readFile(path.join(root, 'native-b/state.json'), 'utf8')).tasks.find(task => task.manifest.id === handback.id)
    assert.equal(savedBack.view.status, 'completed'); assert.equal(hash(await fs.readFile(savedBack.files[0])), hash(bytes))
    await generator.dispose(); generator = undefined; await returnedReceiver.dispose(); returnedReceiver = undefined
    const retainedBack = JSON.parse(await fs.readFile(path.join(root, 'native-a/state.json'), 'utf8')).tasks.find(task => task.view.id === handback.id)
    assert.deepEqual(retainedBack.manifest, nativeState.tasks.find(task => task.view.id === handback.id).manifest)
    check('after both native services stop, reconstructed old sender and receiver resume the actual native partial task; real HTTPS offer contains only protocol fields while local native source metadata stays intact')
    await old.dispose(); old = undefined
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const driver of drivers) if (driver.child.exitCode === null) await driver.kill()
    await old?.dispose(); await generator?.dispose(); await returnedReceiver?.dispose()
    for (const item of proxies) { try { await item.close() } catch {} }
    for (const server of servers) await server.close()
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.flatMap((driver, index) => driver.lines.map(line => `${index}: ${line}`)).join('\n'))
    await fs.writeFile(path.join(artifacts, 'stderr.log'), drivers.flatMap(driver => driver.errors).join('\n'))
    report.remainingProcesses = drivers.filter(driver => driver.child.exitCode === null && driver.child.signalCode === null).length
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup.reverse()) await callback()
  }
})
