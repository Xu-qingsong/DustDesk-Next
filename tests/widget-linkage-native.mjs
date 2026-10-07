import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'

const run = await launchDustDesk()
const page = run.window
const waitState = async (target, predicate, argument) => {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if (await target.evaluate(predicate, argument)) return
    await target.waitForTimeout(30)
  }
  throw Error('Timed out waiting for widget state: ' + predicate.toString())
}
const navigate = name => page.locator('.sidebar').getByText(name, { exact: true }).click()
const waitPin = (name, visible) => page.waitForFunction(({ name, visible }) => [...document.querySelectorAll('button')].some(button => (button.title === name || button.textContent === name) && button.getAttribute('aria-pressed') === String(visible)), { name, visible })
const picker = page.getByTitle('桌面小组件', { exact: true })
const closePicker = () => page.locator('.widget-picker').getByTitle('关闭', { exact: true }).click()
const createWidget = async action => {
  const promise = run.electronApp.waitForEvent('window', { timeout: 10_000 })
  await action()
  const widget = await promise
  await widget.locator('.widget-content').waitFor()
  return widget
}
let projectKey
try {
  await navigate('项目')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('项目名称').fill('NATIVE_LINKAGE_PROJECT')
  await waitState(page, async () => (await window.dustdesk.loadWorkspace()).Projects.some(project => project.Name === 'NATIVE_LINKAGE_PROJECT'))
  projectKey = await page.evaluate(async () => `project:${(await window.dustdesk.loadWorkspace()).Projects.find(project => project.Name === 'NATIVE_LINKAGE_PROJECT').Id}`)
  const projectWidget = await createWidget(() => page.getByRole('button', { name: '固定', exact: true }).click())
  await waitPin('取消固定', true)
  await projectWidget.getByText('NATIVE_LINKAGE_PROJECT', { exact: true }).waitFor()
  await page.getByLabel('项目名称').fill('NATIVE_LINKAGE_RENAMED')
  await projectWidget.getByText('NATIVE_LINKAGE_RENAMED', { exact: true }).waitFor()
  await picker.click()
  await page.getByRole('button', { name: '隐藏项目：NATIVE_LINKAGE_RENAMED小组件', exact: true }).click()
  await waitPin('固定', false)
  await waitState(page, key => window.dustdesk.getWidgetVisibility([key]).then(result => !result[key]), projectKey)
  await page.getByRole('button', { name: '显示项目：NATIVE_LINKAGE_RENAMED小组件', exact: true }).click()
  await waitPin('取消固定', true)
  await projectWidget.getByTitle('隐藏小组件', { exact: true }).click()
  await waitPin('固定', false)
  await page.getByRole('button', { name: '显示项目：NATIVE_LINKAGE_RENAMED小组件', exact: true }).waitFor()
  await closePicker()

  await navigate('便签')
  await page.getByRole('button', { name: '新建便签', exact: true }).click()
  await page.getByLabel('便签标题', { exact: true }).fill('NATIVE_LINKAGE_NOTE')
  await waitState(page, async () => (await window.dustdesk.loadWorkspace()).Notes.some(note => note.Title === 'NATIVE_LINKAGE_NOTE'))
  const noteWidget = await createWidget(() => page.getByTitle('固定便签', { exact: true }).click())
  await waitPin('固定便签', true)
  await noteWidget.getByLabel('便签正文').fill('Edited on desktop')
  await noteWidget.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.note-text').value === 'Edited on desktop')
  await page.locator('.note-text').fill('Edited on page')
  await noteWidget.waitForFunction(() => document.querySelector('textarea').value === 'Edited on page')
  const noteKey = await page.evaluate(async () => `note:${(await window.dustdesk.loadWorkspace()).Notes.find(note => note.Title === 'NATIVE_LINKAGE_NOTE').Id}`)
  await noteWidget.evaluate(key => window.dustdesk.moveWidget(key, 120, 140, true), noteKey)
  await noteWidget.getByTitle('置顶', { exact: true }).click()
  await picker.click()
  await page.getByRole('button', { name: '隐藏便签：NATIVE_LINKAGE_NOTE小组件', exact: true }).click()
  await waitPin('固定便签', false)
  const placement = await page.evaluate(async key => (await window.dustdesk.loadWorkspace()).Settings.WidgetPlacements[key], noteKey)
  assert.equal(placement.X, 120); assert.equal(placement.Y, 140); assert.equal(placement.TopMost, true)
  await page.getByRole('button', { name: '显示便签：NATIVE_LINKAGE_NOTE小组件', exact: true }).click()
  await waitPin('固定便签', true)
  await run.electronApp.evaluate(({ BrowserWindow }, key) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes(encodeURIComponent(key))).close(), noteKey)
  await waitPin('固定便签', false)
  await page.getByRole('button', { name: '显示便签：NATIVE_LINKAGE_NOTE小组件', exact: true }).waitFor()
  await closePicker()

  await navigate('系统检测')
  const cpu = page.getByRole('group', { name: '显示项目' }).getByRole('button').filter({ hasText: 'CPU' })
  if (await cpu.getAttribute('aria-pressed') !== 'true') await cpu.click()
  await picker.click()
  const monitorWidget = await createWidget(() => page.getByRole('button', { name: '显示监控小组件', exact: true }).click())
  await monitorWidget.locator('.widget-metrics > strong').filter({ hasText: /^CPU / }).waitFor()
  await closePicker()
  await cpu.click()
  await monitorWidget.locator('.widget-metrics > strong').filter({ hasText: /^CPU / }).waitFor({ state: 'detached' })
  await cpu.click()
  await monitorWidget.locator('.widget-metrics > strong').filter({ hasText: /^CPU / }).waitFor()
  await monitorWidget.getByTitle('隐藏小组件', { exact: true }).click()

  await navigate('桌面收纳')
  await page.getByRole('button', { name: '分类管理', exact: true }).click()
  const categories = page.getByRole('dialog', { name: '分类管理', exact: true })
  const organizerWidget = await createWidget(() => categories.getByRole('button', { name: '固定组合', exact: true }).click())
  await waitPin('取消固定组合', true)
  await organizerWidget.getByTitle('隐藏小组件', { exact: true }).click()
  await waitPin('固定组合', false)
  await categories.getByRole('button', { name: '完成', exact: true }).click()

  await navigate('项目')
  await page.getByRole('button', { name: '固定', exact: true }).click()
  await waitPin('取消固定', true)
  await picker.click()
  const directory = path.resolve('test-artifacts/widget-linkage')
  await fs.mkdir(directory, { recursive: true })
  await page.screenshot({ path: path.join(directory, 'project-picker.png') })
  await projectWidget.evaluate(key => window.dustdesk.resizeWidget(key, 300, 260, true), projectKey)
  await projectWidget.waitForFunction(() => innerWidth === 300)
  const buttonsFit = await projectWidget.locator('.widget-controls button').evaluateAll(buttons => buttons.every(button => { const rect = button.getBoundingClientRect(); return rect.x >= 0 && rect.right <= innerWidth }))
  assert.equal(buttonsFit, true, 'All widget actions fit at the minimum window width')
  await projectWidget.screenshot({ path: path.join(directory, 'project-widget.png') })
  console.log('Native project, note, organizer and monitor linkage passed')
} finally { await closeDustDesk({ ...run, preserveTempRoot: true }) }

const restarted = await launchDustDesk({ tempRoot: run.tempRoot })
try {
  await waitState(restarted.window, key => window.dustdesk.getWidgetVisibility([key]).then(result => result[key]), projectKey)
  await restarted.window.locator('.sidebar').getByText('项目', { exact: true }).click()
  await restarted.window.getByRole('button', { name: '取消固定', exact: true }).waitFor()
  await restarted.window.getByTitle('桌面小组件', { exact: true }).click()
  assert.equal(await restarted.window.getByRole('button', { name: '隐藏项目：NATIVE_LINKAGE_RENAMED小组件', exact: true }).getAttribute('aria-pressed'), 'true')
  console.log('Pinned project visibility restored consistently after restart')
} finally { await closeDustDesk(restarted) }
