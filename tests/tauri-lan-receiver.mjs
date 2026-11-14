import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/lan-receiver')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(read, accept, description) {
  const end = Date.now() + 15_000
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
  const executable = path.resolve('src-tauri/target/debug/examples/lan-receiver.exe')
  const child = spawn(executable, [profile, downloads], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const events = [], waiters = new Set(), replies = new Map(), lines = [], errors = []
  let closed = false, sequence = 0
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { closed = true; for (const notify of waiters) notify(); resolve({ code, signal }) }) })
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
        const timeout = setTimeout(() => { replies.delete(id); reject(Error('snapshot timeout')) }, 15_000)
        replies.set(id, result => { clearTimeout(timeout); resolve(result) })
      })
      send({ command, id }); const result = await value; assert.equal(result.ok, true, result.error); return result
    },
    async snapshot() { return (await this.call('snapshot')).state },
    async event(predicate) {
      const end = Date.now() + 15_000
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

test('Rust receiver persists real files, authorizes resume and continues an old sender after both endpoints restart', { timeout: 240_000 }, async () => {
  const cleanup = []; const { root, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const report = { verified: false, productionReady: false, migrationComplete: false,
    scope: 'Rust receiver service library with actual HTTPS/files/state; explicit stdin approval fixture replaces native dialogs; old sender runs its Electron LAN module in Node', checks: [] }
  let fixture, sender, generator; const drivers = []
  const check = name => report.checks.push(name)
  try {
    await fs.mkdir(artifacts, { recursive: true }); await build()
    const sources = ['src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/src/lib.rs', 'src-tauri/src/lan/mod.rs', 'src-tauri/src/lan/protocol.rs', 'src-tauri/src/lan/storage.rs', 'src-tauri/src/lan/files.rs', 'src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs', 'src-tauri/src/lan/publication.rs', 'src-tauri/src/lan/publication/legacy.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/src/lan/tls.rs', 'src-tauri/src/lan/transport.rs', 'src-tauri/examples/lan-receiver.rs', 'tests/tauri-lan-receiver.mjs', 'tests/toolbox-fixture.mjs', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/reference/src/main/fileOperations.ts', 'src/shared/toolbox.ts']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async source => [source, digest(await fs.readFile(source))])))
    report.driver = { executable: path.resolve('src-tauri/target/debug/examples/lan-receiver.exe'), sha256: digest(await fs.readFile('src-tauri/target/debug/examples/lan-receiver.exe')) }
    const profile = path.join(root, 'rust'); const downloads = path.join(root, 'downloads'); await fs.mkdir(downloads)
    const options = name => ({ storage: path.join(root, name), downloads, host: '127.0.0.1', name, discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => downloads })
    generator = lan.createLanService(options('rust')); await generator.enable(true); await generator.dispose(); generator = undefined
    sender = lan.createLanService(options('old-sender')); await sender.enable(true)
    let identity = JSON.parse(await fs.readFile(path.join(root, 'old-sender/identity.json'), 'utf8'))
    fixture = driver(profile, downloads); drivers.push(fixture)
    let ready = await fixture.event(value => value.event === 'ready')
    let connect = sender.connect('127.0.0.1', ready.port); connect.catch(() => {})
    const paired = await fixture.event(value => value.event === 'pair')
    assert.equal(paired.peer.fingerprint, identity.fingerprint); assert.match(paired.code, /^\d{6}$/)
    fixture.approve(paired.request); let device = await connect
    assert.ok(JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).trusted.includes(identity.fingerprint))
    check('explicit pairing approves actual TLS fingerprint and persists trust before response')
    {
      generator = lan.createLanService(options('stranger')); await generator.enable(true); await generator.dispose(); generator = undefined
      const stranger = JSON.parse(await fs.readFile(path.join(root, 'stranger/identity.json'), 'utf8'))
      await fixture.call('state-lock')
      const failing = request(ready, stranger, '/pair', { value: { id: stranger.id, name: 'stranger', port: 12345 } })
      const prompt = await fixture.event(value => value.event === 'pair'); fixture.approve(prompt.request)
      const failed = await failing.result; assert.equal(failed.status, 400)
      assert.equal((await fixture.snapshot()).trusted.includes(stranger.fingerprint), false)
      assert.equal((await request(ready, stranger, '/offer', { value: { id: 'untrusted', name: 'blocked', entries: [], directories: [], text: 'blocked' } }).result).status, 400)
      await fixture.call('state-unlock')
      const retry = request(ready, stranger, '/pair', { value: { id: stranger.id, name: 'stranger', port: 12345 } })
      const approval = await fixture.event(value => value.event === 'pair'); fixture.approve(approval.request)
      assert.equal((await retry.result).status, 200)
      check('real state sharing violation prevents pairing and live trust; explicit approval can retry after write access recovers')
    }
    const text = { id: 'unicode-text', name: '文本', entries: [], directories: [], text: '旧版发送到 Rust 😀\n中文' }
    let offered = await offer(fixture, ready, identity, text, { accept: false }); assert.equal(offered.response.status, 400)
    assert.equal((await fixture.snapshot()).tasks.length, 0)
    offered = await offer(fixture, ready, identity, text); assert.equal(offered.response.status, 200)
    assert.equal(offered.prompt.peer.name, 'old-sender')
    assert.equal((await fixture.snapshot()).tasks[0].view.text, text.text)
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).tasks.length, 0)
    check('text requires receive approval, uses actual paired name, and stays out of restart state')

    const source = path.join(root, '发送目录'); await fs.mkdir(path.join(source, '空目录'), { recursive: true })
    const data = Buffer.alloc(8 * 1024 * 1024 + 17); for (let i = 0; i < data.length; i++) data[i] = (i * 43 + (i >>> 16)) & 255
    await fs.writeFile(path.join(source, 'large.bin'), data); await fs.writeFile(path.join(source, 'small.txt'), '已完成 😀'); await fs.writeFile(path.join(source, 'zero.bin'), Buffer.alloc(0))
    await sender.send(device.id, [source])
    const held = await fixture.event(value => value.event === 'receive')
    const senderId = sender.snapshot().tasks[0].id
    await sender.control(senderId, 'pause')
    await fixture.event(value => value.event === 'decision-closed' && value.request === held.request)
    fixture.approve(held.request)
    assert.equal((await fixture.snapshot()).tasks.filter(task => task.manifest.id === senderId).length, 0)
    check('late canceled native receive decision creates no task after remote close is observed')
    let saved = JSON.parse(await fs.readFile(path.join(root, 'old-sender/state.json'), 'utf8'))
    const original = saved.tasks.find(task => task.view.id === senderId)
    const manifest = { ...original.manifest, entries: original.manifest.entries.map(({ source: ignored, ...entry }) => entry) }
    offered = await offer(fixture, ready, identity, manifest); assert.equal(offered.response.status, 200, JSON.stringify(offered.response))
    const token = offered.response.body.token
    const nativeTaskId = identity.fingerprint + '-' + manifest.id
    const nativeTask = (await fixture.snapshot()).tasks.find(task => task.view.id === nativeTaskId)
    const destination = nativeTask.view.directory
    assert.equal(await fs.stat(path.join(destination, '发送目录/空目录')).then(value => value.isDirectory()), true)
    assert.equal((await request(ready, identity, route('file', manifest, 'b'.repeat(64), 0, 0), { value: Buffer.alloc(0) }).result).status, 400)
    assert.equal((await request(ready, identity, route('complete', manifest, token)).result).status, 400)
    assert.equal((await request(ready, identity, route('pause', manifest, token) + '&token=' + token).result).status, 400)
    const largeIndex = manifest.entries.findIndex(entry => entry.relative.endsWith('large.bin'))
    const smallIndex = manifest.entries.findIndex(entry => entry.relative.endsWith('small.txt'))
    const zeroIndex = manifest.entries.findIndex(entry => entry.relative.endsWith('zero.bin'))
    const smallTarget = path.join(destination, manifest.entries[smallIndex].relative)
    await fs.writeFile(smallTarget, 'same-name preserved')
    for (const index of [smallIndex, zeroIndex]) {
      const bytes = index === zeroIndex ? Buffer.alloc(0) : await fs.readFile(path.join(source, 'small.txt'))
      const response = await request(ready, identity, route('file', manifest, token, index, 0), { value: bytes }).result
      assert.equal(response.status, 200, JSON.stringify(response))
    }
    assert.equal(await fs.readFile(smallTarget, 'utf8'), 'same-name preserved')
    const staging = nativeTask.staging
    const partial = data.subarray(0, 1024 * 1024)
    const interrupted = request(ready, identity, route('file', manifest, token, largeIndex, 0), { stream: outgoing => { outgoing.write(partial) } })
    await waitFor(() => fs.stat(path.join(staging, `${largeIndex}.part`)).catch(() => null), value => value?.size === partial.length, 'native partial bytes were not written')
    await fixture.kill(); await interrupted.result.catch(() => null)
    await sender.dispose(); sender = undefined
    saved = JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8'))
    assert.equal(saved.tasks.find(task => task.view.id === nativeTaskId).token, undefined)
    fixture = driver(profile, downloads); drivers.push(fixture); ready = await fixture.event(value => value.event === 'ready')
    assert.equal((await request(ready, identity, route('file', manifest, token, largeIndex, partial.length), { value: data.subarray(partial.length) }).result).status, 400)
    sender = lan.createLanService(options('old-sender')); await sender.enable(true)
    device = await sender.connect('127.0.0.1', ready.port)
    const wrongDirectory = await offer(fixture, ready, identity, manifest, { directory: downloads })
    assert.equal(wrongDirectory.response.status, 400); assert.equal(wrongDirectory.prompt.existing, destination)
    await sender.control(senderId, 'resume')
    const resumed = await fixture.event(value => value.event === 'receive')
    assert.equal(resumed.existing, destination); fixture.approve(resumed.request)
    const completed = await waitFor(() => sender.snapshot().tasks.find(task => task.id === senderId), task => task?.status === 'completed' || task?.status === 'failed', 'old sender did not finish restarted transfer')
    assert.equal(completed.status, 'completed', completed.error)
    const final = (await fixture.snapshot()).tasks.find(task => task.view.id === nativeTaskId)
    assert.equal(final.view.status, 'completed'); assert.equal(final.view.done, data.length + Buffer.byteLength('已完成 😀'))
    assert.equal(digest(await fs.readFile(final.files[largeIndex])), digest(data))
    assert.equal(await fs.readFile(final.files[smallIndex], 'utf8'), '已完成 😀')
    assert.equal((await fs.stat(final.files[zeroIndex])).size, 0)
    assert.equal(await fs.stat(staging).then(() => true, () => false), false)
    assert.equal(await fs.readFile(smallTarget, 'utf8'), 'same-name preserved')
    check('old real sender and native receiver both restart; fresh approval resumes partial bytes, skips complete files, preserves collision and empty directory, verifies hashes and cleans staging')

    const manualData = Buffer.alloc(256 * 1024, 71)
    const manual = { id: 'pause-cancel', name: '暂停取消', directories: ['empty'], entries: [{ relative: 'data.bin', size: manualData.length, mtime: 0, hash: digest(manualData) }] }
    offered = await offer(fixture, ready, identity, manual); assert.equal(offered.response.status, 200)
    let manualToken = offered.response.body.token
    const taskId = identity.fingerprint + '-' + manual.id
    let task = (await fixture.snapshot()).tasks.find(task => task.view.id === taskId)
    const active = request(ready, identity, route('file', manual, manualToken, 0, 0), { stream: outgoing => outgoing.write(manualData.subarray(0, 65_536)) })
    await waitFor(() => fs.stat(path.join(task.staging, '0.part')).catch(() => null), value => value?.size === 65_536, 'partial pause bytes missing')
    const progress = (await fixture.call('progress')).views.find(view => view.id === taskId)
    assert.equal(progress.status, 'transferring'); assert.equal(progress.done, 65_536); assert.ok(progress.speed > 0)
    {
      assert.equal((await fixture.snapshot()).tasks.find(task => task.view.id === taskId).view.status, 'transferring')
      const concurrent = { id: 'concurrent-receive', name: '并行接收', directories: [], entries: [{ relative: 'small.txt', size: 3, mtime: 0, hash: digest(Buffer.from('abc')) }] }
      const second = await offer(fixture, ready, identity, concurrent); assert.equal(second.response.status, 200)
      assert.equal((await request(ready, identity, route('file', concurrent, second.response.body.token, 0, 0), { value: Buffer.from('abc') }).result).status, 200)
      assert.equal((await request(ready, identity, route('complete', concurrent, second.response.body.token)).result).status, 200)
      assert.equal((await request(ready, identity, route('file', manual, manualToken, 0, 65_536), { value: manualData.subarray(65_536) }).result).status, 400)
      assert.equal((await request(ready, identity, route('complete', manual, manualToken)).result).status, 400)
      const live = (await fixture.call('progress')).views.find(view => view.id === taskId)
      assert.equal(live.status, 'transferring'); assert.equal(live.done, 65_536)
      assert.equal((await fs.stat(path.join(task.staging, '0.part'))).size, 65_536)
      check('a stalled upload leaves state inspection, fresh offer and another file publication usable; same-task upload/complete remain exclusive and live progress survives unrelated commits')
    }
    const paused = await request(ready, identity, route('pause', manual, manualToken)).result
    assert.equal(paused.status, 200, JSON.stringify(paused)); await active.result.catch(() => null)
    task = (await fixture.snapshot()).tasks.find(task => task.view.id === taskId)
    assert.equal(task.view.status, 'paused'); assert.equal((await fs.stat(path.join(task.staging, '0.part'))).size, 65_536)
    assert.equal((await request(ready, identity, route('cancel', manual, manualToken)).result).status, 400)
    offered = await offer(fixture, ready, identity, manual); assert.equal(offered.response.status, 200)
    assert.equal(offered.response.body.offsets[0].size, 65_536); assert.equal(offered.response.body.offsets[0].hash, digest(manualData.subarray(0, 65_536)))
    manualToken = offered.response.body.token; assert.notEqual(manualToken, token)
    assert.equal((await request(ready, identity, route('cancel', manual, manualToken)).result).status, 200)
    assert.equal(await fs.stat(task.staging).then(() => true, () => false), false)
    assert.equal((await fixture.snapshot()).tasks.find(task => task.view.id === taskId).view.status, 'canceled')
    assert.equal((await request(ready, identity, '/offer', { value: manual }).result).status, 400)
    check('authenticated pause cancels and joins an active file writer, revokes old token, freshly approved resume hashes partial prefix, cancel deletes only known parts')

    {
      const retryManifest = { id: 'hash-retry', name: '校验重试', directories: [], entries: [{ relative: 'result.bin', size: 3, mtime: 0, hash: digest(Buffer.from('abc')) }] }
      let reply = await offer(fixture, ready, identity, retryManifest); assert.equal(reply.response.status, 200)
      const firstToken = reply.response.body.token
      assert.equal((await request(ready, identity, route('file', retryManifest, firstToken, 0, 1), { value: Buffer.from('ab') }).result).status, 400)
      reply = await offer(fixture, ready, identity, retryManifest); assert.equal(reply.response.status, 200)
      assert.equal((await request(ready, identity, route('file', retryManifest, reply.response.body.token, 0, 0), { value: Buffer.from('bad') }).result).status, 400)
      let current = (await fixture.snapshot()).tasks.find(task => task.manifest.id === retryManifest.id)
      assert.equal(current.view.status, 'failed'); assert.equal(current.view.done, 0)
      assert.equal(await fs.stat(path.join(current.staging, '0.part')).then(() => true, () => false), false)
      reply = await offer(fixture, ready, identity, retryManifest); assert.equal(reply.response.body.offsets[0].size, 0)
      assert.equal((await request(ready, identity, route('file', retryManifest, reply.response.body.token, 0, 0), { value: Buffer.from('abc') }).result).status, 200)
      current = (await fixture.snapshot()).tasks.find(task => task.manifest.id === retryManifest.id)
      await fixture.call('state-lock')
      assert.equal((await request(ready, identity, route('complete', retryManifest, reply.response.body.token)).result).status, 400)
      assert.equal(await fs.stat(current.staging).then(() => true, () => false), false)
      await fixture.call('state-unlock')
      reply = await offer(fixture, ready, identity, retryManifest); assert.equal(reply.response.status, 200)
      assert.equal(reply.response.body.offsets[0].complete, true)
      assert.equal((await request(ready, identity, route('complete', retryManifest, reply.response.body.token)).result).status, 200)
      current = (await fixture.snapshot()).tasks.find(task => task.manifest.id === retryManifest.id)
      assert.equal(await fs.readFile(current.files[0], 'utf8'), 'abc')
      check('wrong offsets fail; hash mismatch removes only its owned corrupt part, resets progress, and fresh approval retries to a verified final file')
      check('actual terminal-state save failure after staging cleanup remains retryable; fresh approval recreates fixed staging and verifies complete file')
    }
    {
      const unknown = { id: 'unknown-staging', name: '保留未知文件', directories: [], entries: [] }
      let reply = await offer(fixture, ready, identity, unknown); assert.equal(reply.response.status, 200)
      let current = (await fixture.snapshot()).tasks.find(task => task.manifest.id === unknown.id)
      const marker = path.join(current.staging, 'unknown.txt'); await fs.writeFile(marker, 'keep unknown')
      assert.equal((await request(ready, identity, route('cancel', unknown, reply.response.body.token)).result).status, 400)
      assert.equal(await fs.readFile(marker, 'utf8'), 'keep unknown')
      await fs.unlink(marker)
      reply = await offer(fixture, ready, identity, unknown); assert.equal(reply.response.status, 200)
      assert.equal((await request(ready, identity, route('cancel', unknown, reply.response.body.token)).result).status, 200)
      check('cancel refuses a nonempty staging directory with unknown content; preserves the file and supports fresh-confirmation cleanup retry')
    }

    const changed = structuredClone(manifest); changed.entries[0].hash = 'c'.repeat(64)
    assert.equal((await request(ready, identity, '/offer', { value: changed }).result).status, 400)
    const shutting = { id: 'stop-active', name: 'stop active', directories: [], entries: [{ relative: 'data.bin', size: manualData.length, mtime: 0, hash: digest(manualData) }] }
    const shutdownOffer = await offer(fixture, ready, identity, shutting); assert.equal(shutdownOffer.response.status, 200)
    const shutdownTask = (await fixture.snapshot()).tasks.find(task => task.manifest.id === shutting.id)
    const pending = request(ready, identity, '/offer', { value: { id: 'stop-pending', name: 'pending', directories: [], entries: [], text: 'pending' } })
    const closing = await fixture.event(value => value.event === 'receive')
    const activeAtStop = request(ready, identity, route('file', shutting, shutdownOffer.response.body.token, 0, 0), { stream: outgoing => outgoing.write(manualData.subarray(0, 65_536)) })
    await waitFor(() => fs.stat(path.join(shutdownTask.staging, '0.part')).catch(() => null), value => value?.size === 65_536, 'shutdown partial bytes missing')
    const stopped = await fixture.stop(); assert.equal(stopped.code, 0, fixture.errors.join(''))
    await pending.result.catch(() => null)
    await activeAtStop.result.catch(() => null)
    const stopEvent = await fixture.event(value => value.event === 'stopped'); assert.equal(stopEvent.pending, 0)
    assert.equal(stopEvent.releaseVerified, true); assert.ok(stopEvent.checkedDirectories >= 2)
    const stoppedState = JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).tasks.find(task => task.manifest.id === shutting.id)
    assert.equal(stoppedState.view.status, 'paused'); assert.equal(stoppedState.view.done, 65_536); assert.equal(stoppedState.token, undefined)
    assert.equal((await fs.stat(path.join(shutdownTask.staging, '0.part'))).size, 65_536)
    await assert.rejects(request(ready, identity, '/hello', { method: 'GET' }).result)
    assert.equal(fixture.lines.some(line => line.includes('"request":' + closing.request) && line.includes('decision-closed')), true)
    check('changed source is refused; shutdown cancels both pending approval and active write, persists paused prefix, joins worker and listener, releases profile/destination handles while Receiver is still alive')
    await sender.dispose(); sender = undefined
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const d of drivers) { if (d.child.exitCode === null) await d.kill(); }
    await sender?.dispose(); await generator?.dispose()
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.flatMap((d, index) => d.lines.map(line => `${index}: ${line}`)).join('\n'))
    await fs.writeFile(path.join(artifacts, 'stderr.log'), drivers.flatMap(d => d.errors).join('\n'))
    report.remainingProcesses = drivers.filter(d => d.child.exitCode === null && d.child.signalCode === null).length
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const callback of cleanup.reverse()) await callback()
  }
})
