import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mainFixture } from './main-headless-harness.mjs'

test('file icons use native icons and retain folder fallback when extraction fails', async t => {
  const fixture = await mainFixture(t)
  const folder = path.join(fixture.root, 'example-folder')
  await fs.mkdir(folder)
  const file = path.join(folder, 'example.txt')
  await fs.writeFile(file, 'example')
  const calls = []
  fixture.electron.app.getFileIcon = async (target, options) => {
    calls.push({ target, options })
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,example' }
  }
  assert.deepEqual(await fixture.invoke('path:icon', file), { isDirectory: false, dataUrl: 'data:image/png;base64,example' })
  assert.deepEqual(calls, [{ target: file, options: { size: 'large' } }])
  const fallbackRequests = []
  fixture.electron.app.getFileIcon = async target => {
    fallbackRequests.push(target)
    throw Error('No native icon')
  }
  assert.deepEqual(await fixture.invoke('path:icon', folder), { isDirectory: true })
  if (process.platform === 'win32') assert.ok(!fallbackRequests.includes(folder), 'Do not use the folder association that returns a drive icon')
  if (process.platform === 'win32') {
    for (const name of ['no-extension', 'website.url']) {
      const target = path.join(folder, name)
      await fs.writeFile(target, '')
      assert.deepEqual(await fixture.invoke('path:icon', target), { isDirectory: false })
      assert.ok(!fallbackRequests.includes(target), 'A failed shell lookup must not fall back to known wrong associations')
    }
  }
  const originalStat = fixture.fileSystem.stat
  const unreadable = path.join(folder, 'unreadable')
  fixture.fileSystem.stat = async target => { if (target === unreadable) throw Error('Temporarily unavailable'); return originalStat(target) }
  assert.deepEqual(await fixture.invoke('path:icon', unreadable), {}, 'An unreadable path must not override an existing folder type with false')
  assert.deepEqual(await fixture.invoke('path:icon', path.join(folder, 'missing.txt')), {})
  for (const target of [null, 42, '', 'relative.txt', 'https://example.com/file', 'x'.repeat(4097)]) {
    assert.deepEqual(await fixture.invoke('path:icon', target), {})
  }
})

test('shortcut extraction failure falls back asynchronously without synchronous shell or image reads', { skip: process.platform !== 'win32' }, async t => {
  const fixture = await mainFixture(t)
  const shortcut = path.join(fixture.root, 'example.LNK')
  await fs.writeFile(shortcut, 'shortcut fixture')
  fixture.electron.shell.readShortcutLink = () => { throw Error('Shortcut reads must run in the background') }
  fixture.electron.nativeImage.createFromPath = () => { throw Error('Image reads must run in the background') }
  fixture.electron.shell.openPath = () => { throw Error('Icon extraction must never launch a program') }
  const calls = []
  fixture.electron.app.getFileIcon = async target => {
    calls.push(target)
    assert.equal(target, shortcut, 'The system icon is the last fallback after background extraction fails')
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,program' }
  }
  assert.deepEqual(await fixture.invoke('path:icon', shortcut), { isDirectory: false, dataUrl: 'data:image/png;base64,program' })
  assert.deepEqual(calls, [shortcut])
  assert.equal((await fixture.invoke('path:icon', shortcut)).dataUrl, 'data:image/png;base64,program')
  assert.equal(calls.length, 1, 'Main process shares the icon across repeated IPC calls')
  const broken = path.join(fixture.root, 'broken.lnk')
  await fs.writeFile(broken, 'broken shortcut')
  fixture.electron.app.getFileIcon = async () => { throw Error('Shell extension failed') }
  assert.deepEqual(await fixture.invoke('path:icon', broken), { isDirectory: false })
})

test('default restore selects the most recent backup across manual and automatic backups', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const directory = path.join(fixture.data, 'Backups')
  await fs.mkdir(directory)
  const older = path.join(directory, 'manual-2026-01-01.json')
  const newer = path.join(directory, 'auto-2026-01-02.json')
  await fs.writeFile(older, JSON.stringify({ ...state, QuickNote: 'older' }))
  await fs.writeFile(newer, JSON.stringify({ ...state, QuickNote: 'newer' }))
  await fs.utimes(older, new Date('2026-01-01'), new Date('2026-01-01'))
  await fs.utimes(newer, new Date('2026-01-02'), new Date('2026-01-02'))
  assert.equal((await fixture.invoke('maintenance:restore')).ok, true)
  assert.equal((await fixture.load()).QuickNote, 'newer')
})

test('transient read errors cannot overwrite valid current data with an older backup', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  await fixture.invoke('workspace:save', { ...state, QuickNote: 'latest' }, state)
  const workspace = path.join(fixture.data, 'workspace.json')
  const contents = await fs.readFile(workspace, 'utf8')
  const read = fixture.fileSystem.readFile
  fixture.fileSystem.readFile = async (target, ...args) => {
    if (target === workspace) throw Object.assign(Error('sharing violation'), { code: 'EACCES' })
    return read(target, ...args)
  }
  await assert.rejects(fixture.load(), /sharing violation/)
  assert.equal(await fs.readFile(workspace, 'utf8'), contents)
})

