import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createHash} from 'node:crypto'
import {mkdir,readFile,writeFile,rm,rmdir} from 'node:fs/promises'
import {spawn,execFile,execFileSync} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import ts from 'typescript'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {clipboardFixture} from './tauri-clipboard-support.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const run=promisify(execFile)
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const report='artifacts/tauri-migration/clipboard-monitor-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})

await test('Windows clipboard update notifications persist history without a renderer and retry storage failures safely',async suite=>{
  const guard=await clipboardFixture();let app;let hidden;const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Clipboard monitor scenario failed: '+name)}
  try{
    await guard.request('set-text',{text:'monitor-start-disabled'})
    app=await launchTauri({clipboardMonitoring:true})
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.DesktopCategories=[];initial.ClipboardHistory=[]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const workspace=path.join(app.root,'user-data','tauri-preview','Workspace');const location=path.join(workspace,'workspace.json')
    const disk=async()=>JSON.parse(await readFile(location,'utf8'))
    const saved=async text=>waitFor(async()=>{const state=await disk();return state.ClipboardHistory.find(item=>item.Text===text)})
    const count=async()=>(await disk()).ClipboardHistory.length
    const events=()=>page.evaluate(()=>window.__clipboardEvents)
    const settings=async enabled=>{const state=await api('loadWorkspace');state.Settings.ClipboardMonitoringEnabled=enabled;assert.equal((await api('saveWorkspace',state)).ok,true)}
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    await page.evaluate(()=>{window.__clipboardEvents=[];window.__clipboardUnsubscribe=window.dustdesk.onClipboardChanged(record=>window.__clipboardEvents.push(record))})
    await delay(150)
    await scenario('disabled monitoring does not ingest or emit, enabling captures current Unicode content after durable storage',async()=>{
      await delay(1200);assert.equal(await count(),0);assert.deepEqual(await events(),[])
      const text='后台通知 中文 😀\r\n第二行';await guard.request('set-text',{text});await delay(400);assert.equal(await count(),0)
      await settings(true);const record=await saved(text)
      await waitFor(async()=>(await events()).some(item=>item.Id===record.Id))
      assert.equal(record.Kind,'Text');assert.equal(record.ImageSha256,createHash('sha256').update(text).digest('hex'));assert.equal(record.ImagePngBase64,'')
      assert.deepEqual((await events()).find(item=>item.Id===record.Id),record);assert.equal(record.IsLocked,false);assert.equal(record.IsPinned,false)
      evidence.firstPersisted=record
    })
    await scenario('notification duplicates and application copies reuse persisted fingerprints instead of multiplying history/events',async()=>{
      const first=(await disk()).ClipboardHistory[0];const before=await count();const emitted=(await events()).length
      await guard.request('set-text',{text:first.Text});await delay(1200);await api('writeClipboard',{recordId:first.Id});await delay(1200)
      assert.equal(await count(),before);assert.equal((await events()).length,emitted)
      await guard.request('clear');await delay(500);assert.equal(await count(),before)
      await guard.request('set-text',{text:'new notification after duplicate'});await saved('new notification after duplicate')
      assert.equal(await count(),before+1)
    })
    await scenario('GDI image notifications externalize PNG before small image events and update the shared clipboard list',async()=>{
      const before=await count();await guard.request('set-bitmap')
      const record=await waitFor(async()=>{const state=await disk();return state.ClipboardHistory.find(item=>item.Kind==='Image')})
      assert.equal(await count(),before+1);assert.equal(record.ImagePngBase64,'');assert.match(record.ImageAssetName,/^[a-f0-9]{64}\.png$/)
      const bytes=await readFile(path.join(workspace,'ClipboardImages',record.ImageAssetName));assert.ok(bytes.length>0)
      await waitFor(async()=>(await events()).some(item=>item.Id===record.Id));const event=(await events()).find(item=>item.Id===record.Id);assert.equal(event.ImagePngBase64,'');assert.ok(JSON.stringify(event).length<1000)
      await page.getByRole('button',{name:'剪贴板',exact:true}).click();await page.locator('[data-clipboard-id="'+record.Id+'"]').locator('img').waitFor()
      const sequence=(await guard.request('sequence')).sequence;assert.equal((await api('previewClipboardImage',record.Id,false)).ok,true);assert.equal((await guard.request('sequence')).sequence,sequence)
      await page.getByText('无法读取小组件状态，请重试',{exact:true}).waitFor({state:'hidden',timeout:10000});await page.screenshot({path:'artifacts/tauri-migration/clipboard-monitor-shared-native.png',fullPage:true})
      await page.getByRole('button',{name:'概览',exact:true}).click();evidence.imageEventBytes=Buffer.byteLength(JSON.stringify(event))
    })
    await scenario('transient clipboard occupancy retries the same update after release without needing a second copy',async()=>{
      const text='clipboard occupied notification'
      await settings(false)
      await guard.request('set-text-locked',{text})
      const offset=app.output().length
      try{await settings(true);await waitFor(()=>app.output().slice(offset).includes('剪贴板后台采样失败'));await delay(7000);assert.ok(!(await disk()).ClipboardHistory.some(item=>item.Text===text))}
      finally{await guard.request('unlock')}
      await saved(text);assert.equal((await disk()).ClipboardHistory.filter(item=>item.Text===text).length,1)
    })
    await scenario('failed metadata commit emits nothing and retries the same candidate without another clipboard notification',async()=>{
      const text='retry-save-exactly-once';const before=await readFile(location);const emitted=(await events()).length;await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      const offset=app.output().length
      try{
        await guard.request('set-text',{text});await waitFor(()=>app.output().slice(offset).includes('保存剪贴板历史失败'))
        assert.deepEqual(await readFile(location),before);assert.equal((await events()).length,emitted)
        await delay(1100);assert.deepEqual(await readFile(location),before)
      }finally{await rmdir(location+'.bak')}
      const record=await saved(text);await waitFor(async()=>(await events()).some(item=>item.Id===record.Id));assert.equal((await disk()).ClipboardHistory.filter(item=>item.Text===text).length,1)
      evidence.saveRetry='workspace.json.bak is a directory during multiple attempts; only the successful commit appears on disk and in events'
    })
    await scenario('a later notification supersedes an uncommitted failed sample rather than replaying stale clipboard bytes',async()=>{
      await rm(location+'.bak',{force:true});await mkdir(location+'.bak');const offset=app.output().length
      try{
        await guard.request('set-text',{text:'superseded failed sample'});await waitFor(()=>app.output().slice(offset).includes('保存剪贴板历史失败'))
        await guard.request('set-text',{text:'latest after failed sample'});await delay(1200)
      }finally{await rmdir(location+'.bak')}
      await saved('latest after failed sample');assert.ok(!(await disk()).ClipboardHistory.some(item=>item.Text==='superseded failed sample'))
    })
    await scenario('disabled settings stop automatic history and re-enabling records only the current clipboard, not a pending old sample',async()=>{
      await settings(false);const before=await count();const emitted=(await events()).length
      await guard.request('set-text',{text:'disabled old sample'});await delay(1200);assert.equal(await count(),before);assert.equal((await events()).length,emitted)
      await guard.request('set-text',{text:'current on re-enable'});await settings(true);await saved('current on re-enable');assert.ok(!(await disk()).ClipboardHistory.some(item=>item.Text==='disabled old sample'))
    })
    await scenario('history retention matches the shared Electron rule while preserving locked and pinned records',async()=>{
      await settings(false);const state=await api('loadWorkspace');const original=state.ClipboardHistory[0];const items=Array.from({length:205},(_,index)=>({...original,Id:'retention-'+index,Text:'retention-'+index,ImageSha256:'retention-hash-'+index,IsLocked:index===203,IsPinned:index===204}))
      state.ClipboardHistory=items;assert.equal((await api('saveWorkspace',state)).ok,true)
      await guard.request('set-text',{text:'retained newest'});await settings(true);const newest=await saved('retained newest')
      const source=await readFile('src/shared/clipboard.ts','utf8');const target=path.join(app.root,'clipboard-retention.mjs');await writeFile(target,ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext}}).outputText)
      const {retainClipboardHistory}=await import(pathToFileURL(target).href)
      assert.deepEqual((await disk()).ClipboardHistory.map(item=>item.Id),retainClipboardHistory([newest,...items]).map(item=>item.Id))
      assert.equal((await disk()).ClipboardHistory.length,200)
    })
    await scenario('restore invalidates earlier samples without immediately reimporting the pre-restore clipboard',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true);const preview=await api('previewBackup',backup.path)
      await guard.request('set-text',{text:'clipboard before restore must stay out'});await saved('clipboard before restore must stay out')
      const emitted=(await events()).length
      assert.equal((await api('restoreBackup',backup.path,preview.fingerprint)).ok,true);await delay(1500)
      assert.ok(!(await disk()).ClipboardHistory.some(item=>item.Text==='clipboard before restore must stay out'));assert.equal((await events()).length,emitted)
      await guard.request('set-text',{text:'fresh event after restore'});await saved('fresh event after restore')
    })
    await scenario('quit handshake pauses background sampling, a veto resumes it, and unsubscribe prevents future events',async()=>{
      await page.evaluate(()=>{window.__monitorQuitRemove=window.dustdesk.onBeforeQuit(async()=>{window.__monitorQuitEntered=true;await new Promise(resolve=>window.__monitorQuitRelease=resolve);throw Error('monitor quit veto')})})
      const quitting=assert.rejects(app.invoke('application_quit',{},page),/monitor quit veto/);await waitFor(()=>page.evaluate(()=>window.__monitorQuitEntered));const before=await count()
      await guard.request('set-text',{text:'copied while quit paused'});await delay(1200);assert.equal(await count(),before)
      await page.evaluate(()=>window.__monitorQuitRelease());await quitting;await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));await page.evaluate(()=>window.__monitorQuitRemove())
      await saved('copied while quit paused');await page.evaluate(()=>window.__clipboardUnsubscribe());const emitted=(await events()).length
      await guard.request('set-text',{text:'persisted after unsubscribe'});await saved('persisted after unsubscribe');await delay(250);assert.equal((await events()).length,emitted);assert.deepEqual(errors,[])
    })
    await scenario('hidden restart listens and retries storage with no WebView, deduplicates existing history and shuts down normally after reopening',async()=>{
      await app.close({preserve:true});const before=await count();const env={...process.env,DUSTDESK_TEST_USER_DATA_DIR:path.join(app.root,'user-data'),DUSTDESK_TEST_DESKTOP_DIR:path.join(app.root,'desktop'),DUSTDESK_TAURI_DISABLE_HOTKEYS:'1',DUSTDESK_TAURI_ENABLE_TEST_CLIPBOARD:'1'};delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
      let output=''
      const start=async()=>{hidden=spawn(app.executable,['--workspace','--hidden'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});hidden.stdout.on('data',bytes=>output+=bytes);hidden.stderr.on('data',bytes=>output+=bytes);await new Promise((resolve,reject)=>{hidden.once('spawn',resolve);hidden.once('error',reject)})}
      const stop=async()=>{if(hidden?.pid&&hidden.exitCode===null){execFileSync('taskkill.exe',['/PID',String(hidden.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});await waitFor(()=>hidden.exitCode!==null)}}
      await start();await delay(1300);assert.equal(await count(),before)
      await guard.request('set-text',{text:'hidden background notification'});await saved('hidden background notification')
      const script='$rows=@(Get-CimInstance Win32_Process);$ids=[Collections.Generic.HashSet[int]]::new();[void]$ids.Add('+hidden.pid+');do{$added=$false;foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId)-and $ids.Add([int]$row.ProcessId)){$added=$true}}}while($added);@($rows|Where-Object{$ids.Contains([int]$_.ProcessId)}|Select-Object ProcessId,Name)|ConvertTo-Json -Compress'
      const measured=JSON.parse((await run('pwsh.exe',['-NoProfile','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true})).stdout);const processes=Array.isArray(measured)?measured:[measured]
      assert.ok(processes.some(item=>item.ProcessId===hidden.pid));assert.ok(processes.every(item=>item.ProcessId===hidden.pid||item.Name.toLowerCase()==='conhost.exe'));evidence.hiddenProcesses=processes
      await rm(location+'.bak',{force:true});await mkdir(location+'.bak');const offset=output.length
      try{await guard.request('set-text',{text:'hidden failed save retries'});await waitFor(()=>output.slice(offset).includes('保存剪贴板历史失败'))}finally{await rmdir(location+'.bak')}
      await saved('hidden failed save retries');await stop();const countBeforeRestart=await count();await start();await delay(1300);assert.equal(await count(),countBeforeRestart);await stop()
      const reopened=await launchTauri({workspace:true,rootDirectory:app.root,clipboardMonitoring:true})
      try{
        await reopened.page.locator('.app-shell').waitFor();const quitting=reopened.invoke('application_quit').then(()=>({ok:true}),error=>({ok:false,error}));await waitFor(()=>reopened.child.exitCode!==null);const result=await quitting;if(!result.ok)assert.match(String(result.error),/closed|destroyed|disconnected/i);assert.equal(reopened.child.exitCode,0)
      }finally{await reopened.close({preserve:true})}
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'native-WM_CLIPBOARDUPDATE-with-isolated-persistence',scenarios,evidence,pending:['all-widget-callers','sleep-resume-and-physical-delayed-rendering','cross-encoder-legacy-image-dedup','full-format-and-clipboard-manager-matrix','formal-migration-and-release-memory']},null,2))
  }finally{
    if(hidden?.pid&&hidden.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(hidden.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{};await waitFor(()=>hidden.exitCode!==null)}
    try{await app?.close()}finally{await guard.close()}
  }
})
