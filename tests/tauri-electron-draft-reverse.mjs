import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl)
const digest = value => createHash('sha256').update(value).digest('hex')
const reportPath = 'artifacts/tauri-migration/draft-reverse-product-native.json'
const sources = ['tests/reference/src/main/draftImport.ts', 'tests/reference/src/main/draftStartup.ts', 'tests/reference/src/main/draftBrowser.ts', 'tests/reference/src/main/draftTransaction.ts', 'tests/reference/src/main/draftMaintenance.ts', 'tests/reference/src/main/index.ts', 'tests/reference/src/preload/index.ts', 'tests/reference/src/preload/draftControl.ts', 'src/shared/draftMigration.ts', 'src-tauri/src/workspace/draft_export.rs', 'src-tauri/src/workspace/draft_lineage.rs', 'src-tauri/src/draft_maintenance.rs', 'tests/tauri-electron-draft-reverse.mjs']

test('actual Tauri native export hands exact drafts to the prepared Electron menu and survives normal ownership handback and restart', { timeout: 180000 }, async suite => {
  await fs.mkdir(path.dirname(reportPath), { recursive: true })
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [], scope: 'Both actual desktop runtimes, shared isolated physical workspace, real Tauri save dialog and prepared Electron product import with intercepted native file/confirmation dialogs. Not a production directory takeover or complete rollback/service/attachment/organizer acceptance.' }
  const inputs = Object.fromEntries(await Promise.all(sources.map(async source => [source, digest(await fs.readFile(source))])))
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-'))
  const data = path.join(root, 'user-data', 'tauri-preview', 'Workspace'), destination = path.join(root, 'actual-tauri-export.json')
  let app, prepared, page, serialized, verified, baseline, taskDraft, failed = false
  const scenario = async (name, run) => { await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('Actual reverse handoff failed: ' + name) }
  const launchPrepared = async () => { prepared = await launchDustDesk({ tempRoot: root, dataDirectory: data }); return prepared }
  const stopPrepared = async () => { if (prepared) { const previous = prepared; prepared = undefined; await closeDustDesk({ ...previous, preserveTempRoot: true }) } }
  const tauriWidget = () => waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget=todo')))
  const electronWidget = () => waitFor(() => prepared.electronApp.windows().find(target => target.url().includes('widget=todo')))
  try {
    await launchPrepared()
    await prepared.window.evaluate(async () => {
      const state = await window.dustdesk.loadWorkspace()
      state.Settings.AutomaticBackupEnabled = false; state.Settings.ClipboardMonitoringEnabled = false; state.Settings.WidgetPlacements = {}; state.Settings.WidgetLayoutPresets = {}; state.DesktopCategories = []; state.Launchers = []
      const saved = await window.dustdesk.saveWorkspace(state); if (!saved.ok) throw Error(saved.error)
    })
    await stopPrepared()
    app = await launchTauri({ rootDirectory: root, workspace: true })
    report.tauriExecutableSha256 = digest(await fs.readFile(app.executable)); page = app.page
    await scenario('a dirty actual Tauri widget is sealed and exported by the native dialog with a compatible physical-workspace receipt', async () => {
      await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))
      const widget = await tauriWidget(); await widget.getByLabel('桌面新增任务').fill('从真实 Tauri 交还 Electron 的任务🪶')
      await page.evaluate(() => {
        localStorage.setItem('quick-capture-draft', '{ "kind":"note", "title":"交还快速记录", "text":"中文🪶与原始空格", "requestId":"actual-reverse-capture" }')
        localStorage.setItem('private-reverse-secret', 'never-export-this')
      })
      await page.getByRole('button', { name: '导出迁移草稿', exact: true }).click()
      await operateDialog(app, '导出迁移草稿', 'select', destination)
      await page.getByRole('status').filter({ hasText: '已导出' }).waitFor(); await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      serialized = await fs.readFile(destination, 'utf8'); verified = await migration.verifyDraftArchive(serialized)
      assert.equal(verified.payload.source.runtime, 'tauri'); assert.equal(serialized.includes('never-export-this'), false)
      taskDraft = verified.payload.entries.find(entry => entry.key === migration.taskDraftStorageKey)
      assert.ok(taskDraft); assert.equal(JSON.parse(taskDraft.value).title, '从真实 Tauri 交还 Electron 的任务🪶')
      baseline = await fs.readFile(path.join(data, 'workspace.json')); assert.equal(verified.payload.source.workspaceFingerprint, digest(baseline))
      await fs.writeFile(path.join(root, 'exported-workspace.json'), baseline)
      const ledger = JSON.parse(await fs.readFile(path.join(data, 'MigrationLineage', 'lineage.json')))
      assert.equal(ledger.exports.find(entry => entry.archiveId === verified.payload.id).archiveSha256, digest(serialized))
      const process = app.child
      await app.invoke('application_quit', {}, page).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
      await waitFor(() => process.exitCode !== null || process.signalCode !== null); assert.equal(process.exitCode, 0)
      await fs.copyFile(path.join(data, 'workspace.json'), path.join(root, 'after-tauri-exit-workspace.json'))
      await app.close({ preserve: true }); app = undefined
    })
    await scenario('the prepared Electron product menu consumes the exact real Tauri export and freezes all old editors until exit', async () => {
      await launchPrepared(); const widget = await electronWidget(); await widget.getByLabel('桌面新增任务').waitFor(); assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '')
      await prepared.electronApp.evaluate(({ dialog, Menu }, destination) => {
        globalThis.__reverseNotice = undefined
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [destination] })
        dialog.showErrorBox = (title, message) => { globalThis.__reverseNotice = { title, message } }
        dialog.showMessageBox = async (...args) => {
          const options = args.at(-1)
          if (options.title === '导入迁移草稿并退出') return { response: 1 }
          globalThis.__reverseNotice = options
          return new Promise(resolve => { globalThis.__reverseExit = () => resolve({ response: 0 }) })
        }
        Menu.getApplicationMenu().getMenuItemById('import-browser-drafts').click()
      }, destination)
      const notice = await waitFor(() => prepared.electronApp.evaluate(() => globalThis.__reverseNotice), 45000)
      report.importNotice = notice; report.fingerprints = { exported: digest(baseline), beforeImport: digest(await fs.readFile(path.join(data, 'workspace.json'))) }
      await fs.copyFile(path.join(data, 'workspace.json'), path.join(root, 'before-electron-import-workspace.json'))
      assert.equal(notice.title, '迁移草稿已导入', JSON.stringify(notice))
      for (const entry of verified.payload.entries) assert.equal(await prepared.window.evaluate(key => localStorage.getItem(key), entry.key), entry.value)
      assert.equal(await widget.evaluate(() => document.documentElement.inert), true)
      const record = JSON.parse(await fs.readFile(path.join(data, 'ElectronMigrationTransaction.json')))
      assert.equal(record.decision, 'commit'); assert.equal(record.completed, true); assert.equal(record.archiveId, verified.payload.id)
      assert.deepEqual(await fs.readFile(path.join(data, 'workspace.json')), baseline)
      const process = prepared.electronApp.process(); await prepared.electronApp.evaluate(() => globalThis.__reverseExit()).catch(() => {}); await waitFor(() => process.exitCode !== null); assert.equal(process.exitCode, 0); await stopPrepared()
    })
    await scenario('normal Electron startup restores the actual task input and stable request ID and consuming it does not resurrect it later', async () => {
      await launchPrepared(); const widget = await electronWidget(); await widget.getByLabel('桌面新增任务').waitFor()
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), JSON.parse(taskDraft.value).title)
      assert.equal(await widget.evaluate(key => localStorage.getItem(key), taskDraft.key), taskDraft.value)
      await widget.screenshot({ path: path.resolve('artifacts/tauri-migration/draft-reverse-restored-widget.png') })
      await widget.getByRole('button', { name: '添加', exact: true }).click()
      await waitFor(async () => (await prepared.window.evaluate(() => window.dustdesk.loadWorkspace())).Todos.some(todo => todo.Id === JSON.parse(taskDraft.value).requestId))
      await stopPrepared(); await launchPrepared(); const next = await electronWidget(); await next.getByLabel('桌面新增任务').waitFor()
      assert.equal(await next.getByLabel('桌面新增任务').inputValue(), '')
      const tasks = (await prepared.window.evaluate(() => window.dustdesk.loadWorkspace())).Todos.filter(todo => todo.Id === JSON.parse(taskDraft.value).requestId)
      assert.equal(tasks.length, 1); assert.equal(tasks[0].Title, JSON.parse(taskDraft.value).title)
      assert.equal(await fs.readFile(destination, 'utf8'), serialized)
      report.archiveSha256 = digest(serialized); report.workspaceFingerprint = digest(baseline); report.archiveId = verified.payload.id; report.exactTaskRequestId = JSON.parse(taskDraft.value).requestId
    })
    for (const [source, expected] of Object.entries(inputs)) assert.equal(digest(await fs.readFile(source)), expected, source)
    report.inputs = inputs; report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally { await stopPrepared(); await app?.close({ preserve: true }); if (report.verified) await fs.rm(root, { recursive: true, force: true }).catch(() => {}); else report.isolatedFailureRoot = root; await fs.writeFile(reportPath, JSON.stringify(report, null, 2)) }
})
