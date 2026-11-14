import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile, mkdir, rm, rmdir, access, readdir, rename, symlink, unlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'

await test('Tauri workspace native parity', async suite => {
const reportPath = 'artifacts/tauri-migration/workspace-native.json'
await rm(reportPath, { force: true })
const application = await launchTauri()
const { invoke, page, findPage } = application
const pages = []
page.on('pageerror', error => pages.push(String(error)))
const root = path.join(application.root, 'user-data', 'tauri-preview', 'Workspace')
const location = path.join(root, 'workspace.json')
let failed = false
const scenario = (name, callback) => suite.test(name, async context => { try { await callback(context) } catch (error) { failed = true; throw error } })
try {
  let initial
  await scenario('Rust storage accepts a real Electron schema-3 workspace without modifying its shape', async t => {
    const electron = await mainFixture(t)
    initial = await electron.load()
    initial = await electron.load()
    initial.UnknownExtension = { nested: ['保留', { enabled: true }] }
    initial.Notes[0].UnknownNote = 'future-field'
    const snapshot = await invoke('prototype_workspace_initialize', { state: initial })
    assert.deepEqual(snapshot.state, initial)
    assert.equal(snapshot.revision, 1)
    assert.equal(snapshot.path, root)
    assert.deepEqual(JSON.parse(await readFile(location, 'utf8')), initial)
    await assert.rejects(invoke('prototype_workspace_initialize', { state: initial }), /禁止覆盖/)
  })
  await invoke('prototype_open_window', { kind: 'widget' })
  const widget = await findPage('widget')
  await widget.getByTestId('workspace-probe').waitFor()
  await scenario('real multi-window events synchronize clean drafts but preserve dirty input', async () => {
    const mainProbe = page.getByTestId('workspace-probe')
    const widgetProbe = widget.getByTestId('workspace-probe')
    await mainProbe.getByRole('textbox', { name: '共享快速笔记' }).waitFor()
    await widgetProbe.getByRole('textbox', { name: '共享快速笔记' }).waitFor()
    await widgetProbe.getByRole('textbox', { name: '共享快速笔记' }).fill('widget-private-draft')
    await mainProbe.getByRole('textbox', { name: '共享快速笔记' }).fill('main-saved')
    await mainProbe.getByRole('button', { name: '保存验证笔记' }).click()
    await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).QuickNote === 'main-saved')
    assert.equal(await widgetProbe.getByRole('textbox', { name: '共享快速笔记' }).inputValue(), 'widget-private-draft')
    await widgetProbe.getByRole('button', { name: '保存验证笔记' }).click()
    await waitFor(async () => await mainProbe.getByRole('textbox', { name: '共享快速笔记' }).inputValue() === 'widget-private-draft')
    assert.equal(JSON.parse(await readFile(location, 'utf8')).QuickNote, 'widget-private-draft')
  })
  await scenario('late real IPC read and save replies cannot overwrite a newer workspace broadcast', async () => {
    const mainProbe = page.getByTestId('workspace-probe')
    const textbox = mainProbe.getByRole('textbox', { name: '共享快速笔记' })
    const delay = async command => {
      await page.evaluate(command => {
        const original = window.fetch
        const gate = { captured: false, release: undefined, original }
        window.__workspaceTestGate = gate
        window.fetch = async (input, ...args) => {
          const result = await original(input, ...args)
          const url = typeof input === 'string' ? input : input.url ?? String(input)
          if (url.endsWith('/' + command) && !gate.captured) {
            gate.captured = true
            await new Promise(resolve => { gate.release = resolve })
          }
          return result
        }
      }, command)
    }
    const release = async () => {
      await page.evaluate(() => {
        const gate = window.__workspaceTestGate
        if (!gate) return
        window.fetch = gate.original
        gate.release?.()
        delete window.__workspaceTestGate
      })
    }
    try {
      await delay('prototype_workspace_load')
      await mainProbe.getByRole('button', { name: '重新读取' }).click()
      await waitFor(() => page.evaluate(() => window.__workspaceTestGate.captured))
      let baseline = (await invoke('prototype_workspace_load', {}, widget)).state
      await invoke('prototype_workspace_save', { state: { ...baseline, QuickNote: 'newer-than-delayed-read' }, baseline }, widget)
      await waitFor(async () => await textbox.inputValue() === 'newer-than-delayed-read')
      await release()
      await waitFor(() => mainProbe.getByRole('button', { name: '重新读取' }).isEnabled())
      assert.equal(await textbox.inputValue(), 'newer-than-delayed-read')
      await textbox.fill('save-whose-reply-will-be-late')
      await delay('prototype_workspace_save')
      await mainProbe.getByRole('button', { name: '保存验证笔记' }).click()
      await waitFor(() => page.evaluate(() => window.__workspaceTestGate.captured))
      baseline = (await invoke('prototype_workspace_load', {}, widget)).state
      assert.equal(baseline.QuickNote, 'save-whose-reply-will-be-late')
      const newest = await invoke('prototype_workspace_save', { state: { ...baseline, QuickNote: 'newer-than-delayed-save' }, baseline }, widget)
      await waitFor(async () => (await mainProbe.innerText()).includes('修订 ' + newest.revision + ' ·'))
      assert.equal(await textbox.inputValue(), 'save-whose-reply-will-be-late')
      await release()
      await waitFor(() => textbox.isEnabled())
      assert.equal(await textbox.inputValue(), 'newer-than-delayed-save')
    } finally { await release() }
  })
  await scenario('independent concurrent edits match actual Electron IPC save semantics', async t => {
    const electron = await mainFixture(t)
    const baseline = (await invoke('prototype_workspace_load')).state
    await mkdir(electron.data, { recursive: true })
    await writeFile(path.join(electron.data, 'workspace.json'), JSON.stringify(baseline))
    const first = structuredClone(baseline)
    const second = structuredClone(baseline)
    first.Notes[0].Title = 'main-title'
    first.Todos.push({ ...first.Todos[0], Id: crypto.randomUUID(), Title: 'background-added' })
    second.Notes[0].Text = 'widget-body'
    second.UnknownExtension.nested.push('new-value')
    await electron.invoke('workspace:save', first, baseline)
    await electron.invoke('workspace:save', second, baseline)
    await invoke('prototype_workspace_save', { state: first, baseline })
    const snapshot = await invoke('prototype_workspace_save', { state: second, baseline }, widget)
    assert.deepEqual(snapshot.state, await electron.load())
    assert.deepEqual(snapshot.state.UnknownExtension, second.UnknownExtension)
    assert.equal(snapshot.state.Notes[0].UnknownNote, 'future-field')
  })
  await scenario('parallel saves serialize rather than dropping independent fields', async () => {
    const baseline = (await invoke('prototype_workspace_load')).state
    const first = structuredClone(baseline)
    const second = structuredClone(baseline)
    first.Notes[0].Title = 'parallel-title'
    second.Notes[0].Text = 'parallel-body'
    const saved = await Promise.all([invoke('prototype_workspace_save', { state: first, baseline }), invoke('prototype_workspace_save', { state: second, baseline }, widget)])
    assert.notEqual(saved[0].revision, saved[1].revision)
    const latest = (await invoke('prototype_workspace_load')).state
    assert.equal(latest.Notes[0].Title, 'parallel-title')
    assert.equal(latest.Notes[0].Text, 'parallel-body')
  })
  await scenario('legacy schema-1 normalization matches Electron and preserves exact original recovery bytes', async t => {
    const electron = await mainFixture(t)
    const legacy = structuredClone(initial)
    legacy.SchemaVersion = 1
    delete legacy.Notes[0].Id
    delete legacy.Todos[0].Id
    legacy.Settings = { SidebarHidden: [], BackupRetentionDays: 999, WidgetPlacements: { todo: { X: -2.5, Visible: true }, unknown: { Visible: true } } }
    const original = JSON.stringify(legacy)
    await writeFile(location, original)
    await mkdir(electron.data, { recursive: true })
    await writeFile(path.join(electron.data, 'workspace.json'), original)
    const actual = await invoke('prototype_workspace_load')
    await electron.load()
    const expected = await electron.load()
    const compared = structuredClone(actual.state)
    for (const key of ['Todos', 'Notes']) {
      assert.match(compared[key][0].Id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      compared[key][0].Id = expected[key][0].Id
    }
    assert.notEqual(actual.state.Todos[0].Id, actual.state.Notes[0].Id)
    assert.deepEqual(compared, expected)
    assert.equal(await readFile(location + '.bak', 'utf8'), original)
    assert.deepEqual(await invoke('prototype_workspace_load'), actual)
    assert.equal(await readFile(location + '.bak', 'utf8'), original)
    await writeFile(location, JSON.stringify(initial))
    await invoke('prototype_workspace_load')
  })
  await scenario('clipboard images externalize identically to Electron and return scoped binary bytes', async t => {
    const electron = await mainFixture(t)
    const baseline = (await invoke('prototype_workspace_load')).state
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1cAAAAASUVORK5CYII=', 'base64')
    const incoming = structuredClone(baseline)
    incoming.ClipboardHistory = ['first-image', 'second-image'].map(Id => ({ Id, Kind: 'Image', Text: '', ImagePngBase64: bytes.toString('base64'), ImageFileName: '测试.png', ImageSha256: createHash('sha256').update(bytes).digest('hex'), CreatedAt: '2026-11-09T01:00:00.000Z', IsLocked: false, IsPinned: false }))
    await mkdir(electron.data, { recursive: true })
    await writeFile(path.join(electron.data, 'workspace.json'), JSON.stringify(baseline))
    await electron.invoke('workspace:save', incoming, baseline)
    const saved = await invoke('prototype_workspace_save', { state: incoming, baseline })
    assert.deepEqual(saved.state, await electron.load())
    const directory = path.join(root, 'ClipboardImages')
    const name = createHash('sha256').update(bytes).digest('hex') + '.png'
    const asset = path.join(directory, name)
    assert.deepEqual(await readdir(directory), [name])
    assert.deepEqual(await readFile(asset), await readFile(path.join(electron.data, 'ClipboardImages', name)))
    const binary = await page.evaluate(async () => {
      const content = await window.__TAURI_INTERNALS__.invoke('prototype_workspace_image', { id: 'first-image' })
      return { binary: content instanceof ArrayBuffer, bytes: Array.from(new Uint8Array(content)) }
    })
    assert.equal(binary.binary, true)
    assert.deepEqual(Buffer.from(binary.bytes), bytes)
    await assert.rejects(invoke('prototype_workspace_image', { id: '../../workspace.json' }))
    await writeFile(asset, 'corrupted-image')
    await assert.rejects(invoke('prototype_workspace_image', { id: 'first-image' }), /损坏/)
    assert.deepEqual((await invoke('prototype_workspace_load')).state, saved.state)
    await rm(asset)
    await assert.rejects(invoke('prototype_workspace_image', { id: 'first-image' }))
    await rmdir(directory)
    await writeFile(directory, 'blocked-directory')
    const before = await readFile(location)
    await assert.rejects(invoke('prototype_workspace_save', { state: incoming, baseline: saved.state }))
    assert.deepEqual(await readFile(location), before)
    await rm(directory)
    await invoke('prototype_workspace_save', { state: incoming, baseline: saved.state })
    assert.deepEqual(await readFile(asset), bytes)
    const current = (await invoke('prototype_workspace_load')).state
    await invoke('prototype_workspace_save', { state: { ...current, ClipboardHistory: [] }, baseline: current })
    assert.deepEqual(await readFile(asset), bytes)
    await assert.rejects(invoke('prototype_workspace_image', { id: 'first-image' }))
    await invoke('prototype_workspace_save', { state: current, baseline: (await invoke('prototype_workspace_load')).state })
  })
  await scenario('Windows directory junctions cannot redirect image reads or writes outside the workspace', async () => {
    const baseline = (await invoke('prototype_workspace_load')).state
    const directory = path.resolve(root, 'ClipboardImages')
    const held = path.resolve(root, 'ClipboardImages.held')
    assert.equal(path.dirname(directory), path.resolve(root))
    assert.equal(path.dirname(held), path.resolve(root))
    const outside = path.resolve(application.root, 'outside-assets')
    await mkdir(outside)
    await writeFile(path.join(outside, 'sentinel.txt'), 'untouched')
    await rename(directory, held)
    let linked = false
    try {
      await symlink(outside, directory, 'junction')
      linked = true
      await assert.rejects(invoke('prototype_workspace_image', { id: 'first-image' }), /重解析点/)
      const incoming = structuredClone(baseline)
      incoming.ClipboardHistory[0].ImagePngBase64 = Buffer.from('junction-write-must-not-happen').toString('base64')
      const before = await readFile(location)
      await assert.rejects(invoke('prototype_workspace_save', { state: incoming, baseline }), /重解析点/)
      assert.deepEqual(await readFile(location), before)
      assert.deepEqual(await readdir(outside), ['sentinel.txt'])
      assert.equal(await readFile(path.join(outside, 'sentinel.txt'), 'utf8'), 'untouched')
    } finally {
      if (linked) await unlink(directory)
      await rename(held, directory)
    }
  })
  await scenario('deleted records cannot be resurrected and native-owned collections cannot be forged', async () => {
    const baseline = (await invoke('prototype_workspace_load')).state
    const deletion = structuredClone(baseline)
    deletion.Notes = []
    deletion.FocusSessions.push({ Id: 'forged-focus', TaskTitle: 'fake', ProjectName: 'fake', Seconds: 1 })
    const deleted = await invoke('prototype_workspace_save', { state: deletion, baseline })
    assert.equal(deleted.state.RecycleBin.length, 1)
    assert.deepEqual(deleted.state.RecycleBin[0].value, baseline.Notes[0])
    assert.deepEqual(deleted.state.FocusSessions, baseline.FocusSessions)
    const stale = structuredClone(baseline)
    stale.Notes[0].Text = 'late-stale-draft'
    const saved = await invoke('prototype_workspace_save', { state: stale, baseline }, widget)
    assert.deepEqual(saved.state.Notes, [])
    assert.equal(saved.state.RecycleBin.length, 1)
  })
  await scenario('validation and window-role authorization protect existing files', async () => {
    const baseline = (await invoke('prototype_workspace_load')).state
    const before = await readFile(location)
    const duplicate = structuredClone(baseline)
    duplicate.Todos.push(duplicate.Todos[0])
    await assert.rejects(invoke('prototype_workspace_save', { state: duplicate, baseline }), /不完整/)
    await invoke('prototype_open_window', { kind: 'pin' })
    const pin = await findPage('pin')
    await assert.rejects(invoke('prototype_workspace_load', {}, pin), /无工作区访问权限/)
    await assert.rejects(invoke('prototype_workspace_save', { state: baseline, baseline }, pin), /无工作区访问权限/)
    await assert.rejects(invoke('prototype_workspace_image', { id: 'first-image' }, pin), /无工作区访问权限/)
    await assert.rejects(invoke('prototype_workspace_initialize', { state: baseline }, widget), /只有主窗口/)
    assert.deepEqual(await readFile(location), before)
  })
  await scenario('corrupt current JSON recovers backup, while newer schema never downgrades', async () => {
    const baseline = (await invoke('prototype_workspace_load')).state
    const expected = JSON.parse(await readFile(location + '.bak', 'utf8'))
    await writeFile(location, '{broken-current')
    assert.deepEqual((await invoke('prototype_workspace_load')).state, expected)
    for (const SchemaVersion of [4, 4.5, 999]) {
      const protectedBytes = JSON.stringify({ ...baseline, SchemaVersion })
      await writeFile(location, protectedBytes)
      await assert.rejects(invoke('prototype_workspace_load'), /较新/)
      assert.equal(await readFile(location, 'utf8'), protectedBytes)
    }
    await writeFile(location, JSON.stringify(baseline))
  })
  await scenario('successful data stays after failure, and missing files cannot trigger starter data', async () => {
    const before = await readFile(location)
    const baseline = JSON.parse(before)
    await rm(location + '.bak')
    await mkdir(location + '.bak')
    await assert.rejects(invoke('prototype_workspace_save', { state: { ...baseline, QuickNote: 'must-not-commit' }, baseline }))
    assert.deepEqual(await readFile(location), before)
    await rm(location + '.bak', { recursive: true })
    await invoke('prototype_workspace_save', { state: { ...baseline, QuickNote: 'recovered-write' }, baseline })
    await rm(location)
    await rm(location + '.bak')
    await assert.rejects(invoke('prototype_workspace_load'), /已丢失/)
    await assert.rejects(access(location))
    await assert.rejects(invoke('prototype_workspace_initialize', { state: initial }), /禁止覆盖/)
  })
  assert.deepEqual(pages, [])
  assert.equal(failed, false, 'Failed scenarios must not produce a successful migration report')
  await mkdir('artifacts/tauri-migration', { recursive: true })
  await writeFile(reportPath, JSON.stringify({
    ok: true, isolated: true, executable: application.executable,
    checks: ['electron-schema3-roundtrip', 'actual-electron-IPC-differential', 'legacy-defaults-IPC-differential', 'exact-legacy-recovery-bytes', 'idempotent-normalization', 'clipboard-assets-IPC-differential', 'binary-image-by-id', 'asset-deduplication-and-retention', 'missing-corrupt-image-retry', 'windows-junction-rejection', 'real-multi-window-draft-sync', 'late-read-and-save-reply-protection', 'parallel-serial-save', 'stale-deletion-protection', 'recycle-owned-state', 'unknown-field-roundtrip', 'role-permissions', 'backup-recovery', 'no-schema-downgrade', 'failure-cleanup-retry', 'missing-file-protection'],
    pending: ['full-normalization-corpus', 'production-data-handoff', 'shutdown-flush']
  }, null, 2))
} finally { await application.close() }
})
