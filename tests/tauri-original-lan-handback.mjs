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

const artifacts = path.resolve('artifacts/tauri-migration/original-lan-handback-process')
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
function driver(root, reference, ids, mode = '--resume') {
  const executable = path.resolve('src-tauri/target/debug/examples/original-lan-recovery.exe')
  const child = spawn(executable, [root, reference, ...(ids ? [mode, ids.preparationId, ids.runtimeId, ids.ownershipId] : ['--prepare'])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
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

test('native LAN drains, durably hands back current state and resumes the original Electron receive task', { timeout: 600_000 }, async suite => {
  const cleanup = [], drivers = [], roots = []
  const { root: toolsRoot, lan } = await toolboxModules({ after: callback => cleanup.push(callback) })
  const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), scenarios: [],
    scope: 'Debug TEMP original native grant, supervised HTTPS/receiver/sender/discovery/file-worker drain, pinned latest compatible state and durable handback. Official EXE/ASAR authenticate source but are not executed. Current preparation Electron LAN module runs in Node with explicit fixture approval callbacks. No desktop maintenance integration, overall workspace/browser handback, production cutover, physical power failure, two-PC or packaging acceptance.' }
  let sender, legacy, generator
  try {
    await fs.mkdir(artifacts, { recursive: true }); await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    const sources = ['tests/tauri-original-lan-handback.mjs', 'src-tauri/examples/original-lan-recovery.rs', 'src-tauri/src/lan/migration/handback.rs', 'src-tauri/src/lan/migration/service.rs', 'src-tauri/src/lan/migration/handover.rs', 'src-tauri/src/lan/receiver.rs', 'src-tauri/src/lan/state_store.rs', 'src-tauri/src/legacy_source/binding/snapshot.rs', 'tests/reference/src/main/lanTransfer.ts', 'tests/toolbox-fixture.mjs']
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
    await build(); report.executableSha256 = await fileDigest('src-tauri/target/debug/examples/original-lan-recovery.exe')
    const reference = await extractOfficialLegacyReference(toolsRoot); report.reference = reference.release
    for (const boundary of [undefined, 'intent', 'decision']) {
      let failed = false
      await suite.test(boundary ? 'real SIGKILL after handback ' + boundary + ' resumes only explicit handback' : 'joined active upload hands latest prefix back and old runtime completes the original task', async () => {
        try {
          const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-runtime-preview-')); roots.push(root)
          const profile = path.join(root, 'Profile/LanTransfers'), downloads = path.join(root, 'Downloads')
          const data = path.join(root, 'Data'), workspace = Buffer.from('{"SchemaVersion":3,"Notes":[],"Todos":[],"QuickNote":"原 LAN 交还"}\r\n')
          await fs.mkdir(data); await fs.mkdir(downloads); await fs.writeFile(path.join(data, 'workspace.json'), workspace)
          let receiveApprovals = 0, pairApprovals = 0
          const options = name => ({ storage: name === 'original' ? profile : path.join(toolsRoot, (boundary ?? 'normal') + '-' + name), downloads, host: '127.0.0.1', name, discovery: false, changed() {},
            confirmPair: async () => { pairApprovals++; return true }, confirmReceive: async () => { receiveApprovals++; return downloads } })
          generator = lan.createLanService(options('original')); await generator.enable(true); await generator.dispose(); generator = undefined
          const originalState = await fs.readFile(path.join(profile, 'state.json')), originalIdentity = await fs.readFile(path.join(profile, 'identity.json'))
          const launch = (ids, mode) => { const driverInstance = driver(root, reference.root, ids, mode); drivers.push(driverInstance); return driverInstance }
          let fixture = launch(), ready = await fixture.event(value => value.event === 'ready')
          const ids = { preparationId: ready.preparationId, runtimeId: ready.runtimeId, ownershipId: ready.ownershipId }
          sender = lan.createLanService(options('sender')); await sender.enable(true)
          const identity = JSON.parse(await fs.readFile(path.join(options('sender').storage, 'identity.json'), 'utf8'))
          const connecting = sender.connect('127.0.0.1', ready.port); connecting.catch(() => {})
          const pair = await fixture.event(value => value.event === 'pair'); fixture.approve(pair.request)
          const device = await connecting
          let manifest, senderId, taskId, active, bytes, prefix, interrupted
          if (!boundary) {
            bytes = Buffer.alloc(8 * 1024 * 1024 + 17)
            for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 43 + (i >>> 16)) & 255
            const source = path.join(toolsRoot, '交还续传.bin'); await fs.writeFile(source, bytes)
            await sender.send(device.id, [source]); const held = await fixture.event(value => value.event === 'receive')
            senderId = sender.snapshot().tasks[0].id; await sender.control(senderId, 'pause')
            await fixture.event(value => value.event === 'decisionClosed' && value.request === held.request)
            const saved = JSON.parse(await fs.readFile(path.join(options('sender').storage, 'state.json'), 'utf8')).tasks.find(task => task.view.id === senderId)
            manifest = { ...saved.manifest, entries: saved.manifest.entries.map(({ source: ignored, ...entry }) => entry) }
            const offered = await offer(fixture, ready, identity, manifest); assert.equal(offered.response.status, 200)
            taskId = identity.fingerprint + '-' + manifest.id
            active = (await fixture.snapshot()).tasks.find(task => task.view.id === taskId)
            prefix = bytes.subarray(0, 1024 * 1024)
            interrupted = request(ready, identity, route('file', manifest, offered.response.body.token, 0, 0), { stream: outgoing => outgoing.write(prefix) })
            await waitFor(() => fs.stat(path.join(active.staging, '0.part')).catch(() => null), value => value?.size === prefix.length, 'active native prefix missing')
          }
          fixture.send({ command: 'handback', interruptAt: boundary })
          let receipt
          if (boundary) {
            const stoppedAt = await fixture.event(value => value.event === 'handbackBoundary'); assert.equal(stoppedAt.boundary, boundary)
            assert.equal((await fixture.kill()).signal, 'SIGKILL')
            assert.equal(await fs.access(path.join(ready.handbackRecord, 'decision.json')).then(() => true, () => false), boundary === 'decision')
          } else {
            receipt = (await fixture.event(value => value.event === 'handbackReady')).receipt
            await interrupted.result.catch(() => null)
            assert.equal(digest(await fs.readFile(path.join(active.staging, '0.part'))), digest(prefix))
            await assert.rejects(fs.writeFile(path.join(profile, 'state.json'), 'must remain pinned until actual release'))
            generator = lan.createLanService(options('original')); await assert.rejects(generator.enable(true), /占用|运行|锁|lock|owned|owner/i); await generator.dispose(); generator = undefined
            assert.equal((await fixture.stop()).code, 0, fixture.errors.join(''))
          }
          await sender.dispose(); sender = undefined
          const stateBefore = await fs.readFile(path.join(profile, 'state.json'))
          const intentBefore = await fs.readFile(path.join(ready.handbackRecord, 'intent.json'))
          const grantBefore = await fs.readFile(path.join(path.dirname(ready.handbackRecord), 'decision.json'))
          const ordinary = launch(ids); assert.notEqual((await ordinary.exited).code, 0)
          assert.equal(ordinary.lines.some(line => JSON.parse(line).event === 'ready'), false)
          fixture = launch(ids, '--resume-handback')
          const recovered = (await fixture.event(value => value.event === 'handbackReady')).receipt
          if (receipt) assert.equal(recovered.intentSha256, receipt.intentSha256)
          receipt = recovered
          await assert.rejects(fs.writeFile(path.join(profile, 'state.json'), 'still owned'))
          assert.equal((await fixture.stop()).code, 0, fixture.errors.join(''))
          assert.equal(receipt.checkpoint.state.sha256, digest(stateBefore))
          assert.equal(receipt.productionReady, false); assert.equal(receipt.migrationComplete, false)
          assert.equal(receipt.compatibleRuntime, 'dustdesk-electron-lan-protocol-1')
          assert.deepEqual(await fs.readFile(path.join(profile, 'state.json')), stateBefore)
          assert.deepEqual(await fs.readFile(path.join(ready.handbackRecord, 'intent.json')), intentBefore)
          assert.deepEqual(await fs.readFile(path.join(path.dirname(ready.handbackRecord), 'decision.json')), grantBefore)
          assert.deepEqual(await fs.readFile(path.join(root, 'Snapshot/lan-state.json')), originalState)
          assert.deepEqual(await fs.readFile(path.join(data, 'workspace.json')), workspace)
          assert.deepEqual(await fs.readFile(path.join(profile, 'identity.json')), originalIdentity)
          // A real old service now acquires the released physical directory.
          // Trust from native pairing must avoid another pairing confirmation.
          pairApprovals = 0
          legacy = lan.createLanService(options('original')); await legacy.enable(true)
          sender = lan.createLanService(options('sender')); await sender.enable(true)
          const legacyReady = { ...ready, port: legacy.snapshot().port }
          await sender.connect('127.0.0.1', legacyReady.port)
          assert.equal(pairApprovals, 0)
          if (!boundary) {
            assert.ok(legacy.snapshot().tasks.some(task => task.id === taskId))
            const probe = await request(legacyReady, identity, '/offer', { value: manifest }).result
            assert.equal(probe.status, 200, JSON.stringify(probe))
            assert.equal(probe.body.offsets[0].size, prefix.length); assert.equal(probe.body.offsets[0].hash, digest(prefix))
            assert.equal((await request(legacyReady, identity, route('pause', manifest, probe.body.token)).result).status, 200)
            await sender.control(senderId, 'resume')
            const completed = await waitFor(() => sender.snapshot().tasks.find(task => task.id === senderId), task => ['completed', 'failed'].includes(task?.status), 'old sender did not complete handed-back task')
            assert.equal(completed.status, 'completed', completed.error)
            const final = JSON.parse(await fs.readFile(path.join(profile, 'state.json'), 'utf8')).tasks.find(task => task.view.id === taskId)
            assert.equal(final.view.status, 'completed'); assert.equal(digest(await fs.readFile(final.files[0])), digest(bytes))
            assert.ok(receiveApprovals >= 2)
          }
          await sender.dispose(); sender = undefined; await legacy.dispose(); legacy = undefined
          assert.deepEqual(await fs.readFile(path.join(profile, 'identity.json')), originalIdentity)
          report.scenarios.push({ boundary: boundary ?? 'normal', verified: true, receipt, latestStateSha256BeforeLegacy: digest(stateBefore), partial: prefix ? { bytes: prefix.length, sha256: digest(prefix), finalSha256: digest(bytes) } : undefined })
        } catch (error) { failed = true; throw error }
      })
      if (failed) throw Error('Handback scenario failed: ' + (boundary ?? 'normal'))
    }
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const d of drivers) if (d.child.exitCode === null && d.child.signalCode === null) await d.kill()
    await sender?.dispose(); await legacy?.dispose(); await generator?.dispose()
    await fs.writeFile(path.join(artifacts, 'events.log'), drivers.flatMap((d, index) => d.lines.map(line => `${index}: ${line}`)).join('\n'))
    await fs.writeFile(path.join(artifacts, 'stderr.log'), drivers.flatMap(d => d.errors).join('\n'))
    report.remainingProcesses = drivers.filter(d => d.child.exitCode === null && d.child.signalCode === null).length
    for (const root of roots) {
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^dustdesk-runtime-preview-[A-Za-z0-9]+$/); assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
      await fs.rm(root, { recursive: true, force: true })
    }
    for (const callback of cleanup.reverse()) await callback()
    report.finishedAt = new Date().toISOString(); report.cleanup = { rootsRemoved: roots.length }
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
  }
})
