import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
async function waitFor(read, accept, message) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const value = await read()
    if (accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  throw Error(message)
}
async function cargo(args, log) {
  const chunks = []
  const child = spawn('cargo', args, { cwd: path.resolve('src-tauri'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => chunks.push(chunk))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  await fs.writeFile(path.join(artifacts, log), Buffer.concat(chunks))
  assert.equal(code, 0, 'Rust compatibility driver failed; see ' + log)
}
async function filesUnder(root) {
  const result = {}
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else result[path.relative(root, target)] = digest(await fs.readFile(target))
    }
  }
  await visit(root); return result
}

test('Rust core reads identities and partial tasks from the Electron LAN module, which resumes both reencoded endpoints in Node', { timeout: 180000 }, async t => {
  const cleanup = []
  const { root, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const report = { productionReady: false, migrationComplete: false, networkRuntime: 'node-test-process-with-electron-lan-module-on-both-endpoints', rustScope: 'protocol-and-read-only-state-core', checks: [] }
  const inputPaths = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/examples/lan-compat.rs', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/reference/src/main/fileOperations.ts', 'src/shared/toolbox.ts', 'tests/toolbox-fixture.mjs', 'tests/tauri-lan-compat.mjs']
  const inputDigests = async () => Object.fromEntries(await Promise.all(inputPaths.map(async target => [target, digest(await fs.readFile(target))])))
  report.inputs = await inputDigests()
  const check = name => report.checks.push(name)
  let sender, receiver
  await fs.mkdir(artifacts, { recursive: true })
  try {
    const source = path.join(root, '发送目录'), downloads = path.join(root, 'received')
    await fs.mkdir(path.join(source, '空目录'), { recursive: true })
    await fs.writeFile(path.join(source, '完整.txt'), '完整文件 😀\n')
    await fs.writeFile(path.join(source, 'empty.bin'), Buffer.alloc(0))
    const large = path.join(source, 'large.bin'), bytes = Buffer.alloc(4 * 1024 * 1024)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >>> 16)) & 255
    await fs.writeFile(large, bytes)
    let firstOffer, releaseFirst
    const offered = new Promise(resolve => { firstOffer = resolve })
    const firstDecision = new Promise(resolve => { releaseFirst = resolve })
    let blockFirst = true, confirmations = 0, pairs = 0
    const options = name => ({ storage: path.join(root, name), downloads, name, host: '127.0.0.1', discovery: false,
      changed() {}, confirmPair: async () => { pairs++; return true },
      confirmReceive: async () => { confirmations++; if (blockFirst) { firstOffer(); return firstDecision } return downloads },
    })
    sender = lan.createLanService(options('sender')); receiver = lan.createLanService(options('receiver'))
    await sender.enable(true); await receiver.enable(true)
    const peer = await sender.connect('127.0.0.1', receiver.snapshot().port)
    await sender.send(peer.id, [source]); await offered
    const id = sender.snapshot().tasks[0].id
    await sender.control(id, 'pause'); blockFirst = false; releaseFirst(downloads)
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(receiver.snapshot().tasks.length, 0, 'late canceled receive confirmation creates no task')
    check('actual submitted sender task pauses and ignores late receiver confirmation')
    const identityPaths = ['sender', 'receiver'].map(name => path.join(root, name, 'identity.json'))
    const identities = await Promise.all(identityPaths.map(async target => JSON.parse(await fs.readFile(target, 'utf8'))))
    const state = JSON.parse(await fs.readFile(path.join(root, 'sender/state.json'), 'utf8'))
    const manifest = state.tasks[0].manifest
    assert.equal(state.tasks[0].prepared, true)
    const publicManifest = { ...manifest, entries: manifest.entries.map(({ source: ignored, ...entry }) => entry) }
    const request = (route, value) => new Promise((resolve, reject) => {
      const outgoing = https.request({ hostname: '127.0.0.1', port: receiver.snapshot().port, path: route, method: 'POST', key: identities[0].key, cert: identities[0].cert,
        rejectUnauthorized: false, agent: false, headers: { 'Content-Type': Buffer.isBuffer(value) ? 'application/octet-stream' : 'application/json' } }, async response => {
        try { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve({ ...JSON.parse(Buffer.concat(chunks).toString()), status: response.statusCode }) } catch (error) { reject(error) }
      })
      outgoing.on('socket', socket => socket.once('secureConnect', () => {
        if (digest(socket.getPeerCertificate().raw) !== identities[1].fingerprint) outgoing.destroy(Error('fixture peer certificate changed'))
      }))
      outgoing.setTimeout(10000, () => outgoing.destroy(Error('fixture request timeout')))
      outgoing.once('error', reject); outgoing.end(Buffer.isBuffer(value) ? value : JSON.stringify(value))
    })
    const offer = await request('/offer', publicManifest); assert.equal(offer.status, 200)
    const index = manifest.entries.findIndex(entry => entry.source === large)
    for (const entryIndex of [...manifest.entries.keys()].filter(i => i !== index).concat(index)) {
      const entry = manifest.entries[entryIndex]
      const body = entryIndex === index ? bytes.subarray(0, 1024 * 1024) : await fs.readFile(entry.source)
      const reply = await request(`/file?id=${id}&token=${offer.token}&index=${entryIndex}&offset=0`, body)
      assert.equal(reply.status, entryIndex === index ? 400 : 200)
      if (entryIndex === index) assert.match(reply.error, /文件未传输完整/)
    }
    assert.equal((await request(`/pause?id=${id}&token=${offer.token}`, {})).status, 200)
    await sender.dispose(); await receiver.dispose(); sender = undefined; receiver = undefined
    const receiverState = JSON.parse(await fs.readFile(path.join(root, 'receiver/state.json'), 'utf8'))
    const receivedTask = receiverState.tasks[0]
    const part = path.join(receivedTask.staging, index + '.part')
    assert.equal((await fs.stat(part)).size, 1024 * 1024)
    assert.ok(Object.keys(receivedTask.files).length >= 1)
    check('real HTTPS receiver retains a 1 MiB partial file alongside verified completed files and empty directories')

    const base = { id: 'corpus', name: '中文 😀', entries: [{ relative: '目录/文件.txt', size: 3, mtime: 123.125, hash: 'a'.repeat(64), source: 'C:/private' }], directories: ['目录', '目录/empty'] }
    const manifests = []
    const add = value => {
      let valid = true; try { lan.validateManifest(value) } catch { valid = false }
      manifests.push({ json: JSON.stringify(value), valid })
    }
    add(base); add(publicManifest)
    for (const relative of ['../escape', '/abs', 'a\\b', 'a//b', 'a/./b', 'a/../b', 'NUL.txt', 'LPT1.x', 'com9', 'com10', 'a.', 'a ', 'a:b', 'a\0b', '中文/😀.txt', '', 'a'.repeat(2048), 'a'.repeat(2049)]) {
      const value = structuredClone(base); value.entries[0].relative = relative; add(value)
    }
    for (const name of ['', '😀'.repeat(127) + 'a', '😀'.repeat(128), 'a'.repeat(255), 'a'.repeat(256)]) add({ ...base, name })
    for (const size of [-1, 0, 0.5, 1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, '3', null]) {
      const value = structuredClone(base); value.entries[0].size = size; add(value)
    }
    for (const change of ['duplicate', 'file-parent', 'text-with-files', 'bad-hash', 'null-text', 'count-limit', 'over-count', 'total-limit']) {
      const value = structuredClone(base)
      if (change === 'duplicate') value.directories.push('目录/EMPTY')
      if (change === 'file-parent') value.directories.push('目录/文件.txt/child')
      if (change === 'text-with-files') value.text = 'text'
      if (change === 'bad-hash') value.entries[0].hash = 'A'.repeat(64)
      if (change === 'null-text') value.text = null
      if (change.includes('count')) { value.entries = []; value.directories = Array.from({ length: change === 'count-limit' ? 10000 : 10001 }, (_, i) => String(i)) }
      if (change === 'total-limit') { value.entries[0].size = Number.MAX_SAFE_INTEGER; value.entries.push({ ...value.entries[0], relative: 'another', size: 1 }) }
      add(value)
    }
    for (let i = 0; i < 700; i++) {
      const hash = digest('lan-corpus-' + i), value = structuredClone(base)
      value.entries[0].relative = (i % 3 ? '目录/' : '') + ['正常', '../', 'CON', 'a ', 'a.', '😀', 'a?b', 'com10', 'Iİ'][i % 9] + hash.slice(0, i % 13) + '.txt'
      value.entries[0].size = i % 7 === 0 ? i + 0.25 : i * 1024
      value.entries[0].mtime = i * 1000 + 0.125; add(value)
    }
    const pairInputs = Array.from({ length: 250 }, (_, i) => [digest('a' + i), digest('b' + i)])
    pairInputs.push([identities[0].fingerprint, identities[1].fingerprint], [identities[1].fingerprint, identities[0].fingerprint])
    const addresses = ['127.0.0.1', '10.0.0.1', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.0.1', '172.15.0.1', '172.32.0.1', '8.8.8.8', '::1', '10.256.0.1', '10.001.2.3', '010.1.2.3', '127.0.0.1\n', '192.168.1', '0.0.0.0']
    const validAddress = address => /^\d{1,3}(\.\d{1,3}){3}$/.test(address) && address.split('.').every(p => +p <= 255) && (/^127\./.test(address) || /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^169\.254\./.test(address))
    const packet = { protocol: 'dustdesk-1', id: 'peer', name: '对方 😀', port: 12345, fingerprint: 'b'.repeat(64) }
    const discoveries = [
      { packet, remote: '192.168.1.2', valid: true },
      ...[{ ...packet, id: 'self' }, { ...packet, protocol: 'dustdesk-2' }, { ...packet, port: 0 }, { ...packet, port: 65536 }, { ...packet, fingerprint: 'c' }, { ...packet, name: '😀'.repeat(128) }].map(packet => ({ packet, remote: '127.0.0.1', valid: false })),
      { packet, remote: '8.8.8.8', valid: false },
    ].map(({ packet, ...rest }) => ({ ...rest, json: JSON.stringify(packet) }))
    const identityFaults = []
    for (const [name, data] of [['fingerprint', { ...identities[0], fingerprint: '0'.repeat(64) }], ['mismatched-key', { ...identities[0], key: identities[1].key }], ['malformed-key', { ...identities[0], key: 'private-invalid' }]]) {
      const target = path.join(root, 'identity-fault-' + name); await fs.mkdir(target); await fs.writeFile(path.join(target, 'identity.json'), JSON.stringify(data)); identityFaults.push(target)
    }
    const offsets = manifest.entries.map((entry, i) => ({ size: i === index ? 1024 * 1024 : entry.size, hash: digest(i === index ? bytes.subarray(0, 1024 * 1024) : Buffer.from(entry.size ? '完整文件 😀\n' : '')), complete: i !== index }))
    const offers = [{ manifest: JSON.stringify(manifest), offer: { token: 'c'.repeat(64), offsets }, valid: true }]
    for (const fault of ['token', 'size', 'complete', 'hash', 'count']) {
      const value = structuredClone(offers[0]); value.valid = false
      if (fault === 'token') value.offer.token = 'invalid'
      if (fault === 'size') value.offer.offsets[index].size = bytes.length + 1
      if (fault === 'complete') value.offer.offsets[index].complete = true
      if (fault === 'hash') value.offer.offsets[index].hash = 'INVALID'
      if (fault === 'count') value.offer.offsets.pop()
      offers.push(value)
    }
    const prefixes = [{ path: large, size: 1024 * 1024 }, { path: large, size: 0 }, { path: part, size: 1024 * 1024 }]
    const fixture = { manifests, pairs: pairInputs, addresses, discoveries, roots: ['sender', 'receiver'].map(name => path.join(root, name)), identityFaults, offers, prefixes }
    const fixturePath = path.join(root, 'fixture.json'), output = path.join(root, 'rust-output')
    await fs.writeFile(fixturePath, JSON.stringify(fixture))
    const before = await filesUnder(root)
    await cargo(['run', '--quiet', '--example', 'lan-compat', '--', fixturePath, output], 'lan-core-compat-rust.log')
    for (const [name, hash] of Object.entries(before)) assert.equal(digest(await fs.readFile(path.join(root, name))), hash, 'Rust must not mutate legacy file: ' + name)
    const result = JSON.parse(await fs.readFile(path.join(output, 'report.json'), 'utf8'))
    for (const [i, item] of manifests.entries()) assert.equal(result.manifests[i].valid, item.valid, 'manifest case ' + i)
    assert.deepEqual(result.pairs, pairInputs.map(([a, b]) => lan.pairingCode(a, b)))
    // The legacy regexp accepts a final newline before `$`; native endpoints
    // deliberately reject whitespace rather than passing it to the resolver.
    assert.deepEqual(result.addresses, addresses.map(address => validAddress(address) && !/\s/.test(address)))
    assert.deepEqual(result.discoveries, discoveries.map(item => item.valid))
    assert.deepEqual(result.offers, offers.map(item => item.valid))
    assert.deepEqual(result.identityFaults, [true, true, true])
    assert.deepEqual(result.identities, identities.map(({ id, fingerprint }) => ({ id, fingerprint })))
    assert.deepEqual(result.prefixes, [digest(bytes.subarray(0, 1024 * 1024)), digest(Buffer.alloc(0)), digest(bytes.subarray(0, 1024 * 1024))])
    for (const output of result.manifests.filter(item => item.valid)) for (const entry of output.public.entries) assert.equal(entry.source, undefined)
    check('Electron differential corpus matches Rust manifest validation, six-digit pair codes, addresses, discovery and resume replies')
    check('original RSA identities load without regeneration; wrong fingerprint, swapped key and malformed key are rejected without writes')
    check('Rust reads original state, completed files and partial bytes without changing any input; streamed prefix SHA-256 matches Node')
    report.cases = { manifests: manifests.length, pairs: pairInputs.length, addresses: addresses.length, discoveries: discoveries.length, offers: offers.length, identityFaults: 3, prefixes: prefixes.length }
    report.deliberateStricterValidation = ['IPv4 addresses with trailing whitespace are rejected even when the legacy regexp accepts them', 'Malformed task identities, duplicate task IDs and invalid completed-file indices block state load', 'Local extension metadata is preserved in state but omitted from network offers']

    for (const [i, name] of ['sender', 'receiver'].entries()) {
      const encoded = await fs.readFile(path.join(output, `state-${i}.json`))
      const parsed = JSON.parse(encoded)
      assert.ok(parsed.tasks.every(task => task.view.status === 'paused' && task.view.speed === 0 && !('token' in task)))
      await fs.writeFile(path.join(root, name, 'state.json'), encoded)
    }
    const conflict = path.join(receivedTask.view.directory, ...manifest.entries[index].relative.split('/'))
    await fs.mkdir(path.dirname(conflict), { recursive: true }); await fs.writeFile(conflict, 'existing file retained')
    sender = lan.createLanService(options('sender')); receiver = lan.createLanService(options('receiver'))
    const previousPairs = pairs, previousConfirmations = confirmations
    await sender.restore(); await receiver.restore(); await sender.connect('127.0.0.1', receiver.snapshot().port)
    await sender.control(id, 'resume')
    const finished = await waitFor(() => sender.snapshot().tasks.find(task => task.id === id), task => ['completed', 'failed'].includes(task?.status), 'reencoded transfer did not finish')
    assert.equal(finished.status, 'completed', finished.error)
    assert.equal(pairs, previousPairs, 'fixed certificates/trust avoid renewed pairing')
    assert.ok(confirmations > previousConfirmations, 'resume still requires receiver approval')
    const completed = receiver.snapshot().tasks[0]; assert.equal(completed.status, 'completed')
    const colliding = conflict.replace(/\.bin$/, '-1.bin')
    assert.equal(digest(await fs.readFile(colliding)), digest(bytes)); assert.equal(await fs.readFile(conflict, 'utf8'), 'existing file retained')
    assert.equal(await fs.readFile(path.join(completed.directory, '发送目录/完整.txt'), 'utf8'), '完整文件 😀\n')
    assert.equal((await fs.stat(path.join(completed.directory, '发送目录/empty.bin'))).size, 0)
    assert.ok((await fs.stat(path.join(completed.directory, '发送目录/空目录'))).isDirectory())
    await assert.rejects(fs.stat(receivedTask.staging), { code: 'ENOENT' })
    check('both legacy LAN module endpoints restart in Node from Rust-encoded state and resume verified prefixes with fresh receive approval and unchanged trust')
    check('resumed directory keeps completed and empty files, empty directories, and collision data; final large file SHA-256 matches source')
    assert.deepEqual(await Promise.all(identityPaths.map(async target => JSON.parse(await fs.readFile(target, 'utf8')))), identities)
    assert.deepEqual(await inputDigests(), report.inputs, 'all tested source and dependency inputs remain unchanged')
    report.rustDriverSha256 = digest(await fs.readFile('src-tauri/target/debug/examples/lan-compat.exe'))
    report.verified = true
  } catch (error) {
    report.verified = false; report.error = error.stack; throw error
  } finally {
    await Promise.allSettled([sender?.dispose(), receiver?.dispose()])
    await fs.writeFile(path.join(artifacts, 'lan-core-compat-verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup) await callback()
  }
})
