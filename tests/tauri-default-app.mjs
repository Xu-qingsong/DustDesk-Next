import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launchTauri, waitFor } from './tauri-harness.mjs'

const { version } = JSON.parse(await readFile('package.json','utf8'))

test('default executable opens the existing application, saves edits and reopens without Electron', async () => {
  let app = await launchTauri({ application: true })
  const root = app.root
  const location = path.join(root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')
  try {
    const page = app.page
    await page.locator('.app-shell').waitFor()
    assert.equal(await page.locator('.brand span').innerText(), 'v'+version)
    await page.keyboard.press('Alt')
    const native = JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File','tests/tauri-main-window.ps1','-ProcessId',String(app.child.pid)],{encoding:'utf8',windowsHide:true}))
    assert.equal(native.visible,true)
    assert.equal(native.hasMenu,false)
    execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File','tests/tauri-main-window.ps1','-ProcessId',String(app.child.pid),'-Action','minimize'],{windowsHide:true})
    execFileSync(app.executable,[],{windowsHide:true,timeout:10000,stdio:'ignore',env:{...process.env,DUSTDESK_TEST_USER_DATA_DIR:path.join(root,'user-data'),DUSTDESK_TAURI_DISABLE_HOTKEYS:'1'}})
    await waitFor(()=>{
      const reopened=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-File','tests/tauri-main-window.ps1','-ProcessId',String(app.child.pid)],{encoding:'utf8',windowsHide:true}))
      return reopened.visible&&!reopened.minimized
    })
    assert.ok(app.browser.contexts().flatMap(context => context.pages()).every(p => !p.url().includes('prototype.html')))
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined')
    assert.equal(await page.evaluate(() => typeof window.process), 'undefined')
    await assert.rejects(app.invoke('prototype_diagnostics'), /not allowed|权限/i)
    await page.getByPlaceholder('添加一项任务...').fill('默认 Tauri 应用保存任务')
    await page.getByPlaceholder('添加一项任务...').press('Enter')
    await waitFor(async () => JSON.parse(await readFile(location, 'utf8')).Todos.some(item => item.Title === '默认 Tauri 应用保存任务'))
    assert.equal((await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo',true))).ok,true)
    const widget = await waitFor(() => app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')))
    await widget.getByLabel('桌面新增任务').waitFor()
    await waitFor(async()=> (await widget.locator('body').innerText()).includes('默认 Tauri 应用保存任务'))
    assert.equal((await page.evaluate(() => window.dustdesk.hideWidget('todo'))).ok,true)
    await page.getByPlaceholder('把刚刚想到的事记下来...').fill('退出前尚未防抖的记录 🪶')
    await app.invoke('application_quit').catch(() => {})
    await waitFor(() => app.child.exitCode !== null)
    assert.equal(app.child.exitCode, 0, app.output())
    assert.equal(JSON.parse(await readFile(location, 'utf8')).QuickNote, '退出前尚未防抖的记录 🪶')
    await app.close({ preserve: true })
    app = await launchTauri({ application: true, rootDirectory: root })
    await app.page.locator('.app-shell').waitFor()
    assert.equal(await app.page.getByPlaceholder('把刚刚想到的事记下来...').inputValue(), '退出前尚未防抖的记录 🪶')
    assert.ok((await app.page.evaluate(() => window.dustdesk.loadWorkspace())).Todos.some(item => item.Title === '默认 Tauri 应用保存任务'))
    await app.invoke('application_quit').catch(() => {})
    await waitFor(() => app.child.exitCode !== null)
    assert.equal(app.child.exitCode, 0, app.output())
  } finally { await app.close() }
})
