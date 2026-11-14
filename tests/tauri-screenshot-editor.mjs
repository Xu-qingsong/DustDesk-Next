import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import { nativeWindowFixture } from './native-window-fixture.mjs'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {clipboardFixture} from './tauri-clipboard-support.mjs'

const report='artifacts/tauri-migration/screenshot-editor-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('actual screenshot overlays hand editable native sources to the shared main editor only after delivery',{timeout:180000},async suite=>{
  let app,page,fixtureWindow,overlay,clipboard,failed=false
  const evidence=[],errors=[],title='DustDesk 编辑交接参考'
  const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
  const invoke=(command,args={},target=page)=>app.invoke(command,args,target)
  const scenario=async(name,callback)=>{await suite.test(name,{timeout:45000},async()=>{try{await callback();evidence.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Editor handoff failed: '+name)}
  const directory=()=>path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots')
  const outputs=()=>readdir(directory()).catch(()=>[])
  const docs=()=>page.evaluate(()=>window.__handoffDocuments)
  const metadata=()=>invoke('screenshot_overlay_document',{},overlay)
  const sourceLength=id=>overlay.evaluate(async id=>(await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_source',{id})).byteLength,id)
  const start=async(mode='Region')=>{
    let source
    if(mode==='Window'){const listed=await api('listScreenshotWindows');source=listed.sources.find(item=>item.name===title);assert.ok(source,JSON.stringify({listed:listed.sources.map(item=>item.name)}))}
    const result=await api('startScreenshot',mode,source?.id);assert.equal(result.ok,true,result.message)
    overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')))
    overlay.on('pageerror',error=>errors.push(error.message));await overlay.locator('.screenshot-editor').waitFor()
    await waitFor(()=>overlay.locator('.screenshot-viewport').evaluate(element=>element.style.cursor!=='progress'))
    if(mode==='Region'){await overlay.mouse.move(140,140);await overlay.mouse.down();await overlay.mouse.move(320,270,{steps:10});await overlay.mouse.up();await overlay.locator('.editor-selection').waitFor()}
  }
  const ready=()=>waitFor(()=>page.getByRole('button',{name:'保存',exact:true}).isEnabled())
  const install=()=>page.evaluate(()=>{
    window.__handoffDocuments=[];window.__handoffSourceIds=[];window.__handoffMode='';window.__handoffBlocked=false
    window.dustdesk.onScreenshotDocument(payload=>window.__handoffDocuments.push({document:payload.document,png:[...payload.png]}))
    const original=window.fetch
    window.fetch=async(input,options)=>{
      const url=typeof input==='string'?input:input.url
      if(url.endsWith('/screenshot_source')&&window.__handoffMode){
        window.__handoffSourceIds.push(JSON.parse(options.body).id)
        const mode=window.__handoffMode;window.__handoffMode=''
        if(mode==='fail')return new Response(JSON.stringify('main screenshot source delivery interrupted'),{status:400,headers:{'Content-Type':'application/json','Tauri-Response':'error'}})
        window.__handoffBlocked=true;await new Promise(resolve=>{window.__releaseHandoff=resolve});window.__handoffBlocked=false
      }
      return original.call(window,input,options)
    }
  })
  const startHeld=async()=>{await start('Window');await page.evaluate(()=>{window.__handoffMode='hold'});await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click();await waitFor(()=>page.evaluate(()=>window.__handoffBlocked));return invoke('screenshot_editor_pending')}
  const release=()=>page.evaluate(()=>window.__releaseHandoff())
  try{
    await scenario('live region transfer preserves editable annotation geometry and performs no implicit disk clipboard or history output',async()=>{
      fixtureWindow=await nativeWindowFixture({title:title,width:700,height:500})
      app=await launchTauri();await app.invoke('prototype_open_workspace');page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,ScreenshotAfterAction:'edit',ScreenshotAutoCopy:true,ScreenshotAutoAddToClipboardHistory:true,ScreenshotDelaySeconds:0}},state);if(!result.ok)throw Error(result.error)})
      await install();clipboard=await clipboardFixture();await clipboard.request('set-text',{text:'DUSTDESK_HANDOFF_NO_IMPLICIT_OUTPUT'})
      const beforeHistory=(await api('loadWorkspace')).ClipboardHistory
      await start();await overlay.getByRole('button',{name:'矩形',exact:true}).click();await overlay.mouse.move(170,170);await overlay.mouse.down();await overlay.mouse.move(260,220,{steps:12});await overlay.mouse.up()
      await waitFor(async()=>Boolean((await metadata()).document.sourceAssetId));const original=(await metadata()).document
      await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined;await ready()
      const received=(await docs()).at(-1);assert.equal((await docs()).length,1)
      assert.notEqual(received.document.id,original.id);assert.notEqual(received.document.sourceAssetId,original.sourceAssetId)
      assert.equal(received.document.sourceRect,undefined);assert.equal(received.document.width,180);assert.equal(received.document.height,130)
      assert.deepEqual(received.document.crop,{x:0,y:0,width:180,height:130});assert.equal(received.document.revision,0)
      assert.equal(received.document.annotations.length,1);assert.deepEqual(received.document.annotations[0].points,[{x:30,y:30},{x:120,y:80}])
      const raw=await page.evaluate(async bytes=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)])),canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return[...context.getImageData(30,30,1,1).data]},received.png)
      assert.deepEqual(raw,[56,178,100,255],'Source must remain unflattened; annotations stay in the editable document')
      assert.equal((await api('readScreenshotDocument',original.id)).ok,false);assert.equal((await api('readScreenshotDocument',received.document.id)).ok,true)
      assert.equal(await invoke('screenshot_editor_pending'),null);assert.deepEqual(await outputs(),[])
      assert.equal((await clipboard.request('inspect')).text,'DUSTDESK_HANDOFF_NO_IMPLICIT_OUTPUT');assert.deepEqual((await api('loadWorkspace')).ClipboardHistory,beforeHistory)
    })
    await scenario('the existing main Worker can move handed annotations undo redo and save actual source pixels',async()=>{
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,ScreenshotAutoCopy:false,ScreenshotAutoAddToClipboardHistory:false}},state);if(!result.ok)throw Error(result.error)})
      await page.getByRole('button',{name:'选择标注',exact:true}).click()
      const point=await page.locator('.screenshot-image').evaluate(canvas=>{const rect=canvas.getBoundingClientRect();return{x:rect.left+30*rect.width/canvas.width,y:rect.top+30*rect.height/canvas.height,scale:rect.width/canvas.width}})
      await page.mouse.move(point.x,point.y);await page.mouse.down();await page.mouse.move(point.x+10*point.scale,point.y+10*point.scale);await page.mouse.up()
      await page.getByRole('button',{name:'撤销',exact:true}).click();await page.getByRole('button',{name:'重做',exact:true}).click()
      await page.getByRole('button',{name:'保存',exact:true}).click();await waitFor(async()=>(await outputs()).length===1)
      const bytes=await readFile(path.join(directory(),(await outputs())[0]));assert.equal(bytes.readUInt32BE(16),180);assert.equal(bytes.readUInt32BE(20),130)
      const actual=await page.evaluate(async bytes=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)])),canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return{red:[...context.getImageData(40,40,1,1).data],old:[...context.getImageData(30,30,1,1).data]}},[...bytes])
      assert.ok(actual.red[0]>150&&actual.red[1]<130);assert.deepEqual(actual.old,[56,178,100,255])
    })
    await scenario('interrupted binary delivery keeps the original overlay retryable and discards only the staged main copy',async()=>{
      const count=(await docs()).length,before=await outputs();await start('Window');const original=(await metadata()).document
      await page.evaluate(()=>{window.__handoffMode='fail'});await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click()
      await overlay.getByRole('alert').filter({hasText:'main screenshot source delivery interrupted'}).waitFor()
      assert.equal(overlay.isClosed(),false);assert.equal((await docs()).length,count);assert.deepEqual(await outputs(),before)
      const failedId=await page.evaluate(()=>window.__handoffSourceIds.at(-1));assert.equal((await api('readScreenshotDocument',failedId)).ok,false)
      assert.ok(await sourceLength(original.id)>0)
      await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined;await ready()
      assert.equal((await docs()).length,count+1);assert.equal((await docs()).at(-1).document.width,700)
    })
    await scenario('only the real main may inspect and acknowledge its exact pending ticket',async()=>{
      const pending=await startHeld();assert.ok(pending.ticket);assert.ok(pending.document.id)
      assert.equal((await api('setWidgetVisibility','todo',true)).ok,true);const widget=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')))
      for(const target of [app.page,widget,overlay])for(const command of ['screenshot_editor_pending','screenshot_editor_received'])await assert.rejects(invoke(command,{ticket:pending.ticket,error:null},target),/not allowed|权限|不允许/i)
      await assert.rejects(invoke('screenshot_editor_received',{ticket:'forged',error:null}),/凭据/);assert.equal((await invoke('screenshot_editor_pending')).ticket,pending.ticket)
      await assert.rejects(invoke('screenshot_overlay_source',{id:pending.document.id},overlay),/权限|会话/)
      await api('setWidgetVisibility','todo',false);await release();await waitFor(()=>overlay.isClosed());overlay=undefined;await ready()
      await assert.rejects(invoke('screenshot_editor_received',{ticket:pending.ticket,error:null}),/凭据/)
    })
    await scenario('a real 15 second delivery timeout retains the original edits and a later explicit retry succeeds',async()=>{
      const before=(await docs()).length,pending=await startHeld(),original=(await metadata()).document
      await overlay.getByRole('alert').filter({hasText:'接收截图超时'}).waitFor({timeout:20000})
      assert.equal(overlay.isClosed(),false);assert.equal((await docs()).length,before);assert.equal((await api('readScreenshotDocument',pending.document.id)).ok,false)
      assert.ok(await sourceLength(original.id)>0)
      await release();await waitFor(()=>page.evaluate(()=>!window.__handoffBlocked))
      await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined;await ready()
      assert.equal((await docs()).length,before+1)
    })
    await scenario('a hidden real main window is restored for acknowledged delivery rather than losing the editor handoff',async()=>{
      const before=(await docs()).length
      await start('Window');await api('hideMainWindow');await page.evaluate(()=>{window.__handoffMode='hold'})
      assert.equal((await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='workspace-main').visible,false)
      await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click();await waitFor(()=>page.evaluate(()=>window.__handoffBlocked))
      assert.equal((await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='workspace-main').visible,true)
      const pending=await invoke('screenshot_editor_pending');assert.ok(pending)
      await release();await waitFor(()=>overlay.isClosed());overlay=undefined;await ready();assert.equal((await docs()).length,before+1)
    })
    await scenario('explicit overlay cancellation revokes pending delivery without replacing the previous main editor',async()=>{
      const before=(await docs()).length,pending=await startHeld(),target=overlay
      await invoke('screenshot_overlay_cancel',{},target).catch(error=>{if(!target.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error})
      await waitFor(()=>target.isClosed());overlay=undefined;await release();await waitFor(()=>page.evaluate(()=>!window.__handoffBlocked))
      assert.equal((await docs()).length,before);assert.equal((await api('readScreenshotDocument',pending.document.id)).ok,false);assert.equal(await invoke('screenshot_editor_pending'),null)
    })
    await scenario('overlay navigation invalidates the old delivery epoch while a newly loaded editor can retry',async()=>{
      const before=(await docs()).length,pending=await startHeld()
      await overlay.reload();await overlay.locator('.screenshot-editor').waitFor();await waitFor(()=>overlay.getByRole('button',{name:'在应用内编辑',exact:true}).isEnabled())
      assert.equal(await invoke('screenshot_editor_pending'),null);assert.equal((await api('readScreenshotDocument',pending.document.id)).ok,false)
      await release();await waitFor(()=>page.evaluate(()=>!window.__handoffBlocked));assert.equal((await docs()).length,before)
      await overlay.getByRole('button',{name:'在应用内编辑',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined;await ready();assert.equal((await docs()).length,before+1)
    })
    await scenario('main reload cancels the original group and both pending authorities without publishing output',async()=>{
      const before=await outputs(),pending=await startHeld(),target=overlay
      await page.reload();await page.locator('.app-shell').waitFor();await waitFor(()=>target.isClosed());overlay=undefined
      assert.equal(await invoke('screenshot_editor_pending'),null);assert.equal((await api('readScreenshotDocument',pending.document.id)).ok,false);assert.deepEqual(await outputs(),before);await install()
    })
    await scenario('fullscreen transfer and identical request replay produce one editable main document',async()=>{
      await start('FullScreen');const original=(await metadata()).document
      const results=await overlay.evaluate(async document=>{const metadata=new TextEncoder().encode(JSON.stringify({requestId:'same-editor-request',document,action:'openEditor',format:'png',pngLength:0,jpegLength:0})),packet=new Uint8Array(4+metadata.length);new DataView(packet.buffer).setUint32(0,metadata.length,true);packet.set(metadata,4);const first=await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_finish',packet);const second=await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_finish',packet);return[first,second]},original)
      assert.ok(results.every(result=>result.ok));await waitFor(()=>overlay.isClosed());overlay=undefined;await ready()
      assert.equal((await docs()).length,1);const received=(await docs())[0].document;assert.equal(received.width,original.width);assert.equal(received.height,original.height)
      assert.equal((await api('readScreenshotDocument',received.id)).ok,true);assert.equal((await api('readScreenshotDocument',original.id)).ok,false);assert.equal((await outputs()).length,1)
    })
    assert.deepEqual(errors,[])
    await writeFile(report,JSON.stringify({verified:true,productionReady:false,migrationComplete:false,evidence,errors,pending:['pins-and-reedit','complete-maintenance-quit-checkpoints','physical-mixed-DPI-IME-hotplug','Release-performance-and-package']},null,2))
  }catch(error){failed=true;await writeFile(report,JSON.stringify({verified:false,productionReady:false,migrationComplete:false,evidence,errors,failure:String(error),root:app?.root},null,2));throw error}
  finally{try{if(clipboard)await clipboard.close()}finally{try{if(fixtureWindow)await fixtureWindow.close()}finally{if(app)await app.close({preserve:failed})}}}
})
