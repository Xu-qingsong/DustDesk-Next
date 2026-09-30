import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

let app = await launchDustDesk()
const load = () => app.window.evaluate(() => window.dustdesk.loadWorkspace())
async function update(operation) {
  await app.window.evaluate(async source => {
    const state = await window.dustdesk.loadWorkspace(); const next = structuredClone(state)
    new Function('state', source)(next); await window.dustdesk.saveWorkspace(next, state)
  }, operation)
}
async function poll(operation, predicate, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await operation()
    if (predicate(result)) return result
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`Timed out: ${label}`)
}
async function widget(key) {
  const existing = app.electronApp.windows().find(page => new URL(page.url()).searchParams.get('widget') === key)
  const created = existing ? null : app.electronApp.waitForEvent('window')
  const visibility = await app.window.evaluate(key => window.dustdesk.getWidgetVisibility([key]), key)
  if (!visibility[key]) await app.window.evaluate(key => window.dustdesk.toggleWidgets(key), key)
  const page = existing ?? await created
  await page.getByLabel('便签正文').waitFor()
  return page
}
async function quit() {
  const closed = app.electronApp.waitForEvent('close', { timeout: 15000 })
  await app.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  await closed
}

try {
  await update('state.Settings.ClipboardMonitoringEnabled = false')
  await app.window.evaluate(() => window.dustdesk.productivity({ type: 'capture', kind: 'note', title: 'Second draft note', text: 'second saved' }))
  const state = await load(); const target = state.Notes[0]; const other = state.Notes[1]
  const recent = await widget('notes'); const pinned = await widget(`note:${target.Id}`)
  await recent.getByLabel('便签正文').fill('RECENT UNSAVED DRAFT')
  await update("state.Notes[0].Text = 'MAIN EXTERNAL UPDATE'")
  await poll(() => pinned.getByLabel('便签正文').inputValue(), text => text === 'MAIN EXTERNAL UPDATE', 'clean pinned editor receives external edit')
  await recent.getByLabel('选择桌面便签').selectOption(other.Id)
  await recent.getByLabel('选择桌面便签').selectOption(target.Id)
  assert.equal(await recent.getByLabel('便签正文').inputValue(), 'RECENT UNSAVED DRAFT')
  await pinned.getByLabel('便签正文').fill('PINNED INDEPENDENT DRAFT')
  await update("state.Notes[0].Text = 'LATEST WORKSPACE VALUE'")
  await recent.getByRole('button', { name: '保存', exact: true }).click()
  await recent.getByRole('alert').waitFor()
  assert.equal((await load()).Notes[0].Text, 'LATEST WORKSPACE VALUE')
  await app.window.evaluate(key => window.dustdesk.hideWidget(key), `note:${target.Id}`)
  await app.window.evaluate(() => window.dustdesk.hideWidget('notes'))
  await app.electronApp.evaluate(({ dialog }) => { dialog.showErrorBox = (_title, message) => { globalThis.noteQuitError = message } })
  const tempRoot = app.tempRoot
  await quit()
  assert.equal(JSON.parse(await readFile(path.join(tempRoot, 'data', 'workspace.json'), 'utf8')).Notes[0].Text, 'LATEST WORKSPACE VALUE')
  app = await launchDustDesk({ tempRoot })
  const recoveredRecent = await widget('notes'); const recoveredPinned = await widget(`note:${target.Id}`)
  assert.equal(await recoveredRecent.getByLabel('便签正文').inputValue(), 'RECENT UNSAVED DRAFT')
  assert.equal(await recoveredPinned.getByLabel('便签正文').inputValue(), 'PINNED INDEPENDENT DRAFT')
  console.log('Private drafts survive external updates, note switches, hidden conflict quit and restart')

  // Quota failure after editing another note must still block quit after that
  // editor is unmounted. This exercises the lifetime of the draft flush guard.
  await recoveredRecent.getByLabel('选择桌面便签').selectOption(other.Id)
  await recoveredRecent.evaluate(() => {
    window.originalDraftSetItem = Storage.prototype.setItem
    Storage.prototype.setItem = function (key, value) { if (key.startsWith('widget-note:v2:')) throw new Error('simulated draft storage failure'); return window.originalDraftSetItem.call(this, key, value) }
  })
  await recoveredRecent.getByLabel('便签正文').fill('MEMORY DRAFT DURING QUOTA FAILURE')
  await recoveredRecent.getByLabel('选择桌面便签').selectOption(target.Id)
  await app.electronApp.evaluate(({ dialog, app }) => {
    globalThis.noteQuitError = ''; dialog.showErrorBox = (_title, message) => { globalThis.noteQuitError = message }
    setTimeout(() => app.quit(), 0)
  })
  assert.match(await poll(() => app.electronApp.evaluate(() => globalThis.noteQuitError), Boolean, 'draft storage failure blocks shutdown'), /simulated draft storage failure/)
  await recoveredRecent.evaluate(() => { Storage.prototype.setItem = window.originalDraftSetItem })
  await recoveredRecent.getByLabel('选择桌面便签').selectOption(other.Id)
  assert.equal(await recoveredRecent.getByLabel('便签正文').inputValue(), 'MEMORY DRAFT DURING QUOTA FAILURE')

  // A normal workspace write failure remains fatal to quit even though local
  // drafts are safe; conflict handling must not suppress unrelated failures.
  await app.electronApp.evaluate(({ dialog }) => {
    const fs = process.getBuiltinModule('fs'); const original = fs.promises.writeFile
    globalThis.failNoteWrites = true; globalThis.noteQuitError = ''
    dialog.showErrorBox = (_title, message) => { globalThis.noteQuitError = message }
    fs.promises.writeFile = async (...args) => {
      if (globalThis.failNoteWrites && String(args[0]).includes('.electron-tmp-')) throw new Error('simulated note workspace failure')
      return original(...args)
    }
  })
  await app.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  assert.match(await poll(() => app.electronApp.evaluate(() => globalThis.noteQuitError), Boolean, 'workspace failure blocks shutdown'), /simulated note workspace failure/)
  assert.equal(await recoveredRecent.getByLabel('便签正文').inputValue(), 'MEMORY DRAFT DURING QUOTA FAILURE')
  await app.electronApp.evaluate(() => { globalThis.failNoteWrites = false })
  await quit()
  const saved = JSON.parse(await readFile(path.join(tempRoot, 'data', 'workspace.json'), 'utf8'))
  assert.equal(saved.Notes.find(note => note.Id === other.Id).Text, 'MEMORY DRAFT DURING QUOTA FAILURE')
  assert.equal(saved.Notes.find(note => note.Id === target.Id).Text, 'LATEST WORKSPACE VALUE')
  console.log('Draft quota and workspace persistence failures block quit until a successful retry')
} finally { await closeDustDesk(app) }
