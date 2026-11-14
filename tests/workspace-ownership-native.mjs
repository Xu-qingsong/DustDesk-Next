import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import electronExecutable from 'electron'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'

test('real Electron and Rust share native directory ownership without switching production paths', async suite => {
  const reportPath = 'artifacts/tauri-migration/workspace-ownership-native.json'
  await rm(reportPath, { force: true })
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-'))
  const electronProfile = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-ownership-test-'))
  const bootstrap = path.join(electronProfile, 'isolated-startup.cjs')
  await writeFile(bootstrap, 'const {clipboard,nativeImage}=require("electron"); clipboard.readText=()=>""; clipboard.readImage=()=>nativeImage.createEmpty(); require(' + JSON.stringify(path.resolve('out/main/index.js')) + ');')
  const electron = await launchDustDesk({ tempRoot: electronProfile, bootstrap })
  let tauri; let nodeOwner
  const results = []
  let failed = false
  const scenario = async (name, callback) => suite.test(name, async () => { try { await callback(); results.push(name) } catch (error) { failed = true; throw error } })
  try {
    const state = await electron.window.evaluate(async () => {
      const state = await window.dustdesk.loadWorkspace()
      state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false
      const result = await window.dustdesk.saveWorkspace(state); if (!result.ok) throw Error(result.error)
      return window.dustdesk.loadWorkspace()
    })
    const electronRoot = path.join(electron.tempRoot, 'data')
    await scenario('real Electron owns its data directory before any public workspace use', async () => {
      await assert.rejects(acquireWorkspaceOwnership(electronRoot), /另一个进程/)
    })
    await scenario('a different Electron profile is refused before reads, writes or service startup', async () => {
      const dataPath = path.join(electronRoot, 'workspace.json')
      const before = createHash('sha256').update(await readFile(dataPath)).digest('hex')
      const boot = path.join(electron.tempRoot, 'blocked-startup.cjs')
      await writeFile(boot, 'const {dialog}=require("electron"); dialog.showErrorBox=(title,message)=>console.error("OWNERSHIP_REFUSED",title,message); import(' + JSON.stringify(pathToFileURL(path.resolve('out/main/index.js')).href) + ');')
      const child = spawn(electronExecutable, [boot], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DUSTDESK_TEST_DATA_DIR: electronRoot, DUSTDESK_TEST_USER_DATA_DIR: path.join(electron.tempRoot, 'other-profile'), DUSTDESK_TEST_DESKTOP_DIR: path.join(electron.tempRoot, 'desktop') } })
      let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
      const exited = once(child, 'exit')
      const timeout = setTimeout(() => child.kill(), 20000)
      try {
        const [code] = await exited
        assert.equal(code, 1, output)
        assert.match(output, /OWNERSHIP_REFUSED.*另一个进程/)
      } finally { clearTimeout(timeout); if (child.exitCode === null) child.kill() }
      assert.equal(createHash('sha256').update(await readFile(dataPath)).digest('hex'), before)
    })
    const tauriRoot = path.join(root, 'user-data', 'tauri-preview', 'Workspace')
    nodeOwner = await acquireWorkspaceOwnership(tauriRoot)
    tauri = await launchTauri({ rootDirectory: root })
    await scenario('Rust refuses Node-owned directory before initializing any workspace file', async () => {
      await assert.rejects(tauri.invoke('prototype_workspace_initialize', { state }), /另一个进程/)
      await assert.rejects(readFile(path.join(tauriRoot, 'workspace.json')), { code: 'ENOENT' })
    })
    await scenario('Rust acquires released Node ownership and then excludes Node including case aliases', async () => {
      await nodeOwner.release(); nodeOwner = undefined
      const snapshot = await tauri.invoke('prototype_workspace_initialize', { state })
      assert.deepEqual(snapshot.state, state)
      await assert.rejects(acquireWorkspaceOwnership(tauriRoot), /另一个进程/)
      await assert.rejects(acquireWorkspaceOwnership(tauriRoot.toUpperCase()), /另一个进程/)
    })
    await scenario('terminated Rust releases kernel ownership without removing a stale lock file', async () => {
      const child = tauri.child
      await tauri.close({ preserve: true })
      await waitFor(() => child.exitCode !== null || child.signalCode !== null)
      tauri = undefined
      await (await acquireWorkspaceOwnership(tauriRoot)).release()
      assert.deepEqual(JSON.parse(await readFile(path.join(tauriRoot, 'workspace.json'), 'utf8')), state)
    })
    await scenario('terminated Electron releases ownership without deleting user data', async () => {
      const child = electron.electronApp.process()
      await closeDustDesk({ ...electron, preserveTempRoot: true })
      await waitFor(() => child.exitCode !== null || child.signalCode !== null)
      await (await acquireWorkspaceOwnership(electronRoot)).release()
      assert.deepEqual(JSON.parse(await readFile(path.join(electronRoot, 'workspace.json'), 'utf8')), state)
    })
    await mkdir('artifacts/tauri-migration', { recursive: true })
    if (failed) throw Error('Native workspace ownership verification failed')
    await writeFile(reportPath, JSON.stringify({ verifiedAt: new Date().toISOString(), scenarios: results, productionReady: false, remaining: ['unaware-old-version-process-detection', 'trusted-persistent-lineage', 'production-cutover-and-rollback', 'hostile-local-directory-replacement'] }, null, 2))
  } finally {
    await nodeOwner?.release(); await tauri?.close({ preserve: true })
    await closeDustDesk(electron); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
