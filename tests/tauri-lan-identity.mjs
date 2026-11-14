import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto'
import { createInterface } from 'node:readline'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/lan-identity')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, accept, description) {
  const end = Date.now() + 20_000
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(20) }
  throw Error(description)
}
async function build() {
  const log = await fs.open(path.join(artifacts, 'build.log'), 'w')
  try {
    const child = spawn('cargo', ['build', '--manifest-path', 'src-tauri/Cargo.toml', '--example', 'lan-identity', '--example', 'lan-receiver'], { windowsHide: true, stdio: ['ignore', log.fd, log.fd] })
    assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }), 0, 'native identity driver build failed')
  } finally { await log.close() }
}
function driver(example, args) {
  const child = spawn(path.resolve(`src-tauri/target/debug/examples/${example}.exe`), args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = [], waiters = new Set(), replies = new Map(), lines = [], errors = []
  let sequence = 0, closed = false
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; for (const notify of waiters) notify(); resolve({ code, signal }) }) })
  child.stderr.on('data', bytes => errors.push(bytes.toString()))
  child.stdin.on('error', error => { if (!closed && error.code !== 'EPIPE') errors.push(error.message) })
  createInterface({ input: child.stdout }).on('line', line => {
    lines.push(line)
    const value = JSON.parse(line)
    if (value.id && value.ok !== undefined && replies.has(value.id)) { replies.get(value.id)(value); replies.delete(value.id) }
    else { events.push(value); for (const notify of waiters) notify() }
  })
  const send = value => child.stdin.write(JSON.stringify(value) + '\n')
  return { child, exited, lines, errors, send,
    call(value) {
      const id = String(++sequence)
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(id); reject(Error('native command timeout: ' + value.command)) }, 20_000)
        replies.set(id, reply => { clearTimeout(timer); resolve(reply) })
      })
      result.catch(() => {}); send({ ...value, id }); return result
    },
    async event(predicate) {
      const end = Date.now() + 20_000
      while (Date.now() < end) {
        const index = events.findIndex(predicate); if (index >= 0) return events.splice(index, 1)[0]
        if (closed) throw Error('native exited: ' + errors.join(''))
        await new Promise(resolve => { const ready = () => { clearTimeout(timer); waiters.delete(ready); resolve() }; const timer = setTimeout(ready, 500); waiters.add(ready) })
      }
      throw Error('native event timeout: ' + predicate)
    },
    async snapshot() { const reply = await this.call({ command: 'snapshot' }); assert.equal(reply.ok, true, reply.error); return reply.state },
    approve(request) { send({ command: 'approve', request, accept: true }) },
    async stop() { if (!closed) child.stdin.end(JSON.stringify({ command: 'stop' }) + '\n'); return exited },
    async kill() { if (!closed) child.kill('SIGKILL'); return exited },
  }
}

