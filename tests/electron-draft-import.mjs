import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { createConnection } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { _electron as electron } from 'playwright'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'
import { recordDraftProvenance } from './draft-lineage-module.mjs'
import { draftModuleUrl } from './draft-module.mjs'
import { waitFor } from './tauri-harness.mjs'
import { toolboxModules } from './toolbox-fixture.mjs'

const migration = await import(draftModuleUrl)
const execute = promisify(execFile)
const digest = value => createHash('sha256').update(value).digest('hex')
const reportPath = 'artifacts/tauri-migration/electron-draft-import-native.json'
const sources = ['tests/reference/src/main/draftImport.ts', 'tests/reference/src/main/draftMaintenance.ts', 'tests/reference/src/main/draftBrowser.ts', 'tests/reference/src/main/draftStartup.ts', 'tests/reference/src/main/draftTransaction.ts', 'tests/reference/src/main/index.ts', 'tests/reference/src/main/toolboxRuntime.ts', 'tests/reference/src/main/lanTransfer.ts', 'tests/reference/src/main/productivityRuntime.ts', 'tests/reference/src/preload/index.ts', 'tests/reference/src/preload/draftControl.ts', 'src/shared/draftMigration.ts', 'tests/electron-draft-import.mjs', 'tests/electron-harness.mjs']
const portOpen = port => new Promise((resolve, reject) => {
  const socket = createConnection({ host: '127.0.0.1', port })
  socket.once('connect', () => { socket.destroy(); resolve(true) }); socket.once('error', () => resolve(false))
  socket.setTimeout(2000, () => { socket.destroy(); reject(Error('LAN port probe timed out')) })
})

