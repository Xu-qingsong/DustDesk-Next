import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, copyFile, link, symlink, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const { verifyDraftArchive } = await import(draftModuleUrl)
const digest = value => createHash('sha256').update(value).digest('hex')

test('real Electron local receipts are verified read-only by Rust only under the current native snapshot and lease', async suite => {
  const report = 'artifacts/tauri-migration/draft-lineage-native.json'
  await rm(report, { force: true })
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-'))
  const data = path.join(root, 'user-data', 'tauri-preview', 'Workspace')
  const workspace = path.join(data, 'workspace.json'); const directory = path.join(data, 'MigrationLineage'); const ledgerPath = path.join(directory, 'lineage.json')
  const destination = path.join(root, 'electron-drafts.json')
  let electron; let app; let page; let archive; let verified; let originalLedger; let failed = false
  const results = []; const evidence = {}
  const scenario = async (name, callback) => {
    await suite.test(name, async () => { try { await callback(); results.push(name) } catch (error) { failed = true; console.error(app?.output()); throw error } })
    if (failed) throw Error('Native lineage scenario failed: ' + name)
  }
  const invoke = (command, args = {}, target = page) => app.invoke(command, args, target)
  const prepare = async () => { const checkpoint = await invoke('drafts_prepare'); await waitFor(() => page.evaluate(() => document.documentElement.inert)); return checkpoint }
  const verify = (checkpoint, serialized = archive, extra = {}) => invoke('drafts_verify', { requestId: checkpoint.requestId, serialized, ...extra })
  const end = async checkpoint => { assert.equal(await invoke('drafts_end', { requestId: checkpoint.requestId }), true); await waitFor(() => page.evaluate(() => !document.documentElement.inert)) }
  const openTauri = async options => {
    app = await launchTauri({ rootDirectory: root, ...options })
    await app.invoke('prototype_open_workspace')
    page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
  }
  try {
    await scenario('actual Electron exports a native receipt and exits normally before Rust takes the same isolated directory', async () => {
      electron = await launchDustDesk({ tempRoot: root, dataDirectory: data })
      await electron.window.evaluate(async () => {
        const baseline = await window.dustdesk.loadWorkspace(); const state = structuredClone(baseline)
        state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false; state.Settings.WidgetPlacements = {}; state.Settings.WidgetLayoutPresets = {}
        const saved = await window.dustdesk.saveWorkspace(state, baseline); if (!saved.ok) throw Error(saved.error)
        localStorage.setItem('widget-task-draft:v1:todo', JSON.stringify({ title: 'Electron 到 Rust 核验🪶', requestId: 'stable-cross-runtime-receipt' }))
      })
      await electron.electronApp.evaluate(({ dialog, Menu }, destination) => {
        globalThis.__nativeLineageExport = undefined
        dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
        dialog.showMessageBox = async () => { globalThis.__nativeLineageExport = 'success'; return { response: 0 } }
        dialog.showErrorBox = (_title, message) => { globalThis.__nativeLineageExport = message }
        Menu.getApplicationMenu().getMenuItemById('export-browser-drafts').click()
      }, destination)
      assert.equal(await waitFor(() => electron.electronApp.evaluate(() => globalThis.__nativeLineageExport), 45000), 'success')
      archive = await readFile(destination, 'utf8'); verified = await verifyDraftArchive(archive); originalLedger = await readFile(ledgerPath, 'utf8')
      const child = electron.electronApp.process()
      const quit = electron.electronApp.evaluate(({ app }) => app.quit()).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, 25000); await quit; assert.equal(child.exitCode, 0)
      await closeDustDesk({ ...electron, preserveTempRoot: true }); electron = undefined
      assert.equal(digest(await readFile(workspace)), verified.payload.source.workspaceFingerprint)
      evidence.nativeWorkspaceId = JSON.parse(originalLedger).workspaceId
      const before = JSON.parse(await readFile(workspace, 'utf8'))
      await openTauri()
      const after = JSON.parse(await readFile(workspace, 'utf8'))
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      if (changed.length) {
        await mkdir('artifacts/tauri-migration', { recursive: true })
        await writeFile('artifacts/tauri-migration/rust-lineage-startup-delta.json', JSON.stringify({ scope: 'isolated synthetic workspace only', changed, before: Object.fromEntries(changed.map(key => [key, before[key]])), after: Object.fromEntries(changed.map(key => [key, after[key]])) }, null, 2))
      }
      assert.equal(digest(await readFile(workspace)), verified.payload.source.workspaceFingerprint)
    })
    await scenario('only the real workspace owner under a Ready request can read native provenance', async () => {
      await assert.rejects(invoke('drafts_verify', { requestId: 'old', serialized: archive }), /失效|封存|过期/)
      await app.invoke('prototype_open_window', { kind: 'widget' }); const probe = await app.findPage('widget')
      const checkpoint = await prepare()
      try {
        assert.equal(checkpoint.workspaceFingerprint, verified.payload.source.workspaceFingerprint)
        await assert.rejects(app.invoke('drafts_verify', { requestId: checkpoint.requestId, serialized: archive, window: 'workspace-main' }), /not allowed|权限|denied/i)
        await assert.rejects(invoke('drafts_verify', { requestId: checkpoint.requestId, serialized: archive }, probe), /not allowed|权限|denied/i)
        const before = await readFile(workspace); const proof = await verify(checkpoint)
        assert.deepEqual(proof, { workspaceId: evidence.nativeWorkspaceId, archiveId: verified.payload.id, archiveSha256: digest(archive), workspaceFingerprint: checkpoint.workspaceFingerprint, sourceRuntime: 'electron' })
        assert.deepEqual(await verify(checkpoint), proof)
        assert.equal(await readFile(ledgerPath, 'utf8'), originalLedger); assert.deepEqual(await readFile(workspace), before)
        assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), null)
      } finally { await end(checkpoint) }
    })
    await scenario('valid archive checksums and renderer-supplied roots or fingerprints cannot authorize unrecorded bytes', async () => {
      const checkpoint = await prepare()
      try {
        await assert.rejects(verify(checkpoint, JSON.stringify(JSON.parse(archive), null, 2)), /回执|谱系/)
        const forged = JSON.parse(archive); const payload = JSON.parse(forged.payload); payload.id = randomUUID(); payload.entries[0].value = JSON.stringify({ title: 'forged', requestId: 'forged' }); forged.payload = JSON.stringify(payload); forged.sha256 = digest(forged.payload)
        await assert.rejects(verify(checkpoint, JSON.stringify(forged), { root, nativeFingerprint: payload.source.workspaceFingerprint, ledger: JSON.parse(originalLedger) }), /回执|谱系/)
        assert.equal((await verify(checkpoint)).archiveSha256, digest(archive))
      } finally { await end(checkpoint) }
    })
    await scenario('bad, future and duplicate native ledgers are preserved, not reset or repaired from the package', async () => {
      const checkpoint = await prepare()
      try {
        const parsed = JSON.parse(originalLedger)
        for (const changed of ['{broken-native', JSON.stringify({ ...parsed, version: 2 }), JSON.stringify({ ...parsed, exports: [parsed.exports[0], parsed.exports[0]] })]) {
          await writeFile(ledgerPath, changed); await assert.rejects(verify(checkpoint), /回执|谱系/); assert.equal(await readFile(ledgerPath, 'utf8'), changed)
        }
      } finally { await writeFile(ledgerPath, originalLedger); await end(checkpoint) }
    })
    await scenario('hardlinks and a real junction cannot redirect the fixed native ledger path', async () => {
      const checkpoint = await prepare(); const alias = path.join(root, 'ledger-alias.json'); const held = path.join(data, 'MigrationLineage-held'); const redirected = path.join(root, 'redirected')
      try {
        await link(ledgerPath, alias)
        try { await assert.rejects(verify(checkpoint), /回执|谱系/) } finally { await rm(alias) }
        await rename(directory, held); await mkdir(redirected); await copyFile(path.join(held, 'lineage.json'), path.join(redirected, 'lineage.json')); await symlink(redirected, directory, 'junction')
        try { await assert.rejects(verify(checkpoint), /链接|重解析/); assert.equal(await readFile(path.join(redirected, 'lineage.json'), 'utf8'), originalLedger) } finally { await rm(directory); await rename(held, directory) }
        assert.equal((await verify(checkpoint)).archiveId, verified.payload.id)
      } finally { await end(checkpoint) }
    })
    await scenario('workspace bytes must still equal the sealed native checkpoint even when semantic JSON is unchanged', async () => {
      const checkpoint = await prepare(); const before = await readFile(workspace)
      try {
        await writeFile(workspace, Buffer.concat([Buffer.from('\n'), before]))
        await assert.rejects(verify(checkpoint), /不一致/)
      } finally { await writeFile(workspace, before) }
      try { assert.equal((await verify(checkpoint)).workspaceFingerprint, digest(before)) } finally { await end(checkpoint) }
    })
    await scenario('ended requests cannot be reused as verification authority for a later checkpoint', async () => {
      const previous = await prepare(); await end(previous)
      const next = await prepare()
      try {
        await assert.rejects(verify(previous), /失效|过期/)
        assert.equal((await verify(next)).archiveId, verified.payload.id)
      } finally { await end(next) }
    })
    await scenario('expired native leases deny receipt verification after actual process restart', async () => {
      const child = app.child; await app.close({ preserve: true }); await waitFor(() => child.exitCode !== null || child.signalCode !== null); app = undefined
      await openTauri({ draftLeaseMs: 1000 }); const checkpoint = await prepare()
      assert.equal(checkpoint.leaseMilliseconds, 1000); assert.equal((await verify(checkpoint)).archiveId, verified.payload.id)
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      await assert.rejects(verify(checkpoint), /过期|失效/)
      assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), null)
    })
    await mkdir(path.dirname(report), { recursive: true })
    await writeFile(report, JSON.stringify({ productionReady: false, scenarios: results, evidence, scope: 'read-only native receipt and current workspace verification; no browser import or production path selection', remaining: ['atomic-native-import-and-recovery', 'production-source-discovery-and-snapshot-transfer', 'reverse-receipts-and-rollback', 'same-account-tamper-authentication'] }, null, 2))
  } finally {
    await app?.close({ preserve: true }); if (electron) await closeDustDesk({ ...electron, preserveTempRoot: true })
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
