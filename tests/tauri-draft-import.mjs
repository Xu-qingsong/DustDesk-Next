import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl)
const digest = value => createHash('sha256').update(value).digest('hex')
const report = 'artifacts/tauri-migration/draft-import-product-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('isolated product import uses actual native selection, provenance, irreversible decisions and all-editor reload', async suite => {
  const evidence = []
  let suiteFailed = false
  for (const mode of ['normal', 'existing-target', 'lost-begin-response', 'lost-commit-response', 'expired-after-begin', 'receipt-write-failure']) {
    await suite.test(mode, async scenario => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-'))
      const data = path.join(root, 'user-data', 'tauri-preview', 'Workspace')
      const destination = path.join(root, 'exported-drafts.json')
      let electron; let app; let page; let widget; let archive; let verified; let overlay; let overlayIdentity
      const choose = async target => {
        await page.getByRole('button', { name: '导入草稿迁移包', exact: true }).click()
        await operateDialog(app, '选择草稿迁移包', 'select', target)
      }
      const scenarioEvidence = { mode }
      const step = async (name, callback) => {
        let failed = false
        await scenario.test(name, async () => { try { await callback() } catch (error) { failed = true; throw error } })
        if (failed) throw Error('Native product import step failed: ' + name)
      }
      try {
        electron = await launchDustDesk({ tempRoot: root, dataDirectory: data })
        await electron.window.evaluate(async () => {
          const baseline = await window.dustdesk.loadWorkspace(); const state = structuredClone(baseline)
          state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false; state.Settings.WidgetPlacements = {}; state.Settings.WidgetLayoutPresets = {}
          const saved = await window.dustdesk.saveWorkspace(state, baseline); if (!saved.ok) throw Error(saved.error)
          const visible = await window.dustdesk.setWidgetVisibility('todo', true); if (!visible.ok) throw Error(visible.error)
        })
        const sourceWidget = await waitFor(() => electron.electronApp.windows().find(target => target.url().includes('widget=todo')))
        await sourceWidget.getByLabel('桌面新增任务').fill('产品导入草稿🪶')
        await electron.electronApp.evaluate(({ dialog, Menu }, destination) => {
          globalThis.__productExport = undefined
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
          dialog.showMessageBox = async () => { globalThis.__productExport = 'success'; return { response: 0 } }
          dialog.showErrorBox = (_title, message) => { globalThis.__productExport = message }
          Menu.getApplicationMenu().getMenuItemById('export-browser-drafts').click()
        }, destination)
        assert.equal(await waitFor(() => electron.electronApp.evaluate(() => globalThis.__productExport), 45000), 'success')
        archive = await readFile(destination, 'utf8'); verified = await migration.verifyDraftArchive(archive)
        assert.ok(verified.payload.entries.some(entry => entry.key === migration.taskDraftStorageKey && entry.value.includes('产品导入草稿')))
        const source = electron.electronApp.process(); const quitting = electron.electronApp.evaluate(({ app }) => app.quit()).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
        await waitFor(() => source.exitCode !== null || source.signalCode !== null); await quitting; assert.equal(source.exitCode, 0)
        await closeDustDesk({ ...electron, preserveTempRoot: true }); electron = undefined
        app = await launchTauri({ rootDirectory: root, draftLeaseMs: mode === 'expired-after-begin' ? 1000 : undefined })
        await app.invoke('prototype_open_workspace')
        page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
        await page.locator('.app-shell').waitFor()
        widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html')))
        await widget.getByLabel('桌面新增任务').waitFor()
        assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '')
        if (mode === 'existing-target') await widget.getByLabel('桌面新增任务').fill('目标已有草稿不覆盖')
        const nativeRecord = path.join(data, 'MigrationTransaction.json')
        if (mode === 'normal') {
          await step('main-only commands reject prototype and actual widget callers before opening dialogs', async () => {
            for (const target of [app.page, widget]) for (const command of ['drafts_pick', 'drafts_import_state']) await assert.rejects(app.invoke(command, {}, target), /not allowed|权限|此窗口/i)
          })
          await step('native file cancellation never creates a checkpoint or browser journal', async () => {
            await page.getByRole('button', { name: '导入草稿迁移包', exact: true }).click()
            await operateDialog(app, '选择草稿迁移包', 'cancel')
            await waitFor(() => page.getByRole('button', { name: '导入草稿迁移包', exact: true }).isEnabled())
            assert.equal(await page.getByRole('region', { name: '草稿导入预览' }).count(), 0)
            assert.equal(await page.evaluate(() => localStorage.getItem('dustdesk:draft-migration:pending:v1')), null)
            assert.equal(await page.evaluate(() => document.documentElement.inert), false)
          })
          await step('malformed files remain errors rather than becoming empty imports', async () => {
            const invalid = path.join(root, 'malformed.json'); await writeFile(invalid, '{invalid')
            await choose(invalid); await page.locator('.tauri-draft-import [role="alert"]').waitFor()
            assert.equal(await page.getByRole('region', { name: '草稿导入预览' }).count(), 0)
          })
          await step('preview cancellation does not freeze editors or create a native transaction', async () => {
            await choose(destination); await page.getByRole('region', { name: '草稿导入预览' }).waitFor()
            await page.getByRole('button', { name: '取消导入', exact: true }).click()
            assert.equal(await page.evaluate(() => document.documentElement.inert), false)
            assert.equal(await app.invoke('drafts_import_state', {}, page), null)
            await assert.rejects(readFile(nativeRecord), { code: 'ENOENT' })
          })
          await step('syntactically valid but unreceipted archives fail native provenance without writes and resume every editor', async () => {
            const forged = path.join(root, 'unreceipted.json')
            await writeFile(forged, await migration.createDraftArchive(verified.payload.entries, verified.payload.source))
            await choose(forged); await page.getByRole('region', { name: '草稿导入预览' }).waitFor()
            await page.getByRole('button', { name: '确认导入并重载编辑器' }).click()
            await waitFor(async () => (await page.locator('.tauri-draft-import [role="alert"]').allTextContents()).some(text => /回执|谱系/.test(text)))
            await waitFor(() => page.evaluate(() => !document.documentElement.inert))
            await waitFor(() => widget.evaluate(() => !document.documentElement.inert))
            assert.equal(await page.evaluate(() => localStorage.getItem('dustdesk:draft-migration:pending:v1')), null)
            assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '')
            assert.equal(await app.invoke('drafts_import_state', {}, page), null)
          })
        }
        await step('confirmed import verifies persisted native completion and reloads both actual editors', async () => {
          if (mode === 'normal') {
            const started = await page.evaluate(() => window.dustdesk.startScreenshot('FullScreen')); assert.equal(started.ok, true)
            overlay = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('capture.html')))
            await waitFor(() => overlay.getByRole('button', { name: '文字', exact: true }).isEnabled())
            await overlay.getByRole('button', { name: '文字', exact: true }).click(); await overlay.mouse.click(180, 220)
            await overlay.getByRole('textbox', { name: '标注文字' }).fill('草稿导入保留截图文字')
            overlayIdentity = await overlay.evaluate(() => { window.__importEditorIdentity = crypto.randomUUID(); return window.__importEditorIdentity })
          }
          await choose(destination); await page.getByRole('region', { name: '草稿导入预览' }).waitFor()
          await writeFile(destination, '{changed-after-native-selection')
          if (mode.startsWith('lost-') || mode === 'expired-after-begin') await page.evaluate(mode => {
            const original = window.fetch.bind(window)
            let lost = false
            window.fetch = async (input, init) => {
              const result = await original(input, init)
              if (!String(input).includes('ipc.localhost/drafts_transaction')) return result
              const args = JSON.parse(init.body)
              if (!lost && mode === 'expired-after-begin' && args.serialized) {
                if (result.headers.get('Tauri-Response') !== 'ok') throw Error('Expiry injection expected successful native begin')
                lost = true
                await new Promise(resolve => setTimeout(resolve, 1600))
                sessionStorage.setItem('product-import-fault-injected', mode)
                return result
              }
              if (!lost && ((mode === 'lost-commit-response' && args.commit === true) || (mode === 'lost-begin-response' && args.serialized))) {
                if (result.headers.get('Tauri-Response') !== 'ok') throw Error('Fault injection expected successful native result')
                lost = true
                sessionStorage.setItem('product-import-fault-injected', mode)
                return new Response('injected lost native response', { headers: { 'Content-Type': 'text/plain', 'Tauri-Response': 'error' } })
              }
              return result
            }
          }, mode)
          if (mode === 'receipt-write-failure') await page.evaluate(() => {
            const original = Storage.prototype.setItem
            let failed = false
            Storage.prototype.setItem = function (key, value) {
              if (!failed && this === localStorage && key === 'dustdesk:draft-migration:receipts:v1') { failed = true; sessionStorage.setItem('product-import-fault-injected', 'receipt-write-failure'); throw Error('injected receipt write failure after native commit') }
              return original.call(this, key, value)
            }
          })
          await Promise.all([page.waitForEvent('domcontentloaded'), widget.waitForEvent('domcontentloaded'), page.getByRole('button', { name: '确认导入并重载编辑器' }).click()])
          await page.locator('.app-shell').waitFor(); await widget.getByLabel('桌面新增任务').waitFor()
          if (overlay) {
            assert.equal(overlay.isClosed(), false)
            await waitFor(() => overlay.locator('.screenshot-editor').evaluate(element => !element.inert))
            assert.equal(await overlay.evaluate(() => window.__importEditorIdentity), overlayIdentity)
            assert.equal(await overlay.getByRole('textbox', { name: '标注文字' }).inputValue(), '草稿导入保留截图文字')
            scenarioEvidence.screenshotEditorPreservedAcrossMainRefresh = true
            await app.invoke('screenshot_overlay_cancel', {}, overlay); await waitFor(() => overlay.isClosed()); overlay = undefined
          }
          const aborted = mode === 'lost-begin-response' || mode === 'expired-after-begin'
          const expectedInput = aborted ? '' : mode === 'existing-target' ? '目标已有草稿不覆盖' : '产品导入草稿🪶'
          assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), expectedInput)
          const record = JSON.parse(await readFile(nativeRecord, 'utf8'))
          assert.equal(record.completed, true); assert.equal(record.decision, aborted ? 'abort' : 'commit'); assert.equal(record.archiveSha256, digest(archive))
          if (mode === 'existing-target') assert.equal(record.writes.length, 0)
          assert.equal(await page.evaluate(() => localStorage.getItem('dustdesk:draft-migration:pending:v1')), null)
          assert.equal(await page.evaluate(() => document.documentElement.inert), false)
          if (mode.startsWith('lost-') || mode === 'expired-after-begin' || mode === 'receipt-write-failure') assert.equal(await page.evaluate(() => sessionStorage.getItem('product-import-fault-injected')), mode, 'Fault injection must actually execute before native evidence can count')
          if (mode !== 'receipt-write-failure') await waitFor(() => page.locator('.tauri-draft-import [role="status"]').textContent().then(text => text.includes(aborted ? '中止导入' : '草稿导入完成')))
          assert.equal(digest(await readFile(path.join(data, 'workspace.json'))), verified.payload.source.workspaceFingerprint)
          scenarioEvidence.completedTransaction = record.transactionId; scenarioEvidence.nativeDecision = record.decision; scenarioEvidence.allEditorsReloaded = true; scenarioEvidence.selectedBytesBoundBeforeFileChange = true
          scenarioEvidence.verifiedFaultInjection = !['normal', 'existing-target'].includes(mode)
        })
        if (mode !== 'lost-begin-response' && mode !== 'expired-after-begin') await step('reimporting the same archive respects consumed inputs and does not publish a new native transaction', async () => {
          await widget.getByLabel('桌面新增任务').fill('')
          await waitFor(() => widget.evaluate(() => JSON.parse(localStorage.getItem('widget-task-draft:v1:todo')).title === ''))
          const cleared = await widget.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo'))
          await writeFile(destination, archive); await choose(destination)
          await page.getByRole('region', { name: '草稿导入预览' }).waitFor()
          await page.getByRole('button', { name: '确认导入并重载编辑器' }).click()
          await waitFor(() => page.locator('.tauri-draft-import [role="status"]').textContent().then(text => text.includes('已导入')))
          assert.equal(await widget.getByLabel('桌面新增任务').inputValue(), '')
          assert.equal(await widget.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), cleared)
          assert.equal(JSON.parse(await readFile(nativeRecord, 'utf8')).transactionId, scenarioEvidence.completedTransaction)
          scenarioEvidence.duplicateDoesNotResurrectConsumedInput = true
        })
        evidence.push(scenarioEvidence)
      } catch (error) {
        suiteFailed = true
        console.error('Product import mode:', mode, await page?.locator('[role="alert"]').allTextContents().catch(() => []), app?.output())
        throw error
      } finally {
        await app?.close({ preserve: true }); if (electron) await closeDustDesk({ ...electron, preserveTempRoot: true })
        assert.ok(path.isAbsolute(root) && root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('dustdesk-tauri-test-'))
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      }
    })
    if (suiteFailed) throw Error('Native product import scenario failed: ' + mode)
  }
  await writeFile(report, JSON.stringify({ productionReady: false, scope: 'isolated-product-native-selection-and-receipted-draft-import', evidence, remaining: ['production-source-and-snapshot-transfer', 'complete-failure-matrix', 'orphan-journal-user-recovery', 'reverse-import-and-rollback'] }, null, 2))
})
