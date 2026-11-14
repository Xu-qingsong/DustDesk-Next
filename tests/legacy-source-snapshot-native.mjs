import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'
import { toolboxModules } from './toolbox-fixture.mjs'

const directory = 'artifacts/tauri-migration/live-source-snapshot-native'
const executable = path.resolve('src-tauri/target/debug/DustDesk.exe')
const sources = ['src-tauri/src/legacy_source.rs', 'src-tauri/src/legacy_source/binding.rs', 'src-tauri/src/legacy_source/binding/snapshot.rs', 'src-tauri/src/legacy_source/bridge.rs', 'src-tauri/src/managed_snapshot.rs', 'src-tauri/src/managed_snapshot/bundle.rs', 'src-tauri/src/managed_snapshot/preparation.rs', 'src-tauri/src/managed_snapshot/source.rs', 'src-tauri/src/managed_snapshot/source/tests.rs', 'src-tauri/src/managed_snapshot/target.rs', 'src-tauri/src/managed_snapshot/bundle/tests/retention.rs', 'src-tauri/src/main.rs', 'tests/legacy-source-snapshot-native.mjs', 'tests/legacy-source-reference.mjs', 'tests/toolbox-fixture.mjs', 'tests/reference/src/main/lanTransfer.ts']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
sources.push('src-tauri/src/managed_snapshot/runtime_data.rs', 'src-tauri/src/managed_snapshot/preparation/runtime.rs', 'src-tauri/src/managed_snapshot/preparation/runtime/tests.rs', 'src-tauri/src/legacy_source/binding/tests/runtime.rs', 'src-tauri/src/lan/files.rs', 'src-tauri/src/lan/files_tests.rs')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

