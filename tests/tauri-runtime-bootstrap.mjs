import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { createServer, createConnection } from 'node:net'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'
import { waitFor } from './tauri-harness.mjs'

const directory = 'artifacts/tauri-migration/runtime-bootstrap-native'
const executable = path.resolve('src-tauri/target/debug/DustDesk.exe')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = ['src-tauri/src/legacy_source/bridge.rs', 'src-tauri/src/legacy_source/binding/snapshot.rs', 'src-tauri/src/managed_snapshot/preparation/runtime/ownership/profile.rs', 'src-tauri/src/workspace/runtime_boot.rs', 'src-tauri/src/workspace/draft_browser.rs', 'src-tauri/src/main.rs', 'src-tauri/capabilities/runtime-import.json', 'src-tauri/permissions/runtime-import.toml', 'src-tauri/tauri.conf.json', 'src/renderer/runtime-import.html', 'src/renderer/src/runtime/runtimeImport.ts', 'vite.tauri.config.ts', 'tests/tauri-runtime-bootstrap.mjs']

inputs.push('src-tauri/src/workspace/runtime_boot/handback.rs', 'src-tauri/src/workspace/ownership.rs', 'src-tauri/src/legacy_source/binding/snapshot/handback.rs')
inputs.push('src-tauri/src/legacy_source/binding/snapshot/application.rs', 'src-tauri/src/managed_snapshot/drafts.rs', 'src-tauri/src/managed_snapshot/source.rs', 'src-tauri/src/managed_snapshot/runtime_data.rs')

