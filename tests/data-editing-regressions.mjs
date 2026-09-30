import assert from 'node:assert/strict'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const test = await launchDustDesk()
try {
  const initial = await test.window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    state.Settings.ClipboardMonitoringEnabled = false
    await window.dustdesk.saveWorkspace(state)
    return window.dustdesk.loadWorkspace()
  })
  await test.window.evaluate(state => window.dustdesk.saveWorkspace({ ...state, QuickNote: 'changed' }), initial)
  await test.window.evaluate(state => window.dustdesk.saveWorkspace(state), initial)
  assert.equal((await test.window.evaluate(() => window.dustdesk.loadWorkspace())).QuickNote, initial.QuickNote)

  const widgetPromise = test.electronApp.waitForEvent('window')
  await test.window.evaluate(() => window.dustdesk.toggleWidgets('todo'))
  const widget = await widgetPromise
  await widget.waitForSelector('.widget-head')
  const baseline = await widget.evaluate(() => window.dustdesk.loadWorkspace())
  const [deleted, edited] = baseline.Todos
  await test.window.evaluate(async id => {
    const state = await window.dustdesk.loadWorkspace()
    await window.dustdesk.saveWorkspace({ ...state, Todos: state.Todos.filter(item => item.Id !== id) }, state)
  }, deleted.Id)
  await widget.evaluate(({ state, id }) => window.dustdesk.saveWorkspace({ ...state, Todos: state.Todos.map(item => item.Id === id ? { ...item, Title: 'stale editor change' } : item) }, state), { state: baseline, id: edited.Id })
  const merged = await test.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal(merged.Todos.some(item => item.Id === deleted.Id), false)
  assert.equal(merged.Todos.find(item => item.Id === edited.Id).Title, 'stale editor change')
  await test.window.evaluate(() => window.dustdesk.hideWidget('todo'))

  const goodBackup = await test.window.evaluate(() => window.dustdesk.createBackup())
  const dataFile = path.join(test.tempRoot, 'data', 'workspace.json')
  const full = await readFile(dataFile, 'utf8')
  await writeFile(`${dataFile}.bak`, full)
  await writeFile(dataFile, JSON.stringify({ Settings: {}, Todos: [] }))
  const recovered = await test.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal(recovered.Notes.length, initial.Notes.length)
  assert.equal(await readFile(`${dataFile}.bak`, 'utf8'), full)
  const future = JSON.stringify({ ...recovered, SchemaVersion: 99 })
  await writeFile(dataFile, future)
  await assert.rejects(test.window.evaluate(() => window.dustdesk.loadWorkspace()), /版本较新/)
  assert.equal(await readFile(dataFile, 'utf8'), future)
  const damaged = JSON.stringify({ Settings: {}, Todos: [] })
  await writeFile(dataFile, damaged); await writeFile(`${dataFile}.bak`, damaged)
  await assert.rejects(test.window.evaluate(() => window.dustdesk.loadWorkspace()), /无法完整读取/)
  assert.equal(await readFile(dataFile, 'utf8'), damaged)
  assert.equal(await readFile(`${dataFile}.bak`, 'utf8'), damaged)
  assert.equal((await test.window.evaluate(file => window.dustdesk.restoreBackup(file), goodBackup.path)).ok, true)
  const incompleteBackup = path.join(test.tempRoot, 'data', 'Backups', 'incomplete.json')
  await writeFile(incompleteBackup, damaged)
  const beforeInvalid = await readFile(dataFile, 'utf8')
  assert.equal((await test.window.evaluate(file => window.dustdesk.restoreBackup(file), incompleteBackup)).ok, false)
  assert.equal(await readFile(dataFile, 'utf8'), beforeInvalid)
  console.log('Explicit save baselines, concurrent deletion and data recovery passed')

  const image = await test.window.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200
    const context = canvas.getContext('2d')
    context.fillStyle = 'white'; context.fillRect(0, 0, 400, 200)
    context.fillStyle = 'black'
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) if ((x + y) % 2 === 0) context.fillRect(10 + x, 10 + y, 1, 1)
    return canvas.toDataURL()
  })
  await test.electronApp.evaluate(({ BrowserWindow }, image) => BrowserWindow.getAllWindows().find(w => !w.webContents.getURL().includes('widget=')).webContents.send('screenshot:captured', image), image)
  const canvas = test.window.locator('.canvas-wrap canvas')
  await canvas.waitFor()
  await test.window.getByRole('button', { name: '保存截图', exact: true }).waitFor()
  await test.window.waitForFunction(() => document.querySelector('.canvas-wrap canvas')?.width === 400 && ![...document.querySelectorAll('button')].find(b => b.textContent === '保存截图')?.disabled)
  const draw = async (x1, y1, x2, y2) => {
    const bounds = await canvas.boundingBox()
    const size = await canvas.evaluate(c => ({ width: c.width, height: c.height }))
    await test.window.mouse.move(bounds.x + x1 * bounds.width / size.width, bounds.y + y1 * bounds.height / size.height)
    await test.window.mouse.down()
    await test.window.mouse.move(bounds.x + x2 * bounds.width / size.width, bounds.y + y2 * bounds.height / size.height, { steps: 5 })
    await test.window.mouse.up()
  }
  const redPixels = () => canvas.evaluate(c => {
    const pixels = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    let count = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 1] < 130 && pixels[i + 3] > 0) count++
    return count
  })
  const ready = () => test.window.waitForFunction(() => ![...document.querySelectorAll('button')].find(b => b.textContent === '保存截图')?.disabled)
  const historyAction = async title => { await test.window.getByTitle(title, { exact: true }).click(); await ready() }
  await test.window.getByRole('button', { name: '画笔', exact: true }).click()
  await draw(70, 60, 180, 60); await draw(70, 100, 180, 100)
  const twoStrokes = await redPixels()
  await historyAction('撤销'); await historyAction('重做')
  await draw(70, 140, 180, 140); await historyAction('撤销')
  assert.equal(await redPixels(), twoStrokes)
  await test.window.getByRole('button', { name: '裁剪', exact: true }).click()
  await draw(55, 45, 210, 115); await ready()
  assert.equal(await canvas.evaluate(c => c.width), 155)
  assert.equal(await redPixels(), twoStrokes)
  await test.window.getByRole('button', { name: '保存截图', exact: true }).click()
  await test.window.getByText(/截图已保存：/).waitFor()
  const screenshotDirectory = path.join(test.tempRoot, 'data', 'Screenshots')
  const exportedFile = (await readdir(screenshotDirectory)).find(name => name.startsWith('DustDesk-edited-'))
  const png = await readFile(path.join(screenshotDirectory, exportedFile))
  assert.equal(png.readUInt32BE(16), 155)
  const exportedRedPixels = await test.window.evaluate(async url => {
    const image = new Image(); image.src = url; await image.decode()
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0)
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
    let count = 0
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 220 && pixels[i + 1] < 130) count++
    return count
  }, `data:image/png;base64,${png.toString('base64')}`)
  assert.ok(exportedRedPixels > 0, 'export must include the cropped annotations')
  await historyAction('撤销')
  assert.equal(await canvas.evaluate(c => c.width), 400)
  assert.equal(await redPixels(), twoStrokes)
  for (const tool of ['马赛克', '模糊']) {
    await test.window.getByRole('button', { name: tool, exact: true }).click()
    await draw(25, 25, 30, 30)
    const pixel = await canvas.evaluate(c => Array.from(c.getContext('2d').getImageData(28, 28, 1, 1).data))
    assert.equal(pixel[3], 255, `${tool} must replace the source pixels`)
    assert.ok(pixel[0] > 30 && pixel[0] < 225, `${tool} must process the black/white source`)
    await historyAction('撤销')
  }
  console.log('Screenshot redaction, crop, undo and redo passed')

  await test.window.getByRole('button', { name: '便签', exact: true }).click()
  const text = test.window.locator('.note-text')
  await text.waitFor()
  await test.electronApp.evaluate(({ dialog }) => {
    const fs = process.getBuiltinModule('fs'); const original = fs.promises.writeFile
    globalThis.reviewFailWrites = true
    globalThis.reviewQuitError = ''
    dialog.showErrorBox = (_title, message) => { globalThis.reviewQuitError = message }
    fs.promises.writeFile = async (...args) => {
      if (globalThis.reviewFailWrites && String(args[0]).includes('.electron-tmp-')) throw new Error('simulated disk failure')
      return original(...args)
    }
  })
  await text.fill('unsaved text survives failure')
  await test.window.getByText(/保存失败，修改仍保留/).first().waitFor()
  await test.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  await test.window.waitForFunction(() => !document.documentElement.inert)
  // The failure is signaled from the main process after its flush handshake settles.
  for (let i = 0; i < 50; i++) {
    if (await test.electronApp.evaluate(() => globalThis.reviewQuitError)) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.match(await test.electronApp.evaluate(() => globalThis.reviewQuitError), /simulated disk failure/)
  assert.equal(await text.inputValue(), 'unsaved text survives failure')
  assert.equal(await test.window.evaluate(() => document.documentElement.inert), false)
  await test.electronApp.evaluate(() => { globalThis.reviewFailWrites = false })
  await test.electronApp.evaluate(() => {
    const fs = process.getBuiltinModule('fs'); const original = fs.promises.writeFile
    fs.promises.writeFile = async (...args) => {
      if (String(args[0]).includes('.electron-tmp-')) await new Promise(resolve => setTimeout(resolve, 100))
      return original(...args)
    }
  })
  await text.fill('temporary text'); await text.fill('')
  await test.window.waitForFunction(() => window.dustdesk.loadWorkspace().then(s => s.Notes[0].Text === ''))
  for (let i = 1; i <= 8; i++) await text.fill(`pending-edit-${i}`)
  const closed = test.electronApp.waitForEvent('close', { timeout: 20000 })
  await test.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  await closed
  assert.equal(JSON.parse(await readFile(dataFile, 'utf8')).Notes[0].Text, 'pending-edit-8')
  console.log('Graceful quit flushes the renderer queue under slow disk writes')
} finally { await closeDustDesk(test) }
