import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

let app = await launchDustDesk()
async function chooseQuitResponse(response) {
  await app.electronApp.evaluate(({ dialog }, response) => {
    globalThis.organizerQuitPrompts = []
    dialog.showMessageBox = async (...args) => {
      globalThis.organizerQuitPrompts.push(args.at(-1))
      return { response }
    }
  }, response)
}
async function quit(response = 0) {
  await chooseQuitResponse(response)
  const closed = app.electronApp.waitForEvent('close', { timeout: 20000 })
  await app.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  await closed
}
try {
  await app.window.getByText('桌面收纳', { exact: true }).click()
  assert.match(await app.window.locator('h1').textContent(), /桌面收纳/)
  const desktop = path.join(app.tempRoot, 'desktop')
  await fs.mkdir(desktop, { recursive: true })
  const file = path.join(desktop, '退出恢复.txt')
  const folder = path.join(desktop, '退出恢复文件夹')
  await fs.writeFile(file, '收纳文件')
  await fs.mkdir(folder)
  await fs.writeFile(path.join(folder, '内容.txt'), '文件夹内容')
  const state = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  const category = state.DesktopCategories[0].Id
  const stored = []
  for (const source of [file, folder]) {
    const result = await app.window.evaluate(({ category, source }) => window.dustdesk.moveIntoCategory(category, source), { category, source })
    assert.equal(result.ok, true, result.error)
    stored.push(result.path)
  }
  await fs.writeFile(file, '桌面新同名文件')
  await chooseQuitResponse(2)
  await app.electronApp.evaluate(({ app }) => { setTimeout(() => app.quit(), 0) })
  let prompts = []
  for (let attempt = 0; attempt < 100; attempt++) {
    prompts = await app.electronApp.evaluate(() => globalThis.organizerQuitPrompts)
    if (prompts.length) break
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.equal(prompts.length, 1)
  assert.deepEqual(prompts[0].buttons, ['恢复并退出', '保留收纳并退出', '取消'])
  assert.equal(prompts[0].defaultId, 2)
  await app.window.waitForFunction(() => !document.documentElement.inert)
  for (const target of stored) await fs.stat(target)
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' })
  // Choosing to keep the items exits without moving anything to the desktop.
  await quit(1)
  for (const target of stored) await fs.stat(target)
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' })
  app = await launchDustDesk({ tempRoot: app.tempRoot })
  for (const target of stored) await fs.stat(target)
  // Hiding the main window keeps the tray application and organized files alive.
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('widget=')).close())
  for (const target of stored) await fs.stat(target)
  await quit()
  assert.equal(await fs.readFile(file, 'utf8'), '桌面新同名文件')
  assert.equal(await fs.readFile(path.join(desktop, '退出恢复 (1).txt'), 'utf8'), '收纳文件')
  assert.equal(await fs.readFile(path.join(folder, '内容.txt'), 'utf8'), '文件夹内容')
  const persisted = JSON.parse(await fs.readFile(path.join(app.tempRoot, 'data', 'workspace.json'), 'utf8'))
  assert.equal(persisted.OrganizerDesktopRestores.length, 2)
  app = await launchDustDesk({ tempRoot: app.tempRoot })
  const restarted = await app.window.evaluate(() => window.dustdesk.loadWorkspace())
  assert.deepEqual(restarted.DesktopCategories.find(item => item.Id === category).ItemPaths, stored)
  for (const target of stored) await fs.stat(target)
  await assert.rejects(fs.stat(folder), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(desktop, '退出恢复 (1).txt')), { code: 'ENOENT' })
  assert.equal(await fs.readFile(file, 'utf8'), '桌面新同名文件')
  const undone = await app.window.evaluate(() => window.dustdesk.undoOrganizerMove())
  assert.equal(undone.ok, true, undone.error)
  assert.equal(await fs.readFile(path.join(folder, '内容.txt'), 'utf8'), '文件夹内容')
  await quit()
  assert.equal(await fs.readFile(path.join(desktop, '退出恢复 (1).txt'), 'utf8'), '收纳文件')
  console.log('Organizer real Electron quit confirmation (restore, keep, cancel), tray hide, collision, folder restore, restart and undo passed')
} finally {
  await closeDustDesk(app)
}
