import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { launchTauri, waitFor } from './tauri-harness.mjs'

test('real native legacy processes veto migration preparation and invalidate ready leases without killing other apps', async suite => {
  const report = 'artifacts/tauri-migration/legacy-processes-native.json'
  await rm(report, { force: true })
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-legacy-process-test-'))
  const source = path.join(root, 'fixture.exe')
  const children = new Set()
  const results = []
  let app; let failed = false
  const scenario = async (name, callback) => {
    await suite.test(name, async () => { try { await callback(); results.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Legacy process scenario failed: ' + name)
  }
  const start = async name => {
    const location = path.join(root, name)
    await copyFile(source, location)
    const child = spawn(location, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    children.add(child)
    child.exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
    let output = ''; let error
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { output += bytes })
    child.on('error', reason => { error = reason })
    await waitFor(() => {
      if (error) throw error
      if (child.exitCode !== null) throw Error('Legacy fixture exited: ' + output)
      return output.includes('ready')
    })
    return child
  }
  const stop = async child => {
    child.stdin.end()
    const timeout = setTimeout(() => child.kill(), 5000)
    try { await child.exited } finally { clearTimeout(timeout); children.delete(child) }
  }
  try {
    execFileSync('rustc', ['--edition=2021', fileURLToPath(new URL('./legacy-process-fixture.rs', import.meta.url)), '-o', source], { windowsHide: true, stdio: 'pipe' })
    app = await launchTauri({ workspace: true })
    const page = app.page
    let task
    await page.getByRole('button', { name: '创建工作区', exact: true }).click()
    await page.locator('.app-shell').waitFor()
    const location = path.join(app.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')
    const digest = async () => createHash('sha256').update(await readFile(location)).digest('hex')
    const prepare = () => app.invoke('drafts_prepare')
    const frozen = async value => {
      for (const target of [page, task].filter(Boolean)) await waitFor(() => target.evaluate(value => document.documentElement.inert === value, value))
    }
    const end = async checkpoint => { assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }), true); await frozen(false) }
    await page.evaluate(async () => {
      window.__legacyResumes = []; window.__legacyFlushes = []
      for (const [event, key] of [['drafts:resume', '__legacyResumes'], ['drafts:flush', '__legacyFlushes']]) {
        await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', { event, target: { kind: 'WebviewWindow', label: 'workspace-main' }, handler: window.__TAURI_INTERNALS__.transformCallback(message => window[key].push(message.payload)) })
      }
    })
    await scenario('a lock-unaware DustDesk.exe is refused before flush or any workspace byte changes', async () => {
      const blocker = await start('DustDesk.exe')
      try {
        const before = await digest(); const flushes = await page.evaluate(() => window.__legacyFlushes.length)
        await assert.rejects(prepare(), new RegExp('PID ' + blocker.pid))
        await frozen(false); assert.equal(await digest(), before)
        assert.equal(await page.evaluate(() => window.__legacyFlushes.length), flushes)
        assert.equal(blocker.exitCode, null)
      } finally { await stop(blocker) }
      await end(await prepare())
    })
    await scenario('historical case-varied names and another Tauri pid are also refused but not terminated', async () => {
      for (const name of ['DUSTDESK.NEXT.EXE', 'dustdesk-tauri.exe']) {
        const blocker = await start(name)
        try { await assert.rejects(prepare(), new RegExp('PID ' + blocker.pid)); assert.equal(blocker.exitCode, null); await frozen(false) } finally { await stop(blocker) }
      }
      await end(await prepare())
    })
    await scenario('generic Electron and lookalike filenames do not falsely block maintenance', async () => {
      for (const name of ['electron.exe', 'unrelated-DustDesk.exe']) {
        const unrelated = await start(name)
        try { await end(await prepare()); assert.equal(unrelated.exitCode, null) } finally { await stop(unrelated) }
      }
    })
    await scenario('a legacy process appearing during actual all-window flush vetoes the sealing step', async () => {
      assert.equal((await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true))).ok, true)
      task = await waitFor(() => app.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('widget.html') && new URL(target.url()).searchParams.get('widget') === 'todo'))
      await task.getByLabel('桌面新增任务').fill('旧版出现时保留的未提交任务')
      await page.evaluate(() => {
        window.__legacyHolding = false
        window.__legacyStopHold = window.dustdesk.onBeforeQuit(async () => { window.__legacyHolding = true; await new Promise(resolve => { window.__legacyContinue = resolve }) })
      })
      const pending = prepare(); pending.catch(() => {})
      let blocker
      try {
        await waitFor(() => page.evaluate(() => window.__legacyHolding))
        blocker = await start('DustDesk.exe')
        await page.evaluate(() => { window.__legacyStopHold(); window.__legacyContinue() })
        await assert.rejects(pending, new RegExp('PID ' + blocker.pid))
        await frozen(false); assert.equal(blocker.exitCode, null)
        assert.equal(await task.getByLabel('桌面新增任务').inputValue(), '旧版出现时保留的未提交任务')
      } finally {
        await page.evaluate(() => { window.__legacyStopHold?.(); window.__legacyContinue?.() }).catch(() => {})
        if (blocker) await stop(blocker)
      }
      await end(await prepare())
    })
    await scenario('a legacy restart invalidates a Ready lease and cannot revive its old token', async () => {
      const checkpoint = await prepare(); await frozen(true)
      const blocker = await start('DustDesk.exe')
      try {
        await frozen(false)
        const resume = await page.evaluate(request => window.__legacyResumes.findLast(event => event.requestId === request), checkpoint.requestId)
        assert.match(resume.error, new RegExp('PID ' + blocker.pid)); assert.equal(blocker.exitCode, null)
        assert.equal(await task.getByLabel('桌面新增任务').inputValue(), '旧版出现时保留的未提交任务')
        assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }), false)
        await assert.rejects(prepare(), new RegExp('PID ' + blocker.pid))
      } finally { await stop(blocker) }
      const retry = await prepare(); assert.notEqual(retry.requestId, checkpoint.requestId)
      await new Promise(resolve => setTimeout(resolve, 1400)); await frozen(true)
      assert.equal(await app.invoke('drafts_end', { requestId: checkpoint.requestId }), false)
      await end(retry)
    })
    await mkdir(path.dirname(report), { recursive: true })
    await writeFile(report, JSON.stringify({ verifiedAt: new Date().toISOString(), scenarios: results, productionReady: false, processFixtures: 'independent Rust stdin waiters, no user installation executed', remaining: ['renamed-or-generic-electron-legacy-processes', 'atomic-import-commit-recheck', 'trusted-persistent-lineage', 'production-cutover-and-rollback', 'cross-user-session-validation'] }, null, 2))
  } finally {
    for (const child of children) await stop(child)
    await app?.close()
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
})
