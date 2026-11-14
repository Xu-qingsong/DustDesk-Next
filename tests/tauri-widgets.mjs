import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm,rmdir} from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const run=promisify(execFile)
const report='artifacts/tauri-migration/widgets-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('native widget layout, scoped shared components, isolated presets and all-editor quit preserve real data',async suite=>{
  let app=await launchTauri();const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;console.error('Native output:',app.output());for(const target of app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('widget.html')))console.error(target.url(),await target.locator('body').innerText().catch(reason=>String(reason)));throw error}});if(failed)throw Error('Widget scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite,{widgetWindows:true});const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.Settings.WidgetPlacements={todo:{Visible:false,UnknownPlacement:{keep:'original'}},links:{Visible:false,UnknownLinkPlacement:[1,2,3]}};initial.Settings.WidgetLayoutPresets={};initial.UnknownWidgetPrivateData={secret:'not for task widget'}
    await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(initial));await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    let page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const location=path.join(app.root,'user-data','tauri-preview','Workspace','workspace.json');const disk=async()=>JSON.parse(await readFile(location,'utf8'))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const widget=async key=>waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')&&new URL(target.url()).searchParams.get('widget')===key))
    const geometry=target=>target.evaluate(()=>({x:screenX,y:screenY,width:outerWidth,height:outerHeight}))
    let todo;let note;const noteId=initial.Notes[0].Id;const noteKey='note:'+noteId
    await page.evaluate(()=>{window.__mainWidgetSnapshots=[];window.__mainWidgetSnapshotStop=window.dustdesk.onWorkspaceChanged(state=>window.__mainWidgetSnapshots.push({notes:state.Notes.map(item=>item.Id),todos:state.Todos.map(item=>item.Id)}))})
    await scenario('native hidden layout options and preset transactions match real Electron IPC and do not prebuild unused windows',async()=>{
      const knownLayout=value=>Object.fromEntries(Object.entries(value).map(([key,placement])=>{const {UnknownPlacement,UnknownLinkPlacement,...known}=placement;return [key,known]}))
      const knownPresets=value=>Object.fromEntries(Object.entries(value).map(([name,layout])=>[name,knownLayout(layout)]))
      const pairs=[['widgets:options',['links',{topMost:true,autoCollapse:true,transparentBackground:true}],'setWidgetOptions'],['widgets:presets:save',['  工作布局  '],'saveWidgetPreset'],['widgets:options',['links',{locked:true,snapToEdges:false}],'setWidgetOptions'],['widgets:presets:apply',['工作布局'],'applyWidgetPreset']]
      for(const [channel,args,method] of pairs){assert.equal((await electron.invoke(channel,...args)).ok,true);assert.equal((await api(method,...args)).ok,true);const native=await disk();const legacy=await electron.load();assert.deepEqual(knownLayout(native.Settings.WidgetPlacements),knownLayout(legacy.Settings.WidgetPlacements));assert.deepEqual(knownPresets(native.Settings.WidgetLayoutPresets),knownPresets(legacy.Settings.WidgetLayoutPresets));assert.deepEqual(native.Settings.WidgetPlacements.todo.UnknownPlacement,{keep:'original'});assert.deepEqual(native.Settings.WidgetPlacements.links.UnknownLinkPlacement,[1,2,3])}
      evidence.unknownLayoutFields='Legacy Electron normalization removes the fixture extensions; native preserves them while known layout fields match.'
      assert.deepEqual(await api('listWidgetPresets'),await electron.invoke('widgets:presets:list'));assert.equal((await api('deleteWidgetPreset','工作布局')).ok,true);assert.equal((await electron.invoke('widgets:presets:delete','工作布局')).ok,true)
      assert.deepEqual(await api('getWidgetVisibility',['todo','notes','projects','launcher','links','clipboard','organizer','search','monitor','countdown']),Object.fromEntries(['todo','notes','projects','launcher','links','clipboard','organizer','search','monitor','countdown'].map(key=>[key,false])))
      assert.equal(app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('widget.html')).length,0)
    })
    await scenario('shared Lucide task widget creates real tasks and cannot mutate another business or control a foreign native widget',async()=>{
      assert.equal((await api('setWidgetVisibility','todo',true)).ok,true);todo=await widget('todo');await todo.getByLabel('桌面新增任务').waitFor();await todo.getByLabel('桌面新增任务').fill('Tauri 桌面组件新增任务');await todo.getByLabel('桌面新增任务').press('Enter');await waitFor(async()=>(await disk()).Todos.some(item=>item.Title==='Tauri 桌面组件新增任务'))
      const scoped=await todo.evaluate(()=>window.dustdesk.loadWorkspace());assert.deepEqual(scoped.Notes,[]);assert.deepEqual(scoped.Projects,[]);assert.deepEqual(scoped.UnknownWidgetPrivateData,{});assert.ok(scoped.Todos.some(item=>item.Title==='Tauri 桌面组件新增任务'))
      const rejected=await todo.evaluate(()=>window.dustdesk.setWidgetVisibility('notes',true));assert.equal(rejected.ok,false);assert.match(rejected.error,/其他小组件/)
      await assert.rejects(app.invoke('workspace_productivity',{action:{type:'capture',kind:'note',title:'forbidden',text:'foreign'}},todo),/无此业务操作权限/)
      for(const command of ['workspace_initialize','workspace_save','workspace_backup_create','widgets_presets','application_quit'])await assert.rejects(app.invoke(command,{},todo),/not allowed|denied|无.*权限|参数/i)
      await todo.getByLabel('完成 Tauri 桌面组件新增任务').click();await waitFor(async()=>(await disk()).Todos.some(item=>item.Title==='Tauri 桌面组件新增任务'&&item.IsCompleted));evidence.taskBusiness=true
    })
    await scenario('drag and resize previews perform no workspace writes, while final commits preserve unknown layout fields',async()=>{
      await delay(350);const original=await readFile(location)
      for(let index=0;index<12;index++)assert.equal((await api('moveWidget','todo',310+index,180+index,false)).ok,true)
      await delay(350);assert.deepEqual(await readFile(location),original);assert.equal((await geometry(todo)).x,321)
      assert.equal((await api('moveWidget','todo',321,191,true)).ok,true);assert.equal((await disk()).Settings.WidgetPlacements.todo.X,321)
      const beforeResize=await readFile(location);assert.equal((await api('resizeWidget','todo',620,420,false)).ok,true);await delay(250);assert.deepEqual(await readFile(location),beforeResize);assert.equal((await geometry(todo)).width,620)
      assert.equal((await api('resizeWidget','todo',620,420,true)).ok,true);const placement=(await disk()).Settings.WidgetPlacements.todo;assert.equal(placement.Width,620);assert.equal(placement.Height,420);assert.deepEqual(placement.UnknownPlacement,{keep:'original'});evidence.previewWorkspaceWrites=0
    })
    await scenario('an actual Win32 movement persists through unrelated workspace updates without snapping back to old saved bounds',async()=>{
      const script=`$ErrorActionPreference="Stop";Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class WidgetMoveFixture{delegate bool Callback(IntPtr window,IntPtr value);[StructLayout(LayoutKind.Sequential)]struct Rect{public int Left,Top,Right,Bottom;}[DllImport("user32.dll")]static extern bool EnumWindows(Callback callback,IntPtr value);[DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rect);[DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);[DllImport("user32.dll")]public static extern bool SetWindowPos(IntPtr window,IntPtr after,int horizontal,int vertical,int width,int height,uint flags);public static IntPtr FindOwned(uint processId){IntPtr found=IntPtr.Zero;EnumWindows((window,value)=>{uint owner;GetWindowThreadProcessId(window,out owner);Rect rect;if(owner==processId&&GetWindowRect(window,out rect)&&rect.Left==321&&rect.Top==191&&rect.Right-rect.Left==620&&rect.Bottom-rect.Top==420){found=window;return false;}return true;},IntPtr.Zero);return found;}}';$window=[WidgetMoveFixture]::FindOwned(${app.child.pid});if($window -eq [IntPtr]::Zero){throw "Missing owned fixture bounds"};if(-not [WidgetMoveFixture]::SetWindowPos($window,[IntPtr]::Zero,460,240,0,0,21)){throw "Native movement failed"}`
      let completed=false;let moveFailure;const moving=run('pwsh.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:15000}).then(result=>{completed=true;return result},error=>{completed=true;moveFailure=error})
      let index=0;let afterMove=0;while(!completed||afterMove<4){const state=await api('loadWorkspace');const baseline=structuredClone(state);state.QuickNote='native move concurrent save '+index++;await api('saveWorkspace',state,baseline);if(completed)afterMove++;await delay(20)}await moving;if(moveFailure)throw moveFailure
      await waitFor(async()=>{const placement=(await disk()).Settings.WidgetPlacements.todo;return placement.X===460&&placement.Y===240});assert.equal((await geometry(todo)).x,460);assert.equal((await geometry(todo)).y,240);evidence.nativeWindowEventPersistence=true
    })
    await scenario('locking, snapping, collapse height and native topmost/opacity follow persisted options',async()=>{
      assert.equal((await api('setWidgetOptions','todo',{locked:true})).ok,true);const locked=await geometry(todo);assert.equal((await api('moveWidget','todo',500,400,true)).ok,false);assert.equal((await api('resizeWidget','todo',800,600,true)).ok,false);assert.deepEqual(await geometry(todo),locked)
      assert.equal((await api('setWidgetOptions','todo',{locked:false,snapToEdges:true})).ok,true);const area=await todo.evaluate(()=>({x:screen.availLeft??0,y:screen.availTop??0}));assert.equal((await api('moveWidget','todo',area.x+8,area.y+8,true)).ok,true);assert.equal((await disk()).Settings.WidgetPlacements.todo.DockEdge,'Left')
      assert.equal((await api('setWidgetOptions','todo',{collapsed:true,topMost:true,transparentBackground:true})).ok,true);await waitFor(async()=>(await geometry(todo)).height===34);assert.equal((await disk()).Settings.WidgetPlacements.todo.Height,420)
      assert.equal((await api('setWidgetOptions','todo',{collapsed:false})).ok,true);await waitFor(async()=>(await geometry(todo)).height===420)
      const diagnostics=await app.invoke('prototype_diagnostics');const native=diagnostics.windows.find(item=>item.label.startsWith('workspace-widget-'));assert.equal(native.alwaysOnTop,true);assert.ok(native.opacity>=50);evidence.nativeOptions={height:420,collapsedHeight:34,dockEdge:'Left',topmost:true}
    })
    await scenario('actual metadata failure cannot change visible windows or committed options and permits a later retry',async()=>{
      const before=await readFile(location);const position=await geometry(todo);await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      try{assert.equal((await api('setWidgetVisibility','todo',false)).ok,false);assert.equal((await api('setWidgetOptions','todo',{topMost:false})).ok,false);assert.equal((await api('getWidgetVisibility',['todo'])).todo,true);assert.deepEqual(await geometry(todo),position);assert.deepEqual(await readFile(location),before)}finally{await rmdir(location+'.bak')}
      assert.equal((await api('setWidgetOptions','todo',{topMost:false})).ok,true)
    })
    await scenario('applying a visible preset restores actual window visibility and geometry without aliasing later placement edits',async()=>{
      const original=structuredClone((await disk()).Settings.WidgetPlacements);assert.equal((await api('saveWidgetPreset','桌面窗口布局')).ok,true);assert.equal((await api('hideWidget','todo')).ok,true);assert.equal((await api('setWidgetOptions','todo',{collapsed:true})).ok,true);assert.equal((await api('moveWidget','todo',720,330,true)).ok,true)
      assert.deepEqual((await disk()).Settings.WidgetLayoutPresets['桌面窗口布局'],original);assert.equal((await api('applyWidgetPreset','桌面窗口布局')).ok,true);assert.equal((await api('getWidgetVisibility',['todo'])).todo,true);assert.deepEqual((await disk()).Settings.WidgetPlacements,original);await waitFor(async()=>(await geometry(todo)).height===420);assert.equal((await api('deleteWidgetPreset','桌面窗口布局')).ok,true);assert.equal((await api('applyWidgetPreset','桌面窗口布局')).ok,false);evidence.nativePresetRestore=true
    })
    await scenario('hidden note editors remain quit participants, and a different widget veto resumes every frontend without discarding a saved draft',async()=>{
      assert.equal((await api('setWidgetVisibility',noteKey,true)).ok,true);note=await widget(noteKey);await note.getByLabel('便签正文').waitFor();await note.getByLabel('便签标题').fill('隐藏组件退出保存');await note.getByLabel('便签正文').fill('原生多窗口保存，不覆盖其他业务。');assert.equal((await api('hideWidget',noteKey)).ok,true);assert.equal((await api('getWidgetVisibility',[noteKey]))[noteKey],false)
      await todo.evaluate(()=>{window.__quitEntered=false;window.__quitRemove=window.dustdesk.onBeforeQuit(async()=>{window.__quitEntered=true;await new Promise(resolve=>window.__quitRelease=resolve);throw Error('widget veto for regression')})})
      await assert.rejects(app.invoke('workspace_productivity',{action:{type:'note-edit',id:'00000000-0000-0000-0000-000000000000',title:'wrong',text:'wrong'}},note),/无此业务操作权限/)
      const mainSnapshots=await page.evaluate(()=>window.__mainWidgetSnapshots);assert.ok(mainSnapshots.length>0);assert.ok(mainSnapshots.every(snapshot=>snapshot.notes.includes(noteId)),'Main window must never receive a task-scoped or note-scoped snapshot')
      const request=app.invoke('application_quit',{},page).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));await waitFor(()=>todo.evaluate(()=>window.__quitEntered));await waitFor(async()=>(await disk()).Notes.some(item=>item.Id===noteId&&item.Title==='隐藏组件退出保存'));assert.equal(app.child.exitCode,null);assert.equal(await page.evaluate(()=>document.documentElement.inert),true)
      await todo.evaluate(()=>window.__quitRelease());const result=await request;assert.equal(result.ok,false);assert.match(result.error,/widget veto for regression/);for(const target of [page,todo,note])await waitFor(()=>target.evaluate(()=>!document.documentElement.inert));await todo.evaluate(()=>window.__quitRemove());evidence.hiddenNoteFlushed=true
    })
    await scenario('successful quit flushes a dirty note and a preview-only placement before the full process exits, then restores only configured visible windows',async()=>{
      assert.equal((await api('setWidgetVisibility',noteKey,true)).ok,true);await note.getByLabel('便签正文').fill('最后退出的便签正文');assert.equal((await api('hideWidget',noteKey)).ok,true);assert.equal((await api('setWidgetOptions','todo',{snapToEdges:false})).ok,true);assert.equal((await api('moveWidget','todo',345,234,false)).ok,true)
      const request=app.invoke('application_quit',{},page).then(()=>({ok:true}),error=>({ok:false,error:String(error)}));await waitFor(()=>app.child.exitCode!==null,22000);const result=await request;if(!result.ok)assert.match(result.error,/closed|destroyed|disconnected/i);assert.equal(app.child.exitCode,0)
      const state=await disk();assert.equal(state.Notes.find(item=>item.Id===noteId).Text,'最后退出的便签正文');assert.equal(state.Settings.WidgetPlacements.todo.X,345);assert.equal(state.Settings.WidgetPlacements.todo.Y,234);assert.equal(state.Settings.WidgetPlacements[noteKey].Visible,false);assert.deepEqual(state.UnknownWidgetPrivateData,initial.UnknownWidgetPrivateData)
      await app.close({preserve:true});app=await launchTauri({workspace:true,rootDirectory:app.root});page=app.page;await page.locator('.app-shell').waitFor();todo=await widget('todo');await todo.getByLabel('桌面新增任务').waitFor();assert.deepEqual(await api('getWidgetVisibility',['todo',noteKey]),{todo:true,[noteKey]:false});assert.equal((await geometry(todo)).x,345);assert.equal((await geometry(todo)).y,234);assert.equal(app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('widget.html')).length,1)
      await page.screenshot({path:'artifacts/tauri-migration/widgets-main-native.png',fullPage:true});await todo.screenshot({path:'artifacts/tauri-migration/widgets-task-native.png'});evidence.restartVisible=['todo']
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'native-widget-window-layout-presets-and-scoped-task-note-editors',scenarios,evidence,pending:['remaining-widget-business-callers','hidden-window-reclamation','mixed-DPI-and-hotplug','draft-migration-from-Electron','all-widget-performance-and-production-takeover']},null,2))
  }finally{await app.close()}
})
