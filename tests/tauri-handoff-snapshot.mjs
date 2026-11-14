import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { draftModuleUrl } from './draft-module.mjs'
import { verifyDraftProvenance } from './draft-lineage-module.mjs'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'

const migration = await import(draftModuleUrl)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = 'artifacts/tauri-migration/handoff-snapshot-native'
const sources = ['src-tauri/src/lan/migration.rs', 'src-tauri/src/managed_snapshot.rs', 'src-tauri/src/managed_snapshot/bundle.rs', 'src-tauri/src/managed_snapshot/preparation.rs', 'src-tauri/src/workspace/handoff_snapshot.rs', 'src-tauri/src/workspace/snapshot_preparation.rs', 'src-tauri/src/workspace/draft_export.rs', 'src-tauri/src/workspace/mod.rs', 'src-tauri/src/draft_maintenance.rs', 'src-tauri/src/main.rs', 'src-tauri/permissions/workspace.toml', 'src-tauri/capabilities/workspace.json', 'src/renderer/src/runtime/DraftImportPanel.tsx', 'tests/tauri-handoff-snapshot.mjs']

test('native composed handoff seals actual Data, browser drafts and original LAN identity binding without key export', { timeout: 240000 }, async suite => {
  await fs.mkdir(directory, { recursive: true })
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [], scope: 'Actual isolated Tauri native folder selection and all-editor maintenance; composed Data/browser whitelist/LAN durable-state checkpoint with original-profile-only identity reference; V2 overall decision and startup abort; prepared Electron provenance reader. No production source trust/cutover, private-key backup, external transfer-file restore or full disaster recovery.' }
  let app, page, root, owner, failed = false
  const scenario = async (name, run) => {
    await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Handoff snapshot scenario failed: ' + name)
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await fs.readFile(file))])))
    const fixture = await mainFixture(suite), initial = await fixture.load()
    initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false
    initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; initial.DesktopCategories = []; initial.Launchers = []
    app = await launchTauri({ lanLocalOnly: true }); root = app.root
    report.executableSha256 = digest(await fs.readFile(app.executable))
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace')
    page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const profile = path.join(root, 'user-data', 'tauri-preview'), data = path.join(profile, 'Workspace'), lan = path.join(profile, 'LanTransfers')
    const button = () => page.getByRole('button', { name: '准备隔离交接快照', exact: true })
    const begin = async () => { await button().click(); await operateDialog(app, '选择交接快照保存位置', 'visible') }
    const select = async target => { await operateDialog(app, '选择交接快照保存位置', 'select', target) }
    const settled = async () => {
      await waitFor(async () => await button().isEnabled())
      assert.equal(await page.evaluate(() => document.documentElement.inert), false)
    }
    const catalogs = async () => (await fs.readdir(profile)).filter(name => name.startsWith('.DustDeskSnapshotPreparation-'))
    const snapshots = async () => (await fs.readdir(root)).filter(name => name.startsWith('DustDesk-Handoff-'))
    const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk.toolbox[method](...args), { method, args })
    await scenario('real cancel and protected profile selection create no intent, output or LAN identity', async () => {
      await begin(); await operateDialog(app, '选择交接快照保存位置', 'cancel'); await settled()
      assert.deepEqual(await catalogs(), []); assert.deepEqual(await snapshots(), [])
      await begin(); await select(profile); await settled()
      await page.getByRole('alert').filter({ hasText: 'profile' }).waitFor()
      assert.deepEqual(await catalogs(), []); assert.deepEqual(await snapshots(), [])
      assert.equal(await fs.stat(lan).then(() => true, () => false), false)
    })
    let widget, snapshot, catalog, serialized, verified, workspaceFingerprint, identitySha256, stateSha256
    await scenario('dirty real editors, exact whitelist bytes and enabled original LAN state share one native durable handoff decision', async () => {
      await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))
      widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('widget=todo')))
      await widget.getByLabel('桌面新增任务').fill('组合交接草稿 中文🪶')
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('组合快照保存原文 中文🪶\n第二行')
      const seed = [
        { key: 'widget-note:handoff-note', value: '{ "title":"原文", "text":"\\ud800\\r\\n🪶", "previousTitle":"", "previousText":"" }' },
        { key: 'widget-note:v2:notes:clean-handoff', value: '{"saved":true}' },
        { key: 'widget-notes:selected', value: 'handoff-note' }
      ]
      await page.evaluate(seed => {
        for (const { key, value } of seed) localStorage.setItem(key, value)
        localStorage.setItem('private-cookie-fixture', 'never-export-cookie')
        document.cookie = 'handoff-secret=never-export-cookie'
      }, seed)
      await fs.mkdir(path.join(data, 'HandoffFixture', '空目录'), { recursive: true })
      await fs.writeFile(path.join(data, 'HandoffFixture', 'asset.bin'), Buffer.from([0, 255, 17, 128]))
      assert.equal((await api('lanEnable', true)).enabled, true)
      identitySha256 = digest(await fs.readFile(path.join(lan, 'identity.json')))
      const state = await fs.readFile(path.join(lan, 'state.json')); stateSha256 = digest(state)
      assert.equal(JSON.parse(state).enabled, true)
      await begin(); await select(root); await settled()
      await page.getByRole('status').filter({ hasText: '隔离交接快照已封存' }).waitFor()
      const names = await snapshots(); assert.equal(names.length, 1); snapshot = path.join(root, names[0])
      assert.deepEqual((await fs.readdir(snapshot)).sort(), ['Data', 'browser-drafts.json', 'handoff.json', 'lan-state.json'])
      const manifestBytes = await fs.readFile(path.join(snapshot, 'handoff.json')), manifest = JSON.parse(manifestBytes)
      assert.equal(manifest.identityMode, 'original-profile-only'); assert.equal(manifest.externalTransferFiles, 'original-locations-required')
      assert.equal(manifest.components.lan.originalIdentity.file.sha256, identitySha256)
      assert.equal(manifest.components.lan.state.sha256, stateSha256)
      assert.deepEqual(await fs.readFile(path.join(snapshot, 'lan-state.json')), state)
      assert.equal(manifestBytes.includes(Buffer.from('PRIVATE KEY')), false)
      serialized = await fs.readFile(path.join(snapshot, 'browser-drafts.json'), 'utf8'); verified = await migration.verifyDraftArchive(serialized)
      workspaceFingerprint = digest(await fs.readFile(path.join(data, 'workspace.json')))
      assert.equal(verified.payload.source.workspaceFingerprint, workspaceFingerprint)
      for (const entry of seed) assert.deepEqual(verified.payload.entries.find(saved => saved.key === entry.key), entry)
      assert.ok(verified.payload.entries.some(entry => entry.key === migration.taskDraftStorageKey && JSON.parse(entry.value).title === '组合交接草稿 中文🪶'))
      assert.ok(!serialized.includes('never-export-cookie'))
      assert.equal(manifest.components.drafts.archiveSha256, digest(serialized))
      const dataManifest = JSON.parse(await fs.readFile(path.join(snapshot, 'Data', 'snapshot.json'), 'utf8'))
      assert.equal(dataManifest.workspaceSha256, workspaceFingerprint)
      for (const relative of ['workspace.json', 'MigrationLineage/lineage.json', 'HandoffFixture/asset.bin']) {
        const entry = dataManifest.entries.find(entry => entry.path === relative); assert.ok(entry, relative)
        assert.deepEqual(await fs.readFile(path.join(snapshot, 'Data', 'objects', String(entry.object).padStart(6, '0') + '.bin')), await fs.readFile(path.join(data, relative)))
      }
      assert.ok(dataManifest.entries.some(entry => entry.kind === 'directory' && entry.path === 'HandoffFixture/空目录'))
      assert.ok(!dataManifest.entries.some(entry => /identity|LanTransfers|WebView2|workspace.lock/i.test(entry.path)))
      const namesCatalog = await catalogs(); assert.equal(namesCatalog.length, 1); catalog = path.join(profile, namesCatalog[0])
      const ids = (await fs.readdir(catalog)).filter(name => /^[a-f0-9-]{36}$/.test(name)); assert.equal(ids.length, 1)
      const intentBytes = await fs.readFile(path.join(catalog, ids[0], 'intent.json')), intent = JSON.parse(intentBytes)
      const decision = JSON.parse(await fs.readFile(path.join(catalog, ids[0], 'decision.json'), 'utf8'))
      assert.equal(intent.version, 2); assert.equal(intent.destination, snapshot); assert.equal(intent.workspaceSha256, workspaceFingerprint)
      assert.equal(decision.version, 2); assert.equal(decision.intentSha256, digest(intentBytes)); assert.equal(decision.outcome.state, 'handoffPrepared')
      assert.equal(decision.outcome.receipt.manifestSha256, digest(manifestBytes)); assert.equal(decision.outcome.receipt.componentsSha256, intent.componentsSha256)
      await waitFor(() => api('lanSnapshot').then(value => value.enabled))
      assert.equal(digest(await fs.readFile(path.join(lan, 'identity.json'))), identitySha256)
      assert.equal(digest(await fs.readFile(path.join(lan, 'state.json'))), stateSha256)
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '组合交接草稿 中文🪶')
      await assert.rejects(acquireWorkspaceOwnership(data), /使用|拒绝|占用/)
      report.prepared = { intentId: ids[0], workspaceFingerprint, manifestSha256: digest(manifestBytes), identitySha256, stateSha256 }
      await page.screenshot({ path: path.join(directory, 'prepared.png') })
    })
    await scenario('prototype and widget callers are denied while forged paths and receipts cannot replace the actual chooser', async () => {
      await assert.rejects(app.invoke('handoff_snapshot_prepare'), /not allowed|权限/i)
      await assert.rejects(app.invoke('handoff_snapshot_prepare', {}, widget), /not allowed|权限/i)
      const forged = path.join(data, 'forged-handoff')
      await page.evaluate(forged => {
        window.__handoffProbe = null
        void window.__TAURI_INTERNALS__.invoke('handoff_snapshot_prepare', { destination: forged, fingerprint: 'f'.repeat(64), receipt: { trusted: true } })
          .then(value => { window.__handoffProbe = { value } }, error => { window.__handoffProbe = { error: String(error) } })
      }, forged)
      await operateDialog(app, '选择交接快照保存位置', 'visible'); await select(root)
      const result = await waitFor(() => page.evaluate(() => window.__handoffProbe))
      assert.ok(!result.error, result.error); assert.equal(result.value.scope, 'same-profile-handoff')
      assert.equal(result.value.productionReady, false); assert.equal(result.value.migrationComplete, false)
      assert.equal(result.value.identityMode, 'original-profile-only'); assert.equal(result.value.externalTransferFiles, 'original-locations-required')
      assert.ok(result.value.path.startsWith(root + path.sep)); assert.notEqual(result.value.path, forged)
      assert.equal(await fs.stat(forged).then(() => true, () => false), false)
      await waitFor(() => api('lanSnapshot').then(value => value.enabled))
    })
    await scenario('invalid actual browser whitelist fails before any overall intent and preserves original state and input', async () => {
      const before = await fs.readdir(catalog), outputs = await snapshots()
      await page.evaluate(() => localStorage.setItem('widget-note:invalid-handoff', '{"title":42}'))
      await begin(); await select(root); await settled()
      assert.ok((await page.getByRole('alert').allTextContents()).length)
      assert.deepEqual(await fs.readdir(catalog), before); assert.deepEqual(await snapshots(), outputs)
      assert.equal(await page.evaluate(() => localStorage.getItem('widget-note:invalid-handoff')), '{"title":42}')
      await page.evaluate(() => localStorage.removeItem('widget-note:invalid-handoff'))
      await waitFor(() => api('lanSnapshot').then(value => value.enabled))
      assert.equal(digest(await fs.readFile(path.join(lan, 'identity.json'))), identitySha256)
      assert.equal(digest(await fs.readFile(path.join(lan, 'state.json'))), stateSha256)
    })
    await scenario('real Data hardlink failure cannot publish overall success and native restart aborts the V2 intent before editors', async () => {
      await fs.writeFile(path.join(data, 'blocked-handoff.bin'), 'preserve original source')
      const link = path.join(root, 'blocked-handoff-link.bin'); await fs.link(path.join(data, 'blocked-handoff.bin'), link)
      const before = await fs.readdir(catalog)
      await begin(); await select(root); await settled()
      await page.getByRole('alert').filter({ hasText: /链接/ }).waitFor()
      const pendingId = (await fs.readdir(catalog)).filter(name => /^[a-f0-9-]{36}$/.test(name)).find(name => !before.includes(name)); assert.ok(pendingId)
      const pendingBytes = await fs.readFile(path.join(catalog, pendingId, 'intent.json')), pending = JSON.parse(pendingBytes)
      assert.equal(pending.version, 2); assert.equal(await fs.stat(path.join(catalog, pendingId, 'decision.json')).then(() => true, () => false), false)
      assert.equal(await fs.stat(path.join(pending.destination, 'handoff.json')).then(() => true, () => false), false)
      await app.close({ preserve: true }); app = undefined; await fs.unlink(link)
      app = await launchTauri({ rootDirectory: root, workspace: true, lanLocalOnly: true }); page = app.page
      await page.locator('.app-shell').waitFor()
      const decision = JSON.parse(await fs.readFile(path.join(catalog, pendingId, 'decision.json'), 'utf8'))
      assert.equal(decision.version, 2); assert.equal(decision.outcome.state, 'aborted'); assert.equal(decision.intentSha256, digest(pendingBytes))
      assert.equal(await fs.readFile(path.join(data, 'blocked-handoff.bin'), 'utf8'), 'preserve original source')
      assert.equal(digest(await fs.readFile(path.join(data, 'workspace.json'))), workspaceFingerprint)
      assert.equal(digest(await fs.readFile(path.join(lan, 'identity.json'))), identitySha256)
      assert.equal((await page.evaluate(() => window.dustdesk.loadWorkspace())).SchemaVersion, 3)
      report.aborted = { intentId: pendingId, componentsSha256: pending.componentsSha256 }
    })
    await scenario('normal Tauri exit releases actual Data ownership and prepared Electron accepts the bundled exact native provenance', async () => {
      const child = app.child
      await app.invoke('application_quit', {}, page).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
      await waitFor(() => child.exitCode !== null || child.signalCode !== null); assert.equal(child.exitCode, 0)
      owner = await acquireWorkspaceOwnership(data)
      const provenance = await verifyDraftProvenance(owner, serialized, workspaceFingerprint)
      assert.equal(provenance.sourceRuntime, 'tauri'); assert.equal(provenance.archiveSha256, digest(serialized)); assert.equal(provenance.archiveId, verified.payload.id)
      await assert.rejects(verifyDraftProvenance(owner, JSON.stringify(JSON.parse(serialized), null, 2), workspaceFingerprint), /谱系/)
      report.provenance = provenance
      await owner.release(); owner = undefined
    })
    for (const [file, expected] of Object.entries(report.inputs)) assert.equal(digest(await fs.readFile(file)), expected, file)
    assert.equal(digest(await fs.readFile(app.executable)), report.executableSha256)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); report.output = app?.output(); throw error }
  finally {
    await owner?.release(); await app?.close()
    if (root && !app) await fs.rm(root, { recursive: true, force: true })
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  }
})
