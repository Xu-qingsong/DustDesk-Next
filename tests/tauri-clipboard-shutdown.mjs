import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm,rmdir} from 'node:fs/promises'
import {spawn,execFileSync} from 'node:child_process'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {clipboardFixture,holdClipboard} from './tauri-clipboard-support.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const report='artifacts/tauri-migration/clipboard-shutdown-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('normal quit drains accepted clipboard candidates before exit and failed persistence resumes the same pending record',async suite=>{
  const guard=await clipboardFixture();let app;let unlock;let delayed;const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Clipboard shutdown scenario failed: '+name)}
  try{
    await guard.request('set-text',{text:'shutdown-initial'})
    app=await launchTauri({clipboardMonitoring:true})
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.DesktopCategories=[];initial.ClipboardHistory=[]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    let page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const workspace=path.join(app.root,'user-data','tauri-preview','Workspace');const location=path.join(workspace,'workspace.json')
    const disk=async()=>JSON.parse(await readFile(location,'utf8'))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const settings=async enabled=>{const state=await api('loadWorkspace');state.Settings.ClipboardMonitoringEnabled=enabled;assert.equal((await api('saveWorkspace',state)).ok,true)}
    const block=async()=>{await rm(location+'.bak',{force:true});await mkdir(location+'.bak')}
    const accept=async(action,args={})=>{const offset=app.output().length;await guard.request(action,args);await waitFor(()=>app.output().slice(offset).includes('保存剪贴板历史失败'))}
    const hold=async(draft='')=>page.evaluate(draft=>{window.__quitEntered=false;window.__quitRemove=window.dustdesk.onBeforeQuit(async()=>{window.__quitEntered=true;await new Promise(resolve=>window.__quitRelease=resolve);if(draft){const state=await window.dustdesk.loadWorkspace();state.QuickNote=draft;const result=await window.dustdesk.saveWorkspace(state);if(!result.ok)throw Error(result.error)}})},draft)
    const quit=()=>app.invoke('application_quit',{},page).then(()=>({ok:true}),error=>({ok:false,error:String(error)}))
    const exited=async request=>{await waitFor(()=>app.child.exitCode!==null,20000);const result=await request;if(!result.ok)assert.match(result.error,/closed|destroyed|disconnected/i);assert.equal(app.child.exitCode,0)}
    const reopen=async()=>{await app.close({preserve:true});app=await launchTauri({workspace:true,rootDirectory:app.root,clipboardMonitoring:true});page=app.page;await page.locator('.app-shell').waitFor();await delay(400)}
    await settings(true);await waitFor(async()=>(await disk()).ClipboardHistory.some(item=>item.Text==='shutdown-initial'));await delay(250)
    await scenario('successful quit saves the accepted text and renderer draft even when the system clipboard changes during the handshake',async()=>{
      await block();await accept('set-text',{text:'accepted before normal quit'});const boundary=Date.now();await hold('draft saved before clipboard drain')
      const request=quit();await waitFor(()=>page.evaluate(()=>window.__quitEntered));await guard.request('set-text',{text:'new copy while shutdown is paused'});await rmdir(location+'.bak');await page.evaluate(()=>window.__quitRelease());await exited(request)
      const state=await disk();const record=state.ClipboardHistory.find(item=>item.Text==='accepted before normal quit');assert.ok(record,'Accepted pre-quit clipboard candidate must be durable before exit');assert.ok(Date.parse(record.CreatedAt)<=boundary);assert.equal(state.QuickNote,'draft saved before clipboard drain');assert.ok(!state.ClipboardHistory.some(item=>item.Text==='new copy while shutdown is paused'))
      evidence.frozenText={id:record.Id,createdAt:record.CreatedAt};await reopen()
    })
    await scenario('failed candidate storage vetoes quit and retries the original accepted record without rereading an occupied clipboard',async()=>{
      await block();await accept('set-text',{text:'candidate retained after failed quit'});const boundary=Date.now();await hold();const before=await readFile(location)
      const request=quit();await waitFor(()=>page.evaluate(()=>window.__quitEntered));unlock=await holdClipboard();await page.evaluate(()=>window.__quitRelease());const result=await request;assert.equal(result.ok,false);assert.match(result.error,/剪贴板.*取消退出/);assert.equal(app.child.exitCode,null);await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));assert.deepEqual(await readFile(location),before)
      await rmdir(location+'.bak');const record=await waitFor(async()=>(await disk()).ClipboardHistory.find(item=>item.Text==='candidate retained after failed quit'),6000);assert.ok(Date.parse(record.CreatedAt)<=boundary);assert.equal((await disk()).ClipboardHistory.filter(item=>item.Id===record.Id).length,1);await unlock();unlock=undefined;await page.evaluate(()=>window.__quitRemove());evidence.failedQuitRetained={id:record.Id,createdAt:record.CreatedAt,clipboardOccupiedDuringRetry:true}
    })
    await scenario('a restore overlapping quit invalidates the frozen candidate instead of adding old clipboard data to restored history',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true);const preview=await api('previewBackup',backup.path)
      await block();await accept('set-text',{text:'frozen candidate invalidated by restore'});await hold();const request=quit();await waitFor(()=>page.evaluate(()=>window.__quitEntered));await rmdir(location+'.bak')
      const restored=await app.invoke('workspace_backup_restore',{path:backup.path,fingerprint:preview.fingerprint},page);assert.equal(restored.result.ok,true);await guard.request('clear');await page.evaluate(()=>window.__quitRelease());await exited(request)
      assert.ok(!(await disk()).ClipboardHistory.some(item=>item.Text==='frozen candidate invalidated by restore'));await reopen();assert.ok(!(await disk()).ClipboardHistory.some(item=>item.Text==='frozen candidate invalidated by restore'));evidence.restoreInvalidatesFrozenCandidate=true
    })
    await scenario('explicitly disabling monitoring during a quit flush discards the frozen sample and remains disabled on restart',async()=>{
      await block();await accept('set-text',{text:'frozen candidate invalidated by opt-out'});await hold();const request=quit();await waitFor(()=>page.evaluate(()=>window.__quitEntered));await rmdir(location+'.bak');await settings(false);await page.evaluate(()=>window.__quitRelease());await exited(request)
      const state=await disk();assert.equal(state.Settings.ClipboardMonitoringEnabled,false);assert.ok(!state.ClipboardHistory.some(item=>item.Text==='frozen candidate invalidated by opt-out'));await reopen();await guard.request('clear');await settings(true);evidence.explicitOptOutDiscardsFrozenCandidate=true
    })
    await scenario('accepted image bytes become a durable asset before normal exit and remain readable after process restart',async()=>{
      await block();await accept('set-bitmap');const boundary=Date.now();await hold();const request=quit();await waitFor(()=>page.evaluate(()=>window.__quitEntered));await guard.request('clear');await rmdir(location+'.bak');await page.evaluate(()=>window.__quitRelease());await exited(request)
      const record=(await disk()).ClipboardHistory.find(item=>item.Kind==='Image');assert.ok(record);assert.ok(Date.parse(record.CreatedAt)<=boundary);assert.equal(record.ImagePngBase64,'');assert.match(record.ImageAssetName,/^[a-f0-9]{64}.png$/);const bytes=await readFile(path.join(workspace,'ClipboardImages',record.ImageAssetName));assert.ok(bytes.length>0);await reopen();assert.ok((await api('loadWorkspace')).ClipboardHistory.some(item=>item.Id===record.Id));assert.equal((await api('previewClipboardImage',record.Id,false)).ok,true);evidence.image={id:record.Id,asset:record.ImageAssetName,bytes:bytes.length}
    })
    await scenario('a real delayed-rendering reader cancels quit on deadline without being detached, then completes safely after the owner releases it',async()=>{
      let output='';let errors='';delayed=spawn('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-File',path.resolve('tests/tauri-clipboard-delayed.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']});delayed.stdout.on('data',bytes=>output+=bytes);delayed.stderr.on('data',bytes=>errors+=bytes)
      delayed.stdin.on('error',error=>errors+=String(error));delayed.on('error',error=>errors+=String(error))
      await waitFor(()=>{if(delayed.exitCode!==null)throw Error(errors||output);return output.includes('rendering')},15000)
      const before=await readFile(location);const started=Date.now();const result=await quit();const elapsed=Date.now()-started;assert.equal(result.ok,false);assert.match(result.error,/等待剪贴板后台任务完成超时.*取消退出/);assert.ok(elapsed>=9000&&elapsed<20000);assert.equal(app.child.exitCode,null);assert.equal(delayed.exitCode,null);await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));assert.deepEqual(await readFile(location),before)
      delayed.stdin.write('\n');await waitFor(()=>output.includes('released'),10000);delayed.stdin.end('\n');await waitFor(()=>delayed.exitCode!==null);assert.equal(delayed.exitCode,0,errors);delayed=undefined
      const record=await waitFor(async()=>(await disk()).ClipboardHistory.find(item=>item.Text==='delayed clipboard completes after quit timeout'));assert.equal((await disk()).ClipboardHistory.filter(item=>item.Id===record.Id).length,1);evidence.delayedReader={quitCancelledAfterMs:elapsed,workerOwnerReleasedNormally:true,recordId:record.Id}
    })
    await scenario('quit without an uncommitted candidate exits normally after recovery and leaves no duplicate history on restart',async()=>{
      const before=(await disk()).ClipboardHistory.map(item=>item.Id);await exited(quit());await reopen();assert.deepEqual((await disk()).ClipboardHistory.map(item=>item.Id),before);await exited(quit())
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'normal-quit-accepted-clipboard-drain',scenarios,evidence,pending:['crash-power-loss-recovery-of-uncommitted-memory','all-third-party-delayed-rendering-and-format-matrix','all-widget-callers','full-production-takeover-and-release-performance']},null,2))
  }finally{
    try{
      try{
        if(delayed?.pid&&delayed.exitCode===null){delayed.stdin.end('\n\n');try{await waitFor(()=>delayed.exitCode!==null,10000)}catch{if(delayed.exitCode===null){execFileSync('taskkill.exe',['/PID',String(delayed.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await waitFor(()=>delayed.exitCode!==null)}}}
      }finally{if(unlock)await unlock()}
    }finally{try{await app?.close()}finally{await guard.close()}}
  }
})
