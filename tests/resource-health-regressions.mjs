import assert from 'node:assert/strict'
import { mkdir, writeFile, readFile, symlink } from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
const requests = []
const server = http.createServer((request, response) => {
  requests.push(request.url)
  if (request.url !== '/slow') { response.writeHead(200); response.end('ok') }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const url = `http://127.0.0.1:${server.address().port}`
const load = () => app.window.evaluate(() => window.dustdesk.loadWorkspace())
const action = value => app.window.evaluate(value => window.dustdesk.productivity(value), value)
const navigate = title => app.window.locator('.sidebar').getByText(title, { exact: true }).click()
async function until(predicate, message) {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 40)) }
  throw new Error(message)
}
try {
  const root = path.join(app.tempRoot, 'data', 'DesktopOrganizer')
  const work = path.join(root, '工作'); const dev = path.join(root, '开发')
  const desktop = path.join(app.tempRoot, 'desktop')
  await Promise.all([mkdir(work, { recursive: true }), mkdir(dev, { recursive: true }), mkdir(desktop, { recursive: true })])
  const own = path.join(work, 'replacement.txt'); const duplicate = path.join(work, 'owned.txt'); const other = path.join(dev, 'other.txt'); const missing = path.join(work, 'missing.txt')
  await Promise.all([writeFile(own, 'recover me'), writeFile(duplicate, 'owned'), writeFile(other, 'other')])
  await app.window.evaluate(async ({ url, missing, duplicate, other }) => {
    const state = await window.dustdesk.loadWorkspace(); const next = structuredClone(state)
    next.Settings.ClipboardMonitoringEnabled = false
    next.Settings.AutomaticBackupEnabled = false
    next.Projects = []; next.Launchers = [{ Id: 'missing', Name: 'Missing app', Path: missing }]
    next.DesktopCategories = [{ Id: 'work', Name: '工作', ItemPaths: [missing, duplicate] }, { Id: 'dev', Name: '开发', ItemPaths: [other] }]
    next.LinkGroups = [{ Id: 'test', Name: 'Local test', Links: [{ Id: 'ok', Name: 'Fast link', Url: `${url}/ok`, Note: '', CreatedAt: '', UpdatedAt: '' }, { Id: 'slow', Name: 'Slow link', Url: `${url}/slow`, Note: '', CreatedAt: '', UpdatedAt: '' }] }]
    await window.dustdesk.saveWorkspace(next, state)
  }, { url, missing, duplicate, other })

  await navigate('专注计时')
  await app.window.getByLabel('专注分钟').fill('1.01')
  assert.equal(await app.window.getByRole('timer').innerText(), '01:01')
  await app.window.getByRole('button', { name: '开始专注', exact: true }).click()
  await until(async () => (await load()).ActiveFocus?.PlannedSeconds === 61, 'fractional focus did not round to seconds')
  await action({ type: 'focus-cancel' })
  await app.window.getByLabel('专注分钟').fill('-1')
  assert.equal(await app.window.getByRole('timer').innerText(), '00:00')
  assert.equal(await app.window.getByRole('button', { name: '开始专注', exact: true }).isDisabled(), true)
  for (const minutes of [NaN, Infinity, -1, 0, 180.1]) assert.equal((await action({ type: 'focus-start', taskId: '', projectId: '', minutes })).ok, false)
  console.log('Fractional focus preview, actual duration and invalid input passed')

  const linkResource = { kind: 'link', id: 'ok', parentId: 'test', name: 'Fast link', target: `${url}/ok`, status: 'ok', detail: '' }
  for (const replacement of ['http:example.com', 'https:/example.com', 'www.example.com']) {
    assert.equal((await action({ type: 'resource-relink', resource: linkResource, replacement })).ok, false)
    assert.equal((await app.window.evaluate(value => window.dustdesk.openUrl(value), replacement)).ok, false)
  }
  assert.equal((await load()).LinkGroups[0].Links[0].Url, `${url}/ok`)

  const resource = { kind: 'organizer', id: missing, parentId: 'work', name: '工作', target: missing, status: 'missing', detail: '' }
  for (const replacement of [other, duplicate, work]) {
    const response = await action({ type: 'resource-relink', resource, replacement })
    assert.equal(response.ok, false, `unsafe relink unexpectedly accepted: ${replacement}`)
  }
  const junction = path.join(work, 'redirected')
  await symlink(dev, junction, 'junction')
  assert.equal((await action({ type: 'resource-relink', resource, replacement: path.join(junction, 'other.txt') })).ok, false)
  assert.deepEqual((await load()).DesktopCategories[0].ItemPaths, [missing, duplicate])
  assert.equal((await action({ type: 'resource-relink', resource, replacement: own })).ok, true)
  assert.equal((await app.window.evaluate(({ own }) => window.dustdesk.restoreToDesktop('work', own), { own })).ok, true)
  assert.equal(await readFile(path.join(desktop, 'replacement.txt'), 'utf8'), 'recover me')
  assert.equal(await readFile(other, 'utf8'), 'other')
  console.log('Organizer relink rejects cross-category, duplicate, root and junction; valid relink restores passed')

  await navigate('资源检查')
  await app.window.getByRole('button', { name: '开始检查', exact: true }).click()
  await until(() => requests.includes('/slow'), 'slow resource was not requested')
  await until(async () => Number(await app.window.getByRole('progressbar').getAttribute('value')) >= 1, 'incremental progress missing')
  const cancelledAt = Date.now()
  await app.window.getByRole('button', { name: '取消检查', exact: true }).click()
  await app.window.getByRole('button', { name: '开始检查', exact: true }).waitFor()
  assert.ok(Date.now() - cancelledAt < 2500, 'cancellation waited for network timeout')
  assert.match(await app.window.locator('.resource-progress').innerText(), /已取消/)
  assert.ok(await app.window.locator('.feature-row').filter({ hasText: 'Missing app' }).count(), 'completed results lost on cancellation')

  await app.window.evaluate(async ({ url }) => {
    const state = await window.dustdesk.loadWorkspace(); const next = structuredClone(state)
    next.LinkGroups[0].Links.find(item => item.Id === 'slow').Url = `${url}/ok2`
    await window.dustdesk.saveWorkspace(next, state)
  }, { url })
  await app.window.getByRole('button', { name: '开始检查', exact: true }).click()
  await app.window.getByRole('button', { name: '开始检查', exact: true }).waitFor()
  const networkBefore = requests.length
  const row = app.window.locator('.feature-row').filter({ hasText: 'Missing app' })
  await row.getByRole('button', { name: '重新检查', exact: true }).click()
  await app.window.getByRole('button', { name: '开始检查', exact: true }).waitFor()
  assert.equal(requests.length, networkBefore, 'single path retry rescanned network URLs')
  await row.getByRole('button', { name: '重新关联', exact: true }).click()
  await app.window.getByLabel('新的资源地址').fill(duplicate)
  await app.window.getByRole('button', { name: '保存关联', exact: true }).click()
  await until(async () => (await load()).Launchers[0].Path === duplicate, 'relink not saved')
  await app.window.getByRole('button', { name: '开始检查', exact: true }).waitFor()
  assert.equal(requests.length, networkBefore, 'relink rescanned network URLs')
  await app.window.getByLabel('显示全部').check()
  assert.match(await row.innerText(), /路径可用/)
  console.log('Resource incremental progress, immediate cancellation, per-item retry and relink-only checks passed')

  // Two overlapping generations and another window cannot cancel or corrupt the current scan.
  await app.window.evaluate(async ({ url }) => {
    const state = await window.dustdesk.loadWorkspace(); const next = structuredClone(state)
    next.LinkGroups[0].Links.find(item => item.Id === 'slow').Url = `${url}/slow`
    await window.dustdesk.saveWorkspace(next, state)
    window.scanEvents = []
    window.stopScanEvents = window.dustdesk.onResourceCheckProgress(progress => window.scanEvents.push(progress))
    window.firstScanDone = false
    window.firstScan = window.dustdesk.checkResources({ requestId: 'first' }).then(result => { window.firstScanDone = true; return result })
  }, { url })
  await until(() => requests.filter(value => value === '/slow').length >= 2, 'first generation did not start')
  const capturePromise = app.electronApp.waitForEvent('window')
  await app.window.evaluate(() => window.dustdesk.showQuickCapture())
  const capture = await capturePromise
  await capture.getByLabel('记录标题').waitFor()
  await capture.evaluate(() => window.dustdesk.cancelResourceCheck('first'))
  assert.equal(await app.window.evaluate(() => window.firstScanDone), false, 'another window cancelled a scan it did not own')
  await app.window.evaluate(() => window.dustdesk.hideQuickCapture())
  const missingResource = await app.window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    return { kind: 'launcher', id: state.Launchers[0].Id, name: state.Launchers[0].Name, target: state.Launchers[0].Path, status: 'ok', detail: '' }
  })
  const second = await app.window.evaluate(resource => window.dustdesk.checkResources({ requestId: 'second', resource }), missingResource)
  assert.equal(second.length, 1)
  const first = await app.window.evaluate(() => window.firstScan)
  assert.equal(first.some(item => item.id === 'slow'), false)
  const seen = await app.window.evaluate(() => { window.stopScanEvents(); return window.scanEvents })
  const secondStart = seen.findIndex(item => item.requestId === 'second')
  assert.ok(secondStart >= 0)
  assert.equal(seen.slice(secondStart).some(item => item.requestId === 'first'), false)
  console.log('Overlapping scan generations keep separate results and progress passed')
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  await closeDustDesk(app)
}
