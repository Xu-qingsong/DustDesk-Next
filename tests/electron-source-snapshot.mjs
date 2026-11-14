import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rm, rename, readdir, open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { waitFor } from './tauri-harness.mjs'
import { draftModuleUrl } from './draft-module.mjs'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

const { verifyDraftArchive } = await import(draftModuleUrl)
const directory = 'artifacts/tauri-migration/electron-source-snapshot-native'
const reportPath = path.join(directory, 'report.json')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(directory, { recursive: true }); await rm(reportPath, { force: true })
await test('real Electron maintenance prepares source-bound native snapshots and drains cancellation without taking over production', { timeout: 300000 }, async suite => {
  let app = await launchDustDesk(), failed = false
  const root = app.tempRoot, installation = path.join(root, '旧安装 # & v1'), outputs = path.join(root, 'snapshots')
  const archive = path.join(installation, 'resources', 'app.asar')
  const location = pathToFileURL(path.join(archive, 'out', 'renderer', 'index.html')).href
  const key = 'widget-note:legacy-source-snapshot'
  const value = JSON.stringify({ title: '真实旧来源草稿🪶', text: '分块原文'.repeat(20000), previousTitle: '原标题', previousText: '原正文' })
  const entries = { [key]: value, 'widget-task-draft:v1:todo': JSON.stringify({ title: '旧任务', requestId: 'source-snapshot-task' }), 'quick-capture-draft': JSON.stringify({ kind: 'note', title: '旧快速记录', text: '不执行旧程序', requestId: 'source-snapshot-capture' }), 'access-token': 'must-not-export', 'other-cache': 'must-not-export' }
  const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), scenarios: [], evidence: {}, pending: ['retained-source-target-guards-through-real-cutover', 'historical-profile-authentication', 'trusted-helper-distribution', 'production-cutover-and-full-rollback', 'real-system-folder-dialog', 'physical-network-and-release-acceptance'] }
  const scenario = async (name, callback) => {
    await suite.test(name, async () => { try { await callback(); report.scenarios.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Source snapshot scenario failed: ' + name)
  }
  const api = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
  const toolbox = (method, ...args) => app.window.evaluate(({ method, args }) => { if (method === 'importImage') args[0] = new Uint8Array(args[0]); return window.dustdesk.toolbox[method](...args) }, { method, args })
  const results = () => app.electronApp.evaluate(() => globalThis.__snapshotResults)
  const menu = () => app.electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('prepare-legacy-source-snapshot').click())
  const run = async mode => {
    const before = (await results()).length
    await app.electronApp.evaluate((_electron, mode) => { globalThis.__snapshotMode = mode }, mode)
    await menu()
    return waitFor(async () => (await results())[before], 60000)
  }
  let identity, image, originalWorkspace, task
  const clean = async enabled => {
    await waitFor(() => app.window.evaluate(() => !document.documentElement.inert))
    await waitFor(() => task.evaluate(() => !document.documentElement.inert))
    assert.equal(await task.getByLabel('桌面新增任务').inputValue(), '当前来源未提交任务保留')
    await waitFor(() => app.electronApp.evaluate(({ Menu }) => !Menu.getApplicationMenu().getMenuItemById('cancel-legacy-source-snapshot').enabled))
    assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.protocol.isProtocolHandled('file')), false)
    assert.equal(await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(window => window.webContents.getURL() === globalThis.__snapshotLocation).length), 0)
    assert.equal(await app.electronApp.evaluate(() => globalThis.__snapshotHelpers.every(child => child.exitCode !== null || child.signalCode !== null)), true)
    assert.equal((await toolbox('lanSnapshot')).enabled, enabled)
    assert.equal(digest(await readFile(path.join(root, 'user-data', 'LanTransfers', 'identity.json'))), identity)
    assert.deepEqual(await readFile(path.join(root, 'data', 'workspace.json')), originalWorkspace)
    const writer = await open(path.join(root, 'data', 'Assets', 'raw.bin'), 'r+'); await writer.close()
    for (const file of await app.electronApp.evaluate(() => globalThis.__snapshotTargetPaths)) { const writer = await open(file, 'r+'); await writer.close() }
    assert.deepEqual(Array.from(await toolbox('readAsset', image.id)), Array.from(Buffer.from(image.base64, 'base64')))
  }
  try {
    const reference = await extractOfficialLegacyReference(root); await rename(reference.root, installation)
    report.evidence.officialRelease = reference.release
    report.evidence.helperSha256 = await fileDigest('src-tauri/target/debug/DustDesk.exe')
    await mkdir(outputs)
    await app.electronApp.evaluate(async ({ BrowserWindow }, options) => {
      const owner = BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('widget='))
      const session = owner.webContents.session
      const reader = new BrowserWindow({ show: false, webPreferences: { session, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      session.protocol.handle('file', request => request.url === options.location ? new Response('<!doctype html><title>Controlled storage seed</title>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "default-src 'none'; script-src 'none'" } }) : session.fetch(request, { bypassCustomProtocolHandlers: true }))
      try { await reader.loadURL(options.location); await reader.webContents.executeJavaScript('for (const [key, value] of Object.entries(' + JSON.stringify(options.entries) + ')) localStorage.setItem(key, value)'); session.flushStorageData() }
      finally { reader.destroy(); session.protocol.unhandle('file') }
    }, { location, entries })
    const child = app.electronApp.process()
    const quit = app.electronApp.evaluate(({ app }) => app.quit()).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
    await waitFor(() => child.exitCode !== null, 25000); await quit; assert.equal(child.exitCode, 0)
    await closeDustDesk({ ...app, preserveTempRoot: true })
    const bootstrap = path.join(root, 'source-snapshot-bootstrap.cjs')
    await writeFile(bootstrap, `
const https = require('node:https'), originalServer = https.createServer;
https.createServer = (...args) => { const server = originalServer(...args), listen = server.listen; server.listen = function(port, host, callback) { return listen.call(this, port, '127.0.0.1', callback); }; return server; };
const dgram = require('node:dgram'), originalSocket = dgram.createSocket;
dgram.createSocket = (...args) => { const socket = originalSocket(...args), bind = socket.bind; socket.bind = function(port, callback) { return bind.call(this, 0, '127.0.0.1', callback); }; socket.send = (...values) => { const callback = values.at(-1); if (typeof callback === 'function') queueMicrotask(() => callback(null)); }; return socket; };
globalThis.__snapshotHelpers = []; globalThis.__snapshotNative = []; globalThis.__snapshotAssetPins = []; globalThis.__snapshotTargetPins = []; globalThis.__snapshotTargetPaths = []; globalThis.__snapshotFs = require('node:fs');
const processes = require('node:child_process'), originalSpawn = processes.spawn;
processes.spawn = (...args) => {
  const child = originalSpawn(...args);
  if (args[1]?.includes('--legacy-source-snapshot-v1')) {
    globalThis.__snapshotHelpers.push(child); let buffer = '', binding, targetPaths = []; const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    child.stdout.on('data', bytes => {
      buffer += decoder.write(bytes);
      for (;;) {
        const end = buffer.indexOf('\\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        globalThis.__snapshotNative.push(message);
        if (message.event === 'ready') binding = message.binding;
        if (message.event === 'prepared') {
          const path = require('node:path'), identity = binding.dataIdentity;
          const record = path.join(${JSON.stringify(path.join(root, 'user-data', 'LegacySnapshotPreparation'))}, identity.volume.toString(16).padStart(16, '0') + '-' + identity.index, message.id);
          const destination = JSON.parse(globalThis.__snapshotFs.readFileSync(path.join(record, 'intent.json'), 'utf8')).destination;
          targetPaths = ['handoff.json', 'browser-drafts.json', 'Data/snapshot.json', ...globalThis.__snapshotFs.readdirSync(path.join(destination, 'Data', 'objects')).map(name => 'Data/objects/' + name)].map(name => path.join(destination, name));
          if (globalThis.__snapshotFs.existsSync(path.join(destination, 'lan-state.json'))) targetPaths.push(path.join(destination, 'lan-state.json'));
          targetPaths.push(path.join(record, 'intent.json'), path.join(record, 'decision.json'));
        }
        if (message.event === 'verifiedPrepared') {
          let denied = false, descriptor;
          try { descriptor = globalThis.__snapshotFs.openSync(${JSON.stringify(path.join(root, 'data', 'Assets', 'raw.bin'))}, 'r+'); } catch { denied = true; }
          if (descriptor !== undefined) globalThis.__snapshotFs.closeSync(descriptor);
          globalThis.__snapshotAssetPins.push(denied);
          globalThis.__snapshotTargetPins.push(targetPaths.map(path => {
            let descriptor, denied = false;
            try { descriptor = globalThis.__snapshotFs.openSync(path, 'r+'); } catch { denied = true; }
            if (descriptor !== undefined) globalThis.__snapshotFs.closeSync(descriptor);
            return { path, denied };
          }));
          globalThis.__snapshotTargetPaths.push(...targetPaths);
        }
        if (message.event === 'prepared' && globalThis.__snapshotMode === 'cancel-prepared') { globalThis.__snapshotMode = 'success'; require('electron').Menu.getApplicationMenu().getMenuItemById('cancel-legacy-source-snapshot').click(); }
      }
    });
  }
  return child;
};
require(${JSON.stringify(path.resolve('out/main/index.js'))});
`)
    app = await launchDustDesk({ tempRoot: root, bootstrap })
    await app.electronApp.evaluate(({ dialog, ipcMain, Menu }, options) => {
      globalThis.__snapshotLocation = options.location; globalThis.__snapshotResults = []; globalThis.__snapshotReaders = []; globalThis.__snapshotMode = 'success'
      dialog.showOpenDialog = async (...args) => {
        const parent = args.at(-1).title.includes('保存位置')
        return { canceled: parent && globalThis.__snapshotMode === 'cancel-picker', filePaths: [parent ? options.outputs : options.installation] }
      }
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        if (options.title === '准备来源组合快照（不切换）') return { response: 1 }
        globalThis.__snapshotResults.push({ kind: 'message', ...options }); return { response: 0 }
      }
      dialog.showErrorBox = (title, message) => globalThis.__snapshotResults.push({ kind: 'error', title, message })
      ipcMain.on('draft-reader:ready', event => {
        const preferences = event.sender.getLastWebPreferences()
        globalThis.__snapshotReaders.push({ sandbox: preferences.sandbox, contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration })
        if (globalThis.__snapshotMode === 'kill-reader') globalThis.__snapshotHelpers.at(-1).kill()
        if (globalThis.__snapshotMode === 'cancel-reader') Menu.getApplicationMenu().getMenuItemById('cancel-legacy-source-snapshot').click()
      })
    }, { installation, outputs, location })
    const state = await api('loadWorkspace'); state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false
    assert.equal((await api('saveWorkspace', state)).ok, true)
    assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true)
    task = await waitFor(() => app.electronApp.windows().find(page => page.url().includes('widget=todo')))
    await task.getByLabel('桌面新增任务').fill('当前来源未提交任务保留')
    await mkdir(path.join(root, 'data', 'Assets', '空目录'), { recursive: true })
    await writeFile(path.join(root, 'data', 'Assets', 'raw.bin'), Buffer.from([0, 255, 13, 10]))
    const base64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII='
    image = { ...await toolbox('importImage', Array.from(Buffer.from(base64, 'base64')), 'retained.png'), base64 }
    await toolbox('lanEnable', true)
    assert.equal((await toolbox('lanSnapshot')).enabled, true)
    identity = digest(await readFile(path.join(root, 'user-data', 'LanTransfers', 'identity.json')))
    originalWorkspace = await readFile(path.join(root, 'data', 'workspace.json'))
    await scenario('actual persisted old-origin drafts, Data, lineage and original LAN are composed without exporting identity or switching production', async () => {
      const lan = await readFile(path.join(root, 'user-data', 'LanTransfers', 'state.json'))
      const result = await run('success'); assert.equal(result.kind, 'message', result.message); assert.equal(result.title, '来源组合快照已准备（未切换）')
      await clean(true)
      const destination = result.detail.split('\n')[0]
      const verified = await verifyDraftArchive(await readFile(path.join(destination, 'browser-drafts.json'), 'utf8'))
      const exported = Object.fromEntries(verified.payload.entries.map(entry => [entry.key, entry.value]))
      const actualTask = await task.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo'))
      const expected = { ...entriesWithoutSecrets(entries), 'widget-task-draft:v1:todo': actualTask }
      assert.equal(JSON.parse(actualTask).title, '当前来源未提交任务保留')
      assert.equal(JSON.parse(actualTask).requestId, 'source-snapshot-task')
      assert.deepEqual(Object.keys(exported).sort(), Object.keys(expected).sort())
      for (const [entryKey, entryValue] of Object.entries(expected)) assert.equal(digest(exported[entryKey]), digest(entryValue), entryKey)
      report.evidence.sharedPreparedSessionFileOriginObserved = true
      assert.deepEqual(await readFile(path.join(destination, 'lan-state.json')), lan)
      assert.deepEqual((await readdir(destination)).sort(), ['Data', 'browser-drafts.json', 'handoff.json', 'lan-state.json'])
      const manifest = JSON.parse(await readFile(path.join(destination, 'handoff.json'), 'utf8'))
      assert.ok(manifest.components.source.lanStorageIdentity)
      assert.equal(manifest.components.source.workspaceSha256, digest(originalWorkspace))
      const prepared = await app.electronApp.evaluate(() => globalThis.__snapshotNative.find(message => message.event === 'prepared'))
      assert.equal(digest(await readFile(path.join(destination, 'handoff.json'))), prepared.receipt.manifestSha256)
      const data = JSON.parse(await readFile(path.join(destination, 'Data', 'snapshot.json'), 'utf8'))
      assert.ok(data.entries.some(entry => entry.kind === 'directory' && entry.path === 'Assets/空目录'))
      const lineageEntry = data.entries.find(entry => entry.path === 'MigrationLineage/lineage.json')
      assert.ok(lineageEntry)
      const lineage = JSON.parse(await readFile(path.join(destination, 'Data', 'objects', String(lineageEntry.object).padStart(6, '0') + '.bin'), 'utf8'))
      assert.ok(lineage.exports.some(entry => entry.archiveId === verified.payload.id))
      for (const entry of data.entries.filter(entry => entry.kind === 'file')) assert.equal(digest(await readFile(path.join(destination, 'Data', 'objects', String(entry.object).padStart(6, '0') + '.bin'))), entry.sha256)
      report.evidence.rawDraftBytes = Buffer.byteLength(await readFile(path.join(destination, 'browser-drafts.json'), 'utf8'))
      report.evidence.originalIdentitySha256 = identity
    })
    await scenario('modified official ASAR is rejected before any private browser read and original LAN resumes', async () => {
      const fs = await import('node:fs/promises'), handle = await fs.open(archive, 'r+'), beforeReaders = await app.electronApp.evaluate(() => globalThis.__snapshotReaders.length), before = await readdir(outputs)
      const byte = Buffer.alloc(1); await handle.read(byte, 0, 1, 1024)
      try { await handle.write(Buffer.from([byte[0] ^ 1]), 0, 1, 1024); await handle.close(); const result = await run('success'); assert.equal(result.kind, 'error'); assert.match(result.message, /认证|摘要|受信|正式|校验/); await clean(true); assert.equal(await app.electronApp.evaluate(() => globalThis.__snapshotReaders.length), beforeReaders); assert.deepEqual(await readdir(outputs), before) }
      finally { const restore = await fs.open(archive, 'r+'); await restore.write(byte, 0, 1, 1024); await restore.close(); await handle.close().catch(() => {}) }
    })
    for (const mode of ['kill-reader', 'cancel-reader']) await scenario(mode + ' drains native cleanup before editors, protocol and original LAN resume', async () => {
      const before = await readdir(outputs), result = await run(mode)
      assert.equal(result.kind, 'error'); assert.equal(result.title, '来源组合快照未完成核验'); await clean(true); assert.deepEqual(await readdir(outputs), before)
    })
    await scenario('retry waits for every real editor before LAN suspension or native source binding, then creates a verified preparation', async () => {
      await task.evaluate(() => { window.__snapshotEntered = false; window.__snapshotStop = window.dustdesk.onBeforeQuit(async () => { window.__snapshotEntered = true; await new Promise(resolve => { window.__snapshotContinue = resolve }) }) })
      const helpers = await app.electronApp.evaluate(() => globalThis.__snapshotHelpers.length)
      const pending = run('success')
      try {
        await waitFor(() => task.evaluate(() => window.__snapshotEntered))
        for (const page of [app.window, task]) assert.equal(await page.evaluate(() => document.documentElement.inert), true)
        assert.equal(await app.electronApp.evaluate(() => globalThis.__snapshotHelpers.length), helpers)
        assert.equal((await api('setWidgetVisibility', 'monitor', true)).ok, false)
      } finally { await task.evaluate(() => { window.__snapshotStop(); window.__snapshotContinue() }) }
      const result = await pending; assert.equal(result.kind, 'message', result.message); await clean(true)
    })
    await scenario('cancellation after native durable preparation preserves the decision and target without claiming success', async () => {
      const before = await readdir(outputs), result = await run('cancel-prepared')
      assert.equal(result.kind, 'error'); assert.match(result.message, /已落盘的原生决定/); await clean(true)
      const added = (await readdir(outputs)).filter(entry => !before.includes(entry)); assert.equal(added.length, 1)
      const manifest = JSON.parse(await readFile(path.join(outputs, added[0], 'handoff.json'), 'utf8'))
      assert.ok(manifest.components.source)
      const records = await readdir(path.join(root, 'user-data', 'LegacySnapshotPreparation'), { recursive: true })
      const decisions = records.filter(entry => entry.endsWith('.json'))
      const contents = await Promise.all(decisions.map(entry => readFile(path.join(root, 'user-data', 'LegacySnapshotPreparation', entry), 'utf8')))
      const intent = contents.find(text => JSON.parse(text).destination === path.join(outputs, added[0]))
      assert.ok(intent)
      const decision = contents.map(text => JSON.parse(text)).find(record => record.intentSha256 === digest(intent))
      assert.equal(decision.outcome.state, 'handoffPrepared')
      report.evidence.committedCancellationPreserved = true
    })
    await scenario('cancelling the output parent picker does not enter maintenance or spawn a helper', async () => {
      const before = (await results()).length, helpers = await app.electronApp.evaluate(() => globalThis.__snapshotHelpers.length), files = await readdir(outputs)
      await app.electronApp.evaluate(() => { globalThis.__snapshotMode = 'cancel-picker' }); await menu(); await new Promise(resolve => setTimeout(resolve, 250))
      assert.equal((await results()).length, before); assert.equal(await app.electronApp.evaluate(() => globalThis.__snapshotHelpers.length), helpers); assert.deepEqual(await readdir(outputs), files); await clean(true)
    })
    await scenario('an initialized but disabled original LAN remains disabled after successful preparation', async () => {
      await toolbox('lanEnable', false)
      const result = await run('success'); assert.equal(result.kind, 'message', result.message); await clean(false)
      const readers = await app.electronApp.evaluate(() => globalThis.__snapshotReaders)
      assert.ok(readers.length >= 5); assert.ok(readers.every(preferences => preferences.sandbox && preferences.contextIsolation && !preferences.nodeIntegration))
      report.evidence.controlledReaderCount = readers.length
      const pins = await app.electronApp.evaluate(() => globalThis.__snapshotAssetPins)
      assert.ok(pins.length >= 3); assert.ok(pins.every(Boolean))
      report.evidence.nativeVerifiedLiveAssetPins = pins.length
      const targetPins = await app.electronApp.evaluate(() => globalThis.__snapshotTargetPins)
      assert.equal(targetPins.length, pins.length); assert.ok(targetPins.every(paths => paths.length >= 7 && paths.every(pin => pin.denied)))
      report.evidence.nativeVerifiedTargetPins = targetPins.map(paths => paths.length)
    })
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally { report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2)); await closeDustDesk(app) }
})

function entriesWithoutSecrets(entries) {
  return Object.fromEntries(Object.entries(entries).filter(([key]) => key.startsWith('widget-') || key === 'quick-capture-draft'))
}