test('failed workspace writes clean their temporary files and remain retryable', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const rename = fixture.fileSystem.rename
  fixture.fileSystem.rename = async () => { throw Error('rename failed') }
  await assert.rejects(fixture.invoke('workspace:save', { ...state, QuickNote: 'retry' }, state), /rename failed/)
  assert.equal((await fs.readdir(fixture.data)).some(name => name.includes('.electron-tmp-')), false)
  fixture.fileSystem.rename = rename
  await fixture.invoke('workspace:save', { ...state, QuickNote: 'retry' }, state)
  assert.equal((await fixture.load()).QuickNote, 'retry')
})

test('failed backup copying preserves both the current workspace and previous recovery copy', async t => {
  const fixture = await mainFixture(t)
  const initial = await fixture.load()
  await fixture.invoke('workspace:save', { ...initial, QuickNote: 'saved' }, initial)
  const current = await fixture.load()
  const workspace = path.join(fixture.data, 'workspace.json')
  const recovery = workspace + '.bak'
  const oldBytes = await fs.readFile(workspace, 'utf8')
  const recoveryBytes = await fs.readFile(recovery, 'utf8')
  fixture.fileSystem.copyFile = async (_from, to) => {
    await fs.writeFile(to, 'partial backup')
    throw Error('disk full')
  }
  await assert.rejects(fixture.invoke('workspace:save', { ...current, QuickNote: 'failed' }, current), /disk full/)
  assert.equal(await fs.readFile(workspace, 'utf8'), oldBytes)
  assert.equal(await fs.readFile(recovery, 'utf8'), recoveryBytes)
  assert.equal((await fs.readdir(fixture.data)).some(name => name.includes('.electron-tmp-')), false)
})

test('hotkey changes roll back native registration when their save fails', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  fixture.fileSystem.rename = async () => { throw Error('disk failure') }
  assert.equal((await fixture.invoke('hotkeys:set', { mainWindow: 'Ctrl+Alt+M' })).ok, false)
  assert.equal(fixture.shortcutCalls.includes('Ctrl+Alt+M'), false)
  assert.equal(fixture.shortcutCalls.includes(state.Settings.MainWindowHotKey), true)
  assert.equal((await fixture.load()).Settings.MainWindowHotKey, state.Settings.MainWindowHotKey)
})

test('disappearing workspace files cannot return cached starter data after successful edits', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  await fixture.invoke('workspace:save', { ...state, QuickNote: 'important saved content' }, state)
  await fs.unlink(path.join(fixture.data, 'workspace.json'))
  await fs.unlink(path.join(fixture.data, 'workspace.json.bak'))
  await assert.rejects(fixture.load(), /丢失|无法完整读取/)
})

test('corrupt JSON recovers from backup, but a newer schema must never be downgraded', async t => {
  const fixture = await mainFixture(t)
  const first = await fixture.load()
  await fixture.invoke('workspace:save', { ...first, QuickNote: 'new' }, first)
  const workspace = path.join(fixture.data, 'workspace.json')
  await fs.writeFile(workspace, '{broken')
  assert.equal((await fixture.load()).QuickNote, first.QuickNote)
  const future = JSON.stringify({ ...first, SchemaVersion: 99, QuickNote: 'future' })
  await fs.writeFile(workspace, future)
  await assert.rejects(fixture.load(), /版本较新/)
  assert.equal(await fs.readFile(workspace, 'utf8'), future)
})

test('overlapping workspace edits preserve additions and respect concurrent deletions', async t => {
  const fixture = await mainFixture(t)
  const first = fixture.client(); const second = fixture.client()
  const [baseA, baseB] = await Promise.all([first('workspace:load'), second('workspace:load')])
  await Promise.all([
    first('workspace:save', { ...baseA, QuickNote: 'first change' }, baseA),
    second('workspace:save', { ...baseB, Notes: baseB.Notes.map(note => ({ ...note, Text: 'second change' })) }, baseB)
  ])
  const merged = await fixture.load()
  assert.equal(merged.QuickNote, 'first change')
  assert.equal(merged.Notes[0].Text, 'second change')
  await first('workspace:save', { ...merged, Notes: [] }, merged)
  await second('workspace:save', { ...baseB, Notes: baseB.Notes.map(note => ({ ...note, Title: 'stale title' })) }, baseB)
  assert.equal((await fixture.load()).Notes.length, 0)
})

test('clearing a note background preserves the image required by workspace recovery', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const source = path.join(fixture.root, 'source.png')
  await fs.writeFile(source, 'image bytes')
  const imported = await fixture.invoke('notes:import-background', state.Notes[0].Id, source)
  assert.equal(imported.ok, true)
  assert.equal((await fixture.invoke('notes:clear-background', state.Notes[0].Id, imported.path)).ok, true)
  await fs.writeFile(path.join(fixture.data, 'workspace.json'), '{corrupt')
  const recovered = await fixture.load()
  assert.equal(recovered.Notes[0].BackgroundImagePath, imported.path)
  assert.equal((await fixture.invoke('notes:read-image', imported.path)).ok, true)
})

