import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  await mkdir(path.join(app.tempRoot, 'desktop', 'nested'), { recursive: true })
  await writeFile(path.join(app.tempRoot, 'desktop', 'nested', 'nested-search-target.txt'), 'ok')
  const results = await app.window.evaluate(() => window.dustdesk.searchFiles('nested-search-target'))
  assert.equal(results.some(item => item.Path.endsWith(path.join('nested', 'nested-search-target.txt'))), true)

  const widgetWindowPromise = app.electronApp.waitForEvent('window', { timeout: 10000 })
  await app.window.evaluate(() => window.dustdesk.toggleWidgets('todo'))
  const widget = await widgetWindowPromise
  await widget.waitForSelector('.widget-head')
  const mainBase = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  const widgetBase = await widget.evaluate(() => window.dustdesk.loadWorkspace())
  await Promise.all([
    app.window.evaluate(state => window.dustdesk.saveWorkspace({ ...state, QuickNote: 'main-window-change' }, state), mainBase),
    widget.evaluate(state => window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, MainWindowDisplayName: 'widget-window-change' } }, state), widgetBase)
  ])
  const merged = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal(merged.QuickNote, 'main-window-change')
  assert.equal(merged.Settings.MainWindowDisplayName, 'widget-window-change')

  const staleBase = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  await app.window.evaluate(state => window.dustdesk.saveWorkspace({ ...state, QuickNote: 'sequential-first' }, state), staleBase)
  await app.window.evaluate(state => window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, MainWindowDisplayName: 'sequential-second' } }, state), staleBase)
  const sequential = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal(sequential.QuickNote, 'sequential-first')
  assert.equal(sequential.Settings.MainWindowDisplayName, 'sequential-second')
  const noteBase = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  const noteId = noteBase.Notes[0].Id
  await app.window.evaluate(({ state, noteId }) => window.dustdesk.saveWorkspace({ ...state, Notes: state.Notes.map(note => note.Id === noteId ? { ...note, Title: '合并标题' } : note) }, state), { state: noteBase, noteId })
  await app.window.evaluate(({ state, noteId }) => window.dustdesk.saveWorkspace({ ...state, Notes: state.Notes.map(note => note.Id === noteId ? { ...note, Text: '合并正文' } : note) }, state), { state: noteBase, noteId })
  const mergedNote = (await app.window.evaluate(() => window.dustdesk.loadWorkspace())).Notes.find(note => note.Id === noteId)
  assert.equal(mergedNote.Title, '合并标题')
  assert.equal(mergedNote.Text, '合并正文')

  const presetState = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  await app.window.evaluate(state => window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, WidgetPlacements: { ...state.Settings.WidgetPlacements, todo: { ...state.Settings.WidgetPlacements.todo, Visible: true, Width: 430, Height: 260 } } } }, state), presetState)
  assert.equal((await app.window.evaluate(() => window.dustdesk.setWidgetOptions('todo', { locked: true, topMost: true, transparentBackground: true, collapsed: true, snapToEdges: true }))).ok, true)
  assert.equal((await app.window.evaluate(() => window.dustdesk.saveWidgetPreset('regression-layout'))).ok, true)
  const hiddenState = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  await app.window.evaluate(state => window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, WidgetPlacements: { ...state.Settings.WidgetPlacements, todo: { ...state.Settings.WidgetPlacements.todo, Visible: false } } } }, state), hiddenState)
  await app.window.evaluate(() => window.dustdesk.setWidgetOptions('todo', { locked: false, topMost: false, transparentBackground: false, collapsed: false, snapToEdges: false }))
  assert.equal((await app.window.evaluate(() => window.dustdesk.applyWidgetPreset('regression-layout'))).ok, true)
  assert.equal((await app.window.evaluate(() => window.dustdesk.getWidgetVisibility(['todo']))).todo, true)
  const applied = await app.window.evaluate(() => window.dustdesk.loadWorkspace().then(state => state.Settings.WidgetPlacements.todo))
  assert.equal(applied.Locked, true)
  assert.equal(applied.TopMost, true)
  assert.equal(applied.TransparentBackground, true)
  assert.equal(applied.IsCollapsed, true)
  assert.equal(applied.SnapToEdges, true)
  await widget.waitForFunction(() => innerHeight === 34)
  const collapsedPlacement = await app.window.evaluate(() => window.dustdesk.loadWorkspace().then(state => state.Settings.WidgetPlacements.todo))
  assert.equal(collapsedPlacement.Height >= 120, true)
  await app.window.evaluate(() => window.dustdesk.setWidgetOptions('todo', { collapsed: false }))
  await app.window.evaluate(() => window.dustdesk.hideWidget('todo'))
  assert.equal((await app.window.evaluate(() => window.dustdesk.saveWidgetPreset('hidden-layout'))).ok, true)
  await app.window.evaluate(() => window.dustdesk.toggleWidgets('todo'))
  assert.equal((await app.window.evaluate(() => window.dustdesk.applyWidgetPreset('hidden-layout'))).ok, true)
  assert.equal((await app.window.evaluate(() => window.dustdesk.getWidgetVisibility(['todo']))).todo, false)
  assert.equal((await app.window.evaluate(() => window.dustdesk.hideWidget('todo'))).ok, true)
  assert.equal((await app.window.evaluate(() => window.dustdesk.loadWorkspace())).Settings.WidgetPlacements.todo.Visible, false)

  const categoryId = merged.DesktopCategories[0].Id
  const outside = await app.window.evaluate(root => window.dustdesk.moveIntoCategory(root, 'C:\\outside-dustdesk-test.txt'), categoryId)
  assert.equal(outside.ok, false)

  const organizerSource = path.join(app.tempRoot, 'desktop', 'organizer-merge-source.txt')
  await writeFile(organizerSource, 'organizer')
  const categoryIds = (await app.window.evaluate(() => window.dustdesk.loadWorkspace())).DesktopCategories.slice(0, 2).map(item => item.Id)
  const firstMove = await app.window.evaluate(({ category, source }) => window.dustdesk.moveIntoCategory(category, source), { category: categoryIds[0], source: organizerSource })
  assert.equal(firstMove.ok, true)
  const secondMove = await app.window.evaluate(({ category, source }) => window.dustdesk.moveIntoCategory(category, source), { category: categoryIds[1], source: firstMove.path })
  assert.equal(secondMove.ok, true)
  const undo = await app.window.evaluate(() => window.dustdesk.undoOrganizerMove())
  assert.equal(undo.ok, true)
  assert.equal(path.resolve(undo.path), path.resolve(firstMove.path))
  const organizerState = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal(organizerState.DesktopCategories.find(item => item.Id === categoryIds[0]).ItemPaths.includes(firstMove.path), true)
  assert.equal(organizerState.DesktopCategories.find(item => item.Id === categoryIds[1]).ItemPaths.includes(secondMove.path), false)
  assert.equal((await app.window.evaluate(({ category, source }) => window.dustdesk.restoreToDesktop(category, source), { category: categoryIds[0], source: firstMove.path })).ok, true)

  const backupDirectory = path.join(app.tempRoot, 'data', 'Backups')
  const malformedBackup = path.join(backupDirectory, 'workspace-malformed.json')
  await mkdir(backupDirectory, { recursive: true })
  await writeFile(malformedBackup, JSON.stringify({ Settings: {}, Todos: [], Notes: 'invalid', Projects: [{ Id: 'project', Name: 'Recovered', Phases: 'invalid' }], LinkGroups: [{ Id: 'group', Name: 42, Links: 'invalid' }], DesktopCategories: 'invalid' }))
  const beforeInvalidRestore = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal((await app.window.evaluate(target => window.dustdesk.restoreBackup(target), malformedBackup)).ok, false)
  const recovered = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.deepEqual(recovered, beforeInvalidRestore)
  console.log('Logic regressions passed')
} finally {
  await closeDustDesk(app)
}
