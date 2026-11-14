import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { pointerDrag, keyboardPickup, keyboardMove } from './pointer-drag.mjs'

const report = 'artifacts/tauri-migration/internal-drag-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native WebView2 pointer and keyboard dragging preserves sidebar preferences and real organizer files', { timeout: 90000 }, async () => {
  const app = await launchTauri({ workspace: true })
  const page = app.page
  const evidence = []; const errors = []; let failed = false
  page.on('pageerror', error => errors.push(error.message))
  const state = () => page.evaluate(() => window.dustdesk.loadWorkspace())
  try {
    await page.getByRole('button', { name: '创建工作区', exact: true }).click()
    await page.locator('.app-shell').waitFor()
    await page.evaluate(async () => {
      const state = await window.dustdesk.loadWorkspace()
      const result = await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: false, ClipboardMonitoringEnabled: false } }, state)
      if (!result.ok) throw Error(result.error)
    })
    await page.locator('.sidebar').getByText('设置', { exact: true }).click()
    await pointerDrag(page.getByRole('button', { name: '拖动排序：概览', exact: true }), page.locator('[data-menu-id="projects"]'))
    await waitFor(async () => (await state()).Settings.SidebarOrder[0] === 'tasks')
    const taskHandle = page.getByRole('button', { name: '拖动排序：任务', exact: true })
    await keyboardPickup(taskHandle); await keyboardMove(taskHandle, 'ArrowDown'); await taskHandle.press('Space')
    await waitFor(async () => (await state()).Settings.SidebarOrder[0] === 'notes')
    const before = (await state()).Settings.SidebarOrder
    await keyboardPickup(taskHandle); await keyboardMove(taskHandle, 'ArrowDown'); await taskHandle.press('Escape')
    assert.deepEqual((await state()).Settings.SidebarOrder, before)
    await page.reload(); await page.locator('.app-shell').waitFor()
    assert.deepEqual((await state()).Settings.SidebarOrder, before)
    evidence.push('sidebar pointer commit, keyboard commit/cancel and reload persistence')
    const desktop = path.join(app.root, 'desktop')
    await mkdir(desktop, { recursive: true })
    const source = path.join(desktop, '拖动验证.txt'); await writeFile(source, '原始中文内容')
    await page.locator('.sidebar').getByText('桌面收纳', { exact: true }).click()
    const handle = page.getByRole('button', { name: '拖动收纳 拖动验证.txt', exact: true })
    await keyboardPickup(handle); await keyboardMove(handle, 'ArrowDown')
    await page.getByText('松开即可收纳', { exact: true }).waitFor(); await handle.press('Escape')
    assert.equal(await readFile(source, 'utf8'), '原始中文内容')
    assert.equal((await state()).DesktopCategories[0].ItemPaths.length, 0)
    evidence.push('organizer keyboard cancellation preserves original bytes and workspace')
    await pointerDrag(handle, page.locator('.organizer-categories .category-card > div').first())
    await waitFor(async () => (await state()).DesktopCategories[0].ItemPaths.length === 1)
    const destination = (await state()).DesktopCategories[0].ItemPaths[0]
    assert.equal(await readFile(destination, 'utf8'), '原始中文内容'); await assert.rejects(access(source), { code: 'ENOENT' })
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await waitFor(async () => (await state()).DesktopCategories[0].ItemPaths.length === 0)
    assert.equal(await readFile(source, 'utf8'), '原始中文内容'); await assert.rejects(access(destination), { code: 'ENOENT' })
    evidence.push('organizer pointer move and undo preserve real bytes and ownership')
    await keyboardPickup(handle); await keyboardMove(handle, 'ArrowDown')
    await page.getByText('松开即可收纳', { exact: true }).waitFor(); await handle.press('Space')
    await waitFor(async () => (await state()).DesktopCategories[0].ItemPaths.length === 1)
    assert.equal(await readFile((await state()).DesktopCategories[0].ItemPaths[0], 'utf8'), '原始中文内容')
    await page.getByRole('button', { name: '撤销', exact: true }).click()
    await waitFor(async () => (await state()).DesktopCategories[0].ItemPaths.length === 0)
    assert.equal(await readFile(source, 'utf8'), '原始中文内容')
    evidence.push('organizer keyboard move and undo use the same native transaction')
    assert.deepEqual(errors, [])
    await writeFile(report, JSON.stringify({ verified: true, productionReady: false, evidence, errors }, null, 2))
  } catch (error) {
    failed = true
    await writeFile(report, JSON.stringify({ verified: false, productionReady: false, evidence, errors, failure: String(error), root: app.root }, null, 2))
    throw error
  } finally { await app.close({ preserve: failed }) }
})
