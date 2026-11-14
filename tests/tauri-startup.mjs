import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {spawn,execFile,execFileSync} from 'node:child_process'
import {promisify} from 'node:util'
import {createServer} from 'node:net'
import path from 'node:path'
import {chromium} from 'playwright'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const run=promisify(execFile)
const entry='DustDesk'
const report='artifacts/tauri-migration/startup-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('native autorun settings use isolated registry values and restart hidden into the shared workspace',async suite=>{
  const app=await launchTauri();const scenarios=[];const evidence={};let failed=false;let hidden;let hiddenBrowser
  const userData=path.join(app.root,'user-data');const hash=createHash('sha256').update(userData).digest('hex')
  const registry=async(action='inspect',pid=0)=>JSON.parse((await run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File','tests/tauri-startup-registry.ps1','-KeyHash',hash,'-Action',action,'-AppProcessId',String(pid)],{windowsHide:true,timeout:30000})).stdout.trim())
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Startup scenario failed: '+name)}
  try{
    const before=await registry();evidence.productionBefore=before.ProductionPreviewValue
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.StartWithWindows=false;initial.DesktopCategories=[]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const command='"'+app.executable+'" --workspace --hidden'
    await scenario('reading absent autorun does not create a key and preserves Electron boolean/void contract',async()=>{
      assert.equal(before.Exists,false);assert.equal(await api('getStartupEnabled'),await electron.invoke('startup:get'));assert.equal((await registry()).Exists,false)
      let legacyEnabled=false;electron.electron.app.getLoginItemSettings=()=>({openAtLogin:legacyEnabled});electron.electron.app.setLoginItemSettings=options=>{legacyEnabled=options.openAtLogin;assert.deepEqual(options.args,['--hidden'])}
      assert.equal(await electron.invoke('startup:set',true),undefined);assert.equal(await electron.invoke('startup:get'),true)
      assert.equal(await api('setStartupEnabled',true),undefined);assert.equal(await api('getStartupEnabled'),true)
    })
    await scenario('trusted executable is quoted with fixed workspace/hidden args and only its own registry value changes',async()=>{
      await registry('seed-other');await api('setStartupEnabled',true)
      let values=(await registry()).Values;assert.equal(values[entry].Kind,'String');assert.equal(values[entry].Value,command);assert.equal(values.UnrelatedApp.Value,'leave-this-alone')
      await api('setStartupEnabled',true);assert.equal((await registry()).Values[entry].Value,command)
      await api('setStartupEnabled',false);await api('setStartupEnabled',false);assert.equal(await api('getStartupEnabled'),false)
      values=(await registry()).Values;assert.equal(values[entry],undefined);assert.equal(values.UnrelatedApp.Value,'leave-this-alone')
      evidence.command=command
    })
    await scenario('foreign and invalid registry entries are not mistaken for this executable and invalid renderer types/roles are denied',async()=>{
      await registry('seed-foreign');assert.equal(await api('getStartupEnabled'),false);assert.equal((await registry()).Values[entry].Value,'"C:\\Other App\\Other.exe" --not-dustdesk')
      await api('setStartupEnabled',false);assert.equal((await registry()).Values[entry],undefined)
      await registry('seed-type');await assert.rejects(api('getStartupEnabled'),/类型/);assert.equal((await registry()).Values[entry].Kind,'DWord')
      await api('setStartupEnabled',true);assert.equal(await api('getStartupEnabled'),true);assert.equal((await registry()).Values.UnrelatedApp.Value,'leave-this-alone')
      await assert.rejects(app.invoke('system_startup',{enabled:true}),/not allowed|权限|denied/i)
      for(const enabled of ['true',{},1])await assert.rejects(app.invoke('system_startup',{enabled},page),/invalid|bool|类型/i)
      await app.invoke('system_startup',{enabled:true,key:'Software\\Microsoft\\Windows\\CurrentVersion\\Run',command:'ignored-injected-executable'},page)
      assert.equal((await registry()).Values[entry].Value,command)
    })
    await scenario('shared settings use OS state, guard duplicate clicks and persist the successful checkbox without replacing Lucide',async()=>{
      assert.equal((await api('loadWorkspace')).Settings.StartWithWindows,false);assert.equal(await api('getStartupEnabled'),true)
      await page.getByRole('button',{name:'设置',exact:true}).click();const toggle=page.getByRole('switch',{name:'开机启动',exact:true})
      await waitFor(async()=>await toggle.isEnabled()&&await toggle.getAttribute('aria-checked')==='true')
      await toggle.evaluate(button=>{button.click();button.click()})
      await waitFor(async()=>await toggle.isEnabled()&&await toggle.getAttribute('aria-checked')==='false')
      assert.equal(await api('getStartupEnabled'),false);await waitFor(async()=>!(await api('loadWorkspace')).Settings.StartWithWindows)
      await toggle.click();await waitFor(async()=>await toggle.isEnabled()&&await toggle.getAttribute('aria-checked')==='true')
      await waitFor(async()=>(await api('loadWorkspace')).Settings.StartWithWindows)
      await page.reload();await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'设置',exact:true}).click()
      await waitFor(async()=>await toggle.isEnabled()&&await toggle.getAttribute('aria-checked')==='true')
      await page.locator('#startup-setting-status').evaluate(element=>element.closest('.settings-section').scrollIntoView({block:'center',behavior:'instant'}))
      await page.getByText('无法读取小组件状态，请重试',{exact:true}).waitFor({state:'hidden',timeout:10000})
      await page.screenshot({path:'artifacts/tauri-migration/startup-shared-native.png',fullPage:true})
    })
    await scenario('controlled adapter set failure is caught without flipping the switch or causing an unhandled rejection',async()=>{
      const toggle=page.getByRole('switch',{name:'开机启动',exact:true})
      await page.evaluate(()=>{window.__startupOriginal=window.dustdesk.setStartupEnabled;window.dustdesk.setStartupEnabled=async()=>{throw Error('controlled startup failure')}})
      try{await toggle.click();await page.getByText(/设置开机启动失败：.*controlled startup failure/).waitFor();assert.equal(await toggle.getAttribute('aria-checked'),'true');assert.equal(await toggle.isEnabled(),true);assert.equal(await api('getStartupEnabled'),true)}
      finally{await page.evaluate(()=>{window.dustdesk.setStartupEnabled=window.__startupOriginal;delete window.__startupOriginal})}
      evidence.uiFailure='controlled adapter rejection, not a Windows ACL failure'
    })
    await scenario('actual denied registry writes propagate to the shared UI and recover after restoring only the isolated key ACL',async()=>{
      await registry('deny-write')
      try{
        await assert.rejects(api('setStartupEnabled',false),/开机启动.*失败/)
        assert.equal(await api('getStartupEnabled'),true)
        const toggle=page.getByRole('switch',{name:'开机启动',exact:true});await toggle.click()
        await page.getByText(/设置开机启动失败：.*打开开机启动设置失败/).waitFor()
        assert.equal(await toggle.getAttribute('aria-checked'),'true');assert.equal(await toggle.isEnabled(),true)
        assert.equal((await registry()).Values[entry].Value,command)
      }finally{await registry('allow-write')}
      await api('setStartupEnabled',false);assert.equal(await api('getStartupEnabled'),false);await api('setStartupEnabled',true)
      evidence.nativeWriteFailure='real SetValue deny on the hashed test Run subkey; exact deny rule removed in finally and cleanup'
    })
    await scenario('backup restoration does not silently enable or disable a Windows login item',async()=>{
      await page.getByRole('button',{name:'概览',exact:true}).click()
      const state=await api('loadWorkspace');state.Settings.StartWithWindows=false;assert.equal((await api('saveWorkspace',state)).ok,true)
      const backup=await api('createBackup');assert.equal(backup.ok,true);const preview=await api('previewBackup',backup.path)
      assert.equal((await api('restoreBackup',backup.path,preview.fingerprint)).ok,true);assert.equal(await api('getStartupEnabled'),true)
      assert.equal((await api('loadWorkspace')).Settings.StartWithWindows,false)
    })
    await scenario('a real invalid registry type disables an unknown-state switch and recovers after correcting the isolated entry',async()=>{
      await registry('seed-type')
      try{
        await page.getByRole('button',{name:'设置',exact:true}).click()
        await page.getByText('读取开机启动设置失败',{exact:true}).waitFor()
        await page.getByText('暂时无法读取开机启动状态，请重新打开设置重试。',{exact:true}).waitFor()
        const toggle=page.getByRole('switch',{name:'开机启动',exact:true});assert.equal(await toggle.isEnabled(),false);assert.equal(await toggle.getAttribute('aria-busy'),'false')
        assert.equal((await registry()).Values[entry].Kind,'DWord')
      }finally{await api('setStartupEnabled',true)}
      await page.getByRole('button',{name:'概览',exact:true}).click();await page.getByRole('button',{name:'设置',exact:true}).click()
      const toggle=page.getByRole('switch',{name:'开机启动',exact:true});await waitFor(async()=>await toggle.isEnabled()&&await toggle.getAttribute('aria-checked')==='true')
      await page.getByRole('button',{name:'概览',exact:true}).click()
    })
    await scenario('quit rejects new native autorun changes and resumes after a veto without mutating registry',async()=>{
      await page.evaluate(()=>{window.__startupQuitRemove=window.dustdesk.onBeforeQuit(async()=>{try{await window.__TAURI_INTERNALS__.invoke('system_startup',{enabled:false});window.__startupQuit='unexpected success'}catch(error){window.__startupQuit=String(error)}throw Error('startup quit veto')})})
      await assert.rejects(app.invoke('application_quit',{},page),/startup quit veto/);assert.match(await page.evaluate(()=>window.__startupQuit),/退出/)
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));await page.evaluate(()=>window.__startupQuitRemove());assert.equal(await api('getStartupEnabled'),true)
      assert.deepEqual(errors,[])
    })
    await scenario('stored startup flags launch without WebViews, retain state across a process restart and reopen only the shared workspace',async()=>{
      await app.close({preserve:true})
      const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve))
      const env={...process.env,DUSTDESK_TEST_USER_DATA_DIR:userData,DUSTDESK_TEST_DATA_DIR:path.join(app.root,'data'),DUSTDESK_TEST_DESKTOP_DIR:path.join(app.root,'desktop'),DUSTDESK_TAURI_DISABLE_HOTKEYS:'1',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port+' --remote-debugging-address=127.0.0.1 --no-first-run'}
      hidden=spawn(app.executable,['--workspace','--hidden'],{env,windowsHide:true,stdio:'ignore'});await new Promise((resolve,reject)=>{hidden.once('spawn',resolve);hidden.once('error',reject)})
      await new Promise(resolve=>setTimeout(resolve,2000));assert.equal(hidden.exitCode,null)
      const tree=(await registry('inspect',hidden.pid)).Processes;assert.ok(tree.some(item=>item.ProcessId===hidden.pid));assert.ok(tree.every(item=>item.ProcessId===hidden.pid||item.Name.toLowerCase()==='conhost.exe'),'hidden autorun must not create a WebView')
      evidence.hiddenProcesses=tree
      await run(app.executable,['--workspace'],{env,windowsHide:true,timeout:15000})
      const endpoint='http://127.0.0.1:'+port;await waitFor(async()=>{try{return(await fetch(endpoint+'/json/version',{signal:AbortSignal.timeout(1000)})).ok}catch{return false}})
      hiddenBrowser=await chromium.connectOverCDP(endpoint)
      const reopened=await waitFor(()=>hiddenBrowser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await reopened.locator('.app-shell').waitFor()
      assert.equal(hiddenBrowser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('prototype.html')).length,0)
      assert.equal(await reopened.evaluate(()=>window.dustdesk.getStartupEnabled()),true)
      const quitting=reopened.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')).catch(error=>{if(hidden.exitCode===null)throw error})
      await waitFor(()=>hidden.exitCode!==null);await quitting;assert.equal(hidden.exitCode,0)
      evidence.productionAfter=(await registry()).ProductionPreviewValue;assert.deepEqual(evidence.productionAfter,evidence.productionBefore)
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-per-user-autorun-preview',scenarios,evidence,pending:['actual-Windows-login','Task-Manager-StartupApproved-state','installer-path-migration','formal-Run-entry-takeover-and-rollback','StartHiddenToTray-setting-and-all-background-services','release-package-verification']},null,2))
  }finally{
    await hiddenBrowser?.close().catch(()=>{})
    if(hidden?.pid&&hidden.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(hidden.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{};await waitFor(()=>hidden.exitCode!==null)}
    try{await registry('cleanup')}finally{await app.close()}
  }
})
