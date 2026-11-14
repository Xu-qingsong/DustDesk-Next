import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises'
import path from 'node:path'
import { nativeWindowFixture } from './native-window-fixture.mjs'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {clipboardFixture} from './tauri-clipboard-support.mjs'

const report='artifacts/tauri-migration/region-capture-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('live native region selectors capture only confirmed pixels and preserve shared editing',{timeout:180000},async suite=>{
  let app,page,fixtureWindow,overlay,clipboard,failed=false
  const evidence=[],errors=[]
  const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
  const invoke=(command,args={},target=page)=>app.invoke(command,args,target)
  const scenario=async(name,callback)=>{await suite.test(name,{timeout:45000},async()=>{try{await callback();evidence.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Region capture failed: '+name)}
  const start=async()=>{
    const result=await api('startScreenshot','Region');assert.equal(result.ok,true,result.message)
    const overlays=await waitFor(()=>{const pages=app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('capture.html'));return pages.length?pages:undefined})
    overlay=overlays[0];overlay.on('pageerror',error=>errors.push(error.message));await overlay.locator('.region-live-selector').waitFor()
    await waitFor(()=>overlay.locator('.screenshot-viewport').evaluate(element=>element.style.cursor!=='progress'))
    return overlays
  }
  const metadata=()=>invoke('screenshot_overlay_document',{},overlay)
  const nativeSelect=rect=>invoke('screenshot_overlay_region',{rect},overlay)
  const bytes=id=>overlay.evaluate(async id=>[...new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_source',{id}))],id)
  const pixels=value=>page.evaluate(async bytes=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)]));const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return{width:canvas.width,height:canvas.height,center:[...context.getImageData(Math.floor(canvas.width/2),Math.floor(canvas.height/2),1,1).data]}},value)
  const cancel=async()=>{const targets=app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('capture.html')),target=overlay;await invoke('screenshot_overlay_cancel',{},target).catch(error=>{if(!target.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error});await waitFor(()=>targets.every(target=>target.isClosed()));overlay=undefined}
  const selectWithMouse=async({automatic=false}={})=>{await overlay.mouse.move(140,140);await overlay.mouse.down();await overlay.mouse.move(320,270,{steps:12});await overlay.mouse.up();if(!automatic)await overlay.locator('.editor-selection').waitFor()}
  try{
    await scenario('all real monitor selectors start live with no source image or implicit capture',async()=>{
      fixtureWindow=await nativeWindowFixture({title:'DustDesk 区域参考',width:700,height:500})
      app=await launchTauri();await app.invoke('prototype_open_workspace');page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,ScreenshotAutoCopy:false,ScreenshotAutoAddToClipboardHistory:false,ScreenshotAfterAction:'edit',ScreenshotDelaySeconds:0}},state);if(!result.ok)throw Error(result.error)})
      await app.browser.contexts()[0].addInitScript(()=>{window.__regionCalls=[];const original=window.fetch;window.fetch=async(input,options)=>{const url=typeof input==='string'?input:input.url;window.__regionCalls.push(url);return original.call(window,input,options)}})
      const monitors=(await app.invoke('prototype_diagnostics')).monitors
      const overlays=await start();assert.equal(overlays.length,monitors.length)
      for(const target of overlays){const state=await invoke('screenshot_overlay_document',{},target);assert.equal(state.liveRegion,true);assert.equal(state.document.sourceAssetId,'');assert.equal(state.document.sourceRect,undefined);assert.ok(state.placement.width>0);await assert.rejects(invoke('screenshot_overlay_source',{id:state.document.id},target),/会话|请求/)}
      await selectWithMouse();assert.equal((await metadata()).document.sourceAssetId,'')
      assert.equal(await overlay.evaluate(()=>window.__regionCalls.filter(url=>url.endsWith('/screenshot_overlay_region')).length),0)
    })
    await scenario('invalid and foreign selectors cannot capture outside their own physical monitor',async()=>{
      for(const rect of [{x:-1,y:0,width:10,height:10},{x:0,y:0,width:1,height:10},{x:100000,y:0,width:10,height:10},{x:0,y:0,width:10,height:100000}])await assert.rejects(nativeSelect(rect),/区域|选区/)
      for(const target of [app.page,page])await assert.rejects(invoke('screenshot_overlay_region',{rect:{x:0,y:0,width:10,height:10}},target),/not allowed|权限|不允许/i)
      assert.equal((await metadata()).document.sourceAssetId,'')
    })
    await scenario('native selected pixels exclude the actual overlay and later capture preserves prior source authority',async()=>{
      const first=await nativeSelect({x:150,y:150,width:100,height:80});assert.ok(first.document.sourceRect)
      const firstPixels=await pixels(await bytes(first.document.id));assert.deepEqual(firstPixels.center,[56,178,100,255])
      assert.equal(firstPixels.width,first.document.sourceRect.width);assert.equal(firstPixels.height,first.document.sourceRect.height)
      assert.equal(first.document.width,(await metadata()).document.width)
      const second=await nativeSelect({x:160,y:160,width:120,height:100});assert.notEqual(first.document.id,second.document.id)
      assert.deepEqual(await pixels(await bytes(first.document.id)),firstPixels)
      await assert.rejects(invoke('screenshot_overlay_adopt',{id:first.document.id},overlay),/改变/)
      assert.deepEqual(await pixels(await bytes(first.document.id)),firstPixels)
      await invoke('screenshot_overlay_adopt',{id:second.document.id},overlay)
      await assert.rejects(bytes(first.document.id),/会话/)
      assert.equal((await api('readScreenshotDocument',second.document.id)).ok,false)
      for(let iteration=0;iteration<66;iteration++){const captured=await nativeSelect({x:160,y:160,width:20,height:20});await bytes(captured.document.id);await invoke('screenshot_overlay_adopt',{id:captured.document.id},overlay)}
      await cancel()
    })
    await scenario('shared region editor captures only on confirmation and saves cropped live desktop pixels',async()=>{
      await start();await selectWithMouse()
      const initial=await metadata();assert.equal(initial.document.sourceAssetId,'')
      await overlay.getByRole('button',{name:'保存',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined
      const directory=path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots'),files=await readdir(directory);assert.equal(files.length,1)
      const result=await pixels([...await readFile(path.join(directory,files[0]))]);assert.ok(result.width>100&&result.width<400&&result.height>60&&result.height<300);assert.deepEqual(result.center,[56,178,100,255])
    })
    await scenario('real first-stroke annotation survives capture hide and restore with undo and redo intact',async()=>{
      await start();await selectWithMouse();await overlay.getByRole('button',{name:'矩形',exact:true}).click()
      await overlay.mouse.move(170,170);await overlay.mouse.down();await overlay.mouse.move(260,220,{steps:15});await overlay.mouse.up()
      await waitFor(async()=>Boolean((await metadata()).document.sourceAssetId))
      await waitFor(()=>overlay.getByRole('button',{name:'撤销',exact:true}).isEnabled())
      await overlay.getByRole('button',{name:'撤销',exact:true}).click();await overlay.getByRole('button',{name:'重做',exact:true}).click()
      await overlay.getByRole('button',{name:'保存',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined
      const directory=path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots'),files=await readdir(directory)
      assert.equal(files.length,2)
      const values=await Promise.all(files.map(file=>readFile(path.join(directory,file))))
      const changed=await page.evaluate(async images=>{for(const bytes of images){const image=await createImageBitmap(new Blob([new Uint8Array(bytes)]));const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;let red=0;for(let index=0;index<pixels.length;index+=4)if(pixels[index]>150&&pixels[index+1]<130&&pixels[index+2]<150)red++;if(red>20)return true}return false},values.map(value=>[...value]))
      assert.equal(changed,true,'Saved region must contain the actual first rectangle stroke, not only crop history')
    })
    await scenario('Escape and main reload revoke every real region window without publishing a file',async()=>{
      const overlays=await start();await overlay.keyboard.press('Escape');await waitFor(()=>overlays.every(target=>target.isClosed()));overlay=undefined
      const again=await start();await page.reload();await page.locator('.app-shell').waitFor();await waitFor(()=>again.every(target=>target.isClosed()));overlay=undefined
      await start();await cancel()
    })
    await scenario('failed region binary delivery retains a retryable selection and does not publish an output',async()=>{
      const directory=path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots'),before=await readdir(directory)
      await start();await selectWithMouse()
      await overlay.evaluate(()=>{const original=window.fetch;let fail=true;window.fetch=async(input,options)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/screenshot_overlay_source')&&fail){fail=false;return new Response(JSON.stringify('region source delivery interrupted'),{status:400,headers:{'Content-Type':'application/json','Tauri-Response':'error'}})}return original.call(window,input,options)}})
      await overlay.getByRole('button',{name:'保存',exact:true}).click();await overlay.getByText('region source delivery interrupted',{exact:true}).waitFor()
      assert.deepEqual(await readdir(directory),before)
      const retained=(await metadata()).document;assert.ok(retained.sourceAssetId);assert.ok((await bytes(retained.id)).length>0)
      await overlay.getByRole('button',{name:'保存',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined
      assert.equal((await readdir(directory)).length,before.length+1)
    })
    await scenario('configured region copy waits for selection confirmation and copies only selected pixels',async()=>{
      clipboard=await clipboardFixture()
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,ScreenshotAfterAction:'copy'}},state);if(!result.ok)throw Error(result.error)})
      await start();assert.equal((await metadata()).document.sourceAssetId,'');assert.match(await overlay.locator('.screenshot-feedback').innerText(),/拖动框选区域/)
      assert.equal(await overlay.evaluate(()=>window.__regionCalls.filter(url=>url.endsWith('/screenshot_overlay_region')).length),0)
      await selectWithMouse({automatic:true});await waitFor(()=>overlay.isClosed());overlay=undefined
      const actual=await clipboard.request('inspect');assert.ok(actual.image.width>100&&actual.image.width<400);assert.ok(actual.image.height>60&&actual.image.height<300);assert.deepEqual(actual.image.first,[56,178,100,255])
      await clipboard.close();clipboard=undefined
    })
    await scenario('configured region pin captures only confirmed pixels and creates an independently readable native pin',async()=>{
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,ScreenshotAfterAction:'pin'}},state);if(!result.ok)throw Error(result.error)})
      await start();assert.equal((await metadata()).document.sourceAssetId,'');assert.equal(app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('pin.html')).length,0)
      await selectWithMouse({automatic:true});await waitFor(()=>overlay.isClosed());overlay=undefined
      const pin=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('pin.html'))),id=new URL(pin.url()).searchParams.get('pin')
      await pin.getByAltText('贴图',{exact:true}).waitFor();await waitFor(()=>pin.getByAltText('贴图',{exact:true}).evaluate(image=>image.complete&&image.naturalWidth>0))
      const source=await pin.evaluate(async id=>[...new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_pin_source',{id,version:0}))],id),actual=await pixels(source)
      assert.ok(actual.width>100&&actual.width<400);assert.ok(actual.height>60&&actual.height<300);assert.deepEqual(actual.center,[56,178,100,255])
      await invoke('screenshot_pin_control',{id,action:'close',value:null},pin).catch(error=>{if(!pin.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error});await waitFor(()=>pin.isClosed())
    })
    assert.deepEqual(errors,[])
    await writeFile(report,JSON.stringify({verified:true,productionReady:false,evidence,errors,pending:['physical-mixed-DPI-multi-monitor-IME-hotplug','pin-openEditor-maintenance-quit-participation','Release-performance-and-package']},null,2))
  }catch(error){failed=true;await writeFile(report,JSON.stringify({verified:false,productionReady:false,evidence,errors,failure:String(error),root:app?.root},null,2));throw error}
  finally{try{if(clipboard)await clipboard.close()}finally{try{if(fixtureWindow)await fixtureWindow.close()}finally{if(app)await app.close({preserve:failed})}}}
})
