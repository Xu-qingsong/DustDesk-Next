import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { createHash } from 'node:crypto'
import { chromium, _electron as electron } from 'playwright'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { waitFor } from './tauri-harness.mjs'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

const directory = 'artifacts/tauri-migration/electron-runtime-handback'
const sources = ['tests/reference/src/main/index.ts', 'tests/reference/src/main/legacySourceLease.ts', 'tests/reference/src/main/runtimeHandback.ts', 'tests/reference/src/main/draftMaintenance.ts', 'tests/reference/src/main/toolboxRuntime.ts', 'tests/reference/src/main/workspaceOwnership.ts', 'tests/electron-runtime-handback.mjs']
const digest = value => createHash('sha256').update(value).digest('hex')
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) })
const missing = file => fs.lstat(file).then(() => false, error => { if (error.code === 'ENOENT') return true; throw error })

test('Electron whole-runtime handback retains all-editor maintenance and a durable startup barrier across seal, real termination and read-only recovery', { timeout: 1200000 }, async suite => {
  const toolsRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-handback-tools-')), roots = [], port = await freePort()
  const report = { verified: false, startedAt: new Date().toISOString(), productionReady: false, migrationComplete: false, checks: [], sessions: [], scope: 'Actual Electron all-editor maintenance, durable whole-runtime admission fence before continueRuntime/LAN, final native WebView2 read, actual LAN drain, real host exit followed by independent native re-acquisition, sealed-host SIGKILL, pre-seal cancellation, zero-ordinary-window restart verification and rejection of changed assets. Latest Data changes are file fixtures. No original Data/Session application, ordinary Tauri editors, production cutover or full rollback.' }
  let app, browser, currentRoot, bootstrap, reference, failed = false
  const recordPath = () => path.join(currentRoot, 'user-data/RuntimeHandbackPreview.json')
  async function terminalPath(fence) {
    const parent = path.join(fence.userData, 'LegacySnapshotPreparation')
    const catalogs = (await fs.readdir(parent, { withFileTypes: true })).filter(e => e.isDirectory())
    assert.equal(catalogs.length, 1)
    return path.join(parent, catalogs[0].name, fence.preparationId, 'RuntimePreparation', fence.runtimeId, 'Ownership', fence.ownershipId, 'RuntimeHandback')
  }
  const api = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const toolbox = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk.toolbox[method](...args), { method, args })
  const menu = id => app.electronApp.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id)
  const state = () => app.electronApp.evaluate(() => ({ messages: globalThis.__wholeMessages, notices: globalThis.__wholeNotices, ready: !!globalThis.__wholeDialog, children: globalThis.__wholeChildren.map(c => ({ pid: c.pid, code: c.exitCode, signal: c.signalCode })) }))
  async function close() {
    if (browser) { await browser.close().catch(() => {}); browser = undefined }
    if (app) {
      report.sessions.push(await state().catch(error => ({ terminated: String(error) })))
      await closeDustDesk({ ...app, preserveTempRoot: true }); app = undefined
    }
  }
  async function start({ enabled = false, killAfterSeal = false } = {}) {
    currentRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-runtime-preview-')); roots.push(currentRoot)
    bootstrap = path.join(currentRoot, 'whole-runtime.cjs')
    await fs.writeFile(bootstrap, `
const electron = require('electron'), fs = require('node:fs');
const log = value => fs.appendFileSync(${JSON.stringify(path.join(currentRoot, 'events.jsonl'))}, JSON.stringify(value) + '\\n');
const https = require('node:https'), createServer = https.createServer;
https.createServer = (...args) => { const server = createServer(...args), listen = server.listen; server.listen = function(port, host, callback) { return listen.call(this, port, '127.0.0.1', callback); }; return server; };
const dgram = require('node:dgram'), createSocket = dgram.createSocket;
dgram.createSocket = (...args) => { const socket = createSocket(...args), bind = socket.bind; socket.bind = function(port, callback) { return bind.call(this, 0, '127.0.0.1', callback); }; socket.send = (...args) => { if (typeof args.at(-1) === 'function') queueMicrotask(() => args.at(-1)(null)); }; return socket; };
globalThis.__wholeMessages = []; globalThis.__wholeNotices = []; globalThis.__wholeChildren = []; globalThis.__wholeDialog = undefined; globalThis.__wholeKillAfterSeal = ${killAfterSeal};
const processes = require('node:child_process'), spawn = processes.spawn;
processes.spawn = (...args) => {
  const runtime = args[1]?.includes('--legacy-runtime-preview-v1');
  if (runtime) args[2] = { ...args[2], env: { ...process.env, ...args[2]?.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=${port}' } };
  const child = spawn(...args);
  if (runtime) {
    globalThis.__wholeChildren.push(child); let buffer = ''; const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    const write = child.stdin.write.bind(child.stdin); child.stdin.write = (...args) => { try { log({ command: JSON.parse(String(args[0])), fenceExists: fs.existsSync(${JSON.stringify(path.join(currentRoot, 'user-data/RuntimeHandbackPreview.json'))}) }); } catch {} return write(...args); };
    child.stdout.on('data', b => { buffer += decoder.write(b); for (;;) { const n = buffer.indexOf('\\n'); if (n < 0) break; const line = buffer.slice(0, n); buffer = buffer.slice(n + 1); try { const message = JSON.parse(line); globalThis.__wholeMessages.push(message); log({ message }); if (message.event === 'runtimeHandbackSealed' && globalThis.__wholeKillAfterSeal) { globalThis.__wholeKillAfterSeal = false; child.kill('SIGKILL'); } } catch {} } });
    child.on('close', (code, signal) => log({ childClosed: child.pid, code, signal }));
  }
  return child;
};
electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(reference.root)}] });
electron.dialog.showErrorBox = (title, message) => { const notice = { title, message, kind: 'error' }; globalThis.__wholeNotices.push(notice); log({ notice }); };
electron.dialog.showMessageBox = async (...args) => {
  const o = args.at(-1);
  if (o.title === '验证整体运行交还') return { response: 1 };
  if (o.title === '隔离整体运行已就绪') return new Promise(resolve => { const end = () => { o.signal.removeEventListener('abort', end); globalThis.__wholeDialog = undefined; resolve({ response: 0 }); }; globalThis.__wholeDialog = { end }; o.signal.addEventListener('abort', end, { once: true }); if (o.signal.aborted) end(); });
  if (o.title === '整体运行交还待应用') { const notice = { title: o.title, windows: electron.BrowserWindow.getAllWindows().length, kind: 'startup' }; globalThis.__wholeNotices.push(notice); log({ notice }); return new Promise(resolve => { globalThis.__wholeStartupResolve = resolve; }); }
  if (o.title === '整体交还已核验（保持暂停）' && globalThis.__wholeStartupResolve) { const notice = { title: o.title, kind: 'verified-startup' }; globalThis.__wholeNotices.push(notice); log({ notice }); return new Promise(resolve => { globalThis.__wholeFinalResolve = resolve; }); }
  const notice = { title: o.title, message: o.message, kind: 'message' }; globalThis.__wholeNotices.push(notice); log({ notice }); return { response: 0 };
};
require(${JSON.stringify(path.resolve('out/main/index.js'))});
`)
    app = await launchDustDesk({ tempRoot: currentRoot, bootstrap })
    const saved = await api('loadWorkspace'); saved.Settings.ClipboardMonitoringEnabled = false; saved.Settings.AutomaticBackupEnabled = false
    assert.equal((await api('saveWorkspace', saved)).ok, true)
    assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true)
    const widget = await waitFor(() => app.electronApp.windows().find(p => p.url().includes('widget=todo')))
    await widget.getByLabel('桌面新增任务').fill('整体交还前实际编辑器待保存🪶')
    await app.window.evaluate(() => localStorage.setItem('widget-note:whole-runtime', '{"title":"","text":"原始草稿🪶","previousTitle":"","previousText":""}'))
    if (enabled) await toolbox('lanEnable', true)
    return widget
  }
  async function begin() {
    await menu('preview-runtime-handback')
    await waitFor(async () => { const s = await state(); assert.equal(s.notices.some(n => n.kind === 'error'), false, JSON.stringify(s.notices)); return s.ready }, 90000)
    const fence = JSON.parse(await fs.readFile(recordPath(), 'utf8'))
    const s = await state(), ready = s.messages.find(m => m.event === 'runtimeOriginalLanReady')
    assert.equal(fence.ownershipId, ready.ownershipId)
    assert.equal(await app.window.evaluate(() => document.documentElement.inert), true)
    await assert.rejects(api('loadWorkspace'), /整体运行交还/)
    await assert.rejects(toolbox('lanSnapshot'), /整体运行交还/)
    const events = (await fs.readFile(path.join(currentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    for (const event of events.filter(e => ['continueRuntime', 'startOriginalLan'].includes(e.command?.action))) assert.equal(event.fenceExists, true)
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
    const page = await waitFor(() => browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('runtime-import.html')))
    return { fence, ready, page }
  }
  async function remainsFrozen() {
    assert.equal(await missing(recordPath()), false)
    assert.equal(await app.window.evaluate(() => document.documentElement.inert), true)
    await assert.rejects(api('loadWorkspace'), /整体运行交还/)
    await assert.rejects(toolbox('lanSnapshot'), /整体运行交还/)
  }
  async function recover() {
    await app.electronApp.evaluate(() => { globalThis.__wholeNotices = [] })
    await menu('recover-runtime-handback')
    await waitFor(async () => { const s = await state(); assert.equal(s.notices.some(n => n.kind === 'error'), false, JSON.stringify(s.notices)); return s.notices.some(n => n.title === '整体交还已核验（保持暂停）') }, 90000)
    await remainsFrozen()
  }
  async function restart({ rejects = false } = {}) {
    await close()
    const restarted = await electron.launch({ args: [bootstrap], env: { ...process.env, DUSTDESK_TEST_DATA_DIR: path.join(currentRoot, 'data'), DUSTDESK_TEST_USER_DATA_DIR: path.join(currentRoot, 'user-data'), DUSTDESK_TEST_DESKTOP_DIR: path.join(currentRoot, 'desktop'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
    app = { electronApp: restarted, tempRoot: currentRoot }
    await waitFor(async () => (await state()).notices.some(n => n.kind === 'startup'), 30000)
    const startup = (await state()).notices.find(n => n.kind === 'startup'); assert.equal(startup.windows, 0)
    assert.equal(await restarted.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 0)
    await restarted.evaluate(() => globalThis.__wholeStartupResolve({ response: 1 }))
    await waitFor(async () => { const s = await state(); return s.notices.some(n => n.kind === (rejects ? 'error' : 'verified-startup')) }, 90000)
    const s = await state()
    assert.equal(s.messages.some(m => m.event === 'runtimeBrowserStarting'), false)
    assert.equal(await missing(recordPath()), false)
    if (!rejects) {
      assert.equal(s.messages.some(m => m.event === 'runtimeHandbackRecovered'), true)
      assert.ok(s.children.every(c => c.code === 0 && c.signal === null))
      report.restart = { ordinaryWindowsAtPrompt: startup.windows, nativeRecovery: true }
      await restarted.evaluate(() => globalThis.__wholeFinalResolve({ response: 0 })).catch(() => {})
      await restarted.close().catch(() => {}); app = undefined
    } else {
      report.changedAssetRejection = s.notices.find(n => n.kind === 'error')
      assert.equal(s.messages.some(m => m.event === 'runtimeHandbackRecovered'), false)
      await close()
    }
  }
  async function scenario(name, run) {
    await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Whole-runtime desktop scenario failed: ' + name)
  }
  try {
    await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async f => [f, await fileDigest(f)])))
    report.executable = { path: 'src-tauri/target/debug/DustDesk.exe', sha256: await fileDigest('src-tauri/target/debug/DustDesk.exe') }
    reference = await extractOfficialLegacyReference(toolsRoot); report.reference = reference.release
    await scenario('real all-editor flush, LAN drain, final native browser seal and independent receiver verification keep original Data and Session frozen across restart', async () => {
      const widget = await start({ enabled: true }), held = await begin()
      assert.equal(await widget.evaluate(() => document.documentElement.inert), true)
      const original = await fs.readFile(path.join(currentRoot, 'data/workspace.json'))
      const drafts = '{ "title":"", "text":"最新原生浏览器草稿\\ud800🪶", "previousTitle":"", "previousText":"" }'
      await held.page.evaluate(value => { localStorage.setItem('widget-note:whole-runtime', value); localStorage.setItem('widget-notes:selected', '') }, drafts)
      const latest = Buffer.from('{"SchemaVersion":3,"Notes":[],"Todos":[],"QuickNote":"最新整体 Data","unknown":{"kept":true}}\r\n')
      await fs.writeFile(path.join(held.fence.runtimePath, 'workspace.json'), latest)
      await fs.mkdir(path.join(held.fence.runtimePath, 'Assets/empty-latest'), { recursive: true })
      const asset = path.join(held.fence.runtimePath, 'Assets/latest.bin'); await fs.writeFile(asset, Buffer.from([0, 255, 13, 10]))
      await app.electronApp.evaluate(() => globalThis.__wholeDialog.end())
      await waitFor(async () => { const s = await state(); assert.equal(s.notices.some(n => n.kind === 'error'), false, JSON.stringify(s.notices)); return s.notices.some(n => n.title === '整体交还已封存（保持暂停）') }, 120000)
      const s = await state(), sealed = s.messages.find(m => m.event === 'runtimeHandbackSealed'), recovered = s.messages.find(m => m.event === 'runtimeHandbackRecovered')
      assert.deepEqual(recovered.receipt, sealed.receipt); assert.equal(sealed.receipt.workspaceSha256, digest(latest))
      assert.equal(s.children.length, 2); assert.ok(s.children.every(c => c.code === 0 && c.signal === null))
      const events = (await fs.readFile(path.join(currentRoot, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
      const hostClose = events.findIndex(e => e.childClosed === s.children[0].pid)
      assert.ok(hostClose >= 0 && events.findIndex(e => e.command?.action === 'recoverRuntimeHandback') > hostClose)
      const terminal = await terminalPath(held.fence)
      const names = (await fs.readdir(terminal)).sort(); assert.deepEqual(names, ['browser-drafts.json','data.json','decision.json','intent.json'])
      const terminalBytes = Object.fromEntries(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(terminal, name))])))
      assert.equal(digest(terminalBytes['data.json']), sealed.receipt.dataManifestSha256)
      assert.equal(digest(terminalBytes['browser-drafts.json']), sealed.receipt.drafts.archiveSha256)
      const archive = JSON.parse(terminalBytes['browser-drafts.json']), payload = JSON.parse(archive.payload)
      assert.equal(digest(archive.payload), archive.sha256)
      assert.equal(payload.entries.find(e => e.key === 'widget-note:whole-runtime').value, drafts)
      assert.equal(payload.entries.find(e => e.key === 'widget-notes:selected').value, '')
      assert.ok(s.messages.some(m => m.event === 'runtimeOriginalLanHandedBack'))
      await assert.rejects(new Promise((resolve, reject) => { const socket = net.createConnection({ host: '127.0.0.1', port: held.ready.port }); socket.on('error', reject); socket.on('connect', () => { socket.destroy(); resolve() }) }), { code: 'ECONNREFUSED' })
      await remainsFrozen()
      assert.deepEqual(await fs.readFile(path.join(currentRoot, 'data/workspace.json')), original)
      assert.equal(await app.window.evaluate(() => localStorage.getItem('widget-note:whole-runtime')), '{"title":"","text":"原始草稿🪶","previousTitle":"","previousText":""}')
      report.normal = { sealed: sealed.receipt, independentReceiverPid: s.children[1].pid, hostPid: s.children[0].pid, listenerClosed: true }
      await restart()
      assert.deepEqual(await fs.readFile(path.join(held.fence.runtimePath, 'workspace.json')), latest)
      for (const [name, before] of Object.entries(terminalBytes)) assert.deepEqual(await fs.readFile(path.join(terminal, name)), before)
      await fs.writeFile(asset, Buffer.from([1, 255, 13, 10]))
      await restart({ rejects: true })
    })
    await scenario('real SIGKILL after terminal decision preserves barrier and explicit read-only recovery never resumes old editors', async () => {
      await start({ killAfterSeal: true }); await begin()
      await app.electronApp.evaluate(() => globalThis.__wholeDialog.end())
      await waitFor(async () => (await state()).notices.some(n => n.kind === 'error'), 120000)
      const s = await state(); assert.ok(s.messages.some(m => m.event === 'runtimeHandbackSealed'))
      assert.equal(s.children[0].signal, 'SIGKILL'); await remainsFrozen(); await recover(); await close()
    })
    await scenario('cancellation before final seal retains persistent all-editor freeze and refuses to guess a missing terminal decision', async () => {
      await start(); const held = await begin(); await menu('cancel-legacy-source-snapshot')
      await waitFor(async () => (await state()).notices.some(n => n.kind === 'error'), 90000)
      await remainsFrozen(); await app.electronApp.evaluate(() => { globalThis.__wholeNotices = [] })
      await menu('recover-runtime-handback')
      await waitFor(async () => (await state()).notices.some(n => n.kind === 'error'), 90000)
      assert.equal((await state()).messages.some(m => m.event === 'runtimeHandbackRecovered'), false)
      await assert.rejects(fs.access(await terminalPath(held.fence)), { code: 'ENOENT' })
      await remainsFrozen(); await close()
    })
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async f => [f, await fileDigest(f)]))), report.inputs)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    await close()
    report.events = []
    for (const root of roots) {
      const events = path.join(root, 'events.jsonl')
      const target = path.join(directory, path.basename(root) + '-events.jsonl')
      if (!await missing(events)) { await fs.copyFile(events, target); report.events.push({ path: target, sha256: await fileDigest(target) }) }
      assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.match(path.basename(root), /^dustdesk-runtime-preview-/)
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
    await fs.rm(toolsRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  }
})
