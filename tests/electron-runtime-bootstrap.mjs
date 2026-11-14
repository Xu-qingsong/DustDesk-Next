import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir, open, rm, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { chromium } from 'playwright'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { waitFor } from './tauri-harness.mjs'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const { verifyDraftArchive } = await import(draftModuleUrl)
const directory = 'artifacts/tauri-migration/electron-runtime-bootstrap-native'
const reportPath = path.join(directory, 'verification.json')
const sources = ['tests/reference/src/main/index.ts', 'tests/reference/src/main/legacySourceLease.ts', 'tests/reference/src/main/draftMaintenance.ts', 'tests/reference/src/main/legacyDraftReader.ts', 'tests/reference/src/main/toolboxRuntime.ts', 'src-tauri/src/legacy_source/bridge.rs', 'src-tauri/src/workspace/runtime_boot.rs', 'tests/electron-runtime-bootstrap.mjs']
const digest = value => createHash('sha256').update(value).digest('hex')
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const port = await new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject)
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) })
})

test('actual Electron session and all-editor maintenance remain live through native runtime startup and drain before resuming', { timeout: 600000 }, async suite => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-runtime-preview-'))
  const report = { verified: false, productionReady: false, migrationComplete: false, startedAt: new Date().toISOString(), checks: [], scope: 'Actual prepared Electron Session, native trusted-source snapshot/runtime preparation, same-process Tauri browser import, all-editor freeze and original LAN suspension through end/cancel/helper death/participant reload/client death. Also rejects an ordinary isolated root before native launch. Isolated TEMP only, no new business services, original LAN takeover, production cutover or full rollback.' }
  await mkdir(directory, { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2))
  let app, widget, browser, failed = false, identity
  const scenario = async (name, action) => {
    await suite.test(name, async () => { try { await action(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Electron runtime scenario failed: ' + name)
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
    report.executable = { path: 'src-tauri/target/debug/DustDesk.exe', sha256: await fileDigest('src-tauri/target/debug/DustDesk.exe') }
    const reference = await extractOfficialLegacyReference(root)
    report.reference = reference.release
    const bootstrap = path.join(root, 'runtime-bootstrap.cjs')
    await writeFile(bootstrap, `
const https = require('node:https'), createServer = https.createServer;
https.createServer = (...args) => { const server = createServer(...args), listen = server.listen; server.listen = function(port, host, callback) { return listen.call(this, port, '127.0.0.1', callback); }; return server; };
const dgram = require('node:dgram'), createSocket = dgram.createSocket;
dgram.createSocket = (...args) => { const socket = createSocket(...args), bind = socket.bind; socket.bind = function(port, callback) { return bind.call(this, 0, '127.0.0.1', callback); }; socket.send = (...values) => { const callback = values.at(-1); if (typeof callback === 'function') queueMicrotask(() => callback(null)); }; return socket; };
globalThis.__runtimeChildren = []; globalThis.__runtimeMessages = [];
const processes = require('node:child_process'), spawn = processes.spawn;
processes.spawn = (...args) => {
  const runtime = args[1]?.includes('--legacy-runtime-preview-v1');
  if (runtime) args[2] = { ...args[2], env: { ...process.env, ...args[2]?.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=${port}' } };
  const child = spawn(...args);
  if (runtime) {
    globalThis.__runtimeChildren.push(child); let buffer = ''; const decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    child.stdout.on('data', bytes => { buffer += decoder.write(bytes); for (;;) { const end = buffer.indexOf('\\n'); if (end < 0) break; const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); try { globalThis.__runtimeMessages.push(JSON.parse(line)); } catch {} } });
  }
  return child;
};
require(${JSON.stringify(path.resolve('out/main/index.js'))});
`)
    app = await launchDustDesk({ tempRoot: root, bootstrap })
    const api = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk[method](...args), { method, args })
    const toolbox = (method, ...args) => app.window.evaluate(({ method, args }) => window.dustdesk.toolbox[method](...args), { method, args })
    await app.electronApp.evaluate(({ dialog }, installation) => {
      globalThis.__runtimeNotices = []; globalThis.__runtimeDialog = undefined
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [installation] })
      dialog.showMessageBox = async (...args) => {
        const options = args.at(-1)
        if (options.title === '验证隔离运行交接') return { response: 1 }
        if (options.title === '隔离运行草稿已核验') return new Promise(resolve => {
          const end = () => { options.signal.removeEventListener('abort', end); globalThis.__runtimeDialog = undefined; resolve({ response: 0 }) }
          globalThis.__runtimeDialog = { end }; options.signal.addEventListener('abort', end, { once: true })
          if (options.signal.aborted) end()
        })
        globalThis.__runtimeNotices.push({ ...options, kind: 'message' }); return { response: 0 }
      }
      dialog.showErrorBox = (title, message) => globalThis.__runtimeNotices.push({ title, message, kind: 'error' })
    }, reference.root)
    const state = await api('loadWorkspace')
    state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false
    assert.equal((await api('saveWorkspace', state)).ok, true)
    assert.equal((await api('setWidgetVisibility', 'todo', true)).ok, true)
    widget = await waitFor(() => app.electronApp.windows().find(page => page.url().includes('widget=todo')))
    await widget.getByLabel('桌面新增任务').fill('真实 Electron 编辑器待提交🪶')
    const noteKey = 'widget-note:runtime-session', note = JSON.stringify({ title: '真实 Session', text: '原始草稿保留\n🪶', previousTitle: '', previousText: '' })
    await app.window.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: noteKey, value: note })
    await mkdir(path.join(root, 'data', 'Assets'), { recursive: true })
    const asset = path.join(root, 'data', 'Assets', 'raw.bin')
    await writeFile(asset, Buffer.from([0, 255, 13, 10]))
    await toolbox('lanEnable', true)
    identity = digest(await readFile(path.join(root, 'user-data', 'LanTransfers', 'identity.json')))
    const menu = id => app.electronApp.evaluate(({ Menu }, id) => Menu.getApplicationMenu().getMenuItemById(id).click(), id)
    const begin = async () => {
      const before = await readdir(root)
      const previous = await api('loadWorkspace')
      await app.electronApp.evaluate(() => { globalThis.__runtimeMessages = []; globalThis.__runtimeNotices = [] })
      await menu('preview-legacy-runtime')
      await waitFor(async () => {
        const status = await app.electronApp.evaluate(() => ({ ready: !!globalThis.__runtimeDialog, notices: globalThis.__runtimeNotices }))
        assert.equal(status.notices.length, 0, JSON.stringify(status.notices))
        return status.ready
      }, 90000)
      browser = await chromium.connectOverCDP('http://127.0.0.1:' + port)
      const page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('runtime-import.html')))
      const added = (await readdir(root)).filter(name => !before.includes(name))
      const output = added.find(name => name.startsWith('DustDesk-runtime-')), snapshot = added.find(name => name.startsWith('DustDesk-source-snapshot-'))
      assert.ok(output); assert.ok(snapshot)
      const currentTask = await widget.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo'))
      assert.equal(await page.evaluate(key => localStorage.getItem(key), noteKey), note)
      assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), currentTask)
      const transaction = await readFile(path.join(root, output, 'MigrationTransaction.json'), 'utf8')
      assert.equal(JSON.parse(transaction).decision, 'commit'); assert.equal(JSON.parse(transaction).completed, true)
      assert.equal(await app.window.evaluate(() => document.documentElement.inert), true)
      assert.equal(await widget.evaluate(() => document.documentElement.inert), true)
      await assert.rejects(api('loadWorkspace'), /迁移维护/)
      await assert.rejects(api('saveWorkspace', previous), /迁移维护/)
      await assert.rejects(toolbox('lanSnapshot'), /迁移维护/)
      await assert.rejects(open(asset, 'r+'))
      const messages = await app.electronApp.evaluate(() => globalThis.__runtimeMessages)
      assert.ok(messages.some(message => message.event === 'runtimeBrowserReady' && message.businessServicesStarted === false))
      assert.equal((await app.electronApp.evaluate(() => globalThis.__runtimeChildren.at(-1).exitCode)), null)
      return { output: path.join(root, output), snapshot: path.join(root, snapshot), currentTask, transaction }
    }
    const restored = async (held, expected) => {
      const result = await waitFor(() => app.electronApp.evaluate(() => globalThis.__runtimeNotices.at(-1)), 15000)
      assert.equal(result.kind, expected, JSON.stringify(result))
      await waitFor(() => app.window.evaluate(() => !document.documentElement.inert))
      await waitFor(() => widget.evaluate(() => !document.documentElement.inert))
      assert.equal(await app.electronApp.evaluate(() => globalThis.__runtimeChildren.every(child => child.exitCode !== null || child.signalCode !== null)), true)
      assert.equal(await app.electronApp.evaluate(() => !!globalThis.__runtimeDialog), false)
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '真实 Electron 编辑器待提交🪶')
      const writer = await open(asset, 'r+'); await writer.close()
      assert.equal((await toolbox('lanSnapshot')).enabled, true)
      assert.equal(digest(await readFile(path.join(root, 'user-data', 'LanTransfers', 'identity.json'))), identity)
      assert.equal(await readFile(path.join(held.output, 'MigrationTransaction.json'), 'utf8'), held.transaction)
      const archive = await verifyDraftArchive(await readFile(path.join(held.snapshot, 'browser-drafts.json'), 'utf8'))
      const drafts = Object.fromEntries(archive.payload.entries.map(entry => [entry.key, entry.value]))
      assert.equal(drafts[noteKey], note); assert.equal(drafts['widget-task-draft:v1:todo'], held.currentTask)
      await browser.close().catch(() => {}); browser = undefined
      return result
    }
    await scenario('actual Session and widget drafts import while all old editors and original LAN stay frozen until explicit end', async () => {
      const held = await begin()
      await pause(500)
      assert.equal(await app.window.evaluate(() => document.documentElement.inert), true)
      await app.electronApp.evaluate(() => globalThis.__runtimeDialog.end())
      assert.equal((await restored(held, 'message')).title, '隔离运行验证已结束')
    })
    await scenario('menu cancellation revokes the running host and drains it before editor and original LAN recovery', async () => {
      const held = await begin(); await menu('cancel-legacy-source-snapshot')
      assert.match((await restored(held, 'error')).message, /取消/)
    })
    await scenario('unexpected native process death closes the held dialog and releases maintenance only after actual child exit', async () => {
      const held = await begin()
      await app.electronApp.evaluate(() => { globalThis.__runtimeChildren.at(-1).kill() })
      assert.match((await restored(held, 'error')).message, /提前退出/)
    })
    await scenario('participant reload cancels live ownership and preserves the completed native import and resumed widget draft', async () => {
      const held = await begin(); await widget.reload()
      assert.match((await restored(held, 'error')).message, /已关闭或重载/)
    })
    await scenario('real Electron process termination closes the source channel and permits the original Session and LAN to restart', async () => {
      const held = await begin()
      const nativePid = await app.electronApp.evaluate(() => globalThis.__runtimeChildren.at(-1).pid)
      const main = await app.electronApp.evaluate(() => ({ pid: process.pid, executable: process.execPath }))
      assert.equal(path.basename(main.executable).toLowerCase(), 'electron.exe')
      report.clientTermination = { launcherPid: app.electronApp.process().pid, mainPid: main.pid, executable: main.executable, nativePid }
      process.kill(main.pid, 'SIGKILL')
      await waitFor(() => {
        try { process.kill(main.pid, 0); return false }
        catch (error) { assert.equal(error.code, 'ESRCH'); return true }
      }, 5000)
      await waitFor(() => {
        try { process.kill(nativePid, 0); return false }
        catch (error) { assert.equal(error.code, 'ESRCH'); return true }
      }, 15000)
      await browser.close().catch(() => {}); browser = undefined
      const writer = await open(asset, 'r+'); await writer.close()
      assert.equal(await readFile(path.join(held.output, 'MigrationTransaction.json'), 'utf8'), held.transaction)
      await closeDustDesk({ ...app, preserveTempRoot: true }); app = undefined
      app = await launchDustDesk({ tempRoot: root, bootstrap })
      widget = await waitFor(() => app.electronApp.windows().find(page => page.url().includes('widget=todo')))
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '真实 Electron 编辑器待提交🪶')
      assert.equal((await toolbox('lanSnapshot')).enabled, true)
      assert.equal(digest(await readFile(path.join(root, 'user-data', 'LanTransfers', 'identity.json'))), identity)
      assert.equal(await app.window.evaluate(() => document.documentElement.inert), false)
    })
    await scenario('an ordinary data root is rejected before selecting an installation, freezing editors or launching a native helper', async () => {
      await closeDustDesk({ ...app, preserveTempRoot: true }); app = undefined
      const ordinaryRoot = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-test-'))
      const ordinaryBootstrap = path.join(ordinaryRoot, 'runtime-bootstrap.cjs')
      await writeFile(ordinaryBootstrap, await readFile(bootstrap))
      try {
        app = await launchDustDesk({ tempRoot: ordinaryRoot, bootstrap: ordinaryBootstrap })
        await app.electronApp.evaluate(({ dialog }) => {
          globalThis.__runtimeNotices = []; globalThis.__runtimePickers = 0
          dialog.showOpenDialog = async () => { ++globalThis.__runtimePickers; return { canceled: true, filePaths: [] } }
          dialog.showErrorBox = (title, message) => globalThis.__runtimeNotices.push({ title, message })
        })
        await menu('preview-legacy-runtime')
        const notice = await waitFor(() => app.electronApp.evaluate(() => globalThis.__runtimeNotices[0]))
        assert.match(notice.message, /专用 TEMP 根/)
        assert.equal(await app.electronApp.evaluate(() => globalThis.__runtimePickers), 0)
        assert.equal(await app.electronApp.evaluate(() => globalThis.__runtimeChildren.length), 0)
        assert.equal(await app.window.evaluate(() => document.documentElement.inert), false)
      } finally {
        if (app) { await closeDustDesk(app); app = undefined }
        assert.equal(path.dirname(path.resolve(ordinaryRoot)), path.resolve(os.tmpdir()))
        assert.match(path.basename(ordinaryRoot), /^dustdesk-electron-test-[A-Za-z0-9]+$/)
        assert.equal((await lstat(ordinaryRoot).catch(error => { if (error.code === 'ENOENT') return undefined; throw error }))?.isSymbolicLink() ?? false, false)
        await rm(ordinaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      }
    })
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs)
    assert.equal(await fileDigest(report.executable.path), report.executable.sha256)
    report.verified = true
  } catch (error) {
    report.error = String(error.stack ?? error)
    if (app) report.diagnostics = await app.electronApp.evaluate(() => ({ notices: globalThis.__runtimeNotices, messages: globalThis.__runtimeMessages, children: globalThis.__runtimeChildren.map(child => ({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode })) })).catch(error => String(error))
    throw error
  } finally {
    await browser?.close().catch(() => {})
    if (app) {
      await app.electronApp.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('cancel-legacy-source-snapshot').click()).catch(() => {})
      await closeDustDesk({ ...app, preserveTempRoot: true })
    }
    report.finishedAt = new Date().toISOString(); await writeFile(reportPath, JSON.stringify(report, null, 2))
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.match(path.basename(root), /^dustdesk-runtime-preview-[A-Za-z0-9]+$/)
    assert.equal((await lstat(root)).isSymbolicLink(), false)
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
