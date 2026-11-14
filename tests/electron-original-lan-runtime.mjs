import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { waitFor } from './tauri-harness.mjs'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'
import { toolboxModules } from './toolbox-fixture.mjs'

const artifacts = path.resolve('artifacts/tauri-migration/electron-original-lan-runtime')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
function request(ready, identity, route, { value = {}, stream } = {}) {
  let outgoing
  const result = new Promise((resolve, reject) => {
    outgoing = https.request({ hostname: '127.0.0.1', port: ready.port, path: route, method: 'POST', rejectUnauthorized: false, agent: false,
      key: identity.key, cert: identity.cert, headers: { 'Content-Type': stream ? 'application/octet-stream' : 'application/json' } }, async response => {
      try { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }) } catch (error) { reject(error) }
    })
    outgoing.on('socket', socket => socket.once('secureConnect', () => { if (hash(socket.getPeerCertificate().raw) !== ready.fingerprint) outgoing.destroy(Error('peer pin changed')) }))
    outgoing.on('error', reject); outgoing.setTimeout(15000, () => outgoing.destroy(Error('request timeout')))
    if (stream) stream(outgoing); else outgoing.end(JSON.stringify(value))
  })
  result.catch(() => {}); return { outgoing, result }
}
async function nativeDialog(pid, title, action = 'snapshot', button) {
  const child = spawn('pwsh', ['-NoProfile', '-STA', '-File', 'tests/tauri-lan-dialog.ps1', '-ProcessId', String(pid), '-Title', title, '-Action', action, ...(button ? ['-Button', button] : [])], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const output = [], error = []; child.stdout.on('data', b => output.push(b)); child.stderr.on('data', b => error.push(b))
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve) })
  assert.equal(code, 0, Buffer.concat(error).toString()); return Buffer.concat(output).toString()
}