test('malformed backup image bundles cannot report successful recovery', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const directory = path.join(fixture.data, 'Backups'); await fs.mkdir(directory)
  const target = path.join(directory, 'invalid-assets.json')
  for (const assets of [[], 'invalid', { 'image.png': '' }, { 'image.png': 'a===' }]) {
    await fs.writeFile(target, JSON.stringify({ ...state, BackupNoteAssets: assets }))
    const before = await fs.readFile(path.join(fixture.data, 'workspace.json'), 'utf8')
    assert.equal((await fixture.invoke('maintenance:restore', target)).ok, false, JSON.stringify(assets))
    assert.equal(await fs.readFile(path.join(fixture.data, 'workspace.json'), 'utf8'), before)
  }
})

test('failed image bundle validation leaves no partially restored assets', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const directory = path.join(fixture.data, 'Backups'); await fs.mkdir(directory)
  const target = path.join(directory, 'partial-assets.json')
  await fs.writeFile(target, JSON.stringify({ ...state, BackupNoteAssets: { 'valid.png': 'aW1hZ2U=', 'invalid.exe': 'aW1hZ2U=' } }))
  assert.equal((await fixture.invoke('maintenance:restore', target)).ok, false)
  const remaining = await fs.readdir(path.join(fixture.data, 'NoteBackgrounds')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  assert.deepEqual(remaining, [])
})

test('a failed recovery metadata commit removes its newly restored note images', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const directory = path.join(fixture.data, 'Backups'); await fs.mkdir(directory)
  const target = path.join(directory, 'valid-assets.json')
  await fs.writeFile(target, JSON.stringify({ ...state, Notes: state.Notes.map(note => ({ ...note, BackgroundImagePath: 'old.png' })), BackupNoteAssets: { 'old.png': 'aW1hZ2U=' } }))
  const rename = fixture.fileSystem.rename
  fixture.fileSystem.rename = async (from, to) => {
    if (to === path.join(fixture.data, 'workspace.json')) throw Error('metadata failure')
    return rename(from, to)
  }
  assert.equal((await fixture.invoke('maintenance:restore', target)).ok, false)
  assert.equal((await fixture.load()).Notes[0].BackgroundImagePath, null)
  assert.deepEqual(await fs.readdir(path.join(fixture.data, 'NoteBackgrounds')), [])
})

test('background backups restore live and recycled notes to a shared new image', async t => {
  const fixture = await mainFixture(t)
  let state = await fixture.load()
  const source = path.join(fixture.root, 'source.png'); await fs.writeFile(source, 'original image bytes')
  const imported = await fixture.invoke('notes:import-background', state.Notes[0].Id, source)
  assert.equal(imported.ok, true)
  state = await fixture.load()
  const duplicate = { ...state.Notes[0], Id: 'recycled-note' }
  await fixture.invoke('workspace:save', { ...state, Notes: [...state.Notes, duplicate] }, state)
  state = await fixture.load()
  await fixture.invoke('workspace:save', { ...state, Notes: state.Notes.filter(note => note.Id !== duplicate.Id) }, state)
  const backup = await fixture.invoke('maintenance:backup')
  assert.equal(backup.ok, true)
  await fs.unlink(imported.path)
  assert.equal((await fixture.invoke('maintenance:restore', backup.path)).ok, true)
  const restored = await fixture.load()
  const recoveredPath = restored.Notes[0].BackgroundImagePath
  assert.notEqual(recoveredPath, imported.path)
  assert.equal(restored.RecycleBin[0].value.BackgroundImagePath, recoveredPath)
  assert.equal(await fs.readFile(recoveredPath, 'utf8'), 'original image bytes')
  assert.equal(restored.BackupNoteAssets, undefined)
  assert.equal((await fixture.invoke('productivity:action', { type: 'recycle-restore', id: restored.RecycleBin[0].Id })).ok, true)
  assert.equal((await fixture.load()).Notes.find(note => note.Id === duplicate.Id).BackgroundImagePath, recoveredPath)
})

test('partial image-write failures remove both complete and incomplete recovery files', async t => {
  const fixture = await mainFixture(t)
  const state = await fixture.load()
  const directory = path.join(fixture.data, 'Backups'); await fs.mkdir(directory)
  const target = path.join(directory, 'two-assets.json')
  await fs.writeFile(target, JSON.stringify({ ...state, BackupNoteAssets: { 'one.png': 'aW1hZ2U=', 'two.png': 'aW1hZ2U=' } }))
  const open = fixture.fileSystem.open
  let writes = 0
  fixture.fileSystem.open = async (...args) => {
    const file = await open(...args)
    if (!String(args[0]).endsWith('.png') || ++writes !== 2) return file
    return { close: () => file.close(), writeFile: async buffer => {
      await file.writeFile(buffer.subarray(0, 2))
      throw Error('partial image write')
    } }
  }
  const response = await fixture.invoke('maintenance:restore', target)
  assert.equal(response.ok, false)
  assert.match(response.error, /partial image write/)
  assert.deepEqual(await fs.readdir(path.join(fixture.data, 'NoteBackgrounds')), [])
})
