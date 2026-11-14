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
const directory = 'artifacts/tauri-migration/draft-export'
const sources = ['src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/src/workspace/draft_export.rs','src-tauri/src/workspace/draft_lineage.rs','src-tauri/src/workspace/draft_browser.rs','src-tauri/src/workspace/export_file.rs','src-tauri/src/draft_maintenance.rs','src-tauri/src/system.rs','src-tauri/src/platform/shell.rs','src-tauri/src/platform/mod.rs','src-tauri/src/main.rs','src-tauri/permissions/workspace.toml','src-tauri/capabilities/workspace.json','src/renderer/src/runtime/DraftImportPanel.tsx','src/shared/draftMigration.ts','tests/reference/src/main/draftLineage.ts','tests/reference/src/main/workspaceOwnership.ts','tests/draft-lineage-module.mjs','tests/workspace-ownership-module.mjs','tests/tauri-draft-export.mjs']
test('native product export seals real editors and creates a Tauri archive that the prepared Electron provenance reader accepts', { timeout: 180000 }, async suite => {
  await fs.mkdir(directory, { recursive: true })
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [], scope: 'Isolated Tauri main window native save dialog, all-editor checkpoint and actual browser whitelist collection; prepared Electron provenance reader after Tauri exit; not full reverse import, trusted production handoff or rollback' }
  let app, owner
  let failed = false
  const scenario = async (name, run) => { await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } }); if (failed) throw Error('draft export scenario failed: ' + name) }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, digest(await fs.readFile(file))])))
    const fixture = await mainFixture(suite), initial = await fixture.load()
    initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false; initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; initial.DesktopCategories = []; initial.Launchers = []
    app = await launchTauri()
    report.executableSha256 = digest(await fs.readFile(app.executable))
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace')
    let page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const invoke = (command, args = {}) => app.invoke(command, args, page)
    const profile = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace')
    const ledger = path.join(profile, 'MigrationLineage', 'lineage.json')
    const destination = path.join(app.root, 'native-drafts.json')
    const begin = async () => {
      await page.getByRole('button', { name: '导出迁移草稿', exact: true }).click()
      await operateDialog(app, '导出迁移草稿', 'snapshot')
    }
    const select = async target => {
      const existed = await fs.stat(target).then(() => true, () => false)
      await operateDialog(app, '导出迁移草稿', 'select', target)
      if (existed) await operateDialog(app, '确认另存为', 'confirm')
    }
    const settled = async () => {
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await waitFor(() => page.getByRole('button', { name: '导出迁移草稿', exact: true }).isEnabled())
    }
    await scenario('only the actual main role can export and cancelling the save dialog creates no archive, ledger or maintenance pause', async () => {
      await assert.rejects(app.invoke('drafts_export', { path: destination, entries: [{ key: 'forged', value: 'forged' }] }), /not allowed|权限|denied/i)
      await begin(); await operateDialog(app, '导出迁移草稿', 'cancel'); await settled()
      assert.equal(await fs.stat(destination).then(() => true, () => false), false)
      assert.equal(await fs.stat(ledger).then(() => true, () => false), false)
      const state = await page.evaluate(() => window.dustdesk.loadWorkspace()); assert.equal(state.SchemaVersion, 3)
    })
    await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))
    const widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('widget.html') && page.url().includes('widget=todo')))
    await widget.getByLabel('桌面新增任务').fill('Tauri 回退草稿 中文🪶')
    const seed = [
      { key: 'widget-note:deleted-note', value: '{ "title":"旧草稿", "text":"原文\\r\\n🪶", "previousTitle":"", "previousText":"" }' },
      { key: 'widget-note:v2:notes:clean-note', value: '{"saved":true}' },
      { key: 'quick-capture-draft', value: '{"kind":"note","title":"快速草稿","text":"完整正文🪶","requestId":"keep-this-request"}' },
      { key: 'widget-notes:selected', value: 'deleted-note' },
      { key: 'widget-note:escaped-surrogates', value: String.raw`{ "title":"\ud800\ud83e\udeb6\udfff","text":"\\ud800", "previousTitle":"", "previousText":"" }` }
    ]
    await page.evaluate(seed => { for (const { key, value } of seed) localStorage.setItem(key, value); localStorage.setItem('private-cookie-fixture', 'never-export') }, seed)
    let serialized, verified
    await scenario('actual dirty widget input and exact whitelist values are exported with a native checkpoint and compatible durable receipt', async () => {
      await begin(); await select(destination); await settled()
      await page.getByRole('status').filter({ hasText: '已导出' }).waitFor()
      serialized = await fs.readFile(destination, 'utf8'); verified = await migration.verifyDraftArchive(serialized)
      assert.equal(verified.payload.source.runtime, 'tauri')
      assert.equal(verified.payload.source.workspaceFingerprint, digest(await fs.readFile(path.join(profile, 'workspace.json'))))
      for (const entry of seed) assert.deepEqual(verified.payload.entries.find(saved => saved.key === entry.key), entry)
      assert.ok(verified.payload.entries.some(entry => entry.key === migration.taskDraftStorageKey && JSON.parse(entry.value).title === 'Tauri 回退草稿 中文🪶'))
      assert.ok(!serialized.includes('never-export'))
      const receipt = JSON.parse(await fs.readFile(ledger, 'utf8')).exports.find(entry => entry.archiveId === verified.payload.id)
      assert.equal(receipt.archiveSha256, digest(serialized)); assert.equal(receipt.runtime, 'tauri')
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), 'Tauri 回退草稿 中文🪶')
      assert.equal(await page.evaluate(() => localStorage.getItem('private-cookie-fixture')), 'never-export')
    })
    await scenario('invalid future draft keys and damaged native history preserve the original target and resume every editor', async () => {
      const before = await fs.readFile(ledger)
      await page.evaluate(() => localStorage.setItem('widget-note:v99:future', '{"saved":true}'))
      await begin(); await select(destination); await settled()
      await page.getByRole('alert').filter({ hasText: '白名单' }).waitFor()
      assert.equal(await fs.readFile(destination, 'utf8'), serialized); assert.deepEqual(await fs.readFile(ledger), before)
      await page.evaluate(() => localStorage.removeItem('widget-note:v99:future'))
      await fs.writeFile(ledger, '{broken')
      await begin(); await select(destination); await settled()
      await page.getByRole('alert').filter({ hasText: '谱系' }).waitFor()
      assert.equal(await fs.readFile(destination, 'utf8'), serialized); assert.equal(await fs.readFile(ledger, 'utf8'), '{broken')
      await fs.writeFile(ledger, before)
      assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), 'Tauri 回退草稿 中文🪶')
      assert.equal(await widget.evaluate(() => document.documentElement.inert), false)
    })
    await scenario('native internal-data protection rejects a selected workspace target without pausing editors or changing workspace bytes', async () => {
      const target = path.join(profile, 'workspace.json'), before = await fs.readFile(target)
      await begin(); await select(target); await settled()
      await page.getByRole('alert').filter({ hasText: '内部数据目录' }).waitFor()
      assert.deepEqual(await fs.readFile(target), before)
    })
    await scenario('an actual read-only receipt write failure preserves the selected file, history and dirty editor and permits explicit retry', async () => {
      const before = await fs.readFile(ledger), target = path.join(app.root, 'write-fault.json')
      await fs.writeFile(target, 'keep destination')
      await fs.chmod(ledger, 0o444)
      try {
        await begin(); await select(target); await settled()
        await page.getByRole('alert').filter({ hasText: /拒绝|os error 5|MoveFileEx/i }).waitFor()
        assert.equal(await fs.readFile(target, 'utf8'), 'keep destination'); assert.deepEqual(await fs.readFile(ledger), before)
        assert.equal((await fs.readdir(app.root)).some(name => name.startsWith('.dustdesk-export-')), false)
        assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), 'Tauri 回退草稿 中文🪶')
      } finally { await fs.chmod(ledger, 0o666) }
      const retry = path.join(app.root, 'write-retry.json')
      await begin(); await select(retry); await settled()
      await migration.verifyDraftArchive(await fs.readFile(retry, 'utf8'))
      const history = JSON.parse(await fs.readFile(ledger, 'utf8')).exports
      assert.equal(history.length, JSON.parse(before).exports.length + 1)
    })
    await scenario('normal Tauri exit releases the physical workspace and the actual prepared Electron reader accepts exact native provenance', async () => {
      const child = app.child
      await invoke('application_quit').catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
      await waitFor(() => child.exitCode !== null || child.signalCode !== null); assert.equal(child.exitCode, 0)
      owner = await acquireWorkspaceOwnership(profile)
      const provenance = await verifyDraftProvenance(owner, serialized, digest(await fs.readFile(path.join(profile, 'workspace.json'))))
      assert.equal(provenance.sourceRuntime, 'tauri'); assert.equal(provenance.archiveSha256, digest(serialized)); assert.equal(provenance.archiveId, verified.payload.id)
      await assert.rejects(verifyDraftProvenance(owner, JSON.stringify(JSON.parse(serialized), null, 2), verified.payload.source.workspaceFingerprint), /谱系/)
      report.provenance = provenance
      await owner.release(); owner = undefined
    })
    await scenario('a real browser collection delayed beyond the native Ready deadline cannot publish a file or receipt and releases the editors', async () => {
      const root = app.root; await app.close({ preserve: true })
      app = await launchTauri({ rootDirectory: root, workspace: true, draftLeaseMs: 1000 }); page = app.page
      await page.locator('.app-shell').waitFor()
      const before = await fs.readFile(ledger), target = path.join(root, 'expired-export.json')
      await page.evaluate(() => {
        localStorage.setItem('widget-note:expired-export', JSON.stringify({title:'',text:'EXPORT_DELAY',previousTitle:'',previousText:''}))
        const original = TextEncoder.prototype.encode
        TextEncoder.prototype.encode = function(value) {
          if (String(value).includes('EXPORT_DELAY')) { TextEncoder.prototype.encode = original; const end = performance.now() + 1600; while (performance.now() < end) {} }
          return original.call(this, value)
        }
      })
      await begin(); await select(target); await settled()
      await page.getByRole('alert').filter({ hasText: /失效|过期/ }).waitFor()
      assert.equal(await fs.stat(target).then(() => true, () => false), false); assert.deepEqual(await fs.readFile(ledger), before)
      assert.equal(await page.evaluate(() => document.documentElement.inert), false)
      assert.ok(await page.evaluate(() => localStorage.getItem('widget-note:expired-export')))
    })
    for (const [file, expected] of Object.entries(report.inputs)) assert.equal(digest(await fs.readFile(file)), expected, file)
    assert.equal(digest(await fs.readFile(app.executable)), report.executableSha256)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally { await owner?.release(); await app?.close(); await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2)) }
})
