import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { existsSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import ts from 'typescript'
import { mainFixture } from './main-headless-harness.mjs'

const browserPath = [process.env.DUSTDESK_HEADLESS_BROWSER, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
].find(value => value && existsSync(value))

test('headless renderer uses the real preload and main IPC for editing, recovery and navigation', { timeout: 90_000, skip: !browserPath && 'No installed Chromium browser; set DUSTDESK_HEADLESS_BROWSER' }, async t => {
  const fixture = await mainFixture(t, { widgetWindows: true })
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
  fixture.electron.screen.getAllDisplays = () => [display]
  fixture.electron.screen.getDisplayNearestPoint = () => display
  const assets = path.resolve('out/renderer')
  assert.ok(existsSync(path.join(assets, 'index.html')), 'Build before running renderer tests')
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const file = path.resolve(assets, '.' + (pathname === '/' ? '/index.html' : pathname))
      const relative = path.relative(assets, file)
      if (relative.startsWith('..') || path.isAbsolute(relative)) { response.writeHead(403); response.end(); return }
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[path.extname(file)] ?? 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': mime })
      response.end(await fs.readFile(file))
    } catch { response.writeHead(404); response.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const origin = `http://127.0.0.1:${server.address().port}`
  // Use a fresh temporary browser profile with no visible windows or GPU work.
  const browser = await chromium.launch({ executablePath: browserPath, headless: true, args: ['--disable-gpu', '--disable-background-networking'] })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' })
  await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const invoke = fixture.client((channel, ...args) => {
    void page.evaluate(({ channel, args }) => window.__dustdeskReceive?.(channel, ...args), { channel, args }).catch(() => {})
  }, true)
  await page.exposeFunction('__dustdeskInvoke', (channel, args) => {
    if (channel === 'screenshot:document:create') args[0] = new Uint8Array(Object.values(args[0]))
    if (channel === 'screenshot:finish' && args[0].png) args[0].png = new Uint8Array(Object.values(args[0].png))
    if (channel === 'screenshot:finish' && args[0].jpeg) args[0].jpeg = new Uint8Array(Object.values(args[0].jpeg))
    return invoke(channel, ...args)
  })
  const preload = ts.transpileModule(await fs.readFile('src/preload/index.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/import\s+\{[^}]+\}\s+from\s+['"]electron['"];?/, '')
  await page.addInitScript({ content: `(() => {
    const process = { platform: 'win32' };
    const listeners = new Map();
    const contextBridge = { exposeInMainWorld: (name, value) => { window[name] = value } };
    const ipcRenderer = {
      invoke: (channel, ...args) => window.__dustdeskInvoke(channel, args),
      on: (channel, callback) => { const callbacks = listeners.get(channel) || new Set(); callbacks.add(callback); listeners.set(channel, callbacks) },
      removeListener: (channel, callback) => listeners.get(channel)?.delete(callback),
      send: () => {}
    };
    window.__dustdeskReceive = (channel, ...args) => { for (const callback of listeners.get(channel) || []) callback({}, ...args) };
    ${preload}
  })();` })
  await page.goto(origin)
  await page.locator('h1').waitFor()
  const navigate = name => page.locator('.sidebar').getByText(name, { exact: true }).click()
  const pressed = async (button, value) => {
    await button.waitFor()
    await page.waitForFunction(({ name, value }) => [...document.querySelectorAll('button')].some(node => (node.getAttribute('aria-label') === name || node.title === name || node.textContent === name) && node.getAttribute('aria-pressed') === String(value)), { name: await button.getAttribute('aria-label') || await button.getAttribute('title') || await button.textContent(), value })
  }
  const picker = page.getByTitle('桌面小组件', { exact: true })
  const closePicker = () => page.locator('.widget-picker').getByTitle('关闭', { exact: true }).click()
  const waitForState = async (predicate, argument) => {
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await page.evaluate(predicate, argument)) return
      await page.waitForTimeout(30)
    }
    const diagnostic = await page.evaluate(async () => ({ notes: (await window.dustdesk.loadWorkspace()).Notes.map(note => ({ id: note.Id, title: note.Title })), categories: (await window.dustdesk.loadWorkspace()).DesktopCategories, selections: [...document.querySelectorAll('.organizer-dialog select')].map(item => ({ label: item.getAttribute('aria-label'), value: item.value })), title: document.querySelector('.note-title')?.value, notifications: [...document.querySelectorAll('[data-sonner-toast]')].map(item => item.textContent) }))
    throw Error('Timed out waiting for persisted state: ' + predicate.toString() + '\n' + JSON.stringify(diagnostic))
  }

  await navigate('便签')
  await page.getByLabel('便签标题', { exact: true }).fill('HEADLESS_NOTE')
  await page.locator('.note-text').fill('Saved without disturbing the desktop')
  await waitForState(async () => (await window.dustdesk.loadWorkspace()).Notes.some(note => note.Title === 'HEADLESS_NOTE' && note.Text === 'Saved without disturbing the desktop'))
  await page.reload()
  await page.locator('h1').waitFor()
  await page.locator('#global-search').fill('HEADLESS_NOTE')
  await page.getByRole('option').filter({ hasText: 'HEADLESS_NOTE' }).first().click()
  assert.equal(await page.locator('.note-text').inputValue(), 'Saved without disturbing the desktop')
  await page.getByTitle('删除便签', { exact: true }).click()
  await waitForState(async () => !(await window.dustdesk.loadWorkspace()).Notes.some(note => note.Title === 'HEADLESS_NOTE'))
  await navigate('回收站')
  const recycled = page.locator('.feature-row').filter({ hasText: 'HEADLESS_NOTE' })
  await recycled.getByRole('button', { name: '恢复', exact: true }).click()
  await waitForState(async () => (await window.dustdesk.loadWorkspace()).Notes.some(note => note.Title === 'HEADLESS_NOTE'))

  await navigate('便签')
  await page.locator('.notes-list').getByText('HEADLESS_NOTE', { exact: true }).click()
  const noteKey = `note:${(await fixture.load()).Notes.find(note => note.Title === 'HEADLESS_NOTE').Id}`
  const notePin = page.getByTitle('固定便签', { exact: true })
  await notePin.click()
  await pressed(notePin, true)
  await fixture.invoke('widgets:move', noteKey, 145, 165, true)
  await fixture.invoke('widgets:options', noteKey, { topMost: true })
  await picker.click()
  await pressed(page.getByRole('button', { name: '隐藏便签：HEADLESS_NOTE小组件', exact: true }), true)
  await page.getByRole('button', { name: '隐藏便签：HEADLESS_NOTE小组件', exact: true }).click()
  await pressed(notePin, false)
  const notePlacement = (await fixture.load()).Settings.WidgetPlacements[noteKey]
  assert.equal(notePlacement.X, 145); assert.equal(notePlacement.Y, 165); assert.equal(notePlacement.TopMost, true)
  await page.getByRole('button', { name: '显示便签：HEADLESS_NOTE小组件', exact: true }).click()
  await pressed(notePin, true)
  await fixture.invoke('widgets:hide', noteKey)
  await pressed(notePin, false)
  await pressed(page.getByRole('button', { name: '显示便签：HEADLESS_NOTE小组件', exact: true }), false)
  await closePicker()

  await page.locator('#global-search').fill('todo HEADLESS_TASK')
  await page.locator('#global-search').press('Enter')
  const task = page.locator('.todo-row').filter({ hasText: 'HEADLESS_TASK' })
  await task.getByTitle('标记为完成', { exact: true }).click()
  await waitForState(async () => (await window.dustdesk.loadWorkspace()).Todos.some(todo => todo.Title === 'HEADLESS_TASK' && todo.IsCompleted))

  await navigate('项目')
  await page.getByRole('button', { name: '新建项目', exact: true }).click()
  await page.getByLabel('项目名称').fill('HEADLESS_PROJECT')
  await page.getByRole('button', { name: '添加阶段', exact: true }).click()
  const phaseDialog = page.getByRole('dialog', { name: '添加阶段', exact: true })
  await phaseDialog.getByLabel('阶段名称', { exact: true }).fill('HEADLESS_PHASE')
  await phaseDialog.getByRole('button', { name: '添加阶段', exact: true }).click()
  await phaseDialog.waitFor({ state: 'hidden' })
  await page.getByPlaceholder('添加子事项').fill('HEADLESS_SUBTASK')
  await page.getByPlaceholder('添加子事项').press('Enter')
  await waitForState(async () => (await window.dustdesk.loadWorkspace()).Projects.some(project => project.Name === 'HEADLESS_PROJECT' && project.Phases.some(phase => phase.Subtasks.some(item => item.Title === 'HEADLESS_SUBTASK'))))
  const projectKey = `project:${(await fixture.load()).Projects.find(project => project.Name === 'HEADLESS_PROJECT').Id}`
  const projectPin = page.getByRole('button', { name: '固定', exact: true })
  await projectPin.click()
  await pressed(page.getByRole('button', { name: '取消固定', exact: true }), true)
  await picker.click()
  await pressed(page.getByRole('button', { name: '隐藏项目：HEADLESS_PROJECT小组件', exact: true }), true)
  await page.getByRole('button', { name: '隐藏项目：HEADLESS_PROJECT小组件', exact: true }).click()
  await pressed(projectPin, false)
  const write = fixture.fileSystem.writeFile
  fixture.fileSystem.writeFile = async () => { throw Error('Disk is full') }
  await projectPin.click()
  await page.getByText('Disk is full', { exact: true }).waitFor()
  assert.equal(await projectPin.getAttribute('aria-pressed'), 'false', 'Failed pin leaves both entrances unchanged')
  fixture.fileSystem.writeFile = write
  await page.getByRole('button', { name: '显示项目：HEADLESS_PROJECT小组件', exact: true }).click()
  await pressed(page.getByRole('button', { name: '取消固定', exact: true }), true)
  await fixture.invoke('widgets:hide', projectKey)
  await pressed(projectPin, false)
  await closePicker()
  await page.getByRole('button', { name: '编辑阶段 HEADLESS_PHASE', exact: true }).click()
  const editPhaseDialog = page.getByRole('dialog', { name: '编辑阶段', exact: true })
  await editPhaseDialog.getByLabel('开始日期', { exact: true }).fill('2026-10-03')
  await editPhaseDialog.getByLabel('结束日期', { exact: true }).fill('2026-10-07')
  await editPhaseDialog.getByLabel('进度（%）', { exact: true }).fill('50')
  await editPhaseDialog.getByLabel('状态', { exact: true }).selectOption('Doing')
  await editPhaseDialog.getByRole('button', { name: '保存阶段', exact: true }).click()
  await editPhaseDialog.waitFor({ state: 'hidden' })
  await page.getByRole('group', { name: '时间轴刻度' }).getByRole('button', { name: '日', exact: true }).click()
  const phaseBar = page.locator('.gantt-bar').first()
  assert.equal(await phaseBar.evaluate(node => node.getBoundingClientRect().width), 160, 'Five calendar days include both endpoints')
  assert.equal(await phaseBar.locator('.gantt-bar-progress').evaluate(node => node.getBoundingClientRect().width), 79, 'Progress fills half the bar interior')
  assert.match(await phaseBar.getAttribute('aria-label'), /5 天.*50%/)
  await phaseBar.click()
  await editPhaseDialog.getByLabel('结束日期', { exact: true }).fill('2026-10-01')
  await editPhaseDialog.getByRole('button', { name: '保存阶段', exact: true }).click()
  assert.equal(await editPhaseDialog.count(), 1, 'Invalid dates cannot save')
  await editPhaseDialog.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await phaseBar.evaluate(node => node.getBoundingClientRect().width), 160, 'Cancel preserves the schedule')
  await phaseBar.click()
  await editPhaseDialog.getByLabel('开始日期', { exact: true }).fill('2026-10-07')
  await editPhaseDialog.getByRole('button', { name: '保存阶段', exact: true }).click()
  await editPhaseDialog.waitFor({ state: 'hidden' })
  assert.equal(await phaseBar.evaluate(node => node.getBoundingClientRect().width), 32, 'Same-day stages remain visible')
  await page.getByRole('group', { name: '时间轴刻度' }).getByRole('button', { name: '月', exact: true }).click()
  assert.equal(await phaseBar.evaluate(node => node.getBoundingClientRect().width), 3.5, 'Monthly scale uses the same exact dates')
  await page.getByRole('group', { name: '时间轴刻度' }).getByRole('button', { name: '日', exact: true }).click()
  await phaseBar.click()
  await editPhaseDialog.getByLabel('结束日期', { exact: true }).fill('')
  await editPhaseDialog.getByRole('button', { name: '保存阶段', exact: true }).click()
  await editPhaseDialog.waitFor({ state: 'hidden' })
  assert.equal(await page.locator('.gantt-bar').count(), 0)
  await page.getByText('2026-10-07 起，结束待定', { exact: true }).waitFor()
  await page.getByRole('button', { name: '收起 HEADLESS_PHASE 的子事项', exact: true }).click()
  assert.equal(await page.getByPlaceholder('添加子事项').count(), 0)
  await page.getByRole('button', { name: '展开 HEADLESS_PHASE 的子事项', exact: true }).click()
  await page.getByText('HEADLESS_SUBTASK', { exact: true }).waitFor()

  const beforeGanttPreview = await fixture.load()
  const previewProject = beforeGanttPreview.Projects.find(project => project.Name === 'HEADLESS_PROJECT')
  const ganttNames = ['需求梳理', '设计评审', '开发与联调', '测试验收', '发布准备', '排期确认']
  const previewPhases = ganttNames.map((Title, index) => ({ ...previewProject.Phases[0], Id: `gantt-preview-${index}`, Title, StartDate: index < 4 ? `2026-10-${String([1, 4, 7, 15][index]).padStart(2, '0')}` : null, EndDate: index < 4 ? `2026-10-${String([3, 6, 14, 20][index]).padStart(2, '0')}` : index === 4 ? '2026-10-21' : null, Status: index < 2 ? 'Done' : index === 2 ? 'Doing' : 'Todo', ProgressPercent: index < 2 ? 100 : index === 2 ? 50 : 0, Subtasks: index === 2 ? previewProject.Phases[0].Subtasks : [] }))
  await fixture.invoke('workspace:save', { ...beforeGanttPreview, Projects: beforeGanttPreview.Projects.map(project => project.Id === previewProject.Id ? { ...project, Name: '产品交付', Phases: previewPhases } : project) }, beforeGanttPreview)
  await page.getByRole('button', { name: '编辑阶段 开发与联调', exact: true }).waitFor()
  await page.getByRole('button', { name: '展开 开发与联调 的子事项', exact: true }).click()
  await page.getByRole('group', { name: '时间轴刻度' }).getByRole('button', { name: '适应', exact: true }).click()
  assert.equal(await page.locator('.gantt-row').count(), 6)
  assert.equal(await page.locator('.gantt-bar').count(), 4)
  for (const [name, width, height] of [['light', 1400, 900], ['dark', 1400, 900], ['narrow', 1080, 680]]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, name === 'dark' ? 'dark' : 'light')
    assert.equal(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, 'Timeline overflow stays inside its own scroll area')
    if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) {
      await fs.mkdir(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, { recursive: true })
      const ganttCaptureStyle = await page.addStyleTag({ content: '[data-sonner-toaster], .floating-shortcuts, .floating-widgets { visibility: hidden !important; }' })
      await page.screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, `project-gantt-${name}.png`) })
      await ganttCaptureStyle.evaluate(node => node.remove())
    }
  }
  await page.getByRole('group', { name: '时间轴刻度' }).getByRole('button', { name: '日', exact: true }).click()
  await page.locator('.gantt-scroll').evaluate(node => { node.scrollLeft = 200 })
  const labelPosition = await page.locator('.gantt-phase-label').first().boundingBox()
  const ganttPosition = await page.locator('.gantt-scroll').boundingBox()
  assert.ok(Math.abs(labelPosition.x - ganttPosition.x) <= 1, 'Phase labels remain visible while scrolling horizontally')
  const afterGanttPreview = await fixture.load()
  await fixture.invoke('workspace:save', beforeGanttPreview, afterGanttPreview)
  await page.setViewportSize({ width: 1400, height: 900 })

  await navigate('专注计时')
  await page.getByLabel('专注分钟').fill('1.01')
  assert.equal(await page.getByRole('timer').innerText(), '01:01')
  await page.getByRole('button', { name: '开始专注', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByRole('button', { name: '继续', exact: true }).waitFor()
  assert.equal((await fixture.load()).ActiveFocus.RunningSince, null)
  await page.getByRole('button', { name: '结束并记录', exact: true }).click()
  await page.getByRole('button', { name: '开始专注', exact: true }).waitFor()

  await navigate('设置')
  assert.equal(await page.getByRole('button', { name: '安装更新', exact: true }).count(), 0)
  assert.equal(await page.getByRole('button', { name: '下载更新', exact: true }).count(), 0)
  assert.equal(await page.evaluate(() => document.documentElement.inert), false)
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.getByText('当前已是最新版本', { exact: true }).waitFor()
  const updateDialogs = [], helpUrls = []
  fixture.electron.net.fetch = async () => new Response(JSON.stringify({ tag_name: 'v1.1.0', body: '修复截图卡顿\n添加阶段改为弹窗', draft: false, prerelease: false }))
  fixture.electron.dialog.showMessageBox = async (...args) => { updateDialogs.push(args.at(-1)); return { response: 0 } }
  fixture.electron.shell.openExternal = async url => { helpUrls.push(url) }
  await page.getByRole('button', { name: '检查更新', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.advanced-settings button') && [...document.querySelectorAll('button')].some(button => button.textContent === '检查更新' && !button.disabled))
  assert.equal(updateDialogs.length, 1); assert.match(updateDialogs[0].detail, /添加阶段改为弹窗/)
  assert.deepEqual(helpUrls, [], 'Canceling the update prompt cannot navigate to a download')
  await page.getByRole('button', { name: '关于项目', exact: true }).click()
  await page.getByRole('button', { name: '问题反馈', exact: true }).click()
  assert.deepEqual(helpUrls, ['https://github.com/Xu-qingsong/DustDesk-Next', 'https://github.com/Xu-qingsong/DustDesk-Next/issues'])

  await navigate('系统检测')
  await page.waitForFunction(() => document.querySelector('.health-grid')?.textContent.includes('暂不可用'))
  const disk = page.locator('.health-grid > div').filter({ hasText: '磁盘读取' })
  assert.match(await disk.innerText(), /暂不可用/)
  for (const name of ['统计分析', '资源库', '剪贴板', '桌面收纳', '截图编辑', '资源检查', '概览']) {
    await navigate(name)
    await page.locator('.content-inner').waitFor()
  }

  // The organizer page keeps rules and management in dialogs and uses file tiles.
  const desktop = path.join(fixture.root, 'desktop')
  await fs.mkdir(desktop, { recursive: true })
  const desktopNames = ['工作报告.txt', '会议记录.txt', '长文件名用于检查桌面项目宫格自动换行和提示信息.txt', '项目资料', '参考资料.pdf', '设计稿.png', '软件快捷方式.LNK']
  for (const name of desktopNames) {
    const target = path.join(desktop, name)
    if (name === '项目资料') await fs.mkdir(target)
    else await fs.writeFile(target, name)
  }
  const program = path.join(fixture.root, 'example.exe')
  await fs.writeFile(program, 'program fixture')
  fixture.electron.shell.readShortcutLink = () => ({ target: program, icon: '' })
  fixture.electron.app.getFileIcon = async () => ({ isEmpty: () => false, toDataURL: () => 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect x="10" y="4" width="28" height="40" rx="4" fill="#087f6c"/><path d="M17 19h14M17 26h14M17 33h10" stroke="white" stroke-width="2"/></svg>').toString('base64') })
  const pageOpened = []
  fixture.electron.shell.openPath = async target => { pageOpened.push(target); return '' }
  await navigate('桌面收纳')
  await page.getByRole('button', { name: '打开 工作报告.txt', exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  assert.equal(await page.getByLabel('规则内容', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('当前分类', { exact: true }).count(), 0)
  assert.equal(await page.locator('.organizer-entry').count(), desktopNames.length)
  const tileBounds = await page.locator('.organizer-entry').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })))
  assert.equal(tileBounds[0].y, tileBounds[1].y)
  assert.ok(tileBounds[1].x > tileBounds[0].x, 'Desktop entries must form a grid')
  await page.waitForFunction(() => [...document.querySelectorAll('.organizer-entry .path-icon img')].filter(img => img.complete && img.naturalWidth > 0).length === 6)
  await page.getByRole('button', { name: '打开 项目资料', exact: true }).locator('svg.lucide-folder-open').waitFor()
  const shortcutTile = page.locator('.organizer-entry').filter({ hasText: '软件快捷方式.LNK' })
  await shortcutTile.getByText('快捷方式', { exact: true }).waitFor()
  assert.equal(await shortcutTile.locator('.path-shortcut-badge').count(), 1)
  const menuTrigger = page.getByRole('button', { name: '收纳 工作报告.txt 到分类', exact: true })
  await menuTrigger.click()
  const fileMenu = page.getByRole('menu', { name: '收纳 工作报告.txt 到分类', exact: true })
  await fileMenu.waitFor()
  assert.equal(await fileMenu.getByRole('menuitem').count(), (await fixture.load()).DesktopCategories.length)
  if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-file-menu.png') })
  }
  await fileMenu.press('Escape')
  await fileMenu.waitFor({ state: 'detached' })
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '收纳 工作报告.txt 到分类')
  await menuTrigger.press('Enter')
  await fileMenu.waitFor()
  await page.getByRole('button', { name: '扫描', exact: true }).click()
  await fileMenu.waitFor({ state: 'detached' })
  const triggerBounds = await menuTrigger.boundingBox()
  const reportBounds = await page.locator('.organizer-entry').filter({ hasText: '工作报告.txt' }).boundingBox()
  assert.ok(triggerBounds.x > reportBounds.x + reportBounds.width / 2 && triggerBounds.y < reportBounds.y + 40, 'Category trigger belongs at the top-right of the card')
  await page.getByRole('button', { name: '打开 工作报告.txt', exact: true }).click()
  assert.deepEqual(pageOpened, [path.join(desktop, '工作报告.txt')])
  if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-page.png') })
  }
  await page.getByRole('button', { name: '收纳规则', exact: true }).click()
  const rulesDialog = page.getByRole('dialog', { name: '收纳规则', exact: true })
  await rulesDialog.waitFor()
  await rulesDialog.getByLabel('规则内容', { exact: true }).fill('txt')
  await rulesDialog.getByRole('button', { name: '新增规则', exact: true }).click()
  await waitForState(async () => (await window.dustdesk.loadWorkspace()).OrganizerRules.some(rule => rule.Pattern === 'txt'))
  await rulesDialog.press('Escape')
  await rulesDialog.waitFor({ state: 'detached' })
  assert.equal(await page.getByRole('button', { name: '收纳规则', exact: true }).evaluate(node => node === document.activeElement), true)

  await page.getByRole('button', { name: '分类管理', exact: true }).click()
  const categoryDialog = page.getByRole('dialog', { name: '分类管理', exact: true })
  const groupCategory = (await fixture.load()).DesktopCategories[0]
  const groupKey = `organizer-group:${groupCategory.Id}`
  await categoryDialog.getByRole('button', { name: '固定组合', exact: true }).click()
  await pressed(categoryDialog.getByRole('button', { name: '取消固定组合', exact: true }), true)
  await categoryDialog.getByRole('button', { name: '完成', exact: true }).click()
  await picker.click()
  await pressed(page.getByRole('button', { name: `隐藏收纳组合：${groupCategory.Name}小组件`, exact: true }), true)
  await page.getByRole('button', { name: `隐藏收纳组合：${groupCategory.Name}小组件`, exact: true }).click()
  await pressed(page.getByRole('button', { name: `显示收纳组合：${groupCategory.Name}小组件`, exact: true }), false)
  assert.equal((await fixture.invoke('widgets:visibility', [groupKey]))[groupKey], false)
  await closePicker()
  await page.getByRole('button', { name: '分类管理', exact: true }).click()
  await pressed(categoryDialog.getByRole('button', { name: '固定组合', exact: true }), false)
  await categoryDialog.getByLabel('新增分类名称', { exact: true }).fill('HEADLESS_CATEGORY')
  await categoryDialog.getByRole('button', { name: '新增分类', exact: true }).click()
  await waitForState(async () => (await window.dustdesk.loadWorkspace()).DesktopCategories.some(category => category.Name === 'HEADLESS_CATEGORY'))
  const addedCategory = (await fixture.load()).DesktopCategories.find(category => category.Name === 'HEADLESS_CATEGORY')
  await categoryDialog.getByRole('button', { name: '上移', exact: true }).click()
  await waitForState(async () => { const categories = (await window.dustdesk.loadWorkspace()).DesktopCategories; return categories.at(-2).Name === 'HEADLESS_CATEGORY' })
  if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-categories-dialog.png') })
  await categoryDialog.getByRole('button', { name: '完成', exact: true }).click()
  await menuTrigger.click()
  await fileMenu.getByRole('menuitem', { name: /^HEADLESS_CATEGORY/ }).click()
  await page.getByRole('button', { name: '打开 工作报告.txt', exact: true }).waitFor({ state: 'detached' })
  assert.equal((await fixture.load()).DesktopCategories.find(category => category.Id === addedCategory.Id).ItemPaths.length, 1)
  assert.equal(await fs.readFile((await fixture.load()).DesktopCategories.find(category => category.Id === addedCategory.Id).ItemPaths[0], 'utf8'), '工作报告.txt')
  await page.getByRole('button', { name: '分类管理', exact: true }).click()
  const destinationId = (await fixture.load()).DesktopCategories[0].Id
  await categoryDialog.getByLabel('当前分类', { exact: true }).selectOption(addedCategory.Id)
  await categoryDialog.getByLabel('合并目标分类', { exact: true }).selectOption(destinationId)
  await categoryDialog.getByRole('button', { name: '合并分类', exact: true }).click()
  await waitForState(async () => !(await window.dustdesk.loadWorkspace()).DesktopCategories.some(category => category.Name === 'HEADLESS_CATEGORY'))
  assert.equal((await fixture.load()).DesktopCategories.find(category => category.Id === destinationId).ItemPaths.length, 1)
  await categoryDialog.press('Escape')
  await categoryDialog.waitFor({ state: 'detached' })
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await waitForState(async id => (await window.dustdesk.loadWorkspace()).DesktopCategories.some(category => category.Id === id && category.ItemPaths.length === 1), addedCategory.Id)
  await page.getByRole('button', { name: '分类管理', exact: true }).click()
  await categoryDialog.getByLabel('当前分类', { exact: true }).selectOption(addedCategory.Id)
  await categoryDialog.getByRole('button', { name: '删除并恢复', exact: true }).click()
  await waitForState(async id => !(await window.dustdesk.loadWorkspace()).DesktopCategories.some(category => category.Id === id), addedCategory.Id)
  assert.equal(await fs.readFile(path.join(desktop, '工作报告.txt'), 'utf8'), '工作报告.txt')
  await categoryDialog.getByRole('button', { name: '完成', exact: true }).click()

  const dragged = await page.evaluateHandle(target => { const transfer = new DataTransfer(); transfer.setData('text/plain', target); return transfer }, path.join(desktop, '项目资料'))
  await page.locator('.category-card > div').first().dispatchEvent('dragover', { dataTransfer: dragged })
  await page.getByText('松开即可收纳', { exact: true }).waitFor()
  await page.locator('.category-card > div').first().dispatchEvent('drop', { dataTransfer: dragged })
  await page.getByRole('button', { name: '打开 项目资料', exact: true }).waitFor({ state: 'detached' })
  assert.equal((await fixture.load()).DesktopCategories[0].ItemPaths.length, 1)
  await dragged.dispose()
  await page.getByRole('button', { name: '恢复全部', exact: true }).click()
  await page.getByRole('button', { name: '打开 项目资料', exact: true }).waitFor()
  await page.getByRole('button', { name: '智能预览', exact: true }).click()
  await page.getByRole('button', { name: '执行计划', exact: true }).waitFor()
  if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) {
    const previewCaptureStyle = await page.addStyleTag({ content: '[data-sonner-toaster], .floating-shortcuts, .floating-widgets { visibility: hidden !important; }' })
    await page.locator('.organizer-plan').screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-preview-light.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await page.locator('.organizer-plan').screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-preview-dark.png') })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light' })
    await page.setViewportSize({ width: 760, height: 600 })
    await page.locator('.organizer-plan').screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-preview-narrow.png') })
    await page.setViewportSize({ width: 1400, height: 900 })
    await previewCaptureStyle.evaluate(element => element.remove())
  }
  await page.getByRole('button', { name: '执行计划', exact: true }).click()
  await page.getByRole('button', { name: '恢复全部', exact: true }).waitFor({ state: 'visible' })
  await page.waitForFunction(() => !document.querySelector('.organizer-plan') && document.querySelectorAll('.organizer-entry').length === 0)
  await page.getByRole('button', { name: '恢复全部', exact: true }).click()
  await page.waitForFunction(() => document.querySelectorAll('.organizer-entry').length === 7)
  assert.ok((await fixture.load()).DesktopCategories.every(category => !category.ItemPaths.length))
  await page.setViewportSize({ width: 760, height: 600 })
  assert.equal(await page.locator('.organizer-entries').evaluate(node => node.scrollWidth <= node.clientWidth), true)
  await page.getByRole('button', { name: '收纳 软件快捷方式.LNK 到分类', exact: true }).click()
  const narrowMenu = page.getByRole('menu', { name: '收纳 软件快捷方式.LNK 到分类', exact: true })
  await narrowMenu.waitFor()
  const menuBounds = await narrowMenu.boundingBox()
  assert.ok(menuBounds.x >= 0 && menuBounds.x + menuBounds.width <= 760)
  await narrowMenu.press('Escape')
  await page.getByRole('button', { name: '收纳规则', exact: true }).click()
  await rulesDialog.waitFor()
  assert.equal(await rulesDialog.evaluate(node => node.scrollWidth <= node.clientWidth), true)
  await rulesDialog.press('Escape')

  // List rows keep their content height as windows grow, and scroll when full.
  const beforeWidgetAudit = await fixture.load()
  const auditName = '高度回归检查'.repeat(20)
  const auditPath = path.join(desktop, auditName + '.txt')
  const auditDate = new Date().toISOString()
  const auditWidgetState = count => ({
    ...beforeWidgetAudit,
    Todos: Array.from({ length: count }, (_, i) => ({ Id: `height-task-${i}`, Title: auditName, Tag: '', Note: '', IsCompleted: false, CreatedAt: auditDate, ReminderRepeat: 'None' })),
    Projects: Array.from({ length: count }, (_, i) => ({ Id: `height-project-${i}`, Name: auditName, ProjectPath: '', Phases: [] })),
    Launchers: Array.from({ length: count }, (_, i) => ({ Id: `height-launcher-${i}`, Name: auditName, Path: auditPath })),
    LinkGroups: [{ Id: 'height-links', Name: '学习', Links: Array.from({ length: count }, (_, i) => ({ Id: `height-link-${i}`, Name: auditName, Url: 'https://www.bilibili.com/' + 'long-path/'.repeat(30), Note: '', CreatedAt: auditDate, UpdatedAt: auditDate })) }, { Id: 'height-empty', Name: '空分类', Links: [] }],
    ClipboardHistory: Array.from({ length: count }, (_, i) => ({ Id: `height-clip-${i}`, Kind: 'Text', Text: auditName, ImagePngBase64: '', ImageFileName: '', ImageSha256: '', CreatedAt: auditDate, IsLocked: false, IsPinned: false }))
  })
  const auditLayout = () => page.evaluate(() => {
    const lists = [...document.querySelectorAll('.widget-todos, .widget-search-results')]
    const rows = [...document.querySelectorAll('.widget-todo')]
    const head = document.querySelector('.widget-head, .widget-search-row').getBoundingClientRect()
    return {
      heights: rows.map(row => row.getBoundingClientRect().height),
      horizontalOverflow: [...document.querySelectorAll('.widget-content, .widget-todos, .widget-todo, .widget-search-results')].some(node => node.scrollWidth > node.clientWidth + 1),
      listOverflow: lists.some(node => node.scrollHeight > node.clientHeight + 1),
      headHeight: head.height
    }
  })
  for (const count of [1, 18, 0]) {
    const auditBaseline = await fixture.load()
    await fixture.invoke('workspace:save', auditWidgetState(count), auditBaseline)
    for (const widget of ['links', 'todo', 'projects', 'launcher', 'clipboard']) {
      await page.setViewportSize({ width: 360, height: 320 })
      await page.goto(`${origin}/?widget=${widget}`)
      await page.locator('.widget-content').waitFor()
      if (widget === 'links') await page.getByRole('tab', { name: '学习', exact: true }).waitFor()
      if (count === 1 && widget === 'links') {
        const magnet = page.getByRole('button', { name: '吸附屏幕边缘', exact: true })
        assert.equal(await magnet.getAttribute('aria-pressed'), 'false')
        await magnet.click()
        await page.waitForFunction(() => document.querySelector('button[title="吸附屏幕边缘"]').getAttribute('aria-pressed') === 'true')
        assert.equal((await fixture.load()).Settings.WidgetPlacements.links.SnapToEdges, true)
        await magnet.click()
        await page.waitForFunction(() => document.querySelector('button[title="吸附屏幕边缘"]').getAttribute('aria-pressed') === 'false')
      }
      if (count) await page.locator('.widget-todo').first().waitFor()
      const normal = await auditLayout()
      await page.setViewportSize({ width: 320, height: 520 })
      const tall = await auditLayout()
      assert.equal(normal.horizontalOverflow || tall.horizontalOverflow, false, `${widget}: long content must stay inside the widget`)
      assert.ok(normal.headHeight >= 36 && tall.headHeight >= 36, `${widget}: header must not shrink`)
      if (count) {
        assert.equal(normal.heights.length, count)
        assert.ok(normal.heights.every(height => height >= 39 && height <= 64), `${widget}: compact rows, got ${normal.heights}`)
        assert.deepEqual(tall.heights, normal.heights, `${widget}: row height must not grow with window height`)
        if (count > 1) assert.equal(normal.listOverflow, true, `${widget}: many rows must scroll`)
      }
      if (count === 1 && widget === 'links') {
        await page.getByRole('tab', { name: '空分类', exact: true }).click()
        await page.getByText('这个分类还没有链接', { exact: true }).waitFor()
        await page.getByRole('tab', { name: '学习', exact: true }).click()
        assert.deepEqual((await auditLayout()).heights, normal.heights)
        if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) {
          await fs.mkdir(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, { recursive: true })
          await page.screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'widget-links-fixed.png') })
        }
      }
    }
  }
  const largeIconBaseline = await fixture.load()
  await fixture.invoke('workspace:save', { ...auditWidgetState(1), Settings: { ...beforeWidgetAudit.Settings, LauncherWidgetIconSize: 96 } }, largeIconBaseline)
  await page.goto(`${origin}/?widget=launcher`)
  await page.locator('.widget-launcher-icon').waitFor()
  assert.equal(await page.locator('.widget-launcher-icon').evaluate(node => node.getBoundingClientRect().height), 96)
  assert.equal(await page.locator('.widget-todo').evaluate(node => node.getBoundingClientRect().height), 96, 'Large launcher icons must keep their natural row height')

  const searchAuditFiles = Array.from({ length: 18 }, (_, i) => path.join(desktop, `height-search-${i}.txt`))
  await Promise.all(searchAuditFiles.map(file => fs.writeFile(file, 'layout test')))
  await page.setViewportSize({ width: 360, height: 360 })
  await page.goto(`${origin}/?widget=search`)
  await page.getByPlaceholder('搜索桌面文件').fill('height-search-0')
  await page.locator('.widget-search-results .widget-todo').waitFor()
  assert.deepEqual((await auditLayout()).heights, [34])
  await page.setViewportSize({ width: 320, height: 520 })
  assert.deepEqual((await auditLayout()).heights, [34], 'Search results must not stretch')
  await page.getByPlaceholder('搜索桌面文件').fill('height-search-')
  await page.waitForFunction(() => document.querySelectorAll('.widget-search-results .widget-todo').length === 18)
  await page.setViewportSize({ width: 320, height: 240 })
  const searchLayout = await auditLayout()
  assert.equal(searchLayout.horizontalOverflow, false)
  assert.equal(searchLayout.listOverflow, true)
  assert.ok(searchLayout.heights.every(height => height === 34))
  await Promise.all(searchAuditFiles.map(file => fs.unlink(file)))

  const restoreWidgetAudit = await fixture.load()
  await fixture.invoke('workspace:save', beforeWidgetAudit, restoreWidgetAudit)
  await page.goto(`${origin}/?widget=monitor`)
  await page.locator('.widget-metrics').waitFor()
  const monitorBaseline = await fixture.load()
  const monitorKeys = Object.keys(monitorBaseline.Settings).filter(key => key.startsWith('MonitorShow'))
  const hiddenMetrics = Object.fromEntries(monitorKeys.map(key => [key, false]))
  await fixture.invoke('workspace:save', { ...monitorBaseline, Settings: { ...monitorBaseline.Settings, ...hiddenMetrics, MonitorShowDownload: true, MonitorShowDiskIo: true } }, monitorBaseline)
  await page.waitForFunction(() => document.querySelectorAll('.widget-metrics > strong').length === 3)
  assert.deepEqual(await page.locator('.widget-metrics > strong').allTextContents(), ['下载 0 B/s', '磁盘读取 --', '磁盘写入 --'])
  const selectedMetrics = await fixture.load()
  await fixture.invoke('workspace:save', { ...selectedMetrics, Settings: { ...selectedMetrics.Settings, ...hiddenMetrics } }, selectedMetrics)
  await page.getByText('未选择指标，请在系统检测页设置', { exact: true }).waitFor()
  await fixture.invoke('workspace:save', monitorBaseline, await fixture.load())
  for (const widget of ['countdown', 'monitor', 'notes', `note:${beforeWidgetAudit.Notes[0].Id}`, `project:${beforeWidgetAudit.Projects[0].Id}`]) {
    await page.setViewportSize({ width: 360, height: 320 })
    await page.goto(`${origin}/?widget=${widget}`)
    await page.locator('.widget-content').waitFor()
    const content = widget === 'countdown' ? '.countdown-widget > strong' : widget === 'monitor' ? '.widget-metrics > strong' : widget.startsWith('project:') ? '.widget-todo' : '.widget-note-editor textarea'
    await page.locator(content).first().waitFor()
    const normalHeight = await page.locator(content).first().evaluate(node => node.getBoundingClientRect().height)
    await page.setViewportSize({ width: 320, height: 520 })
    const tallHeight = await page.locator(content).first().evaluate(node => node.getBoundingClientRect().height)
    if (widget.includes('note')) assert.ok(tallHeight > normalHeight, 'Note editor should still use the available height')
    else assert.equal(tallHeight, normalHeight, `${widget}: display items must not stretch`)
    if (widget === 'countdown' || widget === 'monitor') {
      await page.setViewportSize({ width: 320, height: 170 })
      assert.equal(await page.locator('.widget-content > div').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true)
      assert.equal(await page.locator('.widget-content > div').evaluate(node => node.scrollHeight <= node.clientHeight + 1 || getComputedStyle(node).overflowY === 'auto'), true, `${widget}: small windows must allow scrolling`)
    }
  }

  // Exercise the widget at its real desktop size, including legacy hidden-name settings.
  const state = await fixture.load()
  const files = path.join(fixture.data, 'DesktopOrganizer', '文件')
  await fs.mkdir(files, { recursive: true })
  const names = ['工作报告.txt', '一个特别长的中文文件名称用于验证自动换行与完整名称提示.pdf', '资料文件夹', '已删除.txt']
  const paths = names.map(name => path.join(files, name))
  await fs.writeFile(paths[0], 'report')
  await fs.writeFile(paths[1], 'document')
  await fs.mkdir(paths[2])
  const iconRequests = []
  fixture.electron.app.getFileIcon = async target => {
    iconRequests.push(target)
    if (target === paths[2]) throw Error('Folder icon unavailable')
    return { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZcAAAAASUVORK5CYII=' }
  }
  const opened = []
  fixture.electron.shell.openPath = async target => { opened.push(target); return '' }
  const categories = ['工作', '开发', '工具', '文件'].map((Name, index) => ({ Id: crypto.randomUUID(), Name, IsCollapsed: false, ItemPaths: index === 3 ? paths : [] }))
  await fixture.invoke('workspace:save', { ...state, DesktopCategories: categories, Settings: { ...state.Settings, OrganizerWidgetShowNames: false } }, state)
  await page.setViewportSize({ width: 400, height: 330 })
  await page.goto(`${origin}/?widget=organizer`)
  await page.getByRole('tab', { name: '文件 4', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '文件 4', exact: true }).getAttribute('aria-selected'), 'true')
  const tabBounds = await page.getByRole('tab').evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, y: node.getBoundingClientRect().y })))
  assert.ok(tabBounds.every(bounds => bounds.y === tabBounds[0].y), 'Categories must share a horizontal row')
  assert.ok(tabBounds[1].x > tabBounds[0].x)
  for (const name of names) await page.getByRole('button', { name, exact: true }).waitFor()
  await page.waitForFunction(() => [...document.querySelectorAll('.organizer-file-icon img')].filter(img => img.complete && img.naturalWidth > 0).length === 2)
  assert.ok(iconRequests.includes(paths[0]))
  await page.getByRole('button', { name: names[2], exact: true }).locator('svg.lucide-folder-open').waitFor()
  assert.equal(await page.getByRole('button', { name: names[3], exact: true }).locator('svg').count(), 1)
  assert.equal(await page.getByRole('button', { name: names[1], exact: true }).getAttribute('title'), paths[1])
  const fileCellHeights = await page.locator('.organizer-file').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
  await page.setViewportSize({ width: 400, height: 520 })
  assert.deepEqual(await page.locator('.organizer-file').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)), fileCellHeights, 'Organizer cells must not stretch with the window')
  await page.setViewportSize({ width: 400, height: 330 })
  await page.getByRole('button', { name: names[0], exact: true }).click()
  assert.deepEqual(opened, [paths[0]])
  if (process.env.DUSTDESK_TEST_SCREENSHOT_DIR) {
    await fs.mkdir(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: path.join(process.env.DUSTDESK_TEST_SCREENSHOT_DIR, 'organizer-fixed.png') })
  }
  await page.getByRole('tab', { name: '工作 0', exact: true }).click()
  await page.getByText('此分类暂无文件', { exact: true }).waitFor()
  await page.getByRole('tab', { name: '工作 0', exact: true }).press('End')
  await page.getByRole('button', { name: names[0], exact: true }).waitFor()
  await page.setViewportSize({ width: 320, height: 240 })
  assert.equal(await page.locator('.organizer-widget').evaluate(node => node.scrollWidth <= node.clientWidth), true)
  assert.equal(await page.locator('.organizer-panel').evaluate(node => node.scrollWidth <= node.clientWidth), true)

  // Group widgets must expose the same categories and files, rather than counts only.
  await page.goto(`${origin}/?widget=organizer-group:${categories[0].Id},${categories[3].Id}`)
  await page.getByRole('button', { name: names[0], exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 2)
  const groupCellHeights = await page.locator('.organizer-file').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height))
  await page.setViewportSize({ width: 320, height: 520 })
  assert.deepEqual(await page.locator('.organizer-file').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height)), groupCellHeights, 'Organizer group cells must not stretch with the window')
  const current = await fixture.load()
  await fixture.invoke('workspace:save', { ...current, DesktopCategories: [categories[0]] }, current)
  await page.getByText('此分类暂无文件', { exact: true }).waitFor()
  assert.equal(await page.getByRole('tab').count(), 1)

  // Pending icons must not hold navigation or dialogs, and offscreen rows stay lazy.
  const bulkNames = Array.from({ length: 90 }, (_, i) => `async-icon-${String(i).padStart(3, '0')}.txt`)
  await Promise.all(bulkNames.map(name => fs.writeFile(path.join(desktop, name), 'async icon fixture')))
  const requested = []
  const release = []
  let notifyStarted
  const started = new Promise(resolve => { notifyStarted = resolve })
  const nativeIcon = { isEmpty: () => false, toDataURL: () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZcAAAAASUVORK5CYII=' }
  let hold = true
  fixture.electron.app.getFileIcon = target => {
    requested.push(target)
    notifyStarted()
    return hold ? new Promise(resolve => release.push(() => resolve(nativeIcon))) : Promise.resolve(nativeIcon)
  }
  await page.setViewportSize({ width: 760, height: 600 })
  await page.goto(origin)
  await navigate('桌面收纳')
  await page.getByRole('button', { name: `打开 ${bulkNames[0]}`, exact: true }).waitFor()
  await page.getByRole('button', { name: `打开 ${bulkNames[0]}`, exact: true }).scrollIntoViewIfNeeded()
  await started
  assert.ok(requested.length <= 8, 'Pending native icon work is bounded')
  assert.ok(!requested.includes(path.join(desktop, bulkNames.at(-1))), 'Offscreen icons must not be eagerly requested')
  assert.equal(await page.getByRole('button', { name: `打开 ${bulkNames[0]}`, exact: true }).locator('.path-icon svg').count(), 1)
  await page.getByRole('button', { name: '收纳规则', exact: true }).click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('dialog').press('Escape')
  hold = false
  release.splice(0).forEach(done => done())
  const lastTile = page.getByRole('button', { name: `打开 ${bulkNames.at(-1)}`, exact: true })
  await lastTile.scrollIntoViewIfNeeded()
  await lastTile.locator('img').waitFor()
  assert.ok(requested.includes(path.join(desktop, bulkNames.at(-1))), 'Scrolling loads the newly visible icon')
  // Exercise the application editor through the actual preload and session IPC.
  fixture.electron.nativeImage.createFromBuffer = bytes => ({
    isEmpty: () => bytes.length < 24,
    getSize: () => ({ width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }),
    toPNG: () => bytes, toJPEG: () => bytes, toDataURL: () => 'data:image/png;base64,' + bytes.toString('base64')
  })
  fixture.electron.clipboard.writeImage = () => {}
  await page.setViewportSize({ width: 1400, height: 900 })
  await navigate('截图编辑')
  const source = await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 400; c.height = 200; c.getContext('2d').fillStyle = '#fff'; c.getContext('2d').fillRect(0, 0, 400, 200)
    return [...new Uint8Array(await (await new Promise(resolve => c.toBlob(resolve))).arrayBuffer())]
  })
  await page.getByLabel('导入截图图片').setInputFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(source) })
  await page.waitForFunction(() => document.querySelector('button[aria-label="复制"]')?.disabled === false)
  await page.getByRole('button', { name: '调整选区', exact: true }).click()
  const image = await page.locator('.screenshot-image').boundingBox()
  await page.mouse.move(image.x + 40, image.y + 20); await page.mouse.down(); await page.mouse.move(image.x + 240, image.y + 120); await page.mouse.up()
  await page.getByRole('button', { name: '确认裁剪', exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '复制', exact: true }).isDisabled(), true)
  assert.equal(await fs.stat(path.join(fixture.data, 'Screenshots')).catch(() => null), null)
  await page.getByRole('button', { name: '确认裁剪', exact: true }).click()
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.screenshot-feedback').textContent.includes('已保存'))
  const exported = await fs.readdir(path.join(fixture.data, 'Screenshots'))
  assert.equal(exported.length, 1)
  const cropped = await fs.readFile(path.join(fixture.data, 'Screenshots', exported[0]))
  assert.equal(cropped.readUInt32BE(16), 200); assert.equal(cropped.readUInt32BE(20), 100)
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  assert.equal(await page.locator('.selection-size').innerText(), '400 × 200 px')
  await page.getByRole('button', { name: '重做', exact: true }).click()
  assert.equal(await page.locator('.selection-size').innerText(), '200 × 100 px')
  await navigate('概览')
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true })))
  await page.waitForTimeout(60)
  assert.equal((await fs.readdir(path.join(fixture.data, 'Screenshots'))).length, 1, 'Hidden editor cannot handle shortcuts')
  await navigate('截图编辑')
  await page.getByLabel('导入截图图片').setInputFiles({ name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('broken') })
  await page.getByRole('alert').filter({ hasText: '无法读取图片' }).waitFor()
  fixture.electron.clipboard.readText = () => ''
  fixture.electron.clipboard.readImage = () => fixture.electron.nativeImage.createFromBuffer(Buffer.from(source))
  await page.getByRole('button', { name: '剪贴板图片', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('.selection-size').textContent === '400 × 200 px' && !document.querySelector('.screenshot-import-error'))
  await page.evaluate(bytes => {
    const transfer = new DataTransfer(); transfer.items.add(new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' }))
    document.querySelector('.screenshot-page').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }))
  }, source)
  await page.waitForFunction(() => !document.querySelector('.screenshot-page [role="status"]'))
  assert.equal((await fs.readdir(path.join(fixture.data, 'Screenshots'))).length, 1, 'Imports never export raw images')
  assert.deepEqual(errors, [])
})
