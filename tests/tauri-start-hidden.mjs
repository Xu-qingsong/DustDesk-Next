import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import path from 'node:path'
import { chromium } from 'playwright'
import { launchTauri, waitFor } from './tauri-harness.mjs'

test('saved start-hidden preference keeps the main WebView closed until single-instance activation', async () => {
  const app = await launchTauri({application:true})
  let hidden, browser
  try {
    await app.page.locator('.app-shell').waitFor()
    assert.equal((await app.page.evaluate(async()=>{
      const state=await window.dustdesk.loadWorkspace()
      return window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,StartHiddenToTray:true}},state)
    })).ok,true)
    await app.invoke('application_quit').catch(()=>{})
    await waitFor(()=>app.child.exitCode!==null)
    assert.equal(app.child.exitCode,0)
    await app.close({preserve:true})
    const env={...process.env,DUSTDESK_TEST_USER_DATA_DIR:path.join(app.root,'user-data'),DUSTDESK_TAURI_DISABLE_HOTKEYS:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-address=127.0.0.1 --remote-debugging-port='+new URL(app.endpoint).port}
    hidden=spawn(app.executable,[],{env,windowsHide:true,stdio:'ignore'})
    await new Promise((resolve,reject)=>{hidden.once('spawn',resolve);hidden.once('error',reject)})
    await new Promise(resolve=>setTimeout(resolve,1500))
    assert.equal(hidden.exitCode,null)
    const query='$appId='+hidden.pid+'; @(Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq $appId} | Select-Object -ExpandProperty Name) | ConvertTo-Json -Compress'
    const names=JSON.parse(execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',query],{windowsHide:true,encoding:'utf8'}).trim()||'[]')
    assert.ok(![].concat(names).some(name=>/msedgewebview2/i.test(name)),JSON.stringify(names))
    const activate=spawn(app.executable,['--workspace'],{env,windowsHide:true,stdio:'ignore'})
    await waitFor(()=>activate.exitCode!==null)
    assert.equal(activate.exitCode,0)
    await waitFor(async()=>{try{return (await fetch(app.endpoint+'/json/version',{signal:AbortSignal.timeout(1000)})).ok}catch{return false}})
    browser=await chromium.connectOverCDP(app.endpoint)
    const page=await waitFor(()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    await page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')).catch(()=>{})
    await waitFor(()=>hidden.exitCode!==null)
    assert.equal(hidden.exitCode,0)
  } finally {
    await browser?.close().catch(()=>{})
    if(hidden?.pid&&hidden.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(hidden.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}}
    await app.close()
  }
})