test('Electron product menu imports native-provenance drafts under every editor gate and startup recovers before ordinary APIs', { timeout: 180000 }, async suite => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  const report = { verified: false, productionReady: false, migrationComplete: false, scenarios: [], scope: 'Real Electron product menu, actual localStorage/profile and native transaction files; file and import confirmation dialogs are intercepted, but the pending LAN pairing message box is real Windows UI. Archives use the shared Tauri format and native lineage helper, not a running Tauri exporter. Storage failures include an injected rename error and an actual Windows read-only file.' }
  const inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await fs.readFile(file))])))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-import-'))
  const data = path.join(root, 'data'), workspace = path.join(data, 'workspace.json'), transaction = path.join(data, 'ElectronMigrationTransaction.json')
  const destination = path.join(root, 'reverse-drafts.json')
  let app, rawApp, failed = false, archive, baseline, importedKey
  const scenario = async (name, run) => {
    await suite.test(name, async () => { try { await run(); report.scenarios.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Electron product import failed: ' + name)
  }
  const start = async () => { app = await launchDustDesk({ tempRoot: root }); return app }
  const stop = async () => { if (app) { const previous = app; app = undefined; await closeDustDesk({ ...previous, preserveTempRoot: true }) } }
  const menu = () => app.electronApp.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('import-browser-drafts')
    if (!item) throw Error('Missing product import menu')
    item.click()
  })
  const configure = async () => app.electronApp.evaluate(({ dialog }, destination) => {
    globalThis.__importNotices = []; globalThis.__importConfirm = 1; globalThis.__importSource = destination
    const showNativeMessageBox = dialog.showMessageBox.bind(dialog)
    dialog.showOpenDialog = async () => globalThis.__importSource ? { canceled: false, filePaths: [globalThis.__importSource] } : { canceled: true, filePaths: [] }
    dialog.showErrorBox = (title, message) => { globalThis.__importNotices.push({ title, message, kind: 'error' }) }
    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1)
      if (options.title === '局域网设备配对') return showNativeMessageBox(...args)
      if (options.title === '导入迁移草稿并退出') return { response: globalThis.__importConfirm }
      globalThis.__importNotices.push({ ...options, kind: 'message' })
      return new Promise(resolve => { globalThis.__importFinish = () => resolve({ response: 0 }) })
    }
  }, destination)
  const notices = () => app.electronApp.evaluate(() => globalThis.__importNotices)
  const run = async () => { const count = (await notices()).length; await menu(); return waitFor(async () => (await notices())[count], 45000) }
  const finish = async () => {
    const previous = app
    const process = previous.electronApp.process()
    await previous.electronApp.evaluate(() => globalThis.__importFinish()).catch(() => {})
    await waitFor(() => process.exitCode !== null)
    await stop()
  }
  const sealArchive = async (suffix, extra = []) => {
    await stop()
    const ownership = await acquireWorkspaceOwnership(data)
    try {
      baseline = await fs.readFile(workspace)
      importedKey = migration.noteDraftStorageKey('notes', 'reverse-' + suffix)
      archive = await migration.createDraftArchive([{ key: importedKey, value: JSON.stringify({ title: '反向草稿🪶' + suffix, text: '必须保留原字节', previousTitle: '', previousText: '' }) }, ...extra], { runtime: 'tauri', appVersion: '1.0.2', workspaceFingerprint: digest(baseline) })
      await recordDraftProvenance(ownership, archive, digest(baseline))
      await fs.writeFile(destination, archive)
    } finally { await ownership.release() }
    await start(); await configure()
  }
  const frozen = async () => {
    const windows = app.electronApp.windows().filter(page => !page.isClosed())
    for (const page of windows) assert.equal(await page.evaluate(() => document.documentElement.inert), true)
    await assert.rejects(app.window.evaluate(() => window.dustdesk.loadWorkspace()), /迁移维护/)
    await assert.rejects(app.window.evaluate(state => window.dustdesk.saveWorkspace(state), JSON.parse(baseline)), /迁移维护/)
    await assert.rejects(app.window.evaluate(() => window.dustdesk.toolbox.lanEnable(true)), /迁移维护/)
    const count = (await notices()).length; await menu(); assert.equal((await notices()).length, count)
    await app.electronApp.evaluate(({ app }) => app.quit()); assert.equal(app.electronApp.process().exitCode, null)
  }
  const injectRename = async when => app.electronApp.evaluate((_electron, when) => {
    const storage = process.getBuiltinModule('fs').promises, rename = storage.rename
    storage.rename = async (source, target) => {
      if (when === 'lan-stop' && target.replaceAll('\\', '/').endsWith('/LanTransfers/state.json')) throw Object.assign(Error('fixture: LAN checkpoint denied'), { code: 'EACCES' })
      if (pathBase(target) === 'ElectronMigrationTransaction.json') {
        const next = JSON.parse(await storage.readFile(source, 'utf8'))
        if ((when === 'commit' && next.decision === 'commit') || (when === 'complete' && next.completed)) throw Object.assign(Error('fixture: transaction rename denied'), { code: 'EACCES' })
      }
      return rename(source, target)
    }
    function pathBase(location) { return location.split(/[\\/]/).at(-1) }
  }, when)
  try {
    await start()
    await app.window.evaluate(async () => {
      const state = await window.dustdesk.loadWorkspace()
      state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false; state.Settings.WidgetPlacements = {}; state.Settings.WidgetLayoutPresets = {}; state.DesktopCategories = []; state.Launchers = []
      const saved = await window.dustdesk.saveWorkspace(state); if (!saved.ok) throw Error(saved.error)
      const shown = await window.dustdesk.setWidgetVisibility('todo', true); if (!shown.ok) throw Error(shown.error)
    })
    let task = await waitFor(() => app.electronApp.windows().find(page => page.url().includes('widget=todo')))
    await task.getByLabel('桌面新增任务').fill('原有任务草稿不被覆盖')
    await app.window.evaluate(() => localStorage.setItem('unrelated-import-secret', 'must-not-change'))
    await sealArchive('success', [{ key: migration.taskDraftStorageKey, value: JSON.stringify({ title: '不得覆盖原有输入', requestId: 'foreign-task' }) }])
    await scenario('cancelled file or confirmation and malformed or untrusted archives do not acquire a durable import gate', async () => {
      await app.electronApp.evaluate(() => { globalThis.__importSource = null }); await menu(); await new Promise(resolve => setTimeout(resolve, 60)); assert.deepEqual(await notices(), [])
      await app.electronApp.evaluate((_electron, destination) => { globalThis.__importSource = destination; globalThis.__importConfirm = 0 }, destination); await menu(); await new Promise(resolve => setTimeout(resolve, 60)); assert.deepEqual(await notices(), [])
      await app.electronApp.evaluate(() => { globalThis.__importConfirm = 1 })
      await fs.writeFile(destination, '{broken'); assert.equal((await run()).kind, 'error')
      const untrusted = await migration.createDraftArchive([], { runtime: 'tauri', appVersion: '1.0.2', workspaceFingerprint: digest(baseline) })
      await fs.writeFile(destination, untrusted); assert.equal((await run()).kind, 'error')
      assert.equal(await app.window.evaluate(() => document.documentElement.inert), false)
      await assert.rejects(fs.access(transaction), { code: 'ENOENT' }); assert.deepEqual(await fs.readFile(workspace), baseline)
      await fs.writeFile(destination, archive)
    })
    await scenario('product import cancels a real pending native pairing dialog, drains LAN and commits only after all windows save', async () => {
      const lan = await app.window.evaluate(() => window.dustdesk.toolbox.lanEnable(true)); assert.equal(lan.enabled, true); assert.equal(await portOpen(lan.port), true)
      const lanRoot = path.join(root, 'user-data', 'LanTransfers'), identity = await fs.readFile(path.join(lanRoot, 'identity.json'))
      await assert.rejects(acquireWorkspaceOwnership(lanRoot), /另一个进程/)
      const lateSelection = path.join(root, 'late-selection.txt')
      await fs.writeFile(lateSelection, '不得在维护后新增授权')
      await app.electronApp.evaluate(({ dialog }, target) => {
        const open = dialog.showOpenDialog
        dialog.showOpenDialog = (...args) => args.at(-1).title === '选择发送内容' ? new Promise(resolve => { globalThis.__latePick = () => resolve({ canceled: false, filePaths: [target] }) }) : open(...args)
      }, lateSelection)
      const latePick = app.window.evaluate(() => window.dustdesk.toolbox.pick('files')).then(value => ({ value }), error => ({ error: String(error) }))
      await waitFor(() => app.electronApp.evaluate(() => !!globalThis.__latePick))
      const modules = await toolboxModules(suite)
      const peer = modules.lan.createLanService({ storage: path.join(modules.root, 'peer'), downloads: path.join(modules.root, 'downloads'), name: '导入前待决配对', host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => false })
      await peer.enable(true)
      const nativeProcessId = await app.electronApp.evaluate(() => process.pid)
      const pairing = app.window.evaluate(port => window.dustdesk.toolbox.lanConnect('127.0.0.1', port), peer.snapshot().port).then(value => ({ value }), error => ({ error: String(error) }))
      const pairingDialog = async action => {
        const result = await execute('pwsh.exe', ['-NoProfile', '-STA', '-File', 'tests/tauri-lan-dialog.ps1', '-ProcessId', String(nativeProcessId), '-Title', '局域网设备配对', '-Action', action], { windowsHide: true, timeout: 18000, maxBuffer: 1024 * 1024 })
        return JSON.parse(result.stdout)
      }
      const shownPairing = await pairingDialog('snapshot'); assert.equal(shownPairing.visible, true)
      assert.ok(shownPairing.controls.some(control => control.name.includes('导入前待决配对')))
      task = await waitFor(() => app.electronApp.windows().find(page => page.url().includes('widget=todo')))
      await task.evaluate(() => { window.__importWaiting = false; window.__importVeto = window.dustdesk.onBeforeQuit(async () => { window.__importWaiting = true; await new Promise(resolve => { window.__importContinue = resolve }) }) })
      const count = (await notices()).length; await menu(); await waitFor(() => task.evaluate(() => window.__importWaiting))
      await assert.rejects(fs.access(transaction), { code: 'ENOENT' }); assert.equal(await app.window.evaluate(() => document.documentElement.inert), true)
      await task.evaluate(() => { window.__importVeto(); window.__importContinue() })
      const notice = await waitFor(async () => (await notices())[count], 45000); assert.equal(notice.title, '迁移草稿已导入'); assert.match(notice.message, /已导入 1 项草稿，保留 1 项已有草稿/)
      const record = JSON.parse(await fs.readFile(transaction)); assert.equal(record.decision, 'commit'); assert.equal(record.completed, true)
      await app.electronApp.evaluate(() => globalThis.__latePick())
      assert.match((await latePick).error ?? '', /迁移维护/)
      assert.equal(await fs.readFile(lateSelection, 'utf8'), '不得在维护后新增授权')
      assert.equal((await pairingDialog('absent')).absent, true)
      const pairingResult = await pairing; assert.ok(pairingResult.error, JSON.stringify(pairingResult)); assert.match(pairingResult.error, /取消|停止|中止|abort|关闭/i)
      const savedLan = JSON.parse(await fs.readFile(path.join(lanRoot, 'state.json')))
      assert.deepEqual(savedLan.trusted, [])
      report.cancelledNativePairing = { visibleBeforeImport: shownPairing.visible, absentAfterImport: true, rejected: pairingResult.error }
      await peer.dispose()
      assert.equal(await portOpen(lan.port), false)
      await (await acquireWorkspaceOwnership(lanRoot)).release()
      assert.equal(JSON.parse(await fs.readFile(path.join(lanRoot, 'state.json'))).enabled, true)
      assert.deepEqual(await fs.readFile(path.join(lanRoot, 'identity.json')), identity)
      await frozen()
      const values = await app.window.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(key)])), [importedKey, migration.taskDraftStorageKey, migration.draftMigrationJournalKey, 'unrelated-import-secret'])
      assert.match(values[importedKey], /反向草稿/); assert.equal(JSON.parse(values[migration.taskDraftStorageKey]).title, '原有任务草稿不被覆盖'); assert.equal(values[migration.draftMigrationJournalKey], null); assert.equal(values['unrelated-import-secret'], 'must-not-change')
      assert.deepEqual(await fs.readFile(workspace), baseline); assert.equal(await fs.readFile(destination, 'utf8'), archive)
      await finish(); await start(); assert.match(await app.window.evaluate(key => localStorage.getItem(key), importedKey), /反向草稿/)
      const restored = await app.window.evaluate(() => window.dustdesk.toolbox.lanSnapshot()); assert.equal(restored.enabled, true); assert.equal(await portOpen(restored.port), true)
      assert.deepEqual(await fs.readFile(path.join(lanRoot, 'identity.json')), identity)
    })
    await scenario('a consumed completed import never resurrects deleted input and repeating the archive does not create another transaction', async () => {
      await app.window.evaluate(key => localStorage.removeItem(key), importedKey)
      await stop(); await start(); assert.equal(await app.window.evaluate(key => localStorage.getItem(key), importedKey), null)
      await configure(); const previous = await fs.readFile(transaction)
      assert.match((await run()).message, /已导入，未重复写入/); assert.deepEqual(await fs.readFile(transaction), previous); await frozen(); await finish()
    })
    await sealArchive('stop-failure')
    await scenario('a failed native LAN stop checkpoint closes listening but cannot begin a browser write or release editors', async () => {
      const lan = await app.window.evaluate(() => window.dustdesk.toolbox.lanSnapshot()), previous = await fs.readFile(transaction)
      await injectRename('lan-stop'); const notice = await run(); assert.equal(notice.title, '迁移草稿等待受控恢复'); assert.match(notice.detail, /LAN checkpoint denied/)
      assert.equal(await portOpen(lan.port), false); assert.deepEqual(await fs.readFile(transaction), previous)
      assert.equal(await app.window.evaluate(key => localStorage.getItem(key), importedKey), null)
      await frozen(); await finish(); await start(); assert.equal(await app.window.evaluate(key => localStorage.getItem(key), importedKey), null)
      assert.equal((await app.window.evaluate(() => window.dustdesk.toolbox.lanSnapshot())).enabled, true)
    })
    await sealArchive('pending')
    await scenario('a failed commit rename preserves pending authority and startup explicitly aborts without opening an editor first', async () => {
      await injectRename('commit'); const notice = await run(); assert.equal(notice.title, '迁移草稿等待受控恢复'); assert.match(notice.detail, /transaction rename denied/)
      assert.equal(JSON.parse(await fs.readFile(transaction)).decision, 'pending'); await frozen(); assert.deepEqual(await fs.readFile(workspace), baseline)
      await finish(); await start()
      const record = JSON.parse(await fs.readFile(transaction)); assert.equal(record.decision, 'abort'); assert.equal(record.completed, true)
      assert.equal(await app.window.evaluate(key => localStorage.getItem(key), importedKey), null)
      assert.equal(await app.window.evaluate(key => localStorage.getItem(key), migration.draftMigrationJournalKey), null)
    })
    await sealArchive('completion')
    await scenario('failure after the browser commit retains native commit and real read-only startup failure opens no ordinary page or desktop IPC', async () => {
      await injectRename('complete'); const notice = await run(); assert.equal(notice.title, '迁移草稿等待受控恢复')
      const record = JSON.parse(await fs.readFile(transaction)); assert.equal(record.decision, 'commit'); assert.equal(record.completed, false); await frozen(); await finish()
      await fs.chmod(transaction, 0o444)
      const before = await fs.readFile(transaction), bootstrap = path.join(root, 'startup-retry.cjs')
      await fs.writeFile(bootstrap, `const electron = require('electron'); globalThis.__startupRegistrations = []; const original = electron.ipcMain.handle.bind(electron.ipcMain); electron.ipcMain.handle = (channel, ...args) => { globalThis.__startupRegistrations.push(channel); return original(channel, ...args) }; electron.dialog.showMessageBox = async (...args) => { globalThis.__startupPrompt = args.at(-1); return new Promise(resolve => { globalThis.__startupRetry = () => resolve({response:1}) }) }; require(${JSON.stringify(path.resolve('out/main/index.js'))});`)
      rawApp = await electron.launch({ args: [bootstrap], env: { ...process.env, DUSTDESK_TEST_DATA_DIR: data, DUSTDESK_TEST_DESKTOP_DIR: path.join(root, 'desktop'), DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'), ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' } })
      const prompt = await waitFor(() => rawApp.evaluate(() => globalThis.__startupPrompt), 30000)
      assert.equal(prompt.title, '草稿启动恢复未完成'); assert.match(prompt.detail, /ElectronMigrationTransaction.json/); assert.match(prompt.detail, /EPERM|EACCES/)
      const facts = await rawApp.evaluate(({ BrowserWindow, Menu, globalShortcut }) => ({ windows: BrowserWindow.getAllWindows().length, registrations: globalThis.__startupRegistrations, importMenu: !!Menu.getApplicationMenu()?.getMenuItemById('import-browser-drafts'), hotkeys: ['Alt+Space', 'CommandOrControl+Shift+D'].some(key => globalShortcut.isRegistered(key)) }))
      assert.deepEqual(facts, { windows: 0, registrations: [], importMenu: false, hotkeys: false }); assert.deepEqual(await fs.readFile(transaction), before); assert.deepEqual(await fs.readFile(workspace), baseline)
      report.readOnlyFailure = { code: prompt.detail, facts }
      await fs.chmod(transaction, 0o666); await rawApp.evaluate(() => globalThis.__startupRetry())
      const page = await waitFor(async () => {
        for (const candidate of rawApp.windows()) if (!candidate.isClosed() && await candidate.locator('.app-shell').isVisible().catch(() => false)) return candidate
      }, 30000)
      assert.match(await page.evaluate(key => localStorage.getItem(key), importedKey), /反向草稿/)
      assert.equal(JSON.parse(await fs.readFile(transaction)).completed, true)
      await rawApp.evaluate(({ app }) => app.exit(0)); await rawApp.close().catch(() => {}); rawApp = undefined
      await start(); assert.match(await app.window.evaluate(key => localStorage.getItem(key), importedKey), /反向草稿/)
    })
    await app.window.evaluate(() => window.dustdesk.toolbox.lanEnable(false))
    await sealArchive('late-enable')
    await scenario('LAN initialization begun before maintenance cannot enable a listener after the editor gate closes', async () => {
      const lanRoot = path.join(root, 'user-data', 'LanTransfers'), identity = await fs.readFile(path.join(lanRoot, 'identity.json'))
      await app.electronApp.evaluate(() => {
        const storage = process.getBuiltinModule('fs').promises, read = storage.readFile.bind(storage)
        storage.readFile = async (target, ...args) => {
          if (String(target).replaceAll('\\', '/').endsWith('/LanTransfers/state.json') && !globalThis.__lateLanReading) {
            globalThis.__lateLanReading = true
            await new Promise(resolve => { globalThis.__resumeLanRead = resolve })
          }
          return read(target, ...args)
        }
        const network = process.getBuiltinModule('net'), listen = network.Server.prototype.listen
        globalThis.__lateLanListens = 0
        network.Server.prototype.listen = function (...args) { if (typeof args[0] === 'number') globalThis.__lateLanListens++; return listen.apply(this, args) }
      })
      const enabling = app.window.evaluate(() => window.dustdesk.toolbox.lanEnable(true)).then(value => ({ value }), error => ({ error: String(error) }))
      await waitFor(() => app.electronApp.evaluate(() => !!globalThis.__lateLanReading))
      const importing = run()
      await waitFor(() => app.window.evaluate(() => document.documentElement.inert))
      await app.electronApp.evaluate(() => globalThis.__resumeLanRead())
      const enabled = await enabling, notice = await importing
      report.lateLanInitialization = { result: enabled, tcpListens: await app.electronApp.evaluate(() => globalThis.__lateLanListens), state: JSON.parse(await fs.readFile(path.join(lanRoot, 'state.json'))) }
      assert.match(enabled.error ?? '', /迁移维护/)
      assert.equal(report.lateLanInitialization.tcpListens, 0)
      assert.equal(report.lateLanInitialization.state.enabled, false)
      assert.equal(notice.title, '迁移草稿已导入')
      assert.deepEqual(await fs.readFile(path.join(lanRoot, 'identity.json')), identity)
      await (await acquireWorkspaceOwnership(lanRoot)).release()
      await frozen(); await finish(); await start()
      assert.equal((await app.window.evaluate(() => window.dustdesk.toolbox.lanSnapshot())).enabled, false)
    })
    for (const [file, expected] of Object.entries(inputs)) assert.equal(digest(await fs.readFile(file)), expected, file)
    report.inputs = inputs; report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    await fs.chmod(transaction, 0o666).catch(() => {})
    if (rawApp) { await rawApp.evaluate(({ app }) => app.exit(0)).catch(() => {}); await rawApp.close().catch(() => {}) }
    await stop(); await fs.rm(root, { recursive: true, force: true }).catch(() => {})
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2))
  }
})
