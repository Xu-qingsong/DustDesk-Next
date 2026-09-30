import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const test = await launchDustDesk()
try {
  await test.window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    state.Settings.ClipboardMonitoringEnabled = false
    await window.dustdesk.saveWorkspace(state)
  })

  for (let i = 0; i < 3; i++) {
    const marker = `review-save-${i}`
    const backup = await test.window.evaluate(async marker => {
      const state = await window.dustdesk.loadWorkspace()
      const [, backup] = await Promise.all([
        window.dustdesk.saveWorkspace({ ...state, QuickNote: marker }),
        window.dustdesk.createBackup()
      ])
      return backup
    }, marker)
    assert.equal(backup.ok, true)
    assert.equal(JSON.parse(await readFile(backup.path, 'utf8')).QuickNote, marker)
  }

  await test.window.evaluate(() => window.dustdesk.toggleWidgets('todo'))
  for (const operation of ['move', 'resize']) {
    await test.window.evaluate(async operation => {
      if (!(await window.dustdesk.getWidgetVisibility(['todo'])).todo) await window.dustdesk.toggleWidgets('todo')
      await Promise.all([
        operation === 'move' ? window.dustdesk.moveWidget('todo', 120, 120, true) : window.dustdesk.resizeWidget('todo', 440, 280, true),
        window.dustdesk.hideWidget('todo')
      ])
    }, operation)
    const state = await test.window.evaluate(async () => ({
      persisted: (await window.dustdesk.loadWorkspace()).Settings.WidgetPlacements.todo.Visible,
      native: (await window.dustdesk.getWidgetVisibility(['todo'])).todo
    }))
    assert.deepEqual(state, { persisted: false, native: false }, operation)
  }

  const hiddenBackup = await test.window.evaluate(() => window.dustdesk.createBackup())
  await test.window.evaluate(() => window.dustdesk.toggleWidgets('todo'))
  assert.equal((await test.window.evaluate(file => window.dustdesk.restoreBackup(file), hiddenBackup.path)).ok, true)
  assert.equal((await test.window.evaluate(() => window.dustdesk.getWidgetVisibility(['todo']))).todo, false)

  await test.window.evaluate(async () => {
    await window.dustdesk.toggleWidgets('todo')
    await window.dustdesk.resizeWidget('todo', 430, 260, true)
    await window.dustdesk.setWidgetOptions('todo', { locked: true, topMost: true, collapsed: true })
  })
  const configuredBackup = await test.window.evaluate(() => window.dustdesk.createBackup())
  await test.window.evaluate(async () => {
    await window.dustdesk.setWidgetOptions('todo', { locked: false, topMost: false, collapsed: false })
    await window.dustdesk.resizeWidget('todo', 500, 400, true)
  })
  assert.equal((await test.window.evaluate(file => window.dustdesk.restoreBackup(file), configuredBackup.path)).ok, true)
  const native = await test.electronApp.evaluate(({ BrowserWindow }) => {
    const widget = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('widget=todo'))
    return { width: widget.getBounds().width, height: widget.getBounds().height, locked: !widget.isResizable(), topMost: widget.isAlwaysOnTop() }
  })
  assert.deepEqual(native, { width: 430, height: 34, locked: true, topMost: true })
  assert.equal((await test.window.evaluate(() => window.dustdesk.resizeWidget('todo', 600, 400))).ok, false)
  await test.window.evaluate(() => window.dustdesk.setWidgetOptions('todo', { collapsed: false }))
  assert.equal(await test.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().includes('widget=todo')).getBounds().height), 260)

  const state = await test.window.evaluate(() => window.dustdesk.loadWorkspace())
  const category = state.DesktopCategories[0]
  const organizer = path.join(test.tempRoot, 'data', 'DesktopOrganizer')
  const outside = path.join(test.tempRoot, 'outside-managed-root')
  await mkdir(organizer, { recursive: true }); await mkdir(outside)
  await mkdir(path.join(test.tempRoot, 'desktop'), { recursive: true })
  await symlink(outside, path.join(organizer, category.Name), 'junction')
  const source = path.join(test.tempRoot, 'desktop', 'review-junction-probe.txt')
  await writeFile(source, 'original')
  const moved = await test.window.evaluate(({ id, source }) => window.dustdesk.moveIntoCategory(id, source), { id: category.Id, source })
  assert.equal(moved.ok, false)
  assert.equal(await readFile(source, 'utf8'), 'original')
  await assert.rejects(readFile(path.join(outside, path.basename(source))), { code: 'ENOENT' })
  await writeFile(path.join(outside, 'external.txt'), 'untouched')
  const restored = await test.window.evaluate(({ id, source }) => window.dustdesk.restoreToDesktop(id, source), {
    id: category.Id, source: path.join(organizer, category.Name, 'external.txt')
  })
  assert.equal(restored.ok, false)
  assert.equal(await readFile(path.join(outside, 'external.txt'), 'utf8'), 'untouched')
  await symlink(outside, path.join(test.tempRoot, 'data', 'NoteBackgrounds'), 'junction')
  const cleared = await test.window.evaluate(file => window.dustdesk.clearNoteBackground(file), path.join(test.tempRoot, 'data', 'NoteBackgrounds', 'external.txt'))
  assert.equal(cleared.ok, false)
  assert.equal(await readFile(path.join(outside, 'external.txt'), 'utf8'), 'untouched')

  assert.equal(await test.electronApp.evaluate(({ app }) => {
    try { app.emit('window-all-closed'); return null } catch (error) { return error.message }
  }), null)
  const closed = test.electronApp.waitForEvent('close', { timeout: 15000 })
  await test.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 50) })
  await closed
  console.log('Review regressions passed, including graceful quit')
} finally { await closeDustDesk(test) }