test('native prepared-source snapshots retain genuine code Data browser proof and exclusive original LAN through persistent preparation', { timeout: 720000 }, async suite => {
  await fs.mkdir(directory, { recursive: true })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-source-snapshot-'))
  const cleanups = [], { lan } = await toolboxModules({ after: callback => cleanups.push(callback) })
  const children = new Set(), checks = []
  const report = { verified: false, productionReady: false, migrationComplete: false, checks, scope: 'Actual native stdio preparation process and official released code, immutable Data/assets, supplied raw Electron-format archive and retained exclusive actual original LAN files, durable source-bound decisions, fresh full live-source inventory/hash, retained source assets and complete target bundle/Data/object/native decision handles after verifyPrepared, repeated verification without reopening the files, stale-asset and source/target late-entry rejection, forced process interruption, and runtime-shaped Data copied from retained snapshot object handles with exact original timestamps and readonly attributes, write-ahead native intent/inventory/decision, retained output handles, conservative recovery and bounded metadata-only status pagination including lost-response recovery. No runtime launch, ownership transfer or browser import, no actual Electron browser collection in this suite, historical-profile proof, production takeover, identity-key export, external transfer-file restore, cutover, rollback or packaged helper distribution.' }
  let failed = false
  const scenario = async (name, operation) => {
    await suite.test(name, async () => { try { await operation(); checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Native source snapshot scenario failed: ' + name)
  }
  const launch = (locations, flag = '--legacy-source-snapshot-v1') => {
    const child = spawn(executable, [flag], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const requestId = randomUUID(), messages = []
    let pending, stderr = '', terminal
    children.add(child)
    const ended = new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => {
        terminal = { code, signal }; children.delete(child)
        if (pending) { clearTimeout(pending.timer); pending.reject(Error(stderr || 'Native process exited before response')); pending = undefined }
        resolve(terminal)
      })
    })
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-8192) })
    child.stdin.on('error', () => {})
    createInterface({ input: child.stdout }).on('line', line => {
      const value = JSON.parse(line)
      if (pending) { const waiting = pending; pending = undefined; clearTimeout(waiting.timer); waiting.resolve(value) } else messages.push(value)
    })
    const next = () => {
      if (messages.length) return Promise.resolve(messages.shift())
      if (terminal) return Promise.reject(Error(stderr || 'Native process already exited'))
      return new Promise((resolve, reject) => {
        assert.equal(pending, undefined)
        const timer = setTimeout(() => { pending = undefined; reject(Error('Native snapshot response timed out: ' + stderr)) }, 20000)
        pending = { resolve, reject, timer }
      })
    }
    const send = message => child.stdin.write(JSON.stringify({ ...message, requestId }) + '\n')
    const rpc = async (action, fields = {}) => { send({ action, ...fields }); const result = await next(); assert.equal(result.requestId, requestId); return result }
    send({ action: 'open', version: 1, locations })
    return { child, requestId, next, ended, rpc, send, errors: () => stderr,
      async close() { assert.equal((await rpc('close')).event, 'closed'); assert.equal((await ended).code, 0, stderr) },
      async upload(bytes, sha256 = digest(bytes)) {
        assert.equal((await rpc('draftsBegin', { bytes: bytes.length, sha256 })).event, 'draftsStarted')
        for (let offset = 0; offset < bytes.length; offset += 32768) {
          const chunk = bytes.subarray(offset, offset + 32768), response = await rpc('draftsChunk', { data: chunk.toString('base64') })
          assert.equal(response.event, 'draftsAccepted'); assert.equal(response.bytes, offset + chunk.length)
        }
      } }
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
    report.executableSha256 = await fileDigest(executable)
    const reference = await extractOfficialLegacyReference(root)
    let sequence = 0
    const fixture = async () => {
      const location = path.join(root, 'case-' + ++sequence), data = path.join(location, 'Data'), userData = path.join(location, 'ActualProfile')
      await fs.mkdir(path.join(data, 'Assets', '空目录'), { recursive: true }); await fs.mkdir(userData)
      const workspace = Buffer.from('{\r\n "SchemaVersion":3, "unknown":"原文🪶", "Notes":[]\r\n}\r\n')
      await fs.writeFile(path.join(data, 'workspace.json'), workspace)
      await fs.writeFile(path.join(data, 'Assets', 'raw.bin'), Buffer.from([0, 255, 13, 10]))
      const locations = { installation: reference.root, data, userData, browserProfile: userData, workspaceSha256: digest(workspace) }
      const payload = JSON.stringify({ id: randomUUID(), createdAt: '2026-11-13T04:00:00.000Z', source: { runtime: 'electron', appVersion: '1.0.2', workspaceFingerprint: locations.workspaceSha256 }, entries: [{ key: 'widget-task-draft:v1:todo', value: JSON.stringify({ title: '原始🪶'.repeat(20000), unknown: 7 }) }] })
      const drafts = Buffer.from(JSON.stringify({ format: 'dustdesk-browser-drafts', version: 1, sha256: digest(payload), payload }))
      return { locations, location, data, userData, drafts, workspace, destination: path.join(location, 'Snapshot') }
    }
    const catalog = (fixture, binding) => path.join(fixture.userData, 'LegacySnapshotPreparation', binding.dataIdentity.volume.toString(16).padStart(16, '0') + '-' + binding.dataIdentity.index)
    await scenario('multi-frame raw drafts and all Data assets are prepared under genuine live code without initializing missing LAN', async () => {
      const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
      assert.equal(ready.event, 'ready'); assert.ok(fixtureState.drafts.length > 65536)
      await native.upload(fixtureState.drafts)
      await assert.rejects(fs.writeFile(path.join(fixtureState.data, 'workspace.json'), 'must not write'))
      const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
      assert.equal(prepared.event, 'prepared')
      const manifest = JSON.parse(await fs.readFile(path.join(fixtureState.destination, 'handoff.json'), 'utf8'))
      assert.equal(digest(await fs.readFile(path.join(fixtureState.destination, 'handoff.json'))), prepared.receipt.manifestSha256)
      assert.deepEqual(manifest.components.source, ready.binding)
      assert.equal(manifest.components.lan.lanProfile, null)
      assert.deepEqual(await fs.readFile(path.join(fixtureState.destination, 'browser-drafts.json')), fixtureState.drafts)
      const data = JSON.parse(await fs.readFile(path.join(fixtureState.destination, 'Data', 'snapshot.json'), 'utf8'))
      assert.ok(data.entries.some(entry => entry.kind === 'directory' && entry.path === 'Assets/空目录'))
      for (const entry of data.entries.filter(entry => entry.kind === 'file')) {
        const bytes = await fs.readFile(path.join(fixtureState.destination, 'Data', 'objects', String(entry.object).padStart(6, '0') + '.bin'))
        assert.deepEqual(bytes, await fs.readFile(path.join(fixtureState.data, entry.path))); assert.equal(digest(bytes), entry.sha256)
      }
      const record = path.join(catalog(fixtureState, ready.binding), prepared.id)
      const decision = await fs.readFile(path.join(record, 'decision.json'))
      const targetFiles = ['handoff.json', 'browser-drafts.json', 'Data/snapshot.json', ...data.entries.filter(entry => entry.kind === 'file').map(entry => 'Data/objects/' + String(entry.object).padStart(6, '0') + '.bin')].map(name => path.join(fixtureState.destination, name))
      targetFiles.push(path.join(record, 'intent.json'), path.join(record, 'decision.json'))
      assert.deepEqual((await native.rpc('verifyPrepared', { id: prepared.id })).receipt, prepared.receipt)
      for (const file of targetFiles) await assert.rejects(fs.open(file, 'r+'))
      for (const name of ['', 'Data', 'Data/objects']) await assert.rejects(fs.rename(path.join(fixtureState.destination, name), path.join(fixtureState.location, 'must-not-move')))
      await assert.rejects(fs.writeFile(path.join(fixtureState.data, 'Assets', 'raw.bin'), 'must not write'))
      await assert.rejects(fs.rename(path.join(fixtureState.data, 'Assets', '空目录'), path.join(fixtureState.data, 'Assets', 'must-not-move')))
      assert.deepEqual((await native.rpc('verifyPrepared', { id: prepared.id })).receipt, prepared.receipt)
      await native.close()
      for (const file of targetFiles) { const handle = await fs.open(file, 'r+'); await handle.close() }
      assert.deepEqual(await fs.readFile(path.join(record, 'decision.json')), decision)
      report.retainedTargetHandles = targetFiles.length
      const writer = await fs.open(path.join(fixtureState.data, 'Assets', 'raw.bin'), 'r+'); await writer.close()
      const reopened = launch(fixtureState.locations); await reopened.next()
      assert.deepEqual((await reopened.rpc('verifyPrepared', { id: prepared.id })).receipt, prepared.receipt); await reopened.close()
      await assert.rejects(fs.stat(path.join(fixtureState.userData, 'LanTransfers')), { code: 'ENOENT' })
      report.prepared = { id: prepared.id, receipt: prepared.receipt, codeVersion: ready.binding.installation.release.version, rawDraftBytes: fixtureState.drafts.length }
    })
    await scenario('actual prepared Electron LAN owner blocks freezing; disposal admits immutable original state and excludes private identity from output', async () => {
      const fixtureState = await fixture(), storage = path.join(fixtureState.userData, 'LanTransfers')
      const service = lan.createLanService({ storage, downloads: path.join(fixtureState.location, 'Downloads'), name: 'isolated source snapshot', host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => false, confirmReceive: async () => false })
      await service.enable(true)
      const blocked = launch(fixtureState.locations); assert.equal((await blocked.ended).code, 1); assert.match(blocked.errors(), /局域网状态目录正由另一个进程使用或锁访问被拒绝/)
      await service.dispose()
      const originalState = await fs.readFile(path.join(storage, 'state.json')), originalIdentity = await fs.readFile(path.join(storage, 'identity.json'))
      const native = launch(fixtureState.locations), ready = await native.next(); assert.ok(ready.binding.lanStorageIdentity)
      await assert.rejects(fs.writeFile(path.join(storage, 'state.json'), 'must not write'))
      await assert.rejects(fs.writeFile(path.join(storage, 'identity.json'), 'must not write'))
      await native.upload(fixtureState.drafts); const prepared = await native.rpc('prepare', { destination: fixtureState.destination }); assert.equal(prepared.event, 'prepared')
      const manifest = JSON.parse(await fs.readFile(path.join(fixtureState.destination, 'handoff.json'), 'utf8'))
      assert.deepEqual(manifest.components.lan.appProfile, ready.binding.userDataIdentity)
      assert.deepEqual(manifest.components.lan.lanProfile, ready.binding.lanStorageIdentity)
      assert.deepEqual(await fs.readFile(path.join(fixtureState.destination, 'lan-state.json')), originalState)
      assert.deepEqual((await fs.readdir(fixtureState.destination)).sort(), ['Data', 'browser-drafts.json', 'handoff.json', 'lan-state.json'])
      assert.equal((await native.rpc('verifyPrepared', { id: prepared.id })).event, 'verifiedPrepared')
      await assert.rejects(fs.open(path.join(fixtureState.destination, 'lan-state.json'), 'r+'))
      assert.equal((await native.rpc('verifyPrepared', { id: prepared.id })).event, 'verifiedPrepared')
      report.retainedTargetLanState = true
      const runtimeDestination = path.join(fixtureState.location, 'RuntimeData')
      const runtime = await native.rpc('prepareRuntime', { id: prepared.id, destination: runtimeDestination })
      assert.equal(runtime.event, 'runtimePrepared'); assert.equal(runtime.productionReady, false); assert.equal(runtime.migrationComplete, false)
      await assert.rejects(fs.stat(path.join(runtimeDestination, 'LanTransfers')), { code: 'ENOENT' })
      await assert.rejects(fs.stat(path.join(runtimeDestination, 'identity.json')), { code: 'ENOENT' })
      await assert.rejects(fs.open(path.join(runtimeDestination, 'workspace.json'), 'r+'))
      await assert.rejects(fs.open(path.join(storage, 'identity.json'), 'r+'))
      report.runtimeDataKeepsOriginalLanOnly = true
      await native.close(); assert.deepEqual(await fs.readFile(path.join(storage, 'identity.json')), originalIdentity)
    })
    await scenario('read-only lease mode cannot upload drafts or publish a snapshot', async () => {
      for (const action of ['draftsBegin', 'prepareRuntime', 'verifyRuntime', 'queryRuntime']) {
        const fixtureState = await fixture(), native = launch(fixtureState.locations, '--legacy-source-lease-v1'); await native.next()
        native.send(action === 'draftsBegin' ? { action, bytes: fixtureState.drafts.length, sha256: digest(fixtureState.drafts) } : action === 'prepareRuntime' ? { action, id: randomUUID(), destination: fixtureState.destination } : action === 'verifyRuntime' ? { action, preparationId: randomUUID(), id: randomUUID() } : { action, id: randomUUID() })
        assert.equal((await native.ended).code, 1, action); await assert.rejects(fs.stat(fixtureState.destination), { code: 'ENOENT' })
        await fs.writeFile(path.join(fixtureState.data, 'workspace.json'), fixtureState.workspace)
      }
    })
    await scenario('actual native runtime Data preparation uses retained objects and native decisions without granting cutover', async () => {
      const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
      await native.upload(fixtureState.drafts)
      const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
      const data = JSON.parse(await fs.readFile(path.join(fixtureState.destination, 'Data', 'snapshot.json'), 'utf8'))
      const output = path.join(fixtureState.location, 'RuntimeData')
      const empty = await native.rpc('queryRuntime', { id: prepared.id })
      assert.equal(empty.event, 'runtimeStatus'); assert.deepEqual(empty.page, { statuses: [], nextCursor: null })
      const runtime = await native.rpc('prepareRuntime', { id: prepared.id, destination: output })
      assert.equal(runtime.event, 'runtimePrepared'); assert.equal(runtime.scope, 'runtime-data-only')
      assert.equal(runtime.productionReady, false); assert.equal(runtime.migrationComplete, false)
      const record = path.join(catalog(fixtureState, ready.binding), prepared.id, 'RuntimePreparation', runtime.id)
      for (const file of [path.join(output, 'workspace.json'), path.join(output, 'Assets', 'raw.bin'), path.join(fixtureState.destination, 'Data', 'objects', '000000.bin'), ...['intent.json', 'inventory.json', 'decision.json'].map(name => path.join(record, name))]) await assert.rejects(fs.open(file, 'r+'))
      const status = await native.rpc('queryRuntime', { id: prepared.id })
      assert.equal(status.page.statuses.length, 1); assert.equal(status.page.nextCursor, null)
      assert.deepEqual(status.page.statuses[0].outcome.receipt, runtime.receipt)
      assert.deepEqual((await native.rpc('prepareRuntime', { id: prepared.id, destination: output })).receipt, runtime.receipt)
      assert.deepEqual((await native.rpc('verifyRuntime', { preparationId: prepared.id, id: runtime.id })).receipt, runtime.receipt)
      await native.close()
      assert.deepEqual(await fs.readFile(path.join(output, 'workspace.json')), fixtureState.workspace)
      assert.deepEqual(await fs.readFile(path.join(output, 'Assets', 'raw.bin')), Buffer.from([0, 255, 13, 10]))
      assert.deepEqual((await fs.readdir(output)).sort(), ['Assets', 'workspace.json'])
      assert.deepEqual(await fs.readdir(path.join(output, 'Assets', '空目录')), [])
      const inventoryBytes = await fs.readFile(path.join(record, 'inventory.json')), inventory = JSON.parse(inventoryBytes)
      assert.equal(digest(inventoryBytes), runtime.receipt.inventorySha256)
      for (const entry of data.entries.filter(entry => entry.kind === 'file')) {
        const materialized = inventory.entries.find(candidate => candidate.path === entry.path)
        assert.equal(materialized.stamp.modified, entry.stamp.modified); assert.equal(materialized.sha256, entry.sha256); assert.equal(materialized.readOnly, entry.readOnly)
      }
      const decision = await fs.readFile(path.join(record, 'decision.json'))
      const reopened = launch(fixtureState.locations); await reopened.next()
      const query = await reopened.rpc('queryRuntime', { id: prepared.id })
      assert.deepEqual(query.page.statuses[0].outcome.receipt, runtime.receipt)
      const writer = await fs.open(path.join(output, 'Assets', 'raw.bin'), 'r+'); await writer.close()
      assert.deepEqual((await reopened.rpc('verifyRuntime', { preparationId: prepared.id, id: runtime.id })).receipt, runtime.receipt)
      await assert.rejects(fs.open(path.join(output, 'Assets', 'raw.bin'), 'r+'))
      await reopened.close(); assert.deepEqual(await fs.readFile(path.join(record, 'decision.json')), decision)
      report.runtimeDataPreparation = { id: runtime.id, files: runtime.receipt.files, directories: runtime.receipt.directories, originalTimesPreserved: true, statusIsMetadataOnly: true, repeatedOriginalHandleVerification: true }
    })
    await scenario('lost runtime-prepared response is recovered by native status query instead of inferring from complete files', async () => {
      const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
      await native.upload(fixtureState.drafts)
      const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
      const output = path.join(fixtureState.location, 'RuntimeData'), records = path.join(catalog(fixtureState, ready.binding), prepared.id, 'RuntimePreparation')
      native.send({ action: 'prepareRuntime', id: prepared.id, destination: output })
      const until = Date.now() + 30000
      let decided
      while (!decided) {
        for (const id of await fs.readdir(records).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
          if (await fs.stat(path.join(records, id, 'decision.json')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) decided = id
        }
        if (Date.now() > until || native.child.exitCode !== null) throw Error('No native runtime decision before response loss: ' + native.errors())
        if (!decided) await delay(2)
      }
      native.child.kill(); await native.ended
      const decision = await fs.readFile(path.join(records, decided, 'decision.json'))
      const reopened = launch(fixtureState.locations); await reopened.next()
      const status = await reopened.rpc('queryRuntime', { id: prepared.id })
      assert.equal(status.event, 'runtimeStatus'); assert.equal(status.scope, 'native-runtime-preparation-metadata-only')
      assert.equal(status.page.statuses.length, 1); assert.equal(status.page.statuses[0].id, decided)
      const verified = await reopened.rpc('verifyRuntime', { preparationId: prepared.id, id: status.page.statuses[0].id })
      assert.equal(verified.event, 'runtimeVerified'); assert.equal(verified.receipt.productionReady, false)
      await assert.rejects(fs.open(path.join(output, 'workspace.json'), 'r+')); await reopened.close()
      assert.deepEqual(await fs.readFile(path.join(records, decided, 'decision.json')), decision)
      report.runtimeDataLostResponseRecovered = true
    })
    await scenario('incomplete or digest-mismatched uploads never create a preparation intent or destination', async () => {
      for (const wrongDigest of [false, true]) {
        const fixtureState = await fixture(), native = launch(fixtureState.locations); await native.next()
        if (wrongDigest) await native.upload(fixtureState.drafts, '0'.repeat(64))
        else { await native.rpc('draftsBegin', { bytes: fixtureState.drafts.length, sha256: digest(fixtureState.drafts) }); await native.rpc('draftsChunk', { data: fixtureState.drafts.subarray(0, 32).toString('base64') }) }
        native.send({ action: 'prepare', destination: fixtureState.destination }); assert.equal((await native.ended).code, 1)
        await assert.rejects(fs.stat(fixtureState.destination), { code: 'ENOENT' })
        await assert.rejects(fs.stat(path.join(fixtureState.userData, 'LegacySnapshotPreparation')), { code: 'ENOENT' })
      }
    })
    await scenario('reopened native decisions reject changed live bytes, new assets and replaced empty directories without rewriting the prepared decision', async () => {
      report.freshnessRejections = []
      for (const mutation of ['bytes', 'added-file', 'directory-identity']) {
        const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
        await native.upload(fixtureState.drafts)
        const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
        await native.close()
        const decisionPath = path.join(catalog(fixtureState, ready.binding), prepared.id, 'decision.json')
        const decision = await fs.readFile(decisionPath), target = await fs.readFile(path.join(fixtureState.destination, 'handoff.json'))
        if (mutation === 'bytes') await fs.writeFile(path.join(fixtureState.data, 'Assets', 'raw.bin'), Buffer.from([1, 254, 12, 9]))
        else if (mutation === 'added-file') await fs.writeFile(path.join(fixtureState.data, 'Assets', 'added.bin'), 'extra')
        else { await fs.rmdir(path.join(fixtureState.data, 'Assets', '空目录')); await fs.mkdir(path.join(fixtureState.data, 'Assets', '空目录')) }
        const reopened = launch(fixtureState.locations); assert.equal((await reopened.next()).event, 'ready')
        reopened.send({ action: 'verifyPrepared', id: prepared.id })
        assert.equal((await reopened.ended).code, 1, mutation); assert.match(reopened.errors(), /活源资产/, mutation)
        assert.deepEqual(await fs.readFile(decisionPath), decision); assert.deepEqual(await fs.readFile(path.join(fixtureState.destination, 'handoff.json')), target)
        const writer = await fs.open(path.join(fixtureState.data, 'Assets', 'raw.bin'), 'r+'); await writer.close()
        report.freshnessRejections.push(mutation)
      }
    })
    await scenario('new entries after verified live-source pinning revoke native confirmation and release handles on process exit', async () => {
      const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
      await native.upload(fixtureState.drafts)
      const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
      const decisionPath = path.join(catalog(fixtureState, ready.binding), prepared.id, 'decision.json'), decision = await fs.readFile(decisionPath)
      assert.equal((await native.rpc('verifyPrepared', { id: prepared.id })).event, 'verifiedPrepared')
      await fs.writeFile(path.join(fixtureState.data, 'Assets', '空目录', 'late.bin'), 'not in the verified inventory')
      native.send({ action: 'confirm' }); assert.equal((await native.ended).code, 1); assert.match(native.errors(), /目录内容已变化/)
      assert.deepEqual(await fs.readFile(decisionPath), decision)
      const writer = await fs.open(path.join(fixtureState.data, 'Assets', 'raw.bin'), 'r+'); await writer.close()
      report.retainedInventoryRevokedOnLateEntry = true
    })
    await scenario('new target entries revoke native confirmation while actual decision and target pins survive until process exit', async () => {
      report.retainedTargetLateEntryRejections = []
      for (const relative of ['extra.bin', 'Data/extra.bin', 'Data/objects/999999.bin']) {
        const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
        await native.upload(fixtureState.drafts)
        const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
        const decisionPath = path.join(catalog(fixtureState, ready.binding), prepared.id, 'decision.json'), decision = await fs.readFile(decisionPath)
        assert.equal((await native.rpc('verifyPrepared', { id: prepared.id })).event, 'verifiedPrepared')
        await assert.rejects(fs.open(decisionPath, 'r+'))
        await fs.writeFile(path.join(fixtureState.destination, relative), 'not a verified target entry')
        native.send({ action: 'confirm' }); assert.equal((await native.ended).code, 1); assert.match(native.errors(), /快照核验期间.*列表发生变化|组合快照核验期间文件集合已变化/)
        assert.deepEqual(await fs.readFile(decisionPath), decision)
        for (const file of [decisionPath, path.join(fixtureState.destination, 'handoff.json'), path.join(fixtureState.data, 'Assets', 'raw.bin')]) { const writer = await fs.open(file, 'r+'); await writer.close() }
        report.retainedTargetLateEntryRejections.push(relative)
      }
    })
    await scenario('forced termination after target verification releases real handles without rewriting the successful decision', async () => {
      const fixtureState = await fixture(), native = launch(fixtureState.locations), ready = await native.next()
      await native.upload(fixtureState.drafts)
      const prepared = await native.rpc('prepare', { destination: fixtureState.destination })
      const decisionPath = path.join(catalog(fixtureState, ready.binding), prepared.id, 'decision.json'), decision = await fs.readFile(decisionPath)
      assert.equal((await native.rpc('verifyPrepared', { id: prepared.id })).event, 'verifiedPrepared')
      await assert.rejects(fs.open(decisionPath, 'r+')); await assert.rejects(fs.open(path.join(fixtureState.destination, 'handoff.json'), 'r+'))
      native.child.kill(); assert.notEqual((await native.ended).code, 0)
      for (const file of [decisionPath, path.join(fixtureState.destination, 'handoff.json'), path.join(fixtureState.data, 'Assets', 'raw.bin')]) { const writer = await fs.open(file, 'r+'); await writer.close() }
      assert.deepEqual(await fs.readFile(decisionPath), decision)
      const reopened = launch(fixtureState.locations); assert.equal((await reopened.next()).event, 'ready')
      assert.deepEqual((await reopened.rpc('verifyPrepared', { id: prepared.id })).receipt, prepared.receipt)
      await reopened.close(); assert.deepEqual(await fs.readFile(decisionPath), decision)
      report.retainedTargetRecoveredAfterForcedExit = true
    })
    await scenario('forced process termination while copying leaves a durable aborted intent instead of promoting partial content', async () => {
      const fixtureState = await fixture(), handle = await fs.open(path.join(fixtureState.data, 'Assets', 'large.bin'), 'wx')
      await handle.truncate(256 * 1024 * 1024); await handle.close()
      const native = launch(fixtureState.locations), ready = await native.next(); await native.upload(fixtureState.drafts)
      native.send({ action: 'prepare', destination: fixtureState.destination })
      const until = Date.now() + 20000
      while (!(await fs.stat(path.join(fixtureState.destination, 'Data', 'objects')).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error }))) {
        if (Date.now() > until || native.child.exitCode !== null) throw Error('Did not observe native copy phase: ' + native.errors())
        await delay(2)
      }
      native.child.kill(); await native.ended
      const catalogPath = catalog(fixtureState, ready.binding), entries = (await fs.readdir(catalogPath)).filter(name => /^[0-9a-f-]{36}$/.test(name))
      assert.equal(entries.length, 1)
      await assert.rejects(fs.stat(path.join(catalogPath, entries[0], 'decision.json')), { code: 'ENOENT' })
      const reopened = launch(fixtureState.locations); await reopened.next(); reopened.send({ action: 'verifyPrepared', id: entries[0] })
      assert.equal((await reopened.ended).code, 1); assert.match(reopened.errors(), /没有组合快照成功决定/)
      const decision = JSON.parse(await fs.readFile(path.join(catalogPath, entries[0], 'decision.json'), 'utf8'))
      assert.equal(decision.outcome.state, 'aborted')
      await fs.writeFile(path.join(fixtureState.data, 'workspace.json'), fixtureState.workspace)
      report.interruptionRecoveredAs = decision.outcome.state
    })
    assert.equal(children.size, 0)
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs)
    report.verified = true
  } finally {
    const active = [...children]
    const ended = active.map(child => new Promise(resolve => child.once('close', resolve)))
    for (const child of active) child.kill()
    await Promise.all(ended)
    for (const cleanup of cleanups) await cleanup()
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir())
    assert.ok(path.relative(temporary, resolved).startsWith('dustdesk-source-snapshot-'))
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
