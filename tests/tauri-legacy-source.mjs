import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

const directory = 'artifacts/tauri-migration/legacy-source-native'
const title = '选择正式旧版安装目录（仅校验，不运行或迁移）'
const sources = ['src-tauri/src/legacy_source.rs', 'src-tauri/src/legacy_source/tests.rs', 'src-tauri/trust/legacy-windows-x64.json', 'src-tauri/src/workspace/legacy_source.rs', 'src-tauri/src/lib.rs', 'src-tauri/src/main.rs', 'src-tauri/src/workspace/mod.rs', 'src-tauri/permissions/workspace.toml', 'src-tauri/capabilities/workspace.json', 'src/renderer/src/runtime/DraftImportPanel.tsx', 'tests/legacy-source-reference.mjs', 'tests/tauri-legacy-source.mjs']

test('native main-only chooser identifies exact official release bytes without executing legacy code or authorizing migration', { timeout: 240000 }, async suite => {
  await fs.mkdir(directory, { recursive: true })
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [], scope: 'Actual isolated native chooser plus official ZIP SHA256 and exact extracted EXE/app.asar; installation identification only. No legacy execution, production profile/data/browser/LAN read, takeover, rollback, signature/full-tree safety or release packaging acceptance.' }
  let app, page, failed = false
  const scenario = async (name, run) => {
    await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Legacy source scenario failed: ' + name)
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
    const fixture = await mainFixture(suite), initial = await fixture.load()
    initial.Settings.AutomaticBackupEnabled = false; initial.Settings.ClipboardMonitoringEnabled = false
    initial.Settings.WidgetPlacements = {}; initial.Settings.WidgetLayoutPresets = {}; initial.DesktopCategories = []; initial.Launchers = []
    app = await launchTauri({ lanLocalOnly: true })
    report.executableSha256 = await fileDigest(app.executable)
    await app.invoke('prototype_workspace_initialize', { state: initial }); await app.invoke('prototype_open_workspace')
    page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const profile = path.join(app.root, 'user-data', 'tauri-preview'), data = path.join(profile, 'Workspace')
    const workspaceSha256 = await fileDigest(path.join(data, 'workspace.json'))
    const reference = await extractOfficialLegacyReference(app.root)
    report.reference = { release: reference.release, zipPath: reference.zipPath, extractionOnly: true, legacyExecuted: false }
    const button = () => page.getByRole('button', { name: '校验正式旧版来源（不迁移）', exact: true })
    const settled = () => waitFor(() => button().isEnabled())
    const choose = async target => {
      await button().click(); await operateDialog(app, title, 'visible')
      await operateDialog(app, title, 'select', target); await settled()
    }
    await scenario('prototype capability cannot access the inspection command', async () => {
      await assert.rejects(app.invoke('legacy_source_inspect'), /not allowed|not found|unknown|不存在|权限/i)
    })
    await scenario('renderer paths hashes and fake receipts cannot bypass real native selection or cancel', async () => {
      const pending = app.invoke('legacy_source_inspect', { path: reference.root, sha256: reference.release.files[0].sha256, receipt: { trusted: true } }, page)
      await operateDialog(app, title, 'visible'); await operateDialog(app, title, 'cancel')
      assert.deepEqual(await pending, { canceled: true })
    })
    await scenario('native UI rejects an arbitrary installation without creating files', async () => {
      const fake = path.join(app.root, 'fake-installation'); await fs.mkdir(fake)
      await choose(fake)
      await page.getByRole('alert').filter({ hasText: '旧版安装来源校验失败' }).waitFor()
      assert.deepEqual(await fs.readdir(fake), [])
    })
    await scenario('native proof matches both genuine critical files and is explicitly identification-only', async () => {
      const pending = app.invoke('legacy_source_inspect', {}, page)
      await operateDialog(app, title, 'visible'); await operateDialog(app, title, 'select', reference.root)
      const proof = await pending
      assert.equal(proof.purpose, 'installation-identification-only'); assert.deepEqual(proof.release, reference.release)
      for (const field of ['productionReady', 'migrationComplete', 'legacyExecuted', 'productionDataRead']) assert.equal(proof[field], false)
      assert.equal(path.resolve(proof.installation), path.resolve(reference.root))
      assert.ok(proof.rootIdentity.index); assert.ok(proof.resourcesIdentity.index)
      report.proof = proof
    })
    await scenario('actual main UI states no legacy execution data read or switch authorization', async () => {
      await choose(reference.root)
      await page.getByRole('status').filter({ hasText: '旧版安装的 EXE 与 app.asar 已匹配受信任正式版 1.0.2' }).waitFor()
      assert.match(await page.getByRole('status').filter({ hasText: '旧版安装的 EXE' }).textContent(), /未运行旧程序、读取旧数据或授权切换/)
      await page.screenshot({ path: path.join(directory, 'official-source.png') })
    })
    await scenario('completed informational proof holds no locks and cannot authorize same-size substituted bytes', async () => {
      const original = path.join(reference.root, 'resources', 'app.asar'), held = original + '.original'
      await fs.rename(original, held); await fs.copyFile(held, original)
      const handle = await fs.open(original, 'r+')
      try { await handle.write(Buffer.from([0x7f]), 0, 1, 0) } finally { await handle.close() }
      await choose(reference.root)
      await page.getByRole('alert').filter({ hasText: '未同时匹配同一个受信任正式发行版' }).waitFor()
      assert.equal(await fileDigest(held), reference.release.files[1].sha256)
    })
    await scenario('identification leaves isolated workspace bytes unchanged and creates no migration decision snapshot or LAN identity', async () => {
      assert.equal(await fileDigest(path.join(data, 'workspace.json')), workspaceSha256)
      assert.ok(!(await fs.readdir(data)).some(name => /MigrationTransaction|MigrationBrowserJournal|MigrationLineage/.test(name)))
      assert.ok(!(await fs.readdir(profile)).some(name => name.startsWith('.DustDeskSnapshotPreparation-')))
      assert.equal(await fs.stat(path.join(profile, 'LanTransfers', 'identity.json')).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error)), false)
    })
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs)
    report.verified = true
  } finally {
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    await app?.close()
  }
})
