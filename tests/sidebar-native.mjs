import assert from 'node:assert/strict'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'

let running = await launchDustDesk()
try {
  const page = running.window, root = running.tempRoot
  assert.equal(await page.locator('.workspace-chip').count(), 0)
  for (const label of ['文本工具箱','图片工具箱','局域网传输']) assert.equal(await page.locator('.sidebar').getByText(label, { exact: true }).count(), 0)
  await page.locator('.sidebar').getByText('设置', { exact: true }).click()
  for (const label of ['文本工具箱','图片工具箱','局域网传输']) await page.getByRole('switch', { name: `显示菜单：${label}`, exact: true }).click()
  await page.waitForFunction(async () => (await window.dustdesk.loadWorkspace()).Settings.SidebarHidden.length === 0)
  await page.getByRole('button', { name: '上移：便签', exact: true }).click()
  await page.waitForFunction(async () => (await window.dustdesk.loadWorkspace()).Settings.SidebarOrder[1] === 'notes')
  await page.getByRole('switch', { name: '显示菜单：概览', exact: true }).click()
  await page.waitForFunction(async () => (await window.dustdesk.loadWorkspace()).Settings.SidebarHidden.includes('overview'))
  await closeDustDesk({ ...running, preserveTempRoot: true })
  running = await launchDustDesk({ tempRoot: root })
  await running.window.getByRole('heading', { name: '便签', exact: true }).waitFor()
  assert.equal(await running.window.locator('.sidebar').getByText('概览', { exact: true }).count(), 0)
  assert.deepEqual((await running.window.locator('.nav-list .nav-item > span').allTextContents()).slice(-3), ['文本工具箱','图片工具箱','局域网传输'])
  await running.window.locator('.sidebar').getByText('设置', { exact: true }).click()
  await running.window.getByRole('button', { name: '恢复默认', exact: true }).click()
  await running.window.waitForFunction(async () => (await window.dustdesk.loadWorkspace()).Settings.SidebarHidden.length === 3)
  for (const label of ['文本工具箱','图片工具箱','局域网传输']) assert.equal(await running.window.locator('.sidebar').getByText(label, { exact: true }).count(), 0)
  assert.equal((await running.window.locator('.nav-list .nav-item > span').allTextContents())[0], '概览')
  console.log(JSON.stringify({ toolsHiddenByDefault: true, placeholderRemoved: true, sorting: true, hiding: true, restartPersistence: true, reset: true }))
} finally { await closeDustDesk(running) }
