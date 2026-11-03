import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

const executablePath = path.resolve(process.env.DUSTDESK_PACKAGE_EXECUTABLE || 'release/win-unpacked/DustDesk.exe')
const expectedVersion = JSON.parse(await readFile('package.json', 'utf8')).version
const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-package-test-'))
let application
try {
  application = await electron.launch({ executablePath, args: [], timeout: 45_000, env: {
    ...process.env,
    DUSTDESK_TEST_DATA_DIR: path.join(tempRoot, 'data'),
    DUSTDESK_TEST_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
    DUSTDESK_TEST_DESKTOP_DIR: path.join(tempRoot, 'desktop'),
    ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
  } })
  const page = await application.firstWindow({ timeout: 20_000 })
  await page.locator('h1').waitFor()
  assert.equal(await application.evaluate(({ app }) => app.isPackaged), true)
  assert.equal(await application.evaluate(({ Menu }) => Menu.getApplicationMenu()), null, 'Packaged apps have no application menu')
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()), false, 'Packaged windows keep the menu bar hidden')
  assert.equal(await application.evaluate(({ app }) => app.getVersion()), expectedVersion)
  assert.equal(await page.locator('.sidebar .brand span').textContent(), `v${expectedVersion}`)
  await page.keyboard.press('Alt')
  assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()), false, 'Alt cannot restore the removed menu')
  await page.evaluate(() => {
    const input = document.createElement('input')
    input.id = 'package-edit-shortcuts'; input.value = 'DustDesk'
    input.style.cssText = 'position:fixed;top:10px;left:10px;z-index:100000'
    document.body.append(input)
  })
  const shortcutInput = page.locator('#package-edit-shortcuts')
  await shortcutInput.focus()
  await shortcutInput.press('End')
  await page.keyboard.type('123')
  await shortcutInput.press('Control+z')
  assert.equal(await shortcutInput.inputValue(), 'DustDesk', 'Native undo works without an application menu')
  await shortcutInput.press('Control+a')
  assert.equal(await shortcutInput.evaluate(input => input.selectionEnd - input.selectionStart), 8, 'Native select-all works without an application menu')
  await shortcutInput.evaluate(input => input.remove())
  assert.equal(await page.evaluate(() => typeof window.dustdesk.setWidgetVisibility), 'function', 'Packaged preload exposes the current API')
  const state = await page.evaluate(() => window.dustdesk.loadWorkspace())
  assert.equal(state.SchemaVersion, 3)
  const widgetPromise = application.waitForEvent('window', { timeout: 10_000 })
  assert.deepEqual(await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true)), { ok: true, visible: true })
  const widget = await widgetPromise
  await widget.locator('.widget-content').waitFor()
  await widget.getByTitle('隐藏小组件', { exact: true }).click()
  const deadline = Date.now() + 10_000
  let hidden = false
  while (Date.now() < deadline) {
    hidden = await page.evaluate(async () => !(await window.dustdesk.getWidgetVisibility(['todo'])).todo)
    if (hidden) break
    await page.waitForTimeout(30)
  }
  assert.equal(hidden, true)
  await page.locator('.sidebar').getByText('项目', { exact: true }).click()
  await page.getByRole('button', { name: '新建项目', exact: true }).waitFor()
  await page.locator('.sidebar').getByText('截图编辑', { exact: true }).click()
  await page.getByRole('button', { name: '区域', exact: true }).waitFor()
  console.log(`Packaged DustDesk ${expectedVersion} startup, workspace, preload and widget smoke passed`)
} finally {
  if (application) {
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await application.close().catch(() => {})
  }
  await rm(tempRoot, { recursive: true, force: true })
}