test('actual owned runtime starts a quarantined WebView, imports and seals native-observed drafts and recovers real process interruptions', { timeout: 900000 }, async suite => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-runtime-preview-'))
  await fs.mkdir(directory, { recursive: true })
  const report = { verified: false, startedAt: new Date().toISOString(), testArguments: process.execArgv, productionReady: false, migrationComplete: false, checks: [], scope: 'Debug TEMP actual WebView2 import and final native browser read, latest Data seal, retained ownership, complete application inputs from pinned handles, exact overwrite/deletion plans, real post-preparation process kill, original LAN drain and immutable cold recovery. Latest Data edits and original Electron archive are fixtures. Control records preserve actual bytes or absence. Cold recovery verifies the archive, not restarted localStorage. No original Data/Session application, control-record rebinding, ordinary business activation, production cutover, power failure or full rollback.' }
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  const children = new Set(), browsers = new Set(), cleanup = []
  let failed = false
  const scenario = async (name, run) => {
    await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Runtime bootstrap failed: ' + name)
  }
  const launch = async (locations, requestId = randomUUID()) => {
    const server = createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port; await new Promise(resolve => server.close(resolve))
    const child = spawn(executable, ['--legacy-runtime-preview-v1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=' + port + ' --remote-debugging-address=127.0.0.1 --no-first-run' } })
    children.add(child)
    const messages = []; let stderr = '', ended
    child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-16384) })
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', line => { try { messages.push(JSON.parse(line)) } catch { stderr += line } })
    const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => { ended = { code, signal }; children.delete(child); resolve(ended) }) })
    const next = () => waitFor(() => { if (messages.length) return messages.shift(); if (ended) throw Error('Native process ended: ' + JSON.stringify(ended) + stderr); return false }, 60000)
    const send = (action, fields = {}) => child.stdin.write(JSON.stringify({ action, requestId, ...fields }) + '\n')
    const rpc = async (action, fields) => { send(action, fields); return next() }
    send('open', { version: 1, locations }); const ready = await next(); assert.equal(ready.event, 'ready')
    return { child, requestId, ready, next, rpc, send, closed, messages, errors: () => stderr,
      async connect() {
        const endpoint = 'http://127.0.0.1:' + port
        await waitFor(async () => { try { return (await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(500) })).ok } catch { return false } }, 30000)
        const browser = await chromium.connectOverCDP(endpoint); browsers.add(browser)
        const page = await waitFor(() => browser.contexts().flatMap(context => context.pages()).find(page => page.url().endsWith('/runtime-import.html')))
        return { browser, page }
      },
      async stop() { child.stdin.end(); assert.equal((await closed).code, 0, stderr) },
      async kill({ tree = true } = {}) {
        if (tree) execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        else assert.equal(child.kill('SIGKILL'), true, 'native child handle must accept SIGKILL: ' + stderr)
        const result = await closed
        if (!tree) assert.equal(result.signal, 'SIGKILL', JSON.stringify(result) + stderr)
      },
    }
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(inputs.map(async file => [file, await fileDigest(file)])))
    report.executableSha256 = await fileDigest(executable)
    const reference = await extractOfficialLegacyReference(root)
    report.reference = reference.release
    // All source/profile paths are direct siblings in the restricted TEMP root.
    let sequence = 0
    const fixture = async ({ originalLan = false, applicationInputs = false } = {}) => {
      const number = ++sequence, data = path.join(root, 'Data-' + number), userData = path.join(root, 'OriginalProfile-' + number)
      const output = path.join(root, 'RuntimeData-' + number), snapshot = path.join(root, 'Snapshot-' + number)
      await fs.mkdir(path.join(data, 'Assets'), { recursive: true }); await fs.mkdir(userData)
      const workspace = Buffer.from('{"SchemaVersion":3,"Notes":[],"Todos":[],"QuickNote":"原工作区"}\r\n')
      await fs.writeFile(path.join(data, 'workspace.json'), workspace); await fs.writeFile(path.join(data, 'Assets', 'raw.bin'), Buffer.from([0, 255, 13, 10]))
      let originalIdentity
      if (originalLan) {
        const { toolboxModules } = await import('./toolbox-fixture.mjs')
        const { lan } = await toolboxModules({ after: cb => cleanup.push(cb) })
        const old = lan.createLanService({ storage: path.join(userData, 'LanTransfers'), downloads: root, host: '127.0.0.1', name: 'Native seal source', discovery: false, changed() {}, confirmPair: async () => false, confirmReceive: async () => false })
        try { await old.enable(true) } finally { await old.dispose() }
        originalIdentity = await fs.readFile(path.join(userData, 'LanTransfers', 'identity.json'))
      }
      const locations = { installation: reference.root, data, userData, browserProfile: userData, workspaceSha256: digest(workspace) }
      const value = '{ "title": "原始🪶\\n草稿", "requestId":"native-original-task" }'
      const entries = [{ key: 'widget-task-draft:v1:todo', value }]
      if (applicationInputs) entries.unshift({ key: 'widget-note:removed', value: '{"saved":true}' }, { key: 'widget-notes:selected', value: 'old-note' })
      const payload = JSON.stringify({ id: randomUUID(), createdAt: '2026-11-13T04:00:00.000Z', source: { runtime: 'electron', appVersion: '1.0.2', workspaceFingerprint: locations.workspaceSha256 }, entries })
      const drafts = Buffer.from(JSON.stringify({ format: 'dustdesk-browser-drafts', version: 1, payload, sha256: digest(payload) }))
      const native = await launch(locations)
      await native.rpc('draftsBegin', { bytes: drafts.length, sha256: digest(drafts) })
      await native.rpc('draftsChunk', { data: drafts.toString('base64') })
      const prepared = await native.rpc('prepare', { destination: snapshot })
      const runtime = await native.rpc('prepareRuntime', { id: prepared.id, destination: output })
      return { native, locations, data, output, snapshot, prepared, runtime, value, workspace, originalLan, originalIdentity }
    }
    const start = async state => {
      state.native.send('launchRuntime', { preparationId: state.prepared.id, id: state.runtime.id, originalLan: state.originalLan })
      const started = await state.native.next(); assert.equal(started.event, 'runtimeBrowserStarting')
      const { browser, page } = await state.native.connect()
      return { ...state, started, browser, page }
    }
    const complete = async state => {
      await waitFor(async () => {
        const message = await state.page.locator('#status').innerText()
        assert.ok(!message.includes('被阻断'), message + '\n' + state.native.errors())
        return message.includes('已核验')
      })
      const ready = await state.native.next(); assert.equal(ready.event, 'runtimeBrowserReady', state.native.errors())
      assert.equal(ready.businessServicesStarted, false)
      await waitFor(async () => (await state.page.locator('#status').innerText()).includes('已核验'))
      assert.equal(await state.page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), state.value)
      assert.equal(await state.page.evaluate(() => localStorage.getItem('dustdesk:draft-migration:pending:v1')), null)
      const record = JSON.parse(await fs.readFile(path.join(state.output, 'MigrationTransaction.json'), 'utf8'))
      assert.equal(record.decision, 'commit'); assert.equal(record.completed, true)
      assert.deepEqual(await fs.readFile(path.join(state.output, 'workspace.json')), state.workspace)
      assert.equal(state.browser.contexts().flatMap(context => context.pages()).length, 1)
      await assert.rejects(state.page.evaluate(() => window.__TAURI_INTERNALS__.invoke('workspace_load')), /not allowed|not found|权限/i)
      for (const action of ['source', 'begin', 'decide']) await assert.rejects(state.page.evaluate(action => window.__TAURI_INTERNALS__.invoke('runtime_drafts_step', { action }), action), /已完成/)
      await assert.rejects(fs.writeFile(path.join(state.data, 'Assets', 'raw.bin'), 'must stay pinned'))
      await assert.rejects(fs.rename(state.started.profile.path, state.started.profile.path + '-replaced'))
      if (!state.originalLan) await assert.rejects(fs.access(path.join(state.locations.userData, 'LanTransfers')))
      return record
    }
    const terminalPath = async state => {
      const parent = path.join(state.locations.userData, 'LegacySnapshotPreparation')
      const catalogs = (await fs.readdir(parent, { withFileTypes: true })).filter(entry => entry.isDirectory())
      assert.equal(catalogs.length, 1)
      return path.join(parent, catalogs[0].name, state.prepared.id, 'RuntimePreparation', state.runtime.id, 'Ownership', state.started.profile.ownershipId, 'RuntimeHandback')
    }
    const recoverSeal = async (state, receipt) => {
      const native = await launch(state.locations)
      const recovered = await native.rpc('recoverRuntimeHandback', { preparationId: state.prepared.id, runtimeId: state.runtime.id, ownershipId: state.started.profile.ownershipId })
      assert.equal(recovered.event, 'runtimeHandbackRecovered', native.errors())
      assert.equal(recovered.businessServicesStarted, false)
      assert.deepEqual(recovered.receipt, receipt)
      await assert.rejects(fs.writeFile(path.join(state.output, 'workspace.json'), 'must remain sealed'))
      assert.equal((await native.rpc('close')).event, 'closed')
      assert.equal((await native.closed).code, 0, native.errors())
    }
    await scenario('same native process imports exact original drafts with no regular UI or business authority, then revokes on client EOF', async () => {
      const state = await start(await fixture())
      await assert.rejects(fs.access(path.join(state.output, 'MigrationTransaction.json')))
      assert.equal(await state.page.evaluate(() => localStorage.getItem('widget-task-draft:v1:todo')), null)
      state.native.send('continueRuntime'); await complete(state)
      await state.page.screenshot({ path: path.join(directory, 'quarantined-import.png') })
      const profile = state.started.profile.path
      await state.native.stop()
      await state.browser.close(); browsers.delete(state.browser)
      await waitFor(async () => {
        const processes = execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | Select-Object -ExpandProperty CommandLine"], { windowsHide: true, encoding: 'utf8' })
        return !processes.toLowerCase().includes(path.basename(profile).toLowerCase())
      }, 10000)
      const handle = await fs.open(path.join(state.data, 'Assets', 'raw.bin'), 'r+'); await handle.close()
      await fs.rename(profile, profile + '-released'); await fs.rename(profile + '-released', profile)
      assert.deepEqual(await fs.readFile(path.join(state.data, 'workspace.json')), state.workspace)
    })
    for (const boundary of ['begin', 'decide']) await scenario('real force exit after ' + boundary + ' preserves native decision and resumes the same physical browser profile', async () => {
      let state = await start(await fixture())
      const script = await state.page.locator('script[type="module"]').getAttribute('src')
      const scriptUrl = new URL(script, state.page.url()).href
      const source = await fs.readFile(path.join('out/tauri', script), 'utf8')
      const decide = /await [\w$]+\("decide"\)/.exec(source)
      assert.ok(decide, 'Observe the real built native decision call')
      const recovery = [...source.matchAll(/await [\w$]+\(localStorage,[\w$]+\)/g)].find(match => match.index > decide.index)
      assert.ok(recovery, 'Observe real browser recovery after the native decision')
      const offset = (boundary === 'begin' ? decide.index : recovery.index) + 6
      const prefix = source.slice(0, offset), lineNumber = prefix.split('\n').length - 1, columnNumber = prefix.length - prefix.lastIndexOf('\n') - 1
      const cdp = await state.browser.contexts()[0].newCDPSession(state.page)
      await cdp.send('Debugger.enable')
      const breakpoint = await cdp.send('Debugger.setBreakpointByUrl', { url: scriptUrl, lineNumber, columnNumber })
      assert.ok(breakpoint.locations.length > 0, 'Breakpoint must bind to the actual loaded code')
      let paused = false
      cdp.on('Debugger.paused', () => { paused = true })
      state.native.send('continueRuntime')
      await waitFor(() => paused)
      const record = JSON.parse(await fs.readFile(path.join(state.output, 'MigrationTransaction.json'), 'utf8'))
      assert.equal(record.decision, boundary === 'begin' ? 'pending' : 'commit'); assert.equal(record.completed, false)
      const ownershipId = state.started.profile.ownershipId, profile = state.started.profile.path
      await state.native.kill()
      const native = await launch(state.locations)
      native.send('launchRuntime', { preparationId: state.prepared.id, id: state.runtime.id, ownershipId })
      const started = await native.next(); assert.equal(started.event, 'runtimeBrowserStarting'); assert.equal(started.profile.path, profile)
      const { browser, page } = await native.connect()
      state = { ...state, native, started, browser, page }
      native.send('continueRuntime')
      await complete(state)
      await native.stop()
    })
    for (const killed of [false, true]) await scenario('native final browser read seals latest Data and exact remaining drafts; ' + (killed ? 'real SIGKILL' : 'client EOF') + ' permits only the same read-only cold decision', async () => {
      const state = await start(await fixture({ applicationInputs: true })); state.native.send('continueRuntime'); await complete(state)
      const note = '{ "title":"新标题", "text":"\\ud800\\n新正文🪶", "previousTitle":"", "previousText":"" }'
      const task = '{"title":"","requestId":"empty-current-draft"}'
      const expected = [
        { key: 'widget-note:latest-native', value: note },
        { key: 'widget-note:saved-native', value: '{"saved":true}' },
        { key: 'widget-task-draft:v1:todo', value: task },
        { key: 'widget-notes:selected', value: '' },
      ].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      await state.page.evaluate(entries => {
        localStorage.removeItem('widget-task-draft:v1:todo')
        localStorage.removeItem('widget-note:removed')
        for (const { key, value } of entries) localStorage.setItem(key, value)
        localStorage.setItem('private-unrelated-key', 'must not be exported')
      }, expected)
      const latest = Buffer.from('{"SchemaVersion":3,"Notes":[],"Todos":[],"QuickNote":"最新运行数据","unknown":{"keep":true}}\r\n')
      await fs.writeFile(path.join(state.output, 'workspace.json'), latest)
      const asset = Buffer.from([0, 13, 10, 255, 1])
      await fs.writeFile(path.join(state.output, 'Assets', 'latest.bin'), asset)
      await fs.unlink(path.join(state.output, 'Assets', 'raw.bin'))
      await fs.mkdir(path.join(state.output, 'Assets', 'empty-latest'))
      state.native.send('sealRuntime')
      assert.equal((await state.native.next()).event, 'runtimeHandbackReading')
      const sealed = await state.native.next(); assert.equal(sealed.event, 'runtimeHandbackSealed', state.native.errors())
      assert.equal(sealed.entries, expected.length); assert.equal(sealed.businessServicesStarted, false)
      assert.equal(sealed.receipt.workspaceSha256, digest(latest))
      const record = await terminalPath(state)
      const names = (await fs.readdir(record)).sort(); assert.deepEqual(names, ['browser-drafts.json', 'data.json', 'decision.json', 'intent.json'])
      await waitFor(() => state.page.isClosed())
      assert.equal(state.native.child.exitCode, null, 'the terminal owner remains held until client close')
      await assert.rejects(fs.readFile(path.join(record, 'browser-drafts.json')), { code: 'EBUSY' })
      await assert.rejects(fs.writeFile(path.join(state.output, 'Assets', 'latest.bin'), 'must remain pinned'))
      await assert.rejects(fs.rename(state.started.profile.path, state.started.profile.path + '-replaced'))
      if (killed) await state.native.kill({ tree: false }); else await state.native.stop()
      const archive = JSON.parse(await fs.readFile(path.join(record, 'browser-drafts.json'), 'utf8'))
      assert.equal(digest(archive.payload), archive.sha256)
      const payload = JSON.parse(archive.payload)
      assert.equal(payload.source.runtime, 'tauri'); assert.equal(payload.source.workspaceFingerprint, digest(latest))
      assert.deepEqual(payload.entries, expected)
      const bytes = Object.fromEntries(await Promise.all(names.map(async name => [name, await fs.readFile(path.join(record, name))])))
      for (let count = 0; count < 2; count++) await recoverSeal(state, sealed.receipt)
      for (const [name, before] of Object.entries(bytes)) assert.deepEqual(await fs.readFile(path.join(record, name)), before)
      const application = path.join(path.dirname(record), 'RuntimeApplication')
      const inputMessages = async action => {
        const native = await launch(state.locations)
        const recovered = await native.rpc('recoverRuntimeHandback', { preparationId: state.prepared.id, runtimeId: state.runtime.id, ownershipId: state.started.profile.ownershipId })
        assert.equal(recovered.event, 'runtimeHandbackRecovered', native.errors())
        assert.deepEqual(recovered.receipt, sealed.receipt)
        const prepared = await native.rpc(action)
        assert.equal(prepared.event, action === 'prepareRuntimeApplication' ? 'runtimeApplicationPrepared' : 'runtimeApplicationRecovered', native.errors())
        assert.equal(prepared.businessServicesStarted, false)
        for (const flag of ['applicationReady', 'originalDataApplied', 'sessionApplied', 'productionReady', 'migrationComplete']) assert.equal(prepared.receipt[flag], false)
        assert.equal(prepared.receipt.handbackIntentSha256, sealed.receipt.intentSha256)
        assert.deepEqual(prepared.receipt.latestDrafts, sealed.receipt.drafts)
        await assert.rejects(fs.writeFile(path.join(application, 'Incoming', 'Assets', 'latest.bin'), 'still pinned'))
        await assert.rejects(fs.writeFile(path.join(state.data, 'Assets', 'raw.bin'), 'still original'))
        if (action === 'prepareRuntimeApplication' && killed) await native.kill({ tree: false })
        else { assert.equal((await native.rpc('close')).event, 'closed'); assert.equal((await native.closed).code, 0, native.errors()) }
        return prepared.receipt
      }
      const applicationReceipt = await inputMessages('prepareRuntimeApplication')
      const applicationNames = (await fs.readdir(application)).sort()
      assert.deepEqual(applicationNames, ['Incoming', 'decision.json', 'draft-plan.json', 'intent.json', 'latest-drafts.json', 'original-data.json', 'original-drafts.json', 'preparing.json', 'sealed-data.json', 'staged-data.json'])
      const applicationBytes = Object.fromEntries(await Promise.all(applicationNames.filter(name => name !== 'Incoming').map(async name => [name, await fs.readFile(path.join(application, name))])))
      const plan = JSON.parse(applicationBytes['draft-plan.json'])
      assert.equal(plan.length, expected.length + 1)
      const change = key => plan.find(change => change.key === key)
      assert.deepEqual(change('widget-note:removed'), { key: 'widget-note:removed', before: '{"saved":true}', after: null })
      assert.deepEqual(change('widget-notes:selected'), { key: 'widget-notes:selected', before: 'old-note', after: '' })
      assert.deepEqual(change('widget-task-draft:v1:todo'), { key: 'widget-task-draft:v1:todo', before: state.value, after: task })
      assert.equal(change('widget-note:latest-native').before, null)
      assert.equal(change('widget-note:latest-native').after, note)
      assert.equal(change('private-unrelated-key'), undefined)
      assert.deepEqual(await fs.readFile(path.join(application, 'latest-drafts.json')), bytes['browser-drafts.json'])
      assert.deepEqual(await fs.readFile(path.join(application, 'Incoming', 'workspace.json')), latest)
      assert.deepEqual(await fs.readFile(path.join(application, 'Incoming', 'Assets', 'latest.bin')), asset)
      await assert.rejects(fs.access(path.join(application, 'Incoming', 'Assets', 'raw.bin')), { code: 'ENOENT' })
      assert.equal((await fs.stat(path.join(application, 'Incoming', 'Assets', 'empty-latest'))).isDirectory(), true)
      // Control records are byte-for-byte historical proofs, never rebound by copying.
      const sealedManifest = JSON.parse(bytes['data.json'])
      for (const file of ['MigrationTransaction.json', 'ElectronMigrationTransaction.json', 'MigrationLineage/lineage.json']) {
        if (sealedManifest.entries.some(entry => entry.path === file)) assert.deepEqual(await fs.readFile(path.join(application, 'Incoming', file)), await fs.readFile(path.join(state.output, file)))
        else await assert.rejects(fs.access(path.join(application, 'Incoming', file)), { code: 'ENOENT' })
      }
      for (let count = 0; count < 2; count++) assert.deepEqual(await inputMessages('resumeRuntimeApplication'), applicationReceipt)
      for (const [name, before] of Object.entries(applicationBytes)) assert.deepEqual(await fs.readFile(path.join(application, name)), before)
      report.applications ??= []; report.applications.push({ killedAfterPreparation: killed, receipt: applicationReceipt, plan, coldRecoveries: 2, applicationApplied: false })
      assert.deepEqual(await fs.readFile(path.join(state.output, 'workspace.json')), latest)
      assert.deepEqual(await fs.readFile(path.join(state.output, 'Assets', 'latest.bin')), asset)
      assert.deepEqual(await fs.readFile(path.join(state.data, 'workspace.json')), state.workspace)
      // A completed terminal record cannot be treated as a writable startup.
      const replay = await launch(state.locations)
      replay.send('launchRuntime', { preparationId: state.prepared.id, id: state.runtime.id, ownershipId: state.started.profile.ownershipId })
      assert.equal((await replay.closed).code, 1)
      assert.match(replay.errors(), /整体|交还/)
      report.handbacks ??= []; report.handbacks.push({ killed, receipt: sealed.receipt, remainingDrafts: payload.entries.map(entry => entry.key), coldRecoveries: 2 })
    })
    await scenario('native whole-runtime seal joins the actual original LAN service and binds its durable latest handback before browser sealing', async () => {
      const state = await start(await fixture({ originalLan: true })); state.native.send('continueRuntime'); await complete(state)
      const ready = await state.native.rpc('startOriginalLan'); assert.equal(ready.event, 'runtimeOriginalLanReady'); assert.equal(ready.enabled, true); assert.ok(ready.port > 0)
      const identity = state.originalIdentity
      state.native.send('sealRuntime')
      const lan = await state.native.next(); assert.equal(lan.event, 'runtimeOriginalLanHandedBack'); assert.equal(lan.proof.kind, 'handback')
      assert.equal((await state.native.next()).event, 'runtimeHandbackReading')
      const sealed = await state.native.next(); assert.equal(sealed.event, 'runtimeHandbackSealed', state.native.errors())
      assert.equal(sealed.receipt.lan.handbackIntentSha256, lan.proof.receipt.intentSha256)
      assert.deepEqual(sealed.receipt.lan.checkpoint, lan.proof.checkpoint)
      await assert.rejects(new Promise((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port: ready.port })
        socket.on('error', reject); socket.on('connect', () => { socket.destroy(); resolve() })
        socket.setTimeout(3000, () => { socket.destroy(); reject(Error('socket timeout')) })
      }), { code: 'ECONNREFUSED' })
      await state.native.stop(); await recoverSeal(state, sealed.receipt)
      assert.deepEqual(await fs.readFile(path.join(state.locations.userData, 'LanTransfers', 'identity.json')), identity)
      report.originalLanSealed = { deviceId: ready.deviceId, fingerprint: ready.fingerprint, receipt: sealed.receipt, listenerClosed: true }
    })
    for (const invalid of ['journal', 'future-version']) await scenario('native seal rejects ' + invalid + ' in actual browser storage without creating a terminal record', async () => {
      const state = await start(await fixture()); state.native.send('continueRuntime'); await complete(state)
      await state.page.evaluate(invalid => localStorage.setItem(invalid === 'journal' ? 'dustdesk:draft-migration:pending:v1' : 'widget-note:v99:id', '{"preserve":"exact"}'), invalid)
      state.native.send('sealRuntime')
      assert.equal((await state.native.next()).event, 'runtimeHandbackReading')
      assert.equal((await state.native.closed).code, 1)
      assert.match(state.native.errors(), /草稿|白名单|事务/)
      await assert.rejects(fs.access(await terminalPath(state)), { code: 'ENOENT' })
      assert.deepEqual(await fs.readFile(path.join(state.output, 'workspace.json')), state.workspace)
    })
    await scenario('navigation during the final native browser read rejects stale or invalid observations without publishing a terminal decision', async () => {
      const state = await start(await fixture()); state.native.send('continueRuntime'); await complete(state)
      const cdp = await state.browser.contexts()[0].newCDPSession(state.page)
      await cdp.send('Debugger.enable'); await cdp.send('Debugger.pause')
      state.native.send('sealRuntime'); assert.equal((await state.native.next()).event, 'runtimeHandbackReading')
      await cdp.send('Page.reload')
      assert.equal((await state.native.closed).code, 1)
      assert.match(state.native.errors(), /读取|代次|变化|超时|草稿数据无效/)
      await assert.rejects(fs.access(await terminalPath(state)), { code: 'ENOENT' })
      report.navigationDiagnostic = state.native.errors()
    })
    await scenario('late original source entries revoke the running browser and retain the native completed import', async () => {
      const state = await start(await fixture()); state.native.send('continueRuntime'); const before = await complete(state)
      await fs.writeFile(path.join(state.data, 'Assets', 'late.bin'), 'late source entry')
      assert.equal((await state.native.closed).code, 0)
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(state.output, 'MigrationTransaction.json'), 'utf8')), before)
    })
    assert.deepEqual(Object.fromEntries(await Promise.all(inputs.map(async file => [file, await fileDigest(file)]))), report.inputs)
    report.verified = true
  } catch (error) { report.error = String(error.stack ?? error); throw error }
  finally {
    for (const browser of browsers) await browser.close().catch(() => {})
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch {} }
    for (const callback of cleanup.reverse()) await callback()
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()))
    assert.match(path.basename(root), /^dustdesk-runtime-preview-[A-Za-z0-9]+$/)
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false)
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    report.finishedAt = new Date().toISOString()
    await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify(report, null, 2))
  }
})