test('actual Electron menu transfers original LAN to Tauri and keeps a restart fence through native or client death', { timeout: 900000 }, async suite => {
  const roots = [], cleanup = [], { root: toolsRoot, lan } = await toolboxModules({ after: cb => cleanup.push(cb) })
  const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), scenarios: [], scope: 'Actual Electron maintenance menu, same-process Tauri browser import, native Windows pair/receive approvals, original identity and real HTTPS upload drain/handback, persistent restart fence, explicit socket-free cold recovery. Dedicated TEMP only. No overall workspace/browser handback or production cutover.' }
  const sources = ['tests/electron-original-lan-runtime.mjs', 'tests/electron-harness.mjs', 'tests/reference/src/main/index.ts', 'tests/reference/src/main/originalLanPreview.ts', 'tests/reference/src/main/legacySourceLease.ts', 'tests/reference/src/main/toolboxRuntime.ts', 'tests/reference/src/main/draftMaintenance.ts', 'src-tauri/src/legacy_source/bridge.rs', 'src-tauri/src/workspace/runtime_boot.rs', 'src-tauri/src/workspace/runtime_boot/lan.rs']
  let app, sender, currentRoot
  const fencePath = () => path.join(currentRoot, 'user-data/OriginalLanPreview.json')
  const api = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const toolbox = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk.toolbox[method](...args), { method, args })
  const menu = id => app.electronApp.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id)
  const messages = () => app.electronApp.evaluate(() => globalThis.__lanMessages)
  const notices = () => app.electronApp.evaluate(() => globalThis.__lanNotices)
  const pid = () => app.electronApp.evaluate(() => globalThis.__lanChildren.at(-1).pid)
  const missing = file => fs.lstat(file).then(() => false, e => { if (e.code === 'ENOENT') return true; throw e })
  const scenario = async (name, action) => {
    let failed = false
    await suite.test(name, async () => { try { await action(); report.scenarios.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Original LAN runtime scenario failed: ' + name)
    await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
  }
  async function start() {
    currentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-runtime-preview-')); roots.push(currentRoot)
    const bootstrap = path.join(currentRoot, 'lan-bootstrap.cjs')
    await fs.writeFile(bootstrap, `
const electron = require('electron');
globalThis.__lanMessages = []; globalThis.__lanChildren = []; globalThis.__lanNotices = []; globalThis.__lanDialog = undefined;
const processes = require('node:child_process'), spawn = processes.spawn;
processes.spawn = (...args) => { const child = spawn(...args); if (args[1]?.includes('--legacy-runtime-preview-v1')) { globalThis.__lanChildren.push(child); let buffer = ''; const decoder = new (require('node:string_decoder').StringDecoder)('utf8'); child.stdout.on('data', b => { buffer += decoder.write(b); for (;;) { const n = buffer.indexOf('\\n'); if (n < 0) break; const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); try { globalThis.__lanMessages.push(JSON.parse(line)); } catch {} } }); } return child; };
electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(reference.root)}] });
electron.dialog.showErrorBox = (title, message) => { globalThis.__lanNotices.push({ title, message, kind: 'error' }); require('node:fs').appendFileSync(${JSON.stringify(path.join(currentRoot, 'startup-errors.jsonl'))}, JSON.stringify({ title, message }) + '\\n'); };
electron.dialog.showMessageBox = async (...args) => { const o = args.at(-1);
  if (['验证原 LAN 隔离交接','恢复原 LAN 交还'].includes(o.title)) return { response: 1 };
  if (o.title === '原 LAN 交还待恢复') { globalThis.__lanNotices.push({ title: o.title, kind: 'startup', windows: electron.BrowserWindow.getAllWindows().length }); return { response: 1 }; }
  if (o.title === '隔离原 LAN 已核验') return new Promise(resolve => { const end = () => { o.signal.removeEventListener('abort', end); globalThis.__lanDialog = undefined; resolve({ response: 0 }); }; globalThis.__lanDialog = { end }; o.signal.addEventListener('abort', end, { once: true }); if (o.signal.aborted) end(); });
  globalThis.__lanNotices.push({ title: o.title, message: o.message, kind: 'message' }); return { response: 0 };
};
require(${JSON.stringify(path.resolve('out/main/index.js'))});
`)
    app = await launchDustDesk({ tempRoot: currentRoot, bootstrap })
    const state = await api('loadWorkspace'); state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false
    assert.equal((await api('saveWorkspace', state)).ok, true)
    await app.window.evaluate(() => localStorage.setItem('widget-note:original-lan-runtime', JSON.stringify({ title: '原 LAN', text: '未提交草稿🪶', previousTitle: '', previousText: '' })))
    return bootstrap
  }
  async function begin() {
    await app.electronApp.evaluate(() => { globalThis.__lanMessages = []; globalThis.__lanNotices = [] })
    await menu('preview-legacy-lan-runtime')
    await waitFor(async () => { const state = await app.electronApp.evaluate(() => ({ ready: !!globalThis.__lanDialog, notices: globalThis.__lanNotices })); assert.deepEqual(state.notices, []); return state.ready }, 90000)
    const ready = (await messages()).find(m => m.event === 'runtimeOriginalLanReady'); assert.ok(ready)
    assert.equal(ready.productionReady, false); assert.equal(ready.migrationComplete, false)
    assert.equal(await app.window.evaluate(() => document.documentElement.inert), true)
    const fence = JSON.parse(await fs.readFile(fencePath(), 'utf8')); assert.equal(fence.ownershipId, ready.ownershipId)
    await assert.rejects(api('loadWorkspace'), /原 LAN|迁移维护/)
    await assert.rejects(toolbox('lanSnapshot'), /原 LAN|迁移维护/)
    return { ready, fence, pid: await pid() }
  }
  async function finish(cancel = false) {
    if (cancel) await menu('cancel-legacy-source-snapshot')
    else await app.electronApp.evaluate(() => globalThis.__lanDialog.end())
    await waitFor(async () => (await notices()).length > 0, 65000)
    await waitFor(() => missing(fencePath()), 10000)
    await api('loadWorkspace')
    assert.ok((await messages()).some(m => m.event === 'runtimeOriginalLanHandedBack'))
    assert.equal(await app.electronApp.evaluate(() => globalThis.__lanChildren.at(-1).exitCode), 0)
  }
  async function recover() {
    await app.electronApp.evaluate(() => { globalThis.__lanNotices = [] })
    await menu('recover-original-lan-preview')
    await waitFor(async () => { const n = await notices(); assert.equal(n.some(n => n.kind === 'error'), false, JSON.stringify(n)); return n.some(n => n.title === '原 LAN 交还已核验') }, 30000)
    assert.equal(await missing(fencePath()), true); await api('loadWorkspace')
    assert.equal((await toolbox('lanSnapshot')).enabled, true)
  }
  async function close() { if (app) {
    report.sessions ??= []
    report.sessions.push(await app.electronApp.evaluate(() => ({ messages: globalThis.__lanMessages, notices: globalThis.__lanNotices, children: globalThis.__lanChildren.map(c => ({ pid: c.pid, code: c.exitCode, signal: c.signalCode })) })).catch(error => ({ terminated: String(error) })))
    await closeDustDesk({ ...app, preserveTempRoot: true }); app = undefined
  } }
  let reference
  try {
    await fs.mkdir(artifacts, { recursive: true }); await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async f => [f, await fileDigest(f)])))
    report.executableSha256 = await fileDigest('src-tauri/target/debug/DustDesk.exe')
    reference = await extractOfficialLegacyReference(toolsRoot); report.reference = reference.release
    await scenario('uninitialized LAN never creates an identity or listener and clears its fence after actual host close', async () => {
      await start(); const held = await begin(); assert.equal(held.ready.enabled, false); assert.equal(held.ready.port, 0)
      await finish(); assert.equal(await missing(path.join(currentRoot, 'user-data/LanTransfers')), true); await close()
    })
    await scenario('disabled initialized LAN preserves the original identity and stays off', async () => {
      await start(); await toolbox('lanEnable', true); await toolbox('lanEnable', false)
      const identity = await fs.readFile(path.join(currentRoot, 'user-data/LanTransfers/identity.json'))
      const held = await begin(); assert.equal(held.ready.enabled, false); await finish()
      assert.equal((await toolbox('lanSnapshot')).enabled, false)
      assert.deepEqual(await fs.readFile(path.join(currentRoot, 'user-data/LanTransfers/identity.json')), identity); await close()
    })
    await scenario('real native pair and receive dialogs authorize active upload; joined handback preserves prefix and Electron completes the same file', async () => {
      await start(); await toolbox('lanEnable', true)
      const originalIdentity = await fs.readFile(path.join(currentRoot, 'user-data/LanTransfers/identity.json'))
      const held = await begin(); assert.equal(held.ready.enabled, true)
      const senderStorage = path.join(toolsRoot, 'actual-peer')
      sender = lan.createLanService({ storage: senderStorage, downloads: toolsRoot, host: '127.0.0.1', name: 'Native runtime peer', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => false })
      await sender.enable(true)
      const connecting = sender.connect('127.0.0.1', held.ready.port); connecting.catch(() => {})
      await nativeDialog(held.pid, '局域网设备配对', 'click', '配对码一致，继续'); await connecting
      const identity = JSON.parse(await fs.readFile(path.join(senderStorage, 'identity.json'), 'utf8'))
      const bytes = Buffer.alloc(3 * 1024 * 1024 + 19, 71), prefix = bytes.subarray(0, 1024 * 1024)
      const manifest = { id: randomUUID(), name: '原宿主续传', directories: [], entries: [{ relative: 'handover.bin', size: bytes.length, mtime: 0, hash: hash(bytes) }] }
      const offered = request(held.ready, identity, '/offer', { value: manifest })
      await nativeDialog(held.pid, '接收局域网内容', 'click', '接收到默认目录')
      const response = await offered.result; assert.equal(response.status, 200, JSON.stringify(response))
      const active = request(held.ready, identity, `/file?id=${manifest.id}&token=${response.body.token}&index=0&offset=0`, { stream: outgoing => outgoing.write(prefix) })
      const stateFile = path.join(currentRoot, 'user-data/LanTransfers/state.json')
      let task
      await waitFor(async () => { task = JSON.parse(await fs.readFile(stateFile, 'utf8')).tasks.find(t => t.manifest?.id === manifest.id); if (!task) return false; return (await fs.stat(path.join(task.staging, '0.part')).catch(() => null))?.size === prefix.length })
      await finish(); await active.result.catch(() => {})
      assert.equal(hash(await fs.readFile(path.join(task.staging, '0.part'))), hash(prefix))
      assert.deepEqual(await fs.readFile(path.join(currentRoot, 'user-data/LanTransfers/identity.json')), originalIdentity)
      const old = { ...held.ready, port: (await toolbox('lanSnapshot')).port }
      const resume = await request(old, identity, '/offer', { value: manifest }).result
      // Existing receive tasks still require actual Electron approval.
      assert.equal(resume.status, 400)
      await app.electronApp.evaluate(({ dialog }) => { const original = dialog.showMessageBox; dialog.showMessageBox = async (...args) => args.at(-1).title === '接收局域网内容' ? { response: 1 } : original(...args) })
      const accepted = await request(old, identity, '/offer', { value: manifest }).result
      assert.equal(accepted.status, 200); assert.equal(accepted.body.offsets[0].size, prefix.length); assert.equal(accepted.body.offsets[0].hash, hash(prefix))
      const token = accepted.body.token
      assert.equal((await request(old, identity, `/file?id=${manifest.id}&token=${token}&index=0&offset=${prefix.length}`, { stream: outgoing => outgoing.end(bytes.subarray(prefix.length)) }).result).status, 200)
      assert.equal((await request(old, identity, `/complete?id=${manifest.id}&token=${token}`).result).status, 200)
      task = JSON.parse(await fs.readFile(stateFile, 'utf8')).tasks.find(t => t.manifest?.id === manifest.id)
      assert.equal(task.view.status, 'completed'); assert.equal(hash(await fs.readFile(task.files[0])), hash(bytes))
      report.activeUpload = { prefixBytes: prefix.length, bytes: bytes.length, sha256: hash(bytes) }
      await sender.dispose(); sender = undefined; await close()
    })
    await scenario('menu cancellation joins a pending native receive dialog before durable handback', async () => {
      await start(); await toolbox('lanEnable', true); const held = await begin()
      sender = lan.createLanService({ storage: path.join(toolsRoot, 'cancel-peer'), downloads: toolsRoot, host: '127.0.0.1', name: 'Cancel peer', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => false })
      await sender.enable(true); const connecting = sender.connect('127.0.0.1', held.ready.port); connecting.catch(() => {})
      await nativeDialog(held.pid, '局域网设备配对', 'click', '配对码一致，继续'); await connecting
      const identity = JSON.parse(await fs.readFile(path.join(toolsRoot, 'cancel-peer/identity.json'), 'utf8'))
      const offer = request(held.ready, identity, '/offer', { value: { id: randomUUID(), name: '取消接收', entries: [], directories: [], text: '取消仍需排空原生窗口' } })
      await nativeDialog(held.pid, '接收局域网内容'); await finish(true); await offer.result.catch(() => {})
      assert.equal((await toolbox('lanSnapshot')).enabled, true); await sender.dispose(); sender = undefined; await close()
    })
    await scenario('actual native SIGKILL retains the fence and blocks workspace and LAN until explicit recovery', async () => {
      await start(); await toolbox('lanEnable', true); const held = await begin()
      await app.electronApp.evaluate(() => globalThis.__lanChildren.at(-1).kill('SIGKILL'))
      await waitFor(async () => (await notices()).some(n => n.kind === 'error'))
      assert.equal(await missing(fencePath()), false)
      await assert.rejects(api('loadWorkspace'), /原 LAN/); await assert.rejects(toolbox('lanSnapshot'), /原 LAN/)
      const findRecord = async directory => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
          if (!entry.isDirectory() || entry.name.startsWith('DustDesk-WebView2-')) continue
          const child = path.join(directory, entry.name)
          if (entry.name === held.fence.ownershipId && await fs.stat(path.join(child, 'OriginalLan')).then(() => true, () => false)) return path.join(child, 'OriginalLan')
          const found = await findRecord(child); if (found) return found
        }
      }
      const record = await findRecord(currentRoot); assert.ok(record)
      const unknown = path.join(record, 'test-unknown.bin'); await fs.writeFile(unknown, 'preserve unknown record', { flag: 'wx' })
      await app.electronApp.evaluate(() => { globalThis.__lanNotices = [] })
      await menu('recover-original-lan-preview')
      await waitFor(async () => (await notices()).some(n => n.title === '原 LAN 交还未恢复'))
      assert.equal(await missing(fencePath()), false); assert.equal(await fs.readFile(unknown, 'utf8'), 'preserve unknown record')
      await assert.rejects(api('loadWorkspace'), /原 LAN/)
      await fs.unlink(unknown)
      await recover()
      const released = (await messages()).find(m => m.event === 'originalLanReleased'); assert.equal(released.proof.kind, 'handback')
      report.killedOwnership = held.fence.ownershipId; await close()
    })
    await scenario('actual Electron SIGKILL triggers EOF drain; restart recovers the durable handback before any editor is created', async () => {
      const bootstrap = await start(); await toolbox('lanEnable', true); const held = await begin()
      const mainPid = await app.electronApp.evaluate(() => process.pid); process.kill(mainPid, 'SIGKILL')
      await waitFor(() => { try { process.kill(held.pid, 0); return false } catch (e) { assert.equal(e.code, 'ESRCH'); return true } }, 20000)
      await close(); assert.equal(await missing(fencePath()), false)
      app = await launchDustDesk({ tempRoot: currentRoot, bootstrap, startupTimeoutMs: 60000 })
      const startup = (await notices()).find(n => n.kind === 'startup'); assert.ok(startup); assert.equal(startup.windows, 0)
      assert.equal(await missing(fencePath()), true); assert.equal((await toolbox('lanSnapshot')).enabled, true)
      const released = (await messages()).find(m => m.event === 'originalLanReleased'); assert.equal(released.proof.kind, 'handback')
      await close()
    })
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async f => [f, await fileDigest(f)]))), report.inputs)
    assert.equal(await fileDigest('src-tauri/target/debug/DustDesk.exe'), report.executableSha256)
    report.verified = true
  } catch (error) {
    report.error = String(error.stack ?? error)
    if (currentRoot) report.startupErrors = await fs.readFile(path.join(currentRoot, 'startup-errors.jsonl'), 'utf8').catch(() => undefined)
    if (app) report.diagnostics = await app.electronApp.evaluate(() => ({ notices: globalThis.__lanNotices, messages: globalThis.__lanMessages, children: globalThis.__lanChildren.map(c => ({ pid: c.pid, code: c.exitCode, signal: c.signalCode })) })).catch(String)
    throw error
  } finally {
    if (app) await app.electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('cancel-legacy-source-snapshot')?.click()).catch(() => {})
    await sender?.dispose(); await close()
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(report, null, 2))
    for (const cb of cleanup.reverse()) await cb()
    for (const root of roots) { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^dustdesk-runtime-preview-[A-Za-z0-9]+$/); assert.equal((await fs.lstat(root)).isSymbolicLink(), false); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
  }
})
