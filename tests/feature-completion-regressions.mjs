import assert from 'node:assert/strict'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

let fixture = await launchDustDesk()
const load = () => fixture.window.evaluate(() => window.dustdesk.loadWorkspace())
const navigate = name => fixture.window.locator('.sidebar').getByText(name, { exact: true }).click()
async function update(source, args) {
  await fixture.window.evaluate(async ({ source, args }) => {
    const before = await window.dustdesk.loadWorkspace(); const next = structuredClone(before)
    new Function('state', 'args', source)(next, args)
    await window.dustdesk.saveWorkspace(next, before)
  }, { source, args })
}
async function poll(read, predicate, label) {
  for (let i = 0; i < 120; i++) {
    const value = await read()
    if (predicate(value)) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error('Timed out: ' + label)
}
async function widget(key) {
  const current = fixture.electronApp.windows().find(page => new URL(page.url()).searchParams.get('widget') === key)
  const created = current ? null : fixture.electronApp.waitForEvent('window')
  if (!(await fixture.window.evaluate(key => window.dustdesk.getWidgetVisibility([key]), key))[key]) await fixture.window.evaluate(key => window.dustdesk.toggleWidgets(key), key)
  const page = current || await created
  await page.locator('.widget-head').waitFor()
  return page
}
async function failWrites(enabled) {
  await fixture.electronApp.evaluate((_electron, enabled) => {
    const fs = process.getBuiltinModule('fs')
    if (enabled) {
      globalThis.featureWriteFile = fs.promises.writeFile
      fs.promises.writeFile = async (...args) => { if (String(args[0]).includes('.electron-tmp-')) throw Error('FEATURE_DISK_FAILURE'); return globalThis.featureWriteFile(...args) }
    } else if (globalThis.featureWriteFile) fs.promises.writeFile = globalThis.featureWriteFile
  }, enabled)
}

try {
  await update('state.Settings.ClipboardMonitoringEnabled = false; state.Settings.AutomaticBackupEnabled = false;')
  const initial = await load(); const noteId = initial.Notes[0].Id
  const png = await fixture.window.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 40; const context = canvas.getContext('2d'); context.fillStyle = '#087f6c'; context.fillRect(0, 0, 40, 40); return canvas.toDataURL('image/png') })
  const external = path.join(fixture.tempRoot, 'external.png')
  await writeFile(external, Buffer.from(png.split(',')[1], 'base64'))
  await navigate('便签')
  await fixture.window.getByLabel('背景图片路径', { exact: true }).fill(external)
  // Typing a path alone must not persist an unusable external reference.
  assert.equal((await load()).Notes[0].BackgroundImagePath || '', '')
  await fixture.window.getByRole('button', { name: '导入背景', exact: true }).click()
  const imported = await poll(load, state => state.Notes[0].BackgroundImagePath?.includes('NoteBackgrounds'), 'background import')
  const firstImage = imported.Notes[0].BackgroundImagePath
  assert.notEqual(firstImage, external)
  await fixture.window.locator('.note-background-preview').waitFor()
  assert.equal((await fixture.window.evaluate(() => window.dustdesk.createBackup())).ok, true)
  await access(external)
  await failWrites(true)
  await fixture.window.getByRole('button', { name: '清除背景', exact: true }).click()
  await fixture.window.locator('.note-background-controls [role=alert]').waitFor()
  assert.equal((await load()).Notes[0].BackgroundImagePath, firstImage)
  await access(firstImage)
  await failWrites(false)
  await fixture.window.getByRole('button', { name: '清除背景', exact: true }).click()
  await poll(load, state => !state.Notes[0].BackgroundImagePath, 'background clear retry')
  await access(firstImage) // workspace.json.bak still references this image for recovery.
  assert.equal((await fixture.window.evaluate(() => window.dustdesk.createBackup())).ok, true)
  console.log('Managed background import, successful backup and failure-safe clear passed')

  const desktop = path.join(fixture.tempRoot, 'desktop'); await mkdir(desktop, { recursive: true })
  const file = path.join(desktop, 'merge-undo.txt'); await writeFile(file, 'remains discoverable')
  const [source, target] = initial.DesktopCategories
  const moved = await fixture.window.evaluate(({ id, file }) => window.dustdesk.moveIntoCategory(id, file), { id: source.Id, file })
  assert.equal(moved.ok, true)
  await navigate('桌面收纳')
  await fixture.window.getByRole('button', { name: '分类管理', exact: true }).click()
  await fixture.window.locator('.category-manager-row select').first().selectOption(source.Id)
  await fixture.window.locator('.category-manager-row select').nth(1).selectOption(target.Id)
  await fixture.window.getByRole('button', { name: '合并分类', exact: true }).click()
  await poll(load, state => !state.DesktopCategories.some(item => item.Id === source.Id), 'category merge')
  await fixture.window.getByRole('dialog', { name: '分类管理' }).getByRole('button', { name: '完成', exact: true }).click()
  await failWrites(true)
  const failedUndo = await fixture.window.evaluate(() => window.dustdesk.undoOrganizerMove())
  assert.equal(failedUndo.ok, false)
  const afterFailure = await load()
  const stillOwned = afterFailure.DesktopCategories.find(item => item.Id === target.Id).ItemPaths.find(item => item.endsWith('merge-undo.txt'))
  assert.equal(await readFile(stillOwned, 'utf8'), 'remains discoverable')
  await failWrites(false)
  const undone = await fixture.window.evaluate(() => window.dustdesk.undoOrganizerMove())
  assert.equal(undone.ok, true)
  assert.equal(await readFile(undone.path, 'utf8'), 'remains discoverable')
  const owner = (await load()).DesktopCategories.find(item => item.ItemPaths.includes(undone.path))
  assert.equal(owner.Id, source.Id)
  console.log('Merged-category undo restores ownership and rolls back safely on failed persistence')

  await navigate('设置')
  await fixture.window.getByRole('button', { name: '深色', exact: true }).click()
  await poll(load, state => state.Settings.Theme === 'dark', 'theme saved')
  await fixture.window.reload(); await fixture.window.waitForSelector('h1')
  assert.equal(await fixture.window.evaluate(() => document.documentElement.dataset.theme), 'dark')

  const captureCreated = fixture.electronApp.waitForEvent('window')
  await fixture.window.evaluate(() => window.dustdesk.showQuickCapture())
  const capture = await captureCreated
  await capture.getByLabel('记录标题').fill('FEATURE_CAPTURE')
  await capture.getByLabel('记录正文').fill('saved exactly once')
  await capture.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = function(key, value) { if (key === 'quick-capture-draft') throw Error('FEATURE_QUOTA'); return window.originalSetItem.call(this, key, value) } })
  await capture.getByLabel('记录正文').fill('edited while draft storage is failing')
  assert.equal(await capture.getByLabel('记录正文').inputValue(), 'edited while draft storage is failing')
  await capture.getByRole('button', { name: '保存并收起', exact: true }).click()
  await poll(load, state => state.Todos.some(item => item.Title === 'FEATURE_CAPTURE'), 'capture saved')
  assert.equal((await load()).Todos.find(item => item.Title === 'FEATURE_CAPTURE').Note, 'edited while draft storage is failing')
  await poll(() => capture.getByLabel('记录标题').inputValue(), value => value === '', 'capture cleared in memory')
  assert.equal(await capture.getByRole('button', { name: '保存并收起', exact: true }).isDisabled(), true)
  await capture.getByRole('alert').waitFor()
  // A reload recognizes the stale disk draft as already committed before editing.
  await capture.reload(); await capture.getByLabel('记录标题').waitFor()
  await poll(() => capture.getByLabel('记录标题').inputValue(), value => value === '', 'stale capture reconciled')
  assert.equal(await capture.getByRole('button', { name: '保存并收起', exact: true }).isDisabled(), true)
  await capture.getByLabel('记录标题').fill('FEATURE_SECOND_CAPTURE')
  await capture.getByRole('button', { name: '保存并收起', exact: true }).click()
  await poll(load, state => state.Todos.some(item => item.Title === 'FEATURE_SECOND_CAPTURE'), 'new draft after cleanup failure')
  await poll(() => capture.getByLabel('记录标题').inputValue(), value => value === '', 'new capture cleared')
  assert.equal((await load()).Todos.filter(item => item.Title === 'FEATURE_CAPTURE').length, 1)
  await fixture.window.evaluate(() => window.dustdesk.showQuickCapture())
  await fixture.electronApp.evaluate(() => {
    const fs = process.getBuiltinModule('fs'); globalThis.featureReadFile = fs.promises.readFile
    fs.promises.readFile = async (...args) => { if (/workspace\.json(?:\.bak)?$/.test(String(args[0]))) throw Error('FEATURE_READ_FAILURE'); return globalThis.featureReadFile(...args) }
  })
  await capture.reload()
  await capture.getByRole('button', { name: '重试读取工作区', exact: true }).waitFor()
  assert.equal(await capture.getByLabel('记录标题').isDisabled(), true)
  await fixture.electronApp.evaluate(() => { process.getBuiltinModule('fs').promises.readFile = globalThis.featureReadFile })
  await capture.getByRole('button', { name: '重试读取工作区', exact: true }).click()
  await poll(() => capture.getByLabel('记录标题').isDisabled(), value => !value, 'workspace read retry')
  console.log('Quick capture handles storage failure and stale-draft reload without duplicates')

  await navigate('任务')
  const task = fixture.window.locator('.todo-row').filter({ hasText: 'FEATURE_CAPTURE' })
  await task.getByTitle('编辑任务').click()
  await task.getByLabel('任务标题', { exact: true }).fill('Edited task title')
  await task.getByLabel('任务标题', { exact: true }).press('Enter')
  await poll(load, state => state.Todos.some(item => item.Title === 'Edited task title'), 'task title edited')
  const renamed = fixture.window.locator('.todo-row').filter({ hasText: 'Edited task title' })
  await renamed.getByLabel('任务标题', { exact: true }).fill('   ')
  await renamed.getByLabel('任务标题', { exact: true }).press('Enter')
  assert.equal(await renamed.getByLabel('任务标题', { exact: true }).inputValue(), 'Edited task title')

  await update("Object.assign(state.Notes.find(note => note.Id === args), { FontSize: 30, FontBold: true, FontColorArgb: -65536, ColorArgb: -16711936, Text: 'saved baseline' })", noteId)
  await navigate('便签')
  const noteWidget = await widget('note:' + noteId)
  const style = page => page.evaluate(() => { const el = document.querySelector('textarea[aria-label="便签正文"], .note-text'); const style = getComputedStyle(el); return { font: style.fontSize, weight: style.fontWeight, color: style.color, background: style.backgroundColor } })
  assert.deepEqual(await style(noteWidget), await style(fixture.window))
  assert.equal((await fixture.window.evaluate(({ id, source }) => window.dustdesk.importNoteBackground(id, source, null), { id: noteId, source: external })).ok, true)
  await update('state.Notes.find(note => note.Id === args).ImageOnly = true', noteId)
  await noteWidget.locator('.widget-note-image img').waitFor()
  assert.equal(await noteWidget.getByLabel('便签正文').count(), 0)
  await noteWidget.getByRole('button', { name: '编辑文字', exact: true }).click()
  await noteWidget.getByLabel('便签正文').fill('PRIVATE_RECOVERY_COPY')
  await update("state.Notes.find(note => note.Id === args).Text = 'NEWER_SAVED_VALUE'", noteId)
  await noteWidget.getByText('对比版本', { exact: true }).click()
  assert.equal(await noteWidget.locator('.note-conflict-versions pre').count(), 2)
  const screenshots = path.resolve('test-artifacts/feature-fixes-2026-09-28')
  await mkdir(screenshots, { recursive: true })
  await noteWidget.screenshot({ path: path.join(screenshots, 'note-conflict.png') })
  await noteWidget.getByRole('button', { name: '另存为新便签', exact: true }).click()
  const recovered = await poll(load, state => state.Notes.some(note => note.Text === 'PRIVATE_RECOVERY_COPY'), 'save conflict as new')
  assert.equal(recovered.Notes.find(note => note.Id === noteId).Text, 'NEWER_SAVED_VALUE')
  const copy = recovered.Notes.find(note => note.Text === 'PRIVATE_RECOVERY_COPY')
  assert.equal(copy.FontSize, 30); assert.equal(copy.FontBold, true)
  assert.equal(copy.BackgroundImagePath, recovered.Notes.find(note => note.Id === noteId).BackgroundImagePath)
  console.log('Task title editing, note appearance/image mode and conflict recovery passed')

  await update("const time = new Date().toISOString(); state.LinkGroups[0].Links = Array.from({length: 15}, (_, i) => ({ Id: 'link-' + i, Name: 'Full link ' + i, Url: 'http://example.test/' + i, Note: '', CreatedAt: time, UpdatedAt: time })); state.Launchers = Array.from({length: 12}, (_, i) => ({ Id: 'launcher-' + i, Name: 'Launcher ' + i, Path: args, GroupId: state.LinkGroups[0].Id })); state.Projects = Array.from({length: 12}, (_, i) => ({ Id: 'project-' + i, Name: 'Project ' + i, ProjectPath: args, Phases: [] }));", external)
  for (const [key, count] of [['links', 15], ['launcher', 12], ['projects', 12]]) {
    const page = await widget(key)
    await fixture.window.evaluate(key => window.dustdesk.resizeWidget(key, 420, 240, true), key)
    await poll(() => page.locator('.widget-todo').count(), value => value === count, key + ' full list')
    await page.locator('.widget-todo').last().scrollIntoViewIfNeeded()
    assert.equal(await page.locator('.widget-todos').evaluate(el => el.scrollTop > 0), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true)
    await fixture.window.evaluate(key => window.dustdesk.hideWidget(key), key)
  }
  console.log('Widget full lists remain scrollable at compact sizes')

  await navigate('便签')
  await fixture.window.screenshot({ path: path.join(screenshots, 'notes-dark.png') })
  await noteWidget.screenshot({ path: path.join(screenshots, 'note-widget.png') })
  await navigate('设置'); await fixture.window.getByRole('button', { name: '浅色', exact: true }).click()
  await poll(load, state => state.Settings.Theme === 'light', 'light theme')
  await navigate('便签'); await fixture.window.screenshot({ path: path.join(screenshots, 'notes-light.png') })
  await navigate('设置'); await fixture.window.getByRole('button', { name: '深色', exact: true }).click()
  await poll(load, state => state.Settings.Theme === 'dark', 'restore dark preference')

  assert.equal((await fixture.window.evaluate(png => window.dustdesk.pinScreenshot(png), png)).ok, true)
  const closed = fixture.electronApp.waitForEvent('close', { timeout: 8000 })
  const started = Date.now()
  await fixture.electronApp.evaluate(({ app, dialog }) => { dialog.showErrorBox = (_title, error) => { throw Error(error) }; setTimeout(() => app.quit(), 0) })
  await closed
  console.log('Quit with pinned image and editing windows completed in ' + (Date.now() - started) + 'ms')
  const tempRoot = fixture.tempRoot
  fixture = await launchDustDesk({ tempRoot })
  assert.equal(await fixture.window.evaluate(() => document.documentElement.dataset.theme), 'dark')
  const final = await load()
  assert.equal(final.Todos.filter(item => item.Title === 'Edited task title').length, 1)
  assert.equal(final.Notes.filter(item => item.Text === 'PRIVATE_RECOVERY_COPY').length, 1)
  assert.ok(final.DesktopCategories.some(item => item.Id === source.Id && item.ItemPaths.includes(undone.path)))
  const backToDesktop = await fixture.window.evaluate(() => window.dustdesk.undoOrganizerMove())
  assert.equal(backToDesktop.ok, true)
  assert.equal(path.dirname(backToDesktop.path), path.join(fixture.tempRoot, 'desktop'))
  assert.equal(await readFile(backToDesktop.path, 'utf8'), 'remains discoverable')
  console.log('Feature completion regressions passed, including process restart')
} finally { await closeDustDesk(fixture) }
