import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm,rename,rmdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {spawn,execFileSync} from 'node:child_process'
import {chromium} from 'playwright'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'
import {operateMenu} from './tauri-menu.mjs'
import {clipboardFixture} from './tauri-clipboard-support.mjs'

const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const report='artifacts/tauri-migration/widget-release-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('hidden native widgets reclaim only acknowledged clean renderers without losing drafts or joining stale quit sessions',async suite=>{
  let app=await launchTauri({releaseDelayMs:400});let failed=false;const scenarios=[];const evidence={};const errors=[]
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;console.error('Native output:',app.output());for(const target of app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('widget.html')))console.error(target.url(),await target.locator('body').innerText().catch(reason=>String(reason)));throw error}});if(failed)throw Error('Widget reclamation scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.Settings.WidgetPlacements={};initial.Settings.WidgetLayoutPresets={}
    const noteId=initial.Notes[0].Id;const noteKey='note:'+noteId;const secondId=randomUUID();initial.Notes=initial.Notes.slice(0,1);initial.Notes.push({...initial.Notes[0],Id:secondId,Title:'回收验证便签二'})
    initial.LinkGroups=[{Id:randomUUID(),Name:'回收分类一',Links:[]},{Id:randomUUID(),Name:'回收分类二',Links:[]}]
    initial.DesktopCategories=[{Id:randomUUID(),Name:'收纳一',ItemPaths:[],IsCollapsed:false},{Id:randomUUID(),Name:'收纳二',ItemPaths:[],IsCollapsed:false}]
    const menuPath=path.join(app.root,'release-menu.txt');await writeFile(menuPath,'isolated native menu fixture');initial.Launchers=[{Id:randomUUID(),Name:'回收菜单授权',Path:menuPath}]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    let page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const call=(target,method,...args)=>target.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const api=(method,...args)=>call(page,method,...args)
    const find=key=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>!target.isClosed()&&target.url().includes('widget.html')&&new URL(target.url()).searchParams.get('widget')===key)
    const show=async key=>{assert.equal((await api('setWidgetVisibility',key,true)).ok,true);const target=await waitFor(()=>find(key));await target.locator('.widget-head').waitFor();target.on('pageerror',error=>errors.push(String(error)));return target}
    const hide=async key=>assert.equal((await api('hideWidget',key)).ok,true)
    const closed=target=>waitFor(()=>target.isClosed(),12000)
    const retained=async target=>{await delay(1200);assert.equal(target.isClosed(),false);assert.equal(await target.evaluate(()=>document.documentElement.inert),false)}
    const location=path.join(app.root,'user-data','tauri-preview','Workspace','workspace.json');const disk=async()=>JSON.parse(await readFile(location,'utf8'))
    const label=target=>target.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)
    await scenario('clean monitor WebView is destroyed only after hiding and recreated lazily with a new native identity',async()=>{
      const monitor=await show('monitor');const before=await label(monitor);await delay(900);assert.equal(monitor.isClosed(),false)
      await monitor.locator('.widget-metrics').waitFor();assert.equal((await api('setWidgetOptions','monitor',{collapsed:true})).ok,true);await waitFor(async()=>await monitor.locator('.widget-metrics').count()===0);assert.equal((await api('setWidgetOptions','monitor',{collapsed:false})).ok,true);await monitor.locator('.widget-metrics').waitFor()
      await hide('monitor');await closed(monitor);assert.equal((await disk()).Settings.WidgetPlacements.monitor.Visible,false);assert.equal(find('monitor'),undefined)
      const restored=await show('monitor');assert.notEqual(await label(restored),before);assert.ok((await call(restored,'sampleSystemMetrics')).TotalMemoryBytes>0);await hide('monitor');await closed(restored);evidence.monitorRecreated=true
    })
    await scenario('typed task input survives collapse and repeated hidden release attempts without becoming a saved task',async()=>{
      const task=await show('todo');await task.getByLabel('桌面新增任务').fill('未提交的桌面任务');assert.equal((await api('setWidgetOptions','todo',{collapsed:true})).ok,true);await hide('todo');await retained(task)
      assert.ok(!(await disk()).Todos.some(item=>item.Title==='未提交的桌面任务'));assert.equal(await show('todo'),task);assert.equal((await api('setWidgetOptions','todo',{collapsed:false})).ok,true);await task.getByLabel('桌面新增任务').waitFor();assert.equal(await task.getByLabel('桌面新增任务').inputValue(),'未提交的桌面任务')
      await task.screenshot({path:'artifacts/tauri-migration/widget-release-task-retained.png'})
      await task.getByLabel('桌面新增任务').fill('');await hide('todo');await closed(task)
    })
    await scenario('dirty note and conflicting private draft are retained without auto-saving merely to reclaim a renderer',async()=>{
      const note=await show(noteKey);const saved=(await disk()).Notes.find(item=>item.Id===noteId);await note.getByLabel('便签正文').fill('隐藏保留的私有便签正文');await hide(noteKey);await retained(note);assert.equal((await disk()).Notes.find(item=>item.Id===noteId).Text,saved.Text)
      const reply=await api('productivity',{type:'note-edit',id:noteId,title:saved.Title,text:'另一个窗口的已保存版本',previousTitle:saved.Title,previousText:saved.Text});assert.equal(reply.ok,true);await retained(note)
      await show(noteKey);await note.getByRole('alert').filter({hasText:'便签已在其他窗口修改；本窗口草稿已保留，退出后仍可恢复。'}).waitFor();assert.equal(await note.getByLabel('便签正文').inputValue(),'隐藏保留的私有便签正文')
      await note.screenshot({path:'artifacts/tauri-migration/widget-release-note-conflict.png'})
      await note.getByLabel('便签正文').fill('另一个窗口的已保存版本');await note.getByRole('button',{name:'保存',exact:true}).click();await hide(noteKey);await closed(note)
      const restored=await show(noteKey);assert.equal(await restored.getByLabel('便签正文').inputValue(),'另一个窗口的已保存版本');await hide(noteKey);await closed(restored)
    })
    await scenario('clean note checkpoints with real localStorage write failures veto release until the successful retry',async()=>{
      const key='note:'+secondId;const note=await show(key)
      await note.evaluate(()=>{window.__originalNoteStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key.startsWith('widget-note:'))throw Error('release storage fixture full');return window.__originalNoteStorage.call(this,key,value)}})
      const original=await note.getByLabel('便签正文').inputValue();await note.getByLabel('便签正文').fill(original+' transient');await note.getByLabel('便签正文').fill(original);await hide(key);await retained(note)
      await show(key);await note.getByRole('alert').filter({hasText:'草稿暂未写入磁盘，请释放空间后重试。退出前会再次保存。'}).waitFor();await note.evaluate(()=>{Storage.prototype.setItem=window.__originalNoteStorage});await note.getByRole('button',{name:'重试保存草稿',exact:true}).click();await hide(key);await closed(note)
    })
    await scenario('generic note switching and collapsing cannot unregister protection for a different dirty private draft',async()=>{
      const notes=await show('notes');await notes.getByLabel('便签正文').fill('已切换便签的未提交内容');await notes.getByRole('combobox',{name:'选择桌面便签'}).click();await notes.getByRole('option',{name:'回收验证便签二',exact:true}).click();await notes.getByLabel('便签正文').waitFor()
      assert.equal((await api('setWidgetOptions','notes',{collapsed:true})).ok,true);await hide('notes');await retained(notes);await show('notes');assert.equal((await api('setWidgetOptions','notes',{collapsed:false})).ok,true)
      await notes.getByRole('combobox',{name:'选择桌面便签'}).click();await notes.getByRole('option',{name:initial.Notes[0].Title,exact:true}).click();assert.equal(await notes.getByLabel('便签正文').inputValue(),'已切换便签的未提交内容');await notes.getByRole('button',{name:'保存',exact:true}).click();await waitFor(async()=>(await disk()).Notes.find(item=>item.Id===noteId).Text==='已切换便签的未提交内容');await hide('notes');await closed(notes)
    })
    await scenario('non-default links and organizer selections retain their UI state while default selections remain reclaimable',async()=>{
      for(const [key,second,first] of [['links','回收分类二','回收分类一'],['organizer','收纳二','收纳一']]){const target=await show(key);await target.getByRole('tab',{name:new RegExp(second)}).click();await hide(key);await retained(target);assert.equal(await show(key),target);assert.equal(await target.getByRole('tab',{name:new RegExp(second)}).getAttribute('aria-selected'),'true');await target.getByRole('tab',{name:new RegExp(first)}).click();await hide(key);await closed(target)}
    })
    await scenario('failed generic note selection checkpoints retain the window until selection is durably saved and survives recreation',async()=>{
      const notes=await show('notes');await notes.getByRole('combobox',{name:'选择桌面便签'}).waitFor();await notes.evaluate(()=>{window.__originalSelectionStorage=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='widget-notes:selected')throw Error('selection checkpoint fixture full');return window.__originalSelectionStorage.call(this,key,value)}})
      await notes.getByRole('combobox',{name:'选择桌面便签'}).click();await notes.getByRole('option',{name:'回收验证便签二',exact:true}).click();await hide('notes');await retained(notes);await show('notes');await notes.evaluate(()=>{Storage.prototype.setItem=window.__originalSelectionStorage})
      await notes.getByRole('combobox',{name:'选择桌面便签'}).click();await notes.getByRole('option',{name:initial.Notes[0].Title,exact:true}).click();await notes.getByRole('combobox',{name:'选择桌面便签'}).click();await notes.getByRole('option',{name:'回收验证便签二',exact:true}).click();await hide('notes');await closed(notes)
      const restored=await show('notes');await waitFor(async()=>await restored.getByLabel('便签标题').inputValue()==='回收验证便签二');await hide('notes');await closed(restored)
    })
    await scenario('composition state vetoes reclamation until composition ends without treating synthetic events as real IME coverage',async()=>{
      const task=await show('todo');await task.getByLabel('桌面新增任务').waitFor();await task.evaluate(()=>document.querySelector('input').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中'})));await hide('todo');await retained(task);await show('todo');await task.evaluate(()=>document.querySelector('input').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中'})));await hide('todo');await closed(task)
    })
    await scenario('a genuinely stalled renderer times out safely and stale or unrelated-window acknowledgements cannot destroy a reopened window',async()=>{
      const monitor=await show('monitor');const other=await show('countdown')
      await monitor.evaluate(()=>{window.__releaseChecks=0;window.__removeReleaseGuard=window.dustdesk.onMainWindowReleaseCheck(()=>{window.__releaseChecks++;if(window.__releaseChecks===1){window.__releaseStalledAt=Date.now();const end=Date.now()+4300;while(Date.now()<end){}window.__releaseReturnedAt=Date.now();return true}return false})})
      await hide('monitor');await delay(5000);assert.equal(monitor.isClosed(),false)
      const elapsed=await monitor.evaluate(()=>window.__releaseReturnedAt-window.__releaseStalledAt);assert.ok(elapsed>=4300);assert.equal(await show('monitor'),monitor)
      await other.evaluate(async()=>{window.__releaseIds=[];const callback=window.__TAURI_INTERNALS__.transformCallback(frame=>{if(frame.message?.event==='window:release-check')window.__releaseIds.push(frame.message.payload)});window.__releaseTestToken=await window.__TAURI_INTERNALS__.invoke('widget_events_attach',{channel:'__CHANNEL__:'+callback})})
      await hide('countdown');const first=await waitFor(()=>other.evaluate(()=>window.__releaseIds[0]?{requestId:window.__releaseIds[0],ready:true}:undefined));assert.ok(first.requestId)
      assert.equal(await app.invoke('window_release_ready',first,monitor),false);await assert.rejects(app.invoke('window_release_ready',first),/not allowed|权限|denied/i)
      assert.equal(await show('countdown'),other);assert.equal(await app.invoke('window_release_ready',first,other),false)
      assert.equal(await other.evaluate(()=>window.__TAURI_INTERNALS__.invoke('widget_events_detach',{token:window.__releaseTestToken})),true);await other.reload();await other.locator('.widget-shell').waitFor()
      await monitor.evaluate(()=>window.__removeReleaseGuard())
      await waitFor(()=>monitor.evaluate(()=>!document.documentElement.inert));await hide('monitor');await closed(monitor);await hide('countdown');await closed(other);evidence.timeoutMilliseconds=3000
    })
    await scenario('an active native file menu vetoes reclamation until normal quit cancellation closes its session',async()=>{
      const monitor=await show('monitor');assert.equal((await api('showPathContextMenu',menuPath)).ok,true);assert.deepEqual(JSON.parse(await operateMenu(app)).map(item=>item.name),['打开','在资源管理器中显示','复制路径']);await hide('monitor');await retained(monitor)
      await page.evaluate(()=>{window.__menuQuitVeto=window.dustdesk.onBeforeQuit(async()=>{throw Error('menu release veto fixture')})});await assert.rejects(app.invoke('application_quit',{},page),/menu release veto fixture/);await page.evaluate(()=>window.__menuQuitVeto());await closed(monitor)
    })
    await scenario('actual metadata failure preserves a hidden geometry preview and release retries only after durable storage recovers',async()=>{
      const links=await show('links');assert.equal((await api('setWidgetOptions','links',{snapToEdges:false})).ok,true);assert.equal((await api('moveWidget','links',333,222,false)).ok,true);await hide('links')
      const backup=location+'.bak';const held=backup+'.release-held';await rename(backup,held);await mkdir(backup)
      try{await retained(links);assert.equal(links.isClosed(),false);assert.notEqual((await disk()).Settings.WidgetPlacements.links.X,333)}finally{await rmdir(backup);await rename(held,backup)}
      await closed(links);assert.equal((await disk()).Settings.WidgetPlacements.links.X,333);assert.equal((await disk()).Settings.WidgetPlacements.links.Y,222)
    })
    await scenario('quit begun during an actual delayed release check preserves participants and cancellation restores editing',async()=>{
      const monitor=await show('monitor');const task=await show('todo');await task.evaluate(()=>{window.__quitVeto=window.dustdesk.onBeforeQuit(async()=>{window.__quitEntered=true;await new Promise(resolve=>window.__quitContinue=resolve);throw Error('release quit veto fixture')})})
      await monitor.evaluate(()=>{window.__removeReleaseGuard=window.dustdesk.onMainWindowReleaseCheck(()=>{window.__releaseStalledAt=Date.now();const end=Date.now()+2500;while(Date.now()<end){}window.__releaseReturnedAt=Date.now();return true})})
      await hide('monitor');await delay(900);const requestedAt=Date.now();const quit=app.invoke('application_quit',{},page).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));await waitFor(()=>task.evaluate(()=>window.__quitEntered));await waitFor(()=>monitor.evaluate(()=>Boolean(window.__releaseReturnedAt)))
      assert.equal(monitor.isClosed(),false);assert.equal(app.child.exitCode,null);const timing=await monitor.evaluate(()=>({start:window.__releaseStalledAt,end:window.__releaseReturnedAt}));assert.ok(timing.start<=requestedAt&&timing.end>requestedAt,JSON.stringify({timing,requestedAt}));await task.evaluate(()=>window.__quitContinue());const reply=await quit;assert.equal(reply.ok,false);assert.match(reply.error,/release quit veto fixture/)
      for(const target of [page,task,monitor])await waitFor(()=>target.evaluate(()=>!document.documentElement.inert));await show('monitor');await monitor.evaluate(()=>window.__removeReleaseGuard());await task.evaluate(()=>window.__quitVeto());await hide('todo');await closed(task);await hide('monitor');await closed(monitor)
    })
    await scenario('after every eligible widget is reclaimed, real quit and restart restore saved data without prebuilding hidden WebViews',async()=>{
      await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('widget.html')).length===0);assert.deepEqual(errors,[])
      const quit=app.invoke('application_quit',{},page).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));await waitFor(()=>app.child.exitCode!==null,22000);const result=await quit;if(!result.ok)assert.match(result.error,/closed|destroyed|disconnected/i);assert.equal(app.child.exitCode,0)
      await app.close({preserve:true});app=await launchTauri({workspace:true,rootDirectory:app.root,releaseDelayMs:400});page=app.page;await page.locator('.app-shell').waitFor();assert.equal(app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('widget.html')).length,0);assert.equal((await api('loadWorkspace')).Notes.find(item=>item.Id===noteId).Text,'已切换便签的未提交内容');evidence.restartHiddenWidgetCount=0
    })
    await scenario('reclaiming the last WebView preserves the tray and actual clipboard worker, and single-instance activation opens the real main window',async()=>{
      const guard=await clipboardFixture()
      try{
      const enabled=await api('loadWorkspace');enabled.Settings.ClipboardMonitoringEnabled=true;assert.equal((await api('saveWorkspace',enabled)).ok,true);await guard.request('set-text',{text:'zero-widget-start-'+randomUUID()})
      await show('monitor');await app.close({preserve:true});app=await launchTauri({rootDirectory:app.root,widgetStartup:'monitor',releaseDelayMs:400,clipboardMonitoring:true});page=app.page;assert.equal(app.browser.contexts().flatMap(context=>context.pages()).some(target=>target.url().includes('tauri.html')||target.url().includes('prototype.html')),false)
      assert.equal((await call(page,'hideWidget','monitor')).ok,true);await closed(page);await delay(1500);assert.equal(app.child.exitCode,null,'Reclaiming the last clean widget must not end the tray process')
      const backgroundText='zero-webview-clipboard-'+randomUUID();await guard.request('set-text',{text:backgroundText});await waitFor(async()=>(await disk()).ClipboardHistory.some(item=>item.Kind==='Text'&&item.Text===backgroundText));evidence.clipboardCapturedWithoutAnyWebView=true
      const activation=spawn(app.executable,['--workspace'],{windowsHide:true,stdio:'ignore',env:{...process.env,DUSTDESK_TEST_USER_DATA_DIR:path.join(app.root,'user-data'),DUSTDESK_TAURI_DISABLE_HOTKEYS:'1'}})
      try{await waitFor(()=>activation.exitCode!==null,12000);assert.equal(activation.exitCode,0)}finally{if(activation.pid&&activation.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(activation.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}}}
      await waitFor(async()=>{try{return (await fetch(app.endpoint+'/json/version',{signal:AbortSignal.timeout(1000)})).ok}catch{return false}});const resumed=await chromium.connectOverCDP(app.endpoint)
      try{const main=await waitFor(()=>resumed.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await main.locator('.app-shell').waitFor();assert.equal((await call(main,'loadWorkspace')).Notes.find(item=>item.Id===noteId).Text,'已切换便签的未提交内容');const quit=app.invoke('application_quit',{},main).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));await waitFor(()=>app.child.exitCode!==null,22000);const reply=await quit;if(!reply.ok)assert.match(reply.error,/closed|destroyed|disconnected/i);assert.equal(app.child.exitCode,0)}finally{await resumed.close().catch(()=>{})}
      evidence.lastWidgetReclaimedWithoutExit=true;evidence.singleInstanceReactivatedMain=true
      }finally{await app.close({preserve:true});await guard.close()}
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'conservative-hidden-widget-reclamation-with-draft-and-identity-guards',scenarios,evidence,pending:['all-main-page-draft-checkpoints','Electron-browser-draft-export-import','non-default-selection-checkpoints','actual-IME-mixed-DPI-sleep-drop','Release-process-tree-performance','production-data-takeover']},null,2))
  }finally{await app.close()}
})
