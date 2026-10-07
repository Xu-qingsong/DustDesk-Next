import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
const output = path.resolve('test-artifacts/ui-fixes')
const page = app.window
const navigate = label => page.locator('.sidebar').getByText(label, { exact: true }).click()
const capture = name => page.screenshot({ path: path.join(output, name + '.png') })
async function contained(locator, label) {
  const bounds = await locator.evaluate(element => { const rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: innerWidth, height: innerHeight } })
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.right <= bounds.width + 1 && bounds.bottom <= bounds.height + 1, `${label}: ${JSON.stringify(bounds)}`)
}
try {
  await mkdir(output, { recursive: true })
  await page.evaluate(async () => {
    const baseline = await window.dustdesk.loadWorkspace(); const state = structuredClone(baseline)
    state.Settings.ClipboardMonitoringEnabled = false
    state.Notes = Array.from({ length: 13 }, (_, i) => ({ ...state.Notes[0], Id: crypto.randomUUID(), Title: `Layout note ${i}`, Text: 'A readable note body with enough space for editing.' }))
    state.Projects = [{ Id: crypto.randomUUID(), Name: 'Very long project name '.repeat(8), ProjectPath: '', Phases: [{ Id: crypto.randomUUID(), Title: 'Long phase title '.repeat(8), Status: 'Doing', ProgressPercent: 40, ProjectPath: '', Subtasks: [] }] }]
    await window.dustdesk.saveWorkspace(state, baseline)
    for (let i = 0; i < 10; i++) await window.dustdesk.saveWidgetPreset(`Layout preset ${i}`)
  })
  for (const [name, width, height] of [['normal', 1380, 880], ['minimum', 1080, 680]]) {
    await app.electronApp.evaluate(({ BrowserWindow }, { width, height }) => BrowserWindow.getAllWindows().find(window => !/widget=|capture=/.test(window.webContents.getURL())).setSize(width, height), { width, height })
    await navigate('便签')
    assert.equal(await page.evaluate(() => document.body.scrollWidth <= innerWidth), true, 'main body fits content viewport')
    const note = await page.locator('.note-image-path').boundingBox()
    assert.ok(note.height >= 30 && note.height <= 40, `single-line path height ${note.height}`)
    const list = await page.locator('.notes-list').evaluate(element => ({ height: element.clientHeight, scroll: element.scrollHeight }))
    assert.ok(list.scroll > list.height, 'long note list scrolls inside panel')
    await capture(`${name}-notes`)
    await navigate('项目')
    await page.locator('.gantt-phase-name').first().click()
    const title = await page.getByRole('dialog', { name: '编辑阶段' }).getByLabel('阶段名称').boundingBox()
    assert.ok(title.width >= 140, `phase title remains editable: ${title.width}`)
    await contained(page.getByRole('button', { name: '转任务', exact: true }), 'phase action')
    await page.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await page.locator('.content').evaluate(element => element.scrollWidth <= element.clientWidth), true, 'projects have no horizontal page scrolling')
    await capture(`${name}-projects`)
  }
  await page.getByTitle('桌面小组件', { exact: true }).click()
  await contained(page.locator('.widget-picker'), 'picker with ten presets')
  assert.ok(await page.locator('.widget-picker-body').evaluate(element => element.scrollHeight > element.clientHeight), 'picker body scrolls')
  await capture('picker-presets')
  await page.locator('.widget-picker-head').getByTitle('关闭').click()

  await navigate('资源库')
  await page.getByRole('button', { name: '新建链接', exact: true }).click()
  await page.getByPlaceholder('可选备注').evaluate(element => { element.style.height = '420px' })
  await contained(page.locator('.library-modal'), 'resized link dialog')
  await contained(page.locator('.library-modal .modal-header'), 'modal header')
  await contained(page.locator('.library-modal .modal-actions'), 'modal actions')
  assert.ok(await page.locator('.modal-body').evaluate(element => element.scrollHeight > element.clientHeight), 'modal fields scroll')
  await page.getByRole('button', { name: '添加到资源库', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.locator('.library-modal').getByTitle('关闭').evaluate(element => document.activeElement === element), true, 'modal tab wraps')
  await capture('link-modal-resized')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('.library-modal').count(), 0)
  assert.equal(await page.getByRole('button', { name: '新建链接', exact: true }).evaluate(element => document.activeElement === element), true, 'modal focus returns to opener')

  await navigate('设置')
  await page.getByRole('button', { name: '管理快捷键', exact: true }).first().click()
  const quickHotkey = await page.getByLabel('快速记录', { exact: true }).inputValue()
  assert.ok(quickHotkey, 'quick capture shares shortcut editor')
  assert.equal(await page.locator('.hotkey-dialog input').count(), 5)
  await page.keyboard.press('Escape')
  await page.getByTitle('快捷键设置').click()
  assert.equal(await page.getByLabel('快速记录', { exact: true }).inputValue(), quickHotkey)
  await page.keyboard.press('Escape')
  assert.equal(await page.getByTitle('快捷键设置').evaluate(element => document.activeElement === element), true, 'shortcut dialog returns focus to floating opener')
  await page.getByRole('button', { name: '深色', exact: true }).click()
  await navigate('专注计时')
  const contrast = await page.locator('.primary-button').first().evaluate(element => {
    const style = getComputedStyle(element)
    const luminance = color => { const channels = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => { const n = value / 255; return n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4 }); return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722 }
    const colors = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a)
    return (colors[0] + .05) / (colors[1] + .05)
  })
  assert.ok(contrast >= 4.5, `dark primary text contrast ${contrast}`)
  await capture('dark-focus')

  await page.evaluate(() => window.dustdesk.showQuickCapture())
  const quickCapture = app.electronApp.windows().find(candidate => candidate.url().includes('capture=')) ?? await app.electronApp.waitForEvent('window')
  await quickCapture.getByLabel('记录标题').waitFor()
  for (const [name, width, height] of [['default', 520, 430], ['minimum', 380, 360]]) {
    await app.electronApp.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('capture=')).setSize(bounds.width, bounds.height), { width, height })
    await contained(quickCapture.getByRole('button', { name: '便签', exact: true }), 'capture kind toggle')
    await contained(quickCapture.getByRole('button', { name: '保存并收起', exact: true }), 'capture save')
    assert.equal(await quickCapture.evaluate(() => document.body.scrollWidth <= innerWidth), true, 'capture body width')
    await quickCapture.screenshot({ path: path.join(output, `quick-capture-${name}.png`) })
  }
  await page.evaluate(() => window.dustdesk.hideQuickCapture())
  const widgetPromise = app.electronApp.waitForEvent('window')
  await page.evaluate(() => window.dustdesk.toggleWidgets('notes'))
  const widget = await widgetPromise
  await widget.getByLabel('便签正文').waitFor()
  await widget.evaluate(() => window.dustdesk.resizeWidget('notes', 300, 180, true))
  await widget.getByLabel('便签正文').fill('Editing and saving directly in a small note widget.')
  await contained(widget.getByLabel('选择桌面便签'), 'tiny widget selector')
  await contained(widget.getByLabel('便签正文'), 'tiny widget textarea')
  await contained(widget.getByRole('button', { name: '保存', exact: true }), 'tiny widget save')
  const body = await widget.getByLabel('便签正文').boundingBox()
  assert.ok(body.height >= 32, `tiny widget editable body ${body.height}`)
  assert.equal(await widget.locator('.widget-note-panel').evaluate(element => element.scrollHeight <= element.clientHeight + 1), true, 'tiny widget normal editor needs no scrolling')
  await widget.screenshot({ path: path.join(output, 'widget-notes-300x180.png') })
  await widget.getByRole('button', { name: '保存', exact: true }).click()
  await widget.getByText('已保存', { exact: true }).waitFor()
  console.log(`UI layout regressions passed; dark primary contrast ${contrast.toFixed(2)}:1`)
} finally { await closeDustDesk(app) }
