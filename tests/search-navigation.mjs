import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
const page = app.window
const errors = []
page.on('pageerror', error => errors.push(error.message))
const navigate = text => page.locator('.sidebar').getByText(text, { exact: true }).click()
async function choose(query, title = query, keyboard = false) {
  const input = page.locator('#global-search')
  await input.fill(query)
  const result = page.locator('.search-popover').getByRole('option').filter({ has: page.locator('span', { hasText: title }) })
  await result.first().waitFor()
  if (keyboard) { await input.press('ArrowDown'); await input.press('Enter') }
  else await result.first().click()
}
async function focused(kind, id) {
  const expected = `search-target-${kind}-${id}`
  await page.waitForFunction(value => document.activeElement?.id === value, expected)
  const geometry = await page.locator(`[id="${expected}"]`).evaluate(element => {
    const rect = element.getBoundingClientRect(); const content = document.querySelector('.content').getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, contentTop: content.top, contentBottom: content.bottom }
  })
  assert.ok(geometry.bottom > geometry.contentTop && geometry.top < geometry.contentBottom, `${kind} target should be inside the scrolled content viewport`)
}
try {
  await page.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace(); const next = structuredClone(state)
    next.Settings.ClipboardMonitoringEnabled = false
    for (const field of ['SearchDesktopFiles', 'SearchAppData', 'SearchStartMenuApps', 'SearchProjectPaths', 'SearchCustomPaths']) next.Settings[field] = false
    const stamp = new Date().toISOString()
    const note = (id, title) => ({ Id: id, Title: title, Text: `${title} body`, ColorArgb: -411768, FontColorArgb: -1385444, FontSize: 14, FontBold: false, BackgroundImageFileName: '', ImageOnly: false, CreatedAt: stamp, UpdatedAt: stamp })
    next.Notes = [note('search-note-first', 'First note'), note('search-note-target', 'SEARCH_NOTE_TARGET')]
    next.Todos = [{ Id: 'search-task-old', Title: 'SEARCH_ARCHIVED_TASK', Tag: '', Note: 'prior completed task', IsCompleted: true, CreatedAt: '2020-01-02T08:00:00.000Z', ReminderRepeat: 'None' }]
    next.Projects = [{ Id: 'search-project-first', Name: 'First project', ProjectPath: '', Phases: [{ Id: 'first-phase', Title: 'First phase', Status: 'Todo', ProgressPercent: 0, ProjectPath: '', Subtasks: [] }] }, { Id: 'search-project-target', Name: 'SEARCH_PROJECT_TARGET', ProjectPath: '', Phases: Array.from({ length: 14 }, (_, i) => ({ Id: `search-phase-${i}`, Title: i === 13 ? 'SEARCH_PHASE_TARGET' : `Phase ${i}`, Status: 'Todo', ProgressPercent: 0, ProjectPath: '', Subtasks: [{ Id: `search-subtask-${i}`, Title: i === 13 ? 'SEARCH_SUBTASK_TARGET' : `Item ${i}`, IsCompleted: false, FilePath: '' }] })) }]
    next.LinkGroups = [{ Id: 'search-group-first', Name: 'First group', Links: [] }, { Id: 'search-group-target', Name: 'SEARCH_GROUP', Links: [{ Id: 'search-link-target', Name: 'SEARCH_LINK_TARGET', Url: 'http://example.com', Note: '', CreatedAt: stamp, UpdatedAt: stamp }] }]
    next.Launchers = [{ Id: 'search-launcher-target', Name: 'SEARCH_LAUNCHER_TARGET', Path: 'C:/test/sample.txt', GroupId: 'search-group-target' }]
    next.DesktopCategories = Array.from({ length: 12 }, (_, i) => ({ Id: `search-category-${i}`, Name: i === 11 ? 'SEARCH_CATEGORY_TARGET' : `分类 ${i}`, IsCollapsed: false, ItemPaths: [] }))
    await window.dustdesk.saveWorkspace(next, state)
  })

  await choose('SEARCH_NOTE_TARGET')
  await focused('note', 'search-note-target')
  assert.equal(await page.locator('.note-title').inputValue(), 'SEARCH_NOTE_TARGET')
  // Repeated navigation must clear the page's own filter without remounting or losing edits.
  await page.locator('.note-text').fill('Keep this changed note text')
  await page.getByPlaceholder('搜索便签').fill('First')
  await page.locator('.note-list-item').first().click()
  await choose('SEARCH_NOTE_TARGET', 'SEARCH_NOTE_TARGET', true)
  await focused('note', 'search-note-target')
  assert.equal(await page.getByPlaceholder('搜索便签').inputValue(), '')
  assert.equal(await page.locator('.note-text').inputValue(), 'Keep this changed note text')

  await choose('SEARCH_ARCHIVED_TASK')
  await focused('task', 'search-task-old')
  assert.equal(await page.locator('.segmented:visible .selected').innerText(), '全部')
  assert.equal(await page.locator('.task-editor').count(), 1)
  assert.match(await page.locator('.date-stepper').innerText(), /1月2日/)
  await page.getByRole('button', { name: '今天', exact: true }).click()
  await choose('SEARCH_ARCHIVED_TASK')
  await focused('task', 'search-task-old')

  // Creating from search while viewing a historical date must reveal today's task.
  await page.locator('#global-search').fill('todo SEARCH_CREATED_TASK')
  await page.locator('#global-search').press('Enter')
  await page.locator('.todo-row').filter({ hasText: 'SEARCH_CREATED_TASK' }).waitFor()
  assert.equal(await page.locator('.todo-row').filter({ hasText: 'SEARCH_ARCHIVED_TASK' }).count(), 0)

  await navigate('项目')
  await page.getByPlaceholder('添加子事项').fill('keep unsaved subtask draft')
  await choose('SEARCH_PROJECT_TARGET')
  await focused('project', 'search-project-target')
  assert.equal(await page.getByLabel('项目名称').inputValue(), 'SEARCH_PROJECT_TARGET')
  await choose('SEARCH_PHASE_TARGET')
  await focused('phase', 'search-phase-13')
  await choose('SEARCH_SUBTASK_TARGET')
  await focused('subtask', 'search-subtask-13')
  await page.locator('.project-row').filter({ hasText: 'First project' }).click()
  assert.equal(await page.getByPlaceholder('添加子事项').inputValue(), 'keep unsaved subtask draft')

  await choose('SEARCH_LINK_TARGET')
  await focused('link', 'search-link-target')
  assert.equal(await page.locator('.category-chip.selected').innerText(), 'SEARCH_GROUP\n2')
  assert.equal(await page.locator('.segmented:visible .selected').innerText(), '链接')
  await choose('SEARCH_LAUNCHER_TARGET')
  await focused('launcher', 'search-launcher-target')
  assert.equal(await page.locator('.segmented:visible .selected').innerText(), '启动器')
  await page.locator('.category-chip').first().click()
  await choose('SEARCH_LAUNCHER_TARGET')
  await focused('launcher', 'search-launcher-target')

  await choose('SEARCH_CATEGORY_TARGET')
  await focused('category', 'search-category-11')
  await page.getByRole('button', { name: '分类管理', exact: true }).click()
  assert.equal(await page.locator('.category-manager-row select').first().inputValue(), 'search-category-11')
  await page.getByRole('dialog', { name: '分类管理' }).getByRole('button', { name: '完成', exact: true }).click()
  await page.locator('#global-search').fill('unmatched query')
  await page.locator('#global-search').press('Escape')
  assert.equal(await page.locator('.search-popover').count(), 0)
  await page.locator('#global-search').fill('noteworthy-unmatched')
  await page.locator('#global-search').press('Enter')
  assert.equal(await page.locator('#global-search').inputValue(), 'noteworthy-unmatched')
  assert.equal((await page.evaluate(() => window.dustdesk.loadWorkspace())).Notes.length, 2)
  const localFile = path.join(app.tempRoot, 'LOCAL_FILE_ALPHA.txt')
  await writeFile(localFile, 'isolated search fixture')
  await page.evaluate(async root => {
    const state = await window.dustdesk.loadWorkspace(); const next = structuredClone(state)
    next.Settings.SearchCustomPaths = true; next.Settings.SearchCustomRoots = [root]
    await window.dustdesk.saveWorkspace(next, state)
  }, app.tempRoot)
  await page.locator('#global-search').fill('LOCAL_FILE_ALPHA')
  await page.locator('.search-popover').getByText('LOCAL_FILE_ALPHA.txt', { exact: true }).waitFor()
  await page.locator('#global-search').fill('ANOTHER_UNMATCHED_FILE')
  assert.equal(await page.locator('.search-popover').getByText('LOCAL_FILE_ALPHA.txt', { exact: true }).count(), 0, 'Changing the query must immediately hide the previous filesystem results')
  assert.deepEqual(errors, [])
  console.log('Search navigation: note/draft, repeated requests, task date/filter, project/phase/subtask, resource tab/category, organizer and keyboard passed')
} finally { await closeDustDesk(app) }
