import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import path from 'node:path'
import { nativeWindowFixture } from './native-window-fixture.mjs'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {operateDialog} from './tauri-dialog.mjs'
import {clipboardFixture,holdClipboard} from './tauri-clipboard-support.mjs'

const report='artifacts/tauri-migration/capture-overlay-native.json'
await mkdir(path.dirname(report),{recursive:true}); await rm(report,{force:true})
await test('business window and fullscreen captures use isolated owned overlays and real shared Worker output',{timeout:180000},async suite=>{
  let app,page,fixtureWindow,overlay,source,clipboard,failed=false
  const evidence=[],errors=[]
  const title='DustDesk 业务截图参考 🖼️'
  const scenario=async(name,callback)=>{await suite.test(name,{timeout:45000},async()=>{try{await callback();evidence.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Capture overlay failed: '+name)}
  const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
  const invoke=(command,args={},target=page)=>app.invoke(command,args,target)
  const settings=patch=>page.evaluate(async patch=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,...patch}},state);if(!result.ok)throw Error(result.error)},patch)
  const start=async(mode='Window')=>{
    const result=await api('startScreenshot',mode,mode==='Window'?source.id:undefined);assert.equal(result.ok,true,JSON.stringify(result))
    overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')))
    overlay.on('pageerror',error=>errors.push(error.message));await overlay.locator('.screenshot-editor').waitFor()
    await waitFor(()=>overlay.getByRole('button',{name:'保存',exact:true}).isEnabled())
    return overlay
  }
  const cancel=async()=>{await invoke('screenshot_overlay_cancel',{},overlay);await waitFor(()=>overlay.isClosed());overlay=undefined}
  const payload=()=>invoke('screenshot_overlay_document',{},overlay)
  const finish=(metadata,action='saveAs')=>overlay.evaluate(async({metadata,action})=>{
    const bytes=new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_source',{id:metadata.document.id}))
    const json=new TextEncoder().encode(JSON.stringify({requestId:crypto.randomUUID(),document:metadata.document,action,format:'png',pngLength:bytes.length,jpegLength:0}))
    const packet=new Uint8Array(4+json.length+bytes.length);new DataView(packet.buffer).setUint32(0,json.length,true);packet.set(json,4);packet.set(bytes,4+json.length)
    return window.__TAURI_INTERNALS__.invoke('screenshot_overlay_finish',packet)
  },{metadata,action})
  try{
    await scenario('native business startup and genuine window chooser preserve native window content',async()=>{
      fixtureWindow=await nativeWindowFixture({title:title,width:480,height:320,x:90,y:90,split:true})
      app=await launchTauri();await app.invoke('prototype_open_workspace');page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
      await settings({AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,ScreenshotAfterAction:'edit',ScreenshotAutoCopy:false,ScreenshotAutoAddToClipboardHistory:false,ScreenshotDelaySeconds:0})
      source=(await api('listScreenshotWindows')).sources.find(target=>target.name===title);assert.ok(source)
      await page.getByRole('button',{name:'截图编辑',exact:true}).click();await page.getByRole('button',{name:'窗口',exact:true}).click();await page.getByRole('button',{name:'开始捕获',exact:true}).click()
      await page.getByRole('dialog',{name:'选择截图窗口'}).getByRole('button',{name:title,exact:true}).click()
      overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')));await overlay.locator('.screenshot-editor').waitFor()
      source=(await api('listScreenshotWindows')).sources.find(target=>target.name===title);assert.ok(source)
    })
    await scenario('overlay has no main workspace path clipboard picker or other-source authority',async()=>{
      const own=await payload();assert.ok(own.document.id)
      assert.deepEqual(Object.keys(own.settings).sort(),['ScreenshotAfterAction','ScreenshotFormat'])
      assert.equal((await api('readScreenshotDocument',own.document.id)).ok,false)
      await assert.rejects(api('discardScreenshotDocument',own.document.id),/权限/)
      for(const command of ['workspace_load','workspace_save','clipboard_read','screenshot_start','screenshot_windows','screenshot_document','screenshot_finish','system_pick','application_quit'])await assert.rejects(invoke(command,{},overlay),/not allowed|权限|不允许/i)
      for(const command of ['screenshot_overlay_document','screenshot_overlay_source','screenshot_overlay_finish','screenshot_overlay_cancel'])await assert.rejects(invoke(command,{},app.page),/not allowed|权限|不允许/i)
      await assert.rejects(invoke('screenshot_overlay_source',{id:own.document.sourceAssetId},overlay),/会话|权限/)
      assert.equal((await api('startScreenshot','FullScreen')).ok,false)
      await waitFor(()=>overlay.getByRole('button',{name:'保存',exact:true}).isEnabled())
      const checkpoint=await invoke('drafts_prepare');await overlay.locator('[data-checkpoint="frozen"]').waitFor()
      await invoke('drafts_end',{requestId:checkpoint.requestId});await waitFor(()=>overlay.locator('[data-checkpoint="frozen"]').count().then(count=>count===0))
      await assert.rejects(invoke('workspace_backup_restore'),/截图/)
      await cancel();assert.equal((await api('readScreenshotDocument',own.document.id)).ok,false)
      const stale=await api('startScreenshot','Window',source.id);assert.equal(stale.ok,false);assert.match(stale.message,/列表已过期/)
      source=(await api('listScreenshotWindows')).sources.find(target=>target.name===title);assert.ok(source)
    })
    await scenario('real Save As cancellation retains the overlay and unchanged original source',async()=>{
      await start();const metadata=await payload();const pending=finish(metadata);void pending.catch(()=>undefined)
      await operateDialog(app,'另存为截图','cancel')
      const result=await pending;assert.equal(result.canceled,true);assert.equal(overlay.isClosed(),false)
      assert.deepEqual((await payload()).document,metadata.document)
    })
    await scenario('shared editor Worker saves the exact native pixels then releases its real window and source',async()=>{
      const metadata=await payload();await waitFor(()=>overlay.getByRole('button',{name:'保存',exact:true}).isEnabled())
      await overlay.getByRole('button',{name:'保存',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined
      const files=await import('node:fs/promises').then(fs=>fs.readdir(path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots')).catch(()=>[]))
      assert.equal(files.length,1)
      const png=await readFile(path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots',files[0]));assert.equal(png.readUInt32BE(16),metadata.document.width);assert.equal(png.readUInt32BE(20),metadata.document.height)
      const pixels=await page.evaluate(async bytes=>{const bitmap=await createImageBitmap(new Blob([new Uint8Array(bytes)]));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');context.drawImage(bitmap,0,0);bitmap.close();return [.25,.75].map(position=>[...context.getImageData(Math.floor(canvas.width*position),Math.floor(canvas.height*.5),1,1).data])},[...png])
      assert.deepEqual(pixels,[[56,178,100,255],[199,70,58,255]])
      assert.equal((await api('readScreenshotDocument',metadata.document.id)).ok,false)
    })
    await scenario('fullscreen uses the native monitor pixels and Escape destroys only its own overlay',async()=>{
      await start('FullScreen');const metadata=await payload();assert.ok(metadata.document.width>=1280&&metadata.document.height>=720)
      await overlay.keyboard.press('Escape');await waitFor(()=>overlay.isClosed());overlay=undefined
      assert.equal(await page.locator('.app-shell').count(),1)
    })
    await scenario('configured automatic copy uses real clipboard effects and a locked clipboard leaves edits retryable',async()=>{
      clipboard=await clipboardFixture()
      await settings({ScreenshotAfterAction:'copy'})
      const held=await holdClipboard()
      try{
        const result=await api('startScreenshot','Window',source.id);assert.equal(result.ok,true,result.message)
        overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')))
        await overlay.locator('.screenshot-editor').waitFor();await overlay.getByText(/剪贴板/).waitFor();assert.equal(overlay.isClosed(),false)
      }finally{await held()}
      const expected=await overlay.evaluate(async()=>{const metadata=await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_document');const png=await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_source',{id:metadata.document.id});const image=await createImageBitmap(new Blob([png]));const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return{width:canvas.width,height:canvas.height,first:[...context.getImageData(0,0,1,1).data]}})
      await overlay.getByRole('button',{name:'复制',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined
      const actual=await clipboard.request('inspect');assert.ok(actual.image.width>0&&actual.image.height>0)
      assert.deepEqual(actual.image,expected)
      await clipboard.close();clipboard=undefined
      await settings({ScreenshotAfterAction:'edit'})
    })
    await scenario('refreshing the source list during the configured native delay revokes the pending source',async()=>{
      await settings({ScreenshotDelaySeconds:2})
      const pending=api('startScreenshot','Window',source.id);void pending.catch(()=>undefined)
      await new Promise(resolve=>setTimeout(resolve,100))
      source=(await api('listScreenshotWindows')).sources.find(target=>target.name===title);assert.ok(source)
      assert.equal((await pending).ok,false)
      assert.equal(app.browser.contexts().flatMap(context=>context.pages()).some(target=>target.url().includes('capture.html')),false)
      await settings({ScreenshotDelaySeconds:0})
    })
    await scenario('main reload revokes owned windows and delay remains native bounded and single-flight',async()=>{
      await start();const old=overlay;await page.reload();await page.locator('.app-shell').waitFor();await waitFor(()=>old.isClosed());overlay=undefined
      source=(await api('listScreenshotWindows')).sources.find(target=>target.name===title);assert.ok(source)
      await settings({ScreenshotDelaySeconds:.5});const began=Date.now();const pending=api('startScreenshot','Window',source.id);void pending.catch(()=>undefined)
      await new Promise(resolve=>setTimeout(resolve,50));assert.equal((await api('startScreenshot','Window',source.id)).ok,false)
      assert.equal((await pending).ok,true);assert.ok(Date.now()-began>=450)
      overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')));await overlay.locator('.screenshot-editor').waitFor();await cancel()
      await settings({ScreenshotDelaySeconds:0,ScreenshotAfterAction:'pin'});const pinned=await api('startScreenshot','Window',source.id);assert.equal(pinned.ok,true)
      const pin=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('pin.html')));await pin.getByAltText('贴图',{exact:true}).waitFor();await waitFor(()=>pin.getByAltText('贴图',{exact:true}).evaluate(image=>image.complete&&image.naturalWidth>0))
      await waitFor(()=>!app.browser.contexts().flatMap(context=>context.pages()).some(target=>target.url().includes('capture.html')))
      await pin.getByRole('button',{name:'关闭贴图',exact:true}).click();await waitFor(()=>pin.isClosed())
      await settings({ScreenshotAfterAction:'edit'});assert.equal((await api('startScreenshot','invalid-mode')).ok,false)
    })
    await scenario('reloading main cancels a real overlay-owned save picker without publishing another file',async()=>{
      const fs=await import('node:fs/promises'),directory=path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots')
      const before=await fs.readdir(directory)
      await start();const metadata=await payload();const pending=finish(metadata).then(value=>({value}),error=>({error:String(error)}))
      await operateDialog(app,'另存为截图','visible')
      const old=overlay;await page.reload();await page.locator('.app-shell').waitFor();await waitFor(()=>old.isClosed());overlay=undefined
      const result=await pending;assert.ok(result.error||result.value?.ok!==true)
      assert.deepEqual(await fs.readdir(directory),before)
      source=(await api('listScreenshotWindows')).sources.find(target=>target.name===title);assert.ok(source)
      await start();await cancel()
    })
    await scenario('closing an overlay cannot cancel a different main-owned native picker',async()=>{
      await start()
      const pending=invoke('system_pick',{folder:false,title:'主窗口权限验证'});void pending.catch(()=>undefined)
      await operateDialog(app,'主窗口权限验证','visible')
      await cancel()
      await operateDialog(app,'主窗口权限验证','visible')
      await operateDialog(app,'主窗口权限验证','cancel');assert.equal((await pending).canceled,true)
    })
    await scenario('a transient first source delivery failure preserves the owned document for explicit retry',async()=>{
      await app.browser.contexts()[0].addInitScript(()=>{
        const original=window.fetch;let interrupted=false
        window.fetch=async(input,options)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/screenshot_overlay_source')&&!interrupted){interrupted=true;return new Response(JSON.stringify('capture source delivery interrupted'),{status:400,headers:{'Content-Type':'application/json','Tauri-Response':'error'}})}return original.call(window,input,options)}
      })
      assert.equal((await api('startScreenshot','Window',source.id)).ok,true)
      overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')))
      await overlay.getByRole('alert').filter({hasText:'capture source delivery interrupted'}).waitFor()
      const before=await payload()
      await overlay.getByRole('button',{name:'重试读取',exact:true}).click();await overlay.locator('.screenshot-editor').waitFor()
      assert.deepEqual((await payload()).document,before.document)
      await cancel()
    })
    assert.deepEqual(errors,[])
    await writeFile(report,JSON.stringify({verified:true,productionReady:false,evidence,errors,pending:['physical-DPI-IME-Release-performance-packaging']},null,2))
  }catch(error){
    failed=true
    const diagnostics={verified:false,productionReady:false,evidence,errors,failure:String(error),root:app?.root,output:app?.output(),pages:await Promise.all((app?.browser.contexts().flatMap(context=>context.pages())??[]).map(async target=>({url:target.url(),text:await target.locator('body').innerText({timeout:2000}).then(text=>text.slice(0,8000)).catch(()=>'<unavailable>')})))}
    await writeFile(report,JSON.stringify(diagnostics,null,2))
    await writeFile('artifacts/tauri-migration/capture-overlay-failure-'+Date.now()+'.json',JSON.stringify(diagnostics,null,2))
    throw error
  }
  finally{try{if(clipboard)await clipboard.close()}finally{try{if(fixtureWindow)await fixtureWindow.close()}finally{if(app)await app.close({preserve:failed})}}}
})