test('native first identities preserve old format and authenticate actual old/native transfers', { timeout: 240_000 }, async () => {
  const cleanups = []
  const { root, lan } = await toolboxModules({ after: callback => cleanups.push(callback) })
  const report = { verified: false, productionReady: false, migrationComplete: false,
    scope: 'Windows CNG ephemeral RSA identity generation/atomic persistence under isolated Rust ownership; actual old LAN module and two native HTTPS drivers, explicit stdin approvals', checks: [] }
  const drivers = []; let old
  const check = name => report.checks.push(name)
  const start = (example, args) => { const fixture = driver(example, args); drivers.push(fixture); return fixture }
  async function fresh(name) {
    const profile = path.join(root, name); await fs.mkdir(profile)
    const fixture = start('lan-identity', [profile]); await fixture.event(value => value.event === 'opened')
    assert.equal((await fs.readdir(profile)).includes('identity.json'), false)
    const created = await fixture.call({ command: 'ensure' }); assert.equal(created.ok, true, created.error)
    const bytes = await fs.readFile(path.join(profile, 'identity.json'))
    const saved = JSON.parse(bytes), cert = new X509Certificate(saved.cert)
    assert.deepEqual(Object.keys(saved).sort(), ['cert', 'fingerprint', 'id', 'key'])
    assert.match(saved.id, /^[a-f0-9-]{36}$/)
    assert.equal(saved.fingerprint, hash(cert.raw)); assert.equal(created.device, saved.id)
    assert.equal(created.fingerprint, saved.fingerprint)
    assert.equal(cert.subject, 'CN=DustDesk Local Transfer'); assert.equal(cert.issuer, cert.subject)
    assert.equal(cert.publicKey.asymmetricKeyType, 'rsa'); assert.equal(cert.publicKey.asymmetricKeyDetails.modulusLength, 2048)
    assert.equal(cert.checkPrivateKey(createPrivateKey(saved.key)), true); assert.equal(cert.verify(cert.publicKey), true)
    assert.ok(cert.raw.includes(Buffer.from('06092a864886f70d01010b', 'hex')), 'RSA SHA256 signature OID missing')
    assert.equal((Date.parse(cert.validTo) - Date.parse(cert.validFrom)) / 86400000, 3650)
    assert.ok(Math.abs(Date.parse(cert.validFrom) - Date.now()) < 60_000)
    const again = await fixture.call({ command: 'ensure' }); assert.equal(again.device, saved.id)
    assert.equal(hash(await fs.readFile(path.join(profile, 'identity.json'))), hash(bytes))
    assert.equal((await fixture.stop()).code, 0)
    return { profile, saved, digest: hash(bytes) }
  }
  try {
    await fs.mkdir(artifacts, { recursive: true }); await build()
    const sources = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/identity.rs', 'src-tauri/src/lan/identity_tests.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/src/lan/files.rs', 'src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/src/lan/sender.rs', 'src-tauri/src/lan/sources.rs', 'src-tauri/src/lan/discovery.rs', 'src-tauri/src/lan/peers.rs', 'src-tauri/src/lan/adapters.rs', 'src-tauri/src/lan/tls.rs', 'src-tauri/src/lan/transport.rs', 'src-tauri/src/lan/publication.rs', 'src-tauri/src/lan/publication/legacy.rs', 'src-tauri/examples/lan-identity.rs', 'src-tauri/examples/lan-receiver.rs', 'tests/tauri-lan-identity.mjs', 'tests/toolbox-fixture.mjs', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/reference/src/main/fileOperations.ts', 'src/shared/toolbox.ts']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async name => [name, hash(await fs.readFile(name))])))
    report.drivers = await Promise.all(['lan-identity', 'lan-receiver'].map(async name => ({ executable: path.resolve(`src-tauri/target/debug/examples/${name}.exe`), sha256: hash(await fs.readFile(`src-tauri/target/debug/examples/${name}.exe`)) })))
    const a = await fresh('a'), b = await fresh('b')
    assert.notEqual(a.saved.id, b.saved.id); assert.notEqual(a.saved.fingerprint, b.saved.fingerprint)
    check('two native CNG RSA2048/SHA256 self-signed identities have matching keys, original CN/3650day validity/UUID/fingerprint/JSON shape and byte-identical repeated ensure')

    let fixture = start('lan-identity', [a.profile]); await fixture.event(value => value.event === 'opened')
    const competitor = start('lan-identity', [a.profile]); assert.notEqual((await competitor.exited).code, 0)
    const restored = await fixture.call({ command: 'ensure' }); assert.equal(restored.device, a.saved.id)
    assert.equal(restored.fingerprint, a.saved.fingerprint)
    assert.equal(hash(await fs.readFile(path.join(a.profile, 'identity.json'))), a.digest)
    assert.equal((await fixture.stop()).code, 0)
    check('actual process restart preserves exact identity bytes; a second Rust owner fails without overwriting the winner')

    for (const mode of ['corrupt', 'mismatch', 'hardlink', 'junction', 'orphan', 'missing-root', 'cancel']) {
      const profile = path.join(root, mode)
      if (mode !== 'missing-root') await fs.mkdir(profile)
      let before
      if (mode === 'corrupt') await fs.writeFile(path.join(profile, 'identity.json'), 'broken-private-data')
      if (mode === 'mismatch') await fs.writeFile(path.join(profile, 'identity.json'), JSON.stringify({ ...a.saved, key: b.saved.key }))
      if (mode === 'hardlink') await fs.link(path.join(a.profile, 'identity.json'), path.join(profile, 'identity.json'))
      if (mode === 'junction') {
        await fs.rmdir(profile); await fs.symlink(a.profile, profile, 'junction')
      }
      if (mode === 'orphan') await fs.writeFile(path.join(profile, 'state.json'), '{}')
      if (['corrupt', 'mismatch', 'hardlink', 'junction'].includes(mode)) before = hash(await fs.readFile(path.join(profile, 'identity.json')))
      fixture = start('lan-identity', [profile])
      if (['junction', 'missing-root'].includes(mode)) assert.notEqual((await fixture.exited).code, 0)
      else {
        await fixture.event(value => value.event === 'opened')
        if (mode === 'cancel') fixture.send({ command: 'cancel' })
        const result = await fixture.call({ command: 'ensure' }); assert.equal(result.ok, false, mode)
        assert.equal((await fixture.stop()).code, 0)
      }
      if (before) assert.equal(hash(await fs.readFile(path.join(profile, 'identity.json'))), before)
      else assert.equal(await fs.stat(path.join(profile, 'identity.json')).then(() => true, () => false), false)
      if (mode !== 'missing-root' && mode !== 'junction') assert.equal((await fs.readdir(profile)).some(name => name.startsWith('.identity-')), false)
      if (mode === 'missing-root') assert.equal(await fs.stat(profile).then(() => true, () => false), false)
      if (mode === 'hardlink') await fs.unlink(path.join(profile, 'identity.json'))
      if (mode === 'junction') await fs.rmdir(profile)
    }
    check('real subprocesses refuse corrupt/mismatched/linked/junction/orphaned profiles, missing roots and canceled initialization; bytes/targets unchanged and no temporary file left')

    const cancelProfile = path.join(root, 'cancel')
    fixture = start('lan-identity', [cancelProfile]); await fixture.event(value => value.event === 'opened')
    assert.equal((await fixture.call({ command: 'ensure' })).ok, true)
    assert.equal((await fixture.stop()).code, 0)
    check('canceled first initialization can be retried with a fresh owned lifecycle')

    const downloadsA = path.join(root, 'downloads-a'), downloadsB = path.join(root, 'downloads-b')
    await fs.mkdir(downloadsA); await fs.mkdir(downloadsB)
    let nativeB = start('lan-receiver', [b.profile, downloadsB])
    let readyB = await nativeB.event(value => value.event === 'ready')
    old = lan.createLanService({ storage: a.profile, downloads: downloadsA, host: '127.0.0.1', name: 'Old module native identity', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => downloadsA })
    await old.enable(true)
    const connecting = old.connect('127.0.0.1', readyB.port); connecting.catch(() => {})
    const pair = await nativeB.event(value => value.event === 'pair'); nativeB.approve(pair.request)
    const peerB = await connecting
    const source = path.join(root, 'native-identity.bin'), bytes = Buffer.alloc(1024 * 1024, 0x6d)
    await fs.writeFile(source, bytes)
    await old.send(peerB.id, [source])
    const offer = await nativeB.event(value => value.event === 'receive'); nativeB.approve(offer.request)
    // The old public send API returns void. The received manifest supplies the
    // actual task ID; treating send's return as an ID made the first fixture
    // wait on undefined even after successful delivery.
    const id = offer.manifest.id
    const completed = await waitFor(() => old.snapshot().tasks.find(task => task.id === id), view => ['completed', 'failed'].includes(view?.status), 'old sender did not finish with native-generated identity')
    assert.equal(completed.status, 'completed', completed.error)
    let received = (await nativeB.snapshot()).tasks.find(task => task.manifest.id === id)
    assert.equal(hash(await fs.readFile(received.files[0])), hash(bytes))
    await old.dispose(); old = undefined
    check('actual old LAN module loads native PKCS8 identity unchanged, pairs via mutual TLS and sends a SHA256-matching file to native receiver')

    let nativeA = start('lan-receiver', [a.profile, downloadsA])
    let readyA = await nativeA.event(value => value.event === 'ready')
    const joined = await nativeA.call({ command: 'connect', address: '127.0.0.1', port: readyB.port }); assert.equal(joined.ok, true, joined.error)
    const sent = await nativeA.call({ command: 'send', peer: joined.value.id, paths: [source] }); assert.equal(sent.ok, true, sent.error)
    const approval = await nativeB.event(value => value.event === 'receive'); nativeB.approve(approval.request)
    received = await waitFor(async () => (await nativeB.snapshot()).tasks.find(task => task.manifest.id === sent.value.task), task => task?.view.status === 'completed', 'native-generated peer transfer did not complete')
    assert.equal(hash(await fs.readFile(received.files[0])), hash(bytes))
    assert.equal((await nativeA.stop()).code, 0); assert.equal((await nativeB.stop()).code, 0)
    nativeA = start('lan-receiver', [a.profile, downloadsA]); readyA = await nativeA.event(value => value.event === 'ready')
    nativeB = start('lan-receiver', [b.profile, downloadsB]); readyB = await nativeB.event(value => value.event === 'ready')
    assert.equal(readyA.fingerprint, a.saved.fingerprint); assert.equal(readyB.fingerprint, b.saved.fingerprint)
    const back = await nativeB.call({ command: 'connect', address: '127.0.0.1', port: readyA.port }); assert.equal(back.ok, true, back.error)
    const reverse = await nativeB.call({ command: 'send', peer: back.value.id, paths: [source] }); assert.equal(reverse.ok, true, reverse.error)
    const reverseApproval = await nativeA.event(value => value.event === 'receive'); nativeA.approve(reverseApproval.request)
    const final = await waitFor(async () => (await nativeA.snapshot()).tasks.find(task => task.manifest.id === reverse.value.task), task => task?.view.status === 'completed', 'restarted native reverse transfer did not complete')
    assert.equal(hash(await fs.readFile(final.files[0])), hash(bytes))
    assert.equal((await nativeA.stop()).code, 0); assert.equal((await nativeB.stop()).code, 0)
    check('two native processes use generated identities for file transfer, both restart and reverse transfer with the original fingerprints and matching SHA256')

    for (const identity of [a, b]) assert.equal(hash(await fs.readFile(path.join(identity.profile, 'identity.json'))), identity.digest)
    const freshProfile = path.join(root, 'fresh-receiver'); await fs.mkdir(freshProfile)
    const receiver = start('lan-receiver', [freshProfile, downloadsA, '--create-identity'])
    const ready = await receiver.event(value => value.event === 'ready')
    assert.equal(ready.fingerprint, JSON.parse(await fs.readFile(path.join(freshProfile, 'identity.json'), 'utf8')).fingerprint)
    assert.equal((await receiver.stop()).code, 0)
    check('receiver explicit fresh initialization no longer relies on Node generation; default driver still requires an existing identity')
    assert.equal(drivers.every(fixture => fixture.child.exitCode !== null || fixture.child.signalCode !== null), true)
    const logs = drivers.flatMap(fixture => [...fixture.lines, ...fixture.errors]).join('\n')
    assert.equal(logs.includes('PRIVATE KEY'), false); assert.equal(logs.includes(a.saved.key.slice(40, 100)), false)
    report.remainingProcesses = 0
    check('all child processes stopped, keys absent from stdout/stderr and identity hashes unchanged throughout old/native restarts')
    report.verified = true
  } catch (error) {
    report.error = String(error.stack ?? error)
    report.failureState = { old: old?.snapshot() }
    throw error
  }
  finally {
    await old?.dispose()
    for (const fixture of drivers) if (fixture.child.exitCode === null && fixture.child.signalCode === null) await fixture.kill()
    await fs.mkdir(artifacts, { recursive: true })
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.map(fixture => [...fixture.lines, ...fixture.errors].join('\n')).join('\n'))
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const cleanup of cleanups.reverse()) await cleanup()
  }
})
