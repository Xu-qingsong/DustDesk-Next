import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, chmod, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { draftModuleUrl, draftModuleSource } from './draft-module.mjs'
import ts from 'typescript'

const { verifyDraftArchive } = await import(draftModuleUrl)
const digest = value => createHash('sha256').update(value).digest('hex')
const moduleSource = ts.transpileModule(await draftModuleSource(), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const install = page => page.evaluate('(() => { const exports = {}; ' + moduleSource + '; window.__draftMigration = exports; })()')
const report = 'artifacts/tauri-migration/draft-transaction-native.json'
async function holdRecord(location) {
  const child = spawn('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', path.resolve('tests/tauri-record-reader.ps1'), '-Path', location], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { errors += bytes })
  const exit = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)) })
  try {
    const before = await waitFor(() => {
      assert.equal(child.exitCode, null, errors)
      return output.match(/^ready:([a-f0-9]{64})/m)?.[1]
    })
    let released
    return { before, release: () => released ??= (async () => {
      child.stdin.end('\n')
      assert.equal(await exit, 0, errors)
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))
      assert.equal(result.before, before); assert.equal(result.after, before); assert.equal(result.unchanged, true)
      return result
    })() }
  } catch (error) { child.stdin.end('\n'); await exit; throw error }
}
function launchHidden(root) {
  let output = ''
  const environment = { ...process.env, DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'), DUSTDESK_TEST_DESKTOP_DIR: path.join(root, 'desktop'), DUSTDESK_TAURI_DISABLE_HOTKEYS: '1' }
  delete environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
  const child = spawn(path.resolve(process.env.DUSTDESK_TAURI_EXECUTABLE || 'src-tauri/target/debug/DustDesk.exe'), ['--hidden'], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const close = async () => {
    if (child.pid && child.exitCode === null) {
      try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {}
    }
    await waitFor(() => child.exitCode !== null || child.signalCode !== null)
  }
  const processes = () => {
    const script = '$rows = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add(' + child.pid + '); do { $added = $false; foreach ($row in $rows) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true } } } while ($added); ConvertTo-Json -InputObject @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,Name) -Compress'
    return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true }))
  }
  return { child, close, processes, output: () => output }
}
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native profile-bound browser recovery verifies actual storage before editors reopen', async suite => {
  const evidence = []
  for (const scenario of ['commit', 'abort', 'shared-reader-commit', 'shared-reader-abort', 'completed-abort-input', 'expiry', 'pending', 'missing-journal', 'missing-values', 'changed-journal', 'changed-native-journal', 'different-profile', 'tray-commit', 'tray-abort', 'tray-pending', 'read-only-abort', 'read-only-completion']) {
    const readOnlyRecord = scenario.startsWith('read-only-')
    const mode = scenario === 'read-only-abort' ? 'pending' : scenario === 'read-only-completion' ? 'commit' : scenario === 'completed-abort-input' ? 'abort' : scenario.replace(/^(?:tray-|shared-reader-)/, '')
    await suite.test(scenario + ' respects the native decision and actual storage ownership', async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-'))
      const data = path.join(root, 'user-data', 'tauri-preview', 'Workspace'); const destination = path.join(root, 'drafts.json')
      let electron; let app; let page; let reader
      try {
        electron = await launchDustDesk({ tempRoot: root, dataDirectory: data })
        await electron.window.evaluate(async () => {
          const baseline = await window.dustdesk.loadWorkspace(); const state = structuredClone(baseline)
          state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false; state.Settings.WidgetPlacements = {}; state.Settings.WidgetLayoutPresets = {}
          const saved = await window.dustdesk.saveWorkspace(state, baseline); if (!saved.ok) throw Error(saved.error)
          localStorage.setItem('widget-task-draft:v1:todo', JSON.stringify({ title: '事务来源草稿🪶', requestId: 'stable-native-transaction' }))
        })
        if (mode === 'pending') {
          assert.equal((await electron.window.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))).ok, true)
          const sourceWidget = await waitFor(() => electron.electronApp.windows().find(page => page.url().includes('widget=todo')))
          await sourceWidget.getByLabel('桌面新增任务').waitFor()
        }
        await electron.electronApp.evaluate(({ dialog, Menu }, destination) => {
          globalThis.__transactionExport = undefined
          dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
          dialog.showMessageBox = async () => { globalThis.__transactionExport = 'success'; return { response: 0 } }
          dialog.showErrorBox = (_title, message) => { globalThis.__transactionExport = message }
          Menu.getApplicationMenu().getMenuItemById('export-browser-drafts').click()
        }, destination)
        assert.equal(await waitFor(() => electron.electronApp.evaluate(() => globalThis.__transactionExport), 45000), 'success')
        const archive = await readFile(destination, 'utf8'); const verified = await verifyDraftArchive(archive)
        const source = electron.electronApp.process(); const quitting = electron.electronApp.evaluate(({ app }) => app.quit()).catch(error => { assert.match(String(error), /closed|destroyed|disconnected/i) })
        await waitFor(() => source.exitCode !== null || source.signalCode !== null); await quitting; assert.equal(source.exitCode, 0)
        await closeDustDesk({ ...electron, preserveTempRoot: true }); electron = undefined
        const open = async () => {
          app = await launchTauri({ rootDirectory: root, draftLeaseMs: mode === 'expiry' ? 1000 : undefined })
          await app.invoke('prototype_open_workspace')
          page = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('tauri.html')))
        }
        await open(); await page.locator('.app-shell').waitFor(); await install(page)
        const invoke = args => app.invoke('drafts_transaction', args, page)
        assert.equal(await invoke(), null)
        await assert.rejects(app.invoke('drafts_transaction'), /not allowed|权限|此窗口/i)
        await assert.rejects(invoke({ requestId: randomUUID(), serialized: archive, journalSha256: 'a'.repeat(64) }), /失效|过期|暂存日志/)
        assert.equal(await invoke(), null)
        let widget
        if (mode === 'pending') {
          widget = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('widget.html')))
          await widget.getByLabel('桌面新增任务').waitFor()
          await assert.rejects(app.invoke('drafts_transaction', {}, widget), /not allowed|权限|此窗口/i)
          assert.equal(JSON.parse(await readFile(path.join(data, 'workspace.json'), 'utf8')).Settings.WidgetPlacements.todo.Visible, true)
        }
        let checkpoint = await app.invoke('drafts_prepare', {}, page)
        await assert.rejects(invoke({ requestId: checkpoint.requestId, serialized: '{}', journalSha256: 'a'.repeat(64) }), /回执|谱系|暂存日志/)
        assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }, page), true)
        checkpoint = await app.invoke('drafts_prepare', {}, page)
        const journal = JSON.stringify({ id: verified.payload.id, sha256: verified.archive.sha256, writes: verified.payload.entries })
        const staged = await page.evaluate(async ({ archive, fingerprint }) => {
          const migration = window.__draftMigration
          const prepared = await migration.prepareDraftImport(archive, fingerprint)
          window.__draftTransaction = prepared.stage(localStorage, () => document.documentElement.inert)
          return { journal: localStorage.getItem(migration.draftMigrationJournalKey), receipt: localStorage.getItem(migration.draftMigrationReceiptsKey) }
        }, { archive, fingerprint: verified.payload.source.workspaceFingerprint })
        assert.equal(staged.journal, journal); assert.equal(staged.receipt, null)
        await assert.rejects(invoke({ requestId: checkpoint.requestId, serialized: archive, journalSha256: '0'.repeat(64) }), /不匹配/)
        assert.equal(await invoke(), null)
        const pending = await invoke({ requestId: checkpoint.requestId, serialized: archive, journalSha256: digest(journal) })
        assert.equal(pending.decision, 'pending'); assert.equal(pending.archiveSha256, digest(archive)); assert.equal(pending.journalSha256, digest(journal))
        assert.equal(pending.requestId, checkpoint.requestId)
        assert.match(pending.browserBinding, /^[a-f0-9]{64}$/); assert.equal(pending.payloadSha256, verified.archive.sha256)
        const record = path.join(data, 'MigrationTransaction.json')
        assert.equal(JSON.parse(await readFile(record, 'utf8')).decision, 'pending')
        await assert.rejects(invoke({ requestId: randomUUID(), transactionId: pending.transactionId, commit: true }), /不属于/)
        await assert.rejects(invoke({ requestId: checkpoint.requestId, transactionId: randomUUID(), commit: true }), /不属于/)
        await assert.rejects(app.invoke('workspace_load', {}, page), /受控恢复/)
        assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }, page), false)
        await assert.rejects(app.invoke('drafts_recovery', { finish: true }, page), /尚未清理|尚无恢复终态/)
        if (mode === 'expiry') await new Promise(resolve => setTimeout(resolve, 1600))
        assert.equal(await page.evaluate(() => document.documentElement.inert), true)
        let expected = pending
        if (scenario.startsWith('shared-reader-')) {
          reader = await holdRecord(record)
          assert.equal(reader.before, digest(await readFile(record)))
        }
        if (mode !== 'pending') {
          expected = await invoke({ requestId: checkpoint.requestId, transactionId: pending.transactionId, commit: mode !== 'abort' })
          assert.equal(expected.decision, mode === 'abort' || mode === 'expiry' ? 'abort' : 'commit')
          const opposite = await invoke({ requestId: checkpoint.requestId, transactionId: pending.transactionId, commit: mode === 'abort' })
          assert.deepEqual(opposite, expected)
        }
        if (reader) {
          assert.notEqual(digest(await readFile(record)), reader.before)
          await reader.release(); reader = undefined
          reader = await holdRecord(record)
          assert.equal(reader.before, digest(await readFile(record)))
        }
        assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), verified.payload.entries.find(entry => entry.key === 'widget-task-draft:v1:todo').value)
        if (mode === 'missing-journal') await page.evaluate(() => localStorage.removeItem('dustdesk:draft-migration:pending:v1'))
        if (mode === 'missing-values') await page.evaluate(() => { localStorage.removeItem('dustdesk:draft-migration:pending:v1'); localStorage.removeItem('widget-task-draft:v1:todo') })
        if (mode === 'changed-journal') await page.evaluate(() => localStorage.setItem('dustdesk:draft-migration:pending:v1', '{changed-journal'))
        assert.equal(digest(await readFile(path.join(data, 'workspace.json'))), verified.payload.source.workspaceFingerprint)
        if (mode !== 'changed-journal') {
          const child = app.child; await app.close({ preserve: true }); await waitFor(() => child.exitCode !== null || child.signalCode !== null); app = undefined
        }
        if (mode === 'different-profile') {
          const profile = path.join(root, 'user-data', 'tauri-preview', 'WebView2')
          await rename(profile, profile + '-held'); await mkdir(profile)
        }
        const nativeJournal = path.join(data, 'MigrationBrowserJournal.json')
        const originalNativeJournal = await readFile(nativeJournal, 'utf8')
        if (mode === 'changed-native-journal') await writeFile(nativeJournal, '{changed-native-journal')
        const originalRecord = await readFile(record, 'utf8')
        if (readOnlyRecord) await chmod(record, 0o444)
        let trayProcesses
        if (scenario.startsWith('tray-')) {
          if (mode === 'pending') {
            app = await launchTauri({ rootDirectory: root, widgetStartup: 'todo' })
            await app.page.getByLabel('桌面新增任务').waitFor()
            assert.equal(await app.page.getByLabel('桌面新增任务').inputValue(), '')
            assert.ok(!app.browser.contexts().flatMap(context => context.pages()).some(target => /tauri\.html|recovery\.html/.test(target.url())), 'Tray recovery must restore visible widgets without retaining a main or recovery page')
            await assert.rejects(app.invoke('drafts_startup_done', { error: null }), /not allowed|权限|此窗口/i)
          } else {
            app = launchHidden(root)
            await waitFor(async () => {
              assert.equal(app.child.exitCode, null, app.output())
              return JSON.parse(await readFile(record, 'utf8')).completed === true
            })
            trayProcesses = await waitFor(() => {
              const rows = app.processes()
              return rows.some(row => row.ProcessId === app.child.pid) && rows.every(row => row.ProcessId === app.child.pid || row.Name.toLowerCase() === 'conhost.exe') ? rows : false
            })
          }
          assert.equal(JSON.parse(await readFile(record, 'utf8')).completed, true)
          const hiddenChild = app.child; await app.close({ preserve: true }); await waitFor(() => hiddenChild.exitCode !== null || hiddenChild.signalCode !== null); app = undefined
        }
        if (mode === 'changed-journal') await page.reload()
        else await open()
        if (readOnlyRecord) {
          await page.getByRole('alert').waitFor()
          const assertProtected = async () => {
            const error = await page.getByRole('alert').innerText()
            assert.match(error, scenario === 'read-only-abort' ? /持久化草稿中止决定失败/ : /持久化草稿恢复完成记录失败/)
            assert.match(error, /FileRenameInfoEx/); assert.match(error, /MigrationTransaction\.json/); assert.match(error, /os error 5/)
            await waitFor(() => app.output().includes('启动草稿恢复失败，后台服务保持停止') && app.output().includes('MigrationTransaction.json'), 3000)
            assert.equal(await readFile(record, 'utf8'), originalRecord)
            assert.equal(await readFile(nativeJournal, 'utf8'), originalNativeJournal)
            assert.equal(digest(await readFile(path.join(data, 'workspace.json'))), verified.payload.source.workspaceFingerprint)
            assert.equal(await page.locator('.app-shell, .widget-head, input, textarea').count(), 0)
            assert.ok(!app.browser.contexts().flatMap(context => context.pages()).some(target => target.url().includes('widget.html')), 'Failed startup must not restore widget editors')
          }
          await assertProtected()
          await Promise.all([page.waitForEvent('domcontentloaded'), page.getByRole('button', { name: '重试启动恢复' }).click()])
          await page.getByRole('alert').waitFor(); await assertProtected()
          await chmod(record, 0o600)
          assert.equal(await readFile(record, 'utf8'), originalRecord)
          await page.getByRole('button', { name: '重试启动恢复' }).click()
        }
        const blocked = ['changed-journal', 'changed-native-journal', 'different-profile'].includes(mode)
        if (blocked) {
          await page.getByRole('alert').waitFor(); assert.equal(await page.locator('.app-shell, .widget-head, input, textarea').count(), 0)
          assert.equal(JSON.parse(await readFile(record, 'utf8')).completed, false)
          const raw = await readFile(record, 'utf8'); const state = await invoke()
          assert.deepEqual(await invoke({ acknowledged: true, recovered: true, clear: true }), state); assert.equal(await readFile(record, 'utf8'), raw)
          await assert.rejects(app.invoke('drafts_recovery', { finish: true }, page))
          await assert.rejects(app.invoke('workspace_load', {}, page), /受控恢复/)
          if (mode === 'changed-native-journal') {
            await assert.rejects(app.invoke('drafts_startup_done', { error: null }, page), /not allowed|权限|此窗口/i)
            await Promise.all([page.waitForEvent('domcontentloaded'), page.getByRole('button', { name: '重试启动恢复' }).click()])
            await page.getByRole('alert').waitFor()
            assert.equal(JSON.parse(await readFile(record, 'utf8')).completed, false)
            await writeFile(nativeJournal, originalNativeJournal)
            await page.getByRole('button', { name: '重试启动恢复' }).click()
            await page.locator('.app-shell').waitFor()
            assert.equal(JSON.parse(await readFile(record, 'utf8')).completed, true)
            assert.ok(!app.browser.contexts().flatMap(context => context.pages()).some(target => target.url().includes('recovery.html')))
          }
          if (mode === 'different-profile') {
            const journalBeforeQuit = await readFile(nativeJournal, 'utf8')
            await page.getByRole('button', { name: '退出并保留恢复日志' }).click()
            await waitFor(() => app.child.exitCode !== null || app.child.signalCode !== null)
            assert.equal(app.child.exitCode, 0)
            assert.equal(await readFile(record, 'utf8'), raw)
            assert.equal(await readFile(nativeJournal, 'utf8'), journalBeforeQuit)
          }
        } else {
          await page.locator('.app-shell').waitFor(); assert.equal(await invoke(), null)
          const completed = JSON.parse(await readFile(record, 'utf8')); assert.equal(completed.completed, true)
          assert.equal(completed.decision, expected.decision === 'pending' ? 'abort' : expected.decision)
          assert.equal(await page.evaluate(() => localStorage.getItem('dustdesk:draft-migration:pending:v1')), null)
          assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), completed.decision === 'commit' ? verified.payload.entries.find(entry => entry.key === 'widget-task-draft:v1:todo').value : null)
          const receipt = await page.evaluate(() => localStorage.getItem('dustdesk:draft-migration:receipts:v1'))
          assert.equal(Boolean(receipt), completed.decision === 'commit')
          if (scenario === 'completed-abort-input') {
            const incoming = verified.payload.entries.find(entry => entry.key === 'widget-task-draft:v1:todo').value
            await page.evaluate(value => localStorage.setItem('widget-task-draft:v1:todo', value), incoming)
            assert.equal(await app.invoke('drafts_recovery', {}, page), null)
            assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), incoming)
            await page.reload(); await page.locator('.app-shell').waitFor()
            assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), incoming, 'Completed abort must preserve later identical input through actual page recovery')
            // Verify an orderly durable handoff. An immediate forced process
            // kill after localStorage.setItem is not a browser flush boundary.
            const abortedChild = app.child
            await app.invoke('application_quit', {}, page).catch(error => assert.match(String(error), /closed|destroyed|disconnected/i))
            await waitFor(() => abortedChild.exitCode !== null || abortedChild.signalCode !== null); assert.equal(abortedChild.exitCode, 0)
            await app.close({ preserve: true }); app = undefined
            await open(); await page.locator('.app-shell').waitFor()
            assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), incoming, 'Completed abort must preserve later identical input after a real restart')
            await page.reload(); await page.locator('.app-shell').waitFor()
            assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), incoming)
          }
          if (mode === 'commit') {
            await page.evaluate(() => { localStorage.removeItem('dustdesk:draft-migration:receipts:v1'); localStorage.removeItem('widget-task-draft:v1:todo') })
            const restoredChild = app.child; await app.close({ preserve: true }); await waitFor(() => restoredChild.exitCode !== null || restoredChild.signalCode !== null); app = undefined
            await open(); await page.locator('.app-shell').waitFor()
            assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), verified.payload.entries.find(entry => entry.key === 'widget-task-draft:v1:todo').value)
            await page.evaluate(() => localStorage.removeItem('widget-task-draft:v1:todo'))
            await page.reload(); await page.locator('.app-shell').waitFor()
            assert.equal(await page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), null)
          }
          if (mode === 'pending') {
            const restored = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(page => page.url().includes('widget.html')))
            await restored.getByLabel('桌面新增任务').waitFor(); assert.equal(await restored.getByLabel('桌面新增任务').inputValue(), '')
          }
        }
        assert.equal(digest(await readFile(path.join(data, 'workspace.json'))), verified.payload.source.workspaceFingerprint)
        if (reader) {
          assert.notEqual(digest(await readFile(record)), reader.before)
          await reader.release(); reader = undefined
        }
        evidence.push({ mode: scenario, blocked, actualNativeRestart: mode !== 'changed-journal', actualRendererReload: mode === 'changed-journal', boundActualBrowserJournal: true, nativeResultVerified: !blocked, automaticRecoveryBeforeEditors: !blocked, trayRecoveryWithoutMain: scenario.startsWith('tray-'), trayProcesses, explicitRetryAfterRepair: mode === 'changed-native-journal' || readOnlyRecord, accessDeniedPreservesNativeDecision: readOnlyRecord, passiveExternalReaderAcrossDecisionAndStartupCompletion: scenario.startsWith('shared-reader-'), blockedExitWithoutWriting: mode === 'different-profile' })
      } catch (error) {
        const alerts = await page?.getByRole('alert').allTextContents().catch(() => [])
        const files = Object.fromEntries(await Promise.all(['MigrationTransaction.json', 'MigrationBrowserJournal.json', 'workspace.json'].map(async name => [name, await readFile(path.join(data, name), 'utf8').catch(failure => String(failure))])))
        const metadata = Object.fromEntries(await Promise.all(['MigrationTransaction.json', 'MigrationBrowserJournal.json', 'workspace.json'].map(async name => [name, await stat(path.join(data, name)).then(value => ({ size: value.size, mode: value.mode, links: value.nlink, modifiedAt: value.mtime.toISOString() })).catch(failure => String(failure))])))
        await writeFile('artifacts/tauri-migration/draft-recovery-failure-'+scenario+'.json', JSON.stringify({ scenario, root, alerts, output: app?.output(), launchDiagnostics: error.launchDiagnostics, error: String(error), files, metadata }, null, 2))
        console.error('Native recovery scenario:', scenario, alerts, app?.output())
        throw error
      } finally {
        await reader?.release().catch(error => console.error('Record reader cleanup failed:', error))
        await app?.close({ preserve: true }); if (electron) await closeDustDesk({ ...electron, preserveTempRoot: true })
        assert.ok(path.isAbsolute(root) && root.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('dustdesk-tauri-test-'))
        if (readOnlyRecord) await chmod(path.join(data, 'MigrationTransaction.json'), 0o600).catch(error => { if (error.code !== 'ENOENT') throw error })
        await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
      }
    })
  }
  await writeFile(report, JSON.stringify({ productionReady: false, scope: 'profile-bound-staged-browser-recovery-with-native-result-verification-before-editors', evidence, remaining: ['user-facing-native-import', 'orphan-browser-journal-without-native-record', 'complete-atomic-import-and-failure-recovery', 'production-source-and-snapshot-transfer', 'rollback'] }, null, 2))
})
