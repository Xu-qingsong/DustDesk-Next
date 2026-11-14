import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { extractOfficialLegacyReference, fileDigest } from './legacy-source-reference.mjs'

const directory = 'artifacts/tauri-migration/live-source-lease-native'
const executable = path.resolve('src-tauri/target/debug/DustDesk.exe')
const sources = ['src-tauri/src/legacy_source.rs', 'src-tauri/src/legacy_source/binding.rs', 'src-tauri/src/legacy_source/bridge.rs', 'src-tauri/src/lan/files.rs', 'src-tauri/src/main.rs', 'tests/reference/src/main/legacySourceLease.ts', 'tests/reference/src/main/index.ts', 'tests/reference/src/main/draftExport.ts', 'tests/legacy-source-lease-native.mjs']
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

test('private native source leases bind real official code actual profile and immutable Data without creating a WebView', { timeout: 240000 }, async suite => {
  await fs.mkdir(directory, { recursive: true })
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-source-lease-'))
  const report = { verified: false, productionReady: false, migrationComplete: false, checks: [], scope: 'Actual private-stdio Rust process, official released bytes and physical selected prepared-runtime Data/profile/browser/LAN-directory binding; no old code execution, historical-profile proof, LAN-state freeze, production cutover or packaged helper distribution.' }
  const children = new Set()
  let failed = false
  const scenario = async (name, run) => {
    await suite.test(name, async () => { try { await run(); report.checks.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Live native source lease failed: ' + name)
  }
  const launch = () => {
    const child = spawn(executable, ['--legacy-source-lease-v1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    let stdout = '', stderr = '', pending, lines = [], terminal
    const ended = new Promise(resolve => child.once('close', (code, signal) => { terminal = { code, signal }; children.delete(child); pending?.reject(Error('Native lease ended: ' + stderr)); pending = undefined; resolve(terminal) }))
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
      let newline
      while ((newline = stdout.indexOf('\n')) !== -1) {
        const message = JSON.parse(stdout.slice(0, newline)); stdout = stdout.slice(newline + 1)
        if (pending) { const waiting = pending; pending = undefined; waiting.resolve(message) } else lines.push(message)
      }
    })
    child.stdin.on('error', () => {})
    const next = () => {
      if (lines.length) return Promise.resolve(lines.shift())
      if (terminal) return Promise.reject(Error('Native lease already ended: ' + stderr))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { child.kill(); reject(Error('Native lease response timeout: ' + stderr)) }, 20000)
        pending = { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } }
      })
    }
    return { child, ended, next, send: value => child.stdin.write(JSON.stringify(value) + '\n'), errors: () => stderr }
  }
  try {
    report.inputs = Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)])))
    report.executableSha256 = await fileDigest(executable)
    const reference = await extractOfficialLegacyReference(root)
    const data = path.join(root, 'Data'), userData = path.join(root, 'ActualProfile')
    await fs.mkdir(data); await fs.mkdir(userData)
    const workspace = path.join(data, 'workspace.json'), original = '{ "SchemaVersion":3, "unknown": "原文🪶" }\r\n'
    await fs.writeFile(workspace, original)
    const locations = { installation: reference.root, data, userData, browserProfile: userData, workspaceSha256: digest(original) }
    const open = async overrides => {
      const lease = launch(), requestId = randomUUID()
      lease.send({ action: 'open', version: 1, requestId, locations: { ...locations, ...overrides } })
      return { ...lease, requestId }
    }
    const close = async lease => {
      lease.send({ action: 'close', requestId: lease.requestId })
      assert.equal((await lease.next()).event, 'closed'); assert.equal((await lease.ended).code, 0)
    }
    await scenario('official code is pinned together with actual default Session storage and read-shared immutable workspace', async () => {
      const lease = await open(); const ready = await lease.next()
      assert.equal(ready.event, 'ready'); assert.equal(ready.requestId, lease.requestId)
      assert.equal(ready.binding.scope, 'prepared-electron-runtime'); assert.equal(ready.binding.workspaceSha256, digest(original))
      assert.deepEqual(ready.binding.browserProfileIdentity, ready.binding.userDataIdentity)
      assert.equal(ready.binding.lanStorageIdentity, null); assert.equal(ready.binding.productionReady, false)
      assert.equal(await fs.readFile(workspace, 'utf8'), original)
      await assert.rejects(fs.writeFile(workspace, 'must not replace'))
      await assert.rejects(fs.rename(userData, userData + '-moved'))
      await assert.rejects(fs.rename(path.join(reference.root, 'resources', 'app.asar'), path.join(reference.root, 'resources', 'moved.asar')))
      lease.send({ action: 'confirm', requestId: lease.requestId }); assert.equal((await lease.next()).event, 'confirmed')
      report.binding = ready.binding
      await close(lease)
      await fs.rename(userData, userData + '-moved'); await fs.rename(userData + '-moved', userData)
      await fs.writeFile(workspace, original)
    })
    await scenario('a forged confirmation cannot manufacture an unopened source lease', async () => {
      const lease = launch(); lease.send({ action: 'confirm', requestId: randomUUID() })
      assert.equal((await lease.ended).code, 1); assert.match(lease.errors(), /必须先打开/)
    })
    await scenario('native workspace fingerprint mismatch rejects before any archive or lineage writes', async () => {
      const lease = await open({ workspaceSha256: '0'.repeat(64) })
      assert.equal((await lease.ended).code, 1); assert.match(lease.errors(), /不匹配原生维护/)
      assert.deepEqual(await fs.readdir(data), ['workspace.json'])
    })
    await scenario('an unrelated browser profile cannot be substituted for the actual userData descendant', async () => {
      const lease = await open({ browserProfile: root })
      assert.equal((await lease.ended).code, 1); assert.match(lease.errors(), /不属于当前 userData/)
    })
    await scenario('late LAN directory initialization invalidates the live binding rather than being omitted', async () => {
      const lease = await open(); await lease.next()
      const lan = path.join(userData, 'LanTransfers'); await fs.mkdir(lan)
      lease.send({ action: 'confirm', requestId: lease.requestId })
      assert.equal((await lease.ended).code, 1); assert.match(lease.errors(), /实际 LAN 存储目录/)
      assert.deepEqual(await fs.readdir(lan), []); await fs.rmdir(lan)
    })
    await scenario('foreign request identifiers fail closed and release native locks', async () => {
      const lease = await open(); await lease.next(); lease.send({ action: 'close', requestId: randomUUID() })
      assert.equal((await lease.ended).code, 1); assert.match(lease.errors(), /请求身份不匹配/)
      await fs.writeFile(workspace, original)
    })
    await scenario('closed parent stdin cancels hashing or releases an established lease without a resident helper', async () => {
      const hashing = await open(); hashing.child.stdin.end(); await hashing.ended
      const ready = await open(); await ready.next(); ready.child.stdin.end(); assert.equal((await ready.ended).code, 0)
      await fs.writeFile(workspace, original)
    })
    await scenario('native helper termination releases every pinned source directory and file', async () => {
      const lease = await open(); await lease.next(); lease.child.kill(); await lease.ended
      await fs.rename(data, data + '-moved'); await fs.rename(data + '-moved', data)
      const archive = path.join(reference.root, 'resources', 'app.asar')
      await fs.rename(archive, archive + '.moved'); await fs.rename(archive + '.moved', archive)
      assert.equal(await fileDigest(archive), reference.release.files[1].sha256)
    })
    assert.equal(children.size, 0); assert.equal(await fs.readFile(workspace, 'utf8'), original)
    assert.deepEqual(await fs.readdir(userData), []); assert.deepEqual(await fs.readdir(data), ['workspace.json'])
    assert.deepEqual(Object.fromEntries(await Promise.all(sources.map(async file => [file, await fileDigest(file)]))), report.inputs)
    report.verified = true
  } finally {
    for (const child of children) child.kill()
    await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))))
    report.finishedAt = new Date().toISOString(); await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
    const resolved = path.resolve(root), temporary = path.resolve(os.tmpdir())
    assert.ok(path.relative(temporary, resolved).startsWith('dustdesk-source-lease-'))
    await fs.rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})
