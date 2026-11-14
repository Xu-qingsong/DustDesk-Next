import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = 'artifacts/tauri-migration/data-snapshot-native'
const sources = ['src-tauri/src/managed_snapshot.rs', 'src-tauri/src/managed_snapshot/preparation.rs', 'src-tauri/src/workspace/snapshot_preparation.rs', 'src-tauri/src/workspace/mod.rs', 'src-tauri/src/draft_maintenance.rs', 'src-tauri/src/main.rs', 'src-tauri/permissions/workspace.toml', 'src-tauri/capabilities/workspace.json', 'src/renderer/src/runtime/DraftImportPanel.tsx', 'tests/tauri-data-snapshot.mjs']

test('native Data-only preparation holds actual ownership and editor maintenance with persisted startup abort', { timeout: 210000 }, async suite => {
  await fs.mkdir(directory, { recursive: true })
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [], scope: 'Actual isolated Tauri main-window folder selection, all-editor maintenance, Data-only native snapshots and native startup abort. No production takeover, browser draft/LAN identity composition, restore, physical network or packaging acceptance.' }
  let app, page, root, failed = false
  const scenario = async (name, run) => {
    await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Data snapshot scenario failed: ' + name)
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await fs.readFile(file))])))
    const fixture = await mainFixture(suite), initial = await fixture.load()
    initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false
    initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; initial.DesktopCategories = []; initial.Launchers = []
    app = await launchTauri(); root = app.root
    report.executableSha256 = digest(await fs.readFile(app.executable))
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace')
    page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const profile = path.join(root, 'user-data', 'tauri-preview'), data = path.join(profile, 'Workspace')
    const button = () => page.getByRole('button', { name: '准备隔离 Data 快照', exact: true })
    const begin = async () => { await button().click(); await operateDialog(app, '选择 Data 快照保存位置', 'visible') }
    const select = async target => { await operateDialog(app, '选择 Data 快照保存位置', 'select', target) }
    const settled = async () => {
      await waitFor(async () => await button().isEnabled())
      assert.equal(await page.evaluate(() => document.documentElement.inert), false)
    }
    const catalogs = async () => (await fs.readdir(profile)).filter(name => name.startsWith('.DustDeskSnapshotPreparation-'))
    const snapshots = async () => (await fs.readdir(root)).filter(name => name.startsWith('DustDesk-Data-'))
    await scenario('real folder cancellation performs no maintenance, snapshot writes or native intent creation', async () => {
      await begin(); await operateDialog(app, '选择 Data 快照保存位置', 'cancel'); await settled()
      assert.deepEqual(await catalogs(), []); assert.deepEqual(await snapshots(), [])
    })
    await scenario('actual internal profile selection is rejected before creating any preparation intent', async () => {
      await begin(); await select(profile); await settled()
      await page.getByRole('alert').filter({ hasText: 'profile' }).waitFor()
      assert.deepEqual(await catalogs(), []); assert.deepEqual(await snapshots(), [])
    })
    let snapshot, catalog, widget, workspaceFingerprint
    await scenario('real editors and raw Data assets are sealed while local browser-only input remains outside the snapshot', async () => {
      await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))
      widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('widget=todo')))
      await widget.getByLabel('桌面新增任务').fill('浏览器草稿不冒充 Data 快照')
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('Data 快照保存原文 中文🪶\n第二行')
      await fs.mkdir(path.join(data, 'SnapshotFixture/空目录'), { recursive: true })
      await fs.writeFile(path.join(data, 'SnapshotFixture/asset.bin'), Buffer.from([0, 255, 91, 128]))
      await begin(); await select(root); await settled()
      await page.getByRole('status').filter({ hasText: '隔离 Data 快照已准备' }).waitFor()
      const names = await snapshots(); assert.equal(names.length, 1); snapshot = path.join(root, names[0])
      const manifest = JSON.parse(await fs.readFile(path.join(snapshot, 'snapshot.json'), 'utf8'))
      const workspace = await fs.readFile(path.join(data, 'workspace.json')); workspaceFingerprint = digest(workspace)
      assert.equal(JSON.parse(workspace).QuickNote, 'Data 快照保存原文 中文🪶\n第二行')
      assert.equal(manifest.workspaceSha256, workspaceFingerprint)
      const entry = manifest.entries.find(entry => entry.path === 'workspace.json')
      assert.deepEqual(await fs.readFile(path.join(snapshot, 'objects', String(entry.object).padStart(6, '0') + '.bin')), workspace)
      const asset = manifest.entries.find(entry => entry.path === 'SnapshotFixture/asset.bin')
      assert.deepEqual(await fs.readFile(path.join(snapshot, 'objects', String(asset.object).padStart(6, '0') + '.bin')), Buffer.from([0, 255, 91, 128]))
      assert.ok(manifest.entries.some(entry => entry.kind === 'directory' && entry.path === 'SnapshotFixture/空目录'))
      assert.ok(!manifest.entries.some(entry => entry.path === 'workspace.lock' || entry.path.includes('WebView2') || /identity|private.key/i.test(entry.path)))
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '浏览器草稿不冒充 Data 快照')
      const namesCatalog = await catalogs(); assert.equal(namesCatalog.length, 1); catalog = path.join(profile, namesCatalog[0])
      const ids = (await fs.readdir(catalog)).filter(name => /^[a-f0-9-]{36}$/.test(name)); assert.equal(ids.length, 1)
      const intentBytes = await fs.readFile(path.join(catalog, ids[0], 'intent.json'))
      const intent = JSON.parse(intentBytes), decision = JSON.parse(await fs.readFile(path.join(catalog, ids[0], 'decision.json'), 'utf8'))
      assert.equal(intent.workspaceSha256, workspaceFingerprint); assert.equal(intent.destination, snapshot)
      assert.equal(decision.intentSha256, digest(intentBytes)); assert.equal(decision.outcome.state, 'prepared')
      assert.equal(decision.outcome.receipt.manifestSha256, digest(await fs.readFile(path.join(snapshot, 'snapshot.json'))))
      await assert.rejects(acquireWorkspaceOwnership(data), /使用|拒绝|占用/)
      report.prepared = { intentId: ids[0], workspaceFingerprint, manifestSha256: decision.outcome.receipt.manifestSha256 }
      await page.screenshot({ path: path.join(directory, 'prepared.png') })
    })
    await scenario('prototype and widget callers are denied and forged path/checkpoint arguments cannot bypass native selection', async () => {
      await assert.rejects(app.invoke('data_snapshot_prepare'), /not allowed|权限/i)
      await assert.rejects(app.invoke('data_snapshot_prepare', {}, widget), /not allowed|权限/i)
      const forged = path.join(data, 'forged-renderer-target')
      await page.evaluate(forged => {
        window.__snapshotProbe = null
        void window.__TAURI_INTERNALS__.invoke('data_snapshot_prepare', { destination: forged, fingerprint: 'f'.repeat(64), receipt: { trusted: true } })
          .then(value => { window.__snapshotProbe = { value } }, error => { window.__snapshotProbe = { error: String(error) } })
      }, forged)
      await operateDialog(app, '选择 Data 快照保存位置', 'visible'); await select(root)
      const result = await waitFor(() => page.evaluate(() => window.__snapshotProbe))
      assert.ok(!result.error, result.error); assert.equal(result.value.scope, 'managed-data-only')
      assert.equal(result.value.productionReady, false); assert.equal(result.value.migrationComplete, false)
      assert.ok(result.value.path.startsWith(root + path.sep)); assert.notEqual(result.value.path, forged)
      assert.equal(await fs.stat(forged).then(() => true, () => false), false)
      assert.equal(digest(await fs.readFile(path.join(data, 'workspace.json'))), workspaceFingerprint)
    })
    let pendingId
    await scenario('a real hard-link rejection retains pending native intent and restart aborts it before normal editor access', async () => {
      await fs.writeFile(path.join(data, 'blocked.bin'), 'preserve source')
      const externalLink = path.join(root, 'blocked-link.bin'); await fs.link(path.join(data, 'blocked.bin'), externalLink)
      const before = (await fs.readdir(catalog)).filter(name => /^[a-f0-9-]{36}$/.test(name))
      await begin(); await select(root); await settled()
      await page.getByRole('alert').filter({ hasText: /链接/ }).waitFor()
      pendingId = (await fs.readdir(catalog)).filter(name => /^[a-f0-9-]{36}$/.test(name)).find(name => !before.includes(name))
      assert.ok(pendingId); assert.equal(await fs.stat(path.join(catalog, pendingId, 'decision.json')).then(() => true, () => false), false)
      const pending = JSON.parse(await fs.readFile(path.join(catalog, pendingId, 'intent.json'), 'utf8'))
      assert.equal(await fs.stat(pending.destination).then(() => true, () => false), false)
      await app.close({ preserve: true }); app = undefined; await fs.unlink(externalLink)
      app = await launchTauri({ rootDirectory: root, workspace: true }); page = app.page
      await page.locator('.app-shell').waitFor()
      const decision = JSON.parse(await fs.readFile(path.join(catalog, pendingId, 'decision.json'), 'utf8'))
      assert.equal(decision.outcome.state, 'aborted')
      assert.equal(await fs.readFile(path.join(data, 'blocked.bin'), 'utf8'), 'preserve source')
      assert.equal(digest(await fs.readFile(path.join(data, 'workspace.json'))), workspaceFingerprint)
      assert.equal((await page.evaluate(() => window.dustdesk.loadWorkspace())).SchemaVersion, 3)
    })
    await scenario('moving an old Data snapshot does not turn its historical record into startup authorization or block ordinary editing', async () => {
      await app.close({ preserve: true }); app = undefined
      await fs.rename(snapshot, path.join(root, 'moved-historical-snapshot'))
      app = await launchTauri({ rootDirectory: root, workspace: true }); page = app.page
      await page.locator('.app-shell').waitFor()
      assert.equal((await page.evaluate(() => window.dustdesk.loadWorkspace())).SchemaVersion, 3)
      const decision = JSON.parse(await fs.readFile(path.join(catalog, pendingId, 'decision.json'), 'utf8'))
      assert.equal(decision.outcome.state, 'aborted')
      assert.equal(digest(await fs.readFile(path.join(data, 'workspace.json'))), workspaceFingerprint)
    })
    for (const [file, expected] of Object.entries(report.inputs)) assert.equal(digest(await fs.readFile(file)), expected, file)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); report.output = app?.output(); throw error }
  finally {
    await app?.close()
    if (root && !app) await fs.rm(root, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  }
})
