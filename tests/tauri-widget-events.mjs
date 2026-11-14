import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,writeFile,rm} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const report='artifacts/tauri-migration/widget-events-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('widget event subscriptions cannot opt into another native role or the global event target',async suite=>{
  const app=await launchTauri({releaseDelayMs:400});const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Widget event scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.Settings.WidgetPlacements={};initial.Settings.WidgetLayoutPresets={}
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const call=(target,method,...args)=>target.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const api=(method,...args)=>call(page,method,...args)
    assert.equal((await api('setWidgetVisibility','todo',true)).ok,true);const task=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')&&new URL(target.url()).searchParams.get('widget')==='todo'));await task.getByLabel('桌面新增任务').waitFor()
    const show=async key=>{assert.equal((await api('setWidgetVisibility',key,true)).ok,true);const target=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>!target.isClosed()&&target.url().includes('widget.html')&&new URL(target.url()).searchParams.get('widget')===key));await target.locator('.widget-head').waitFor();return target}
    const attach=(target,name)=>target.evaluate(async name=>{window[name]=[];const callback=window.__TAURI_INTERNALS__.transformCallback(frame=>{if(frame.message)window[name].push(frame.message)});return window.__TAURI_INTERNALS__.invoke('widget_events_attach',{channel:'__CHANNEL__:'+callback,label:'workspace-main',role:'notes',target:{kind:'Any'},window:'workspace-main'})},name)
    const capture=async title=>{const reply=await api('productivity',{type:'capture',kind:'task',title,text:''});assert.equal(reply.ok,true,JSON.stringify(reply))}
    await scenario('raw Any and workspace-main subscriptions cannot reveal a private note even when the renderer supplies its own target',async()=>{
      const subscriptions=await task.evaluate(async()=>{window.__crossRoleSnapshots=[];const replies=[];for(const target of [{kind:'Any'},{kind:'WebviewWindow',label:'workspace-main'}]){try{await window.__TAURI_INTERNALS__.invoke('plugin:event|listen',{event:'workspace:snapshot',target,handler:window.__TAURI_INTERNALS__.transformCallback(event=>window.__crossRoleSnapshots.push(event.payload))});replies.push({target,allowed:true})}catch(error){replies.push({target,allowed:false,error:String(error)})}}return replies})
      const note=initial.Notes[0];const privateText='main-private-event-'+randomUUID();assert.equal((await api('productivity',{type:'note-edit',id:note.Id,title:note.Title,text:privateText,previousTitle:note.Title,previousText:note.Text})).ok,true)
      await task.evaluate(()=>new Promise(resolve=>setTimeout(resolve,300)));const observations=await task.evaluate(privateText=>window.__crossRoleSnapshots.map(snapshot=>({noteIds:snapshot.state.Notes.map(note=>note.Id),privateNote:snapshot.state.Notes.some(note=>note.Text===privateText)})),privateText)
      evidence.genericSubscriptions=subscriptions;evidence.crossRoleObservations=observations;await writeFile(report,JSON.stringify({productionReady:false,scenarios,evidence},null,2))
      assert.ok(observations.every(snapshot=>!snapshot.privateNote),'A task widget must not receive the main window private note through a renderer-selected event target')
      assert.ok(subscriptions.every(subscription=>!subscription.allowed),'Generic event listening must not remain available to widget renderers')
    })
    await scenario('generic self listening and event emission are denied and trusted windows cannot attach a widget connection',async()=>{
      for(const command of ['plugin:event|listen','plugin:event|unlisten','plugin:event|emit','plugin:event|emit_to'])await assert.rejects(app.invoke(command,{event:'workspace:snapshot',target:{kind:'WebviewWindow',label:await task.evaluate(()=>window.__TAURI_INTERNALS__.metadata.currentWindow.label)},handler:0,eventId:0,payload:{}},task),/not allowed|权限|denied/i)
      for(const target of [page,app.page])for(const command of ['widget_events_attach','widget_events_detach'])await assert.rejects(app.invoke(command,{channel:'__CHANNEL__:1',token:'forged'},target),/not allowed|权限|denied/i)
    })
    await scenario('normal shared UI receives only its role snapshot and unsubscribing stops future frontend notifications',async()=>{
      await task.evaluate(()=>{window.__taskChanges=[];window.__offTaskChanges=window.dustdesk.onWorkspaceChanged(state=>window.__taskChanges.push(state))})
      const title='通道任务-'+randomUUID();await capture(title);await task.getByText(title,{exact:true}).waitFor();await waitFor(()=>task.evaluate(()=>window.__taskChanges.length>0))
      const observed=await task.evaluate(()=>window.__taskChanges);assert.ok(observed.every(state=>state.Notes.length===0&&state.ClipboardHistory.length===0));assert.ok(observed.some(state=>state.Todos.some(todo=>todo.Title===title)))
      await task.evaluate(()=>{window.__offTaskChanges();window.__taskChanges=[]});await capture('取消订阅-'+randomUUID());await task.evaluate(()=>new Promise(resolve=>setTimeout(resolve,200)));assert.deepEqual(await task.evaluate(()=>window.__taskChanges),[])
    })
    const notes=await show('notes');let taskToken
    await scenario('reattach binds to the actual caller despite forged role arguments and old or foreign tokens cannot detach the replacement',async()=>{
      const first=await attach(task,'__oldPackets');taskToken=await attach(task,'__packets');assert.notEqual(first,taskToken)
      assert.equal(await app.invoke('widget_events_detach',{token:first},task),false);assert.equal(await app.invoke('widget_events_detach',{token:taskToken},notes),false)
      const title='真实调用窗口-'+randomUUID();await capture(title);await waitFor(()=>task.evaluate(title=>window.__packets.some(packet=>packet.event==='workspace:snapshot'&&packet.payload.state.Todos.some(todo=>todo.Title===title)),title))
      const packets=await task.evaluate(()=>window.__packets);assert.ok(packets.every(packet=>packet.token===taskToken));assert.ok(packets.filter(packet=>packet.event==='workspace:snapshot').every(packet=>packet.payload.path===''&&packet.payload.state.Notes.length===0));assert.deepEqual(await task.evaluate(()=>window.__oldPackets),[])
    })
    await scenario('large Unicode snapshots preserve exact role data and a task window cannot fetch the notes channel queued payload',async()=>{
      await attach(notes,'__notePackets')
      const state=await api('loadWorkspace');const secret='便签私有正文🪶'.repeat(3000)+randomUUID();state.Notes[0].Text=secret
      state.Todos=Array.from({length:100},(_,index)=>({...state.Todos[0],Id:randomUUID(),Title:'通道顺序🪶-'+index+'-'+'数'.repeat(100)}))
      const expected=state.Todos.map(todo=>({Id:todo.Id,Title:todo.Title}));assert.ok(Buffer.byteLength(JSON.stringify(expected))>8192)
      const start=Date.now();const stalled=notes.evaluate(()=>{window.__eventStallStart=Date.now();const end=Date.now()+4000;while(Date.now()<end){}window.__eventStallEnd=Date.now()})
      await new Promise(resolve=>setTimeout(resolve,250));assert.equal((await api('saveWorkspace',state)).ok,true)
      const probes=await task.evaluate(async()=>{const replies=[];for(let index=0;index<64;index++){try{const payload=await window.__TAURI_INTERNALS__.invoke('plugin:__TAURI_CHANNEL__|fetch',null,{headers:{'Tauri-Channel-Id':String(index)}});replies.push({index,payload})}catch(error){replies.push({index,error:String(error)})}}return replies})
      assert.ok(Date.now()-start<4000,'Foreign fetch probes must run while the note queue is still pending');assert.ok(!JSON.stringify(probes).includes(secret));await stalled
      await waitFor(()=>notes.evaluate(secret=>window.__notePackets.some(packet=>packet.event==='workspace:snapshot'&&packet.payload.state.Notes[0]?.Text===secret),secret))
      await waitFor(()=>task.evaluate(expected=>window.__packets.some(packet=>packet.event==='workspace:snapshot'&&JSON.stringify(packet.payload.state.Todos.map(todo=>({Id:todo.Id,Title:todo.Title})))===JSON.stringify(expected)),expected))
      const latest=await task.evaluate(()=>window.__packets.filter(packet=>packet.event==='workspace:snapshot').at(-1));assert.equal(latest.payload.state.Notes.length,0);assert.deepEqual(latest.payload.state.Todos.map(todo=>({Id:todo.Id,Title:todo.Title})),expected)
      evidence.largeSnapshotBytes=Buffer.byteLength(JSON.stringify(latest));evidence.foreignChannelFetchAttempts=probes.length;evidence.foreignChannelPrivatePayloads=0
    })
    await scenario('reload restores the real frontend channel and destruction cannot transfer an old connection to a recreated widget',async()=>{
      assert.equal(await app.invoke('widget_events_detach',{token:taskToken},task),true);await task.reload();await task.getByLabel('桌面新增任务').waitFor()
      const title='重连后的任务-'+randomUUID();await capture(title);await task.getByText(title,{exact:true}).waitFor()
      await notes.reload();await notes.getByLabel('便签标题').waitFor();assert.equal((await api('hideWidget','todo')).ok,true);await waitFor(()=>task.isClosed(),12000)
      const replacement=await show('todo');assert.notEqual(replacement,task);assert.equal(await app.invoke('widget_events_detach',{token:taskToken},replacement),false)
      const recreated='销毁重建后的任务-'+randomUUID();await capture(recreated);await replacement.getByText(recreated,{exact:true}).waitFor();evidence.recreatedWidgetChannelWorking=true
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'native-widget-event-ownership',scenarios,evidence,pending:['full-product-transport-lifecycle','production-takeover']},null,2))
  }finally{await app.close()}
})
