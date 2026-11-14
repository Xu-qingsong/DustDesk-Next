import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {clipboardFixture} from './tauri-clipboard-support.mjs'
import {operateDialog} from './tauri-dialog.mjs'

const run=promisify(execFile),report='artifacts/tauri-migration/pins-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('native business pins preserve editable sources and owner-only pixels across actual window controls and reediting',{timeout:240000},async suite=>{
  let app,page,pin,pinId,other,otherId,overlay,clipboard,failed=false,reference
  const evidence=[],errors=[],trayClicks=[]
  const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
  const invoke=(command,args={},target=page)=>app.invoke(command,args,target)
  const scenario=async(name,callback)=>{await suite.test(name,{timeout:45000},async()=>{try{await callback();evidence.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Native pin failed: '+name)}
  const pins=()=>app.browser.contexts().flatMap(context=>context.pages()).filter(target=>target.url().includes('pin.html'))
  const info=(target=pin,id=pinId)=>invoke('screenshot_pin_info',{id},target)
  const control=(action,value,target=pin,id=pinId)=>invoke('screenshot_pin_control',{id,action,value:value??null},target)
  const bytes=(target=pin,id=pinId,version)=>target.evaluate(async({id,version})=>[...new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_pin_source',{id,version}))],{id,version})
  const outputDirectory=()=>path.join(app.root,'user-data','tauri-preview','Workspace','Screenshots')
  const outputs=()=>readdir(outputDirectory()).catch(()=>[])
  const loaded=async target=>{target.on('pageerror',error=>errors.push(error.message));await target.getByAltText('贴图',{exact:true}).waitFor();await waitFor(()=>target.getByAltText('贴图',{exact:true}).evaluate(image=>image.complete&&image.naturalWidth===160));if(await target.getByRole('alert').count())await target.getByRole('button',{name:'重试读取',exact:true}).click();await waitFor(async()=>await target.getByRole('alert').count()===0)}
  const create=async requestId=>page.evaluate(async requestId=>{const payload=window.__nativePinPayload;return window.dustdesk.finishScreenshot({requestId,document:payload.document,action:'pin',png:payload.png,format:'png'})},requestId)
  const reedit=async()=>{await control('edit');overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')));overlay.on('pageerror',error=>errors.push(error.message));const metadata=await invoke('screenshot_overlay_document',{},overlay);console.log('Reedit native metadata',JSON.stringify(metadata));await waitFor(async()=>{const alerts=await overlay.getByRole('alert').allTextContents();if(alerts.length)throw Error(alerts.join(';'));return await overlay.getByRole('button',{name:'更新贴图',exact:true}).count()&&await overlay.getByRole('button',{name:'更新贴图',exact:true}).isEnabled()});return metadata}
  const cancelEditor=async()=>{const target=overlay;await invoke('screenshot_overlay_cancel',{},target).catch(error=>{if(!target.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error});await waitFor(()=>target.isClosed());overlay=undefined}
  const save=async(target=pin,id=pinId,version)=>target.evaluate(async({id,version})=>{const image=new Image();image.src=document.querySelector('.pinned-screenshot img').src;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext('2d').drawImage(image,0,0);const jpeg=new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.92))).arrayBuffer()),metadata=new TextEncoder().encode(JSON.stringify({id,version})),packet=new Uint8Array(4+metadata.length+jpeg.length);new DataView(packet.buffer).setUint32(0,metadata.length,true);packet.set(metadata,4);packet.set(jpeg,4+metadata.length);return window.__TAURI_INTERNALS__.invoke('screenshot_pin_save',packet)},{id,version})
  const nativeMenu=async caption=>{const parameters=Buffer.from(JSON.stringify({processId:app.child.pid,caption,script:path.resolve('tests/tauri-pin-menu.ps1')})).toString('base64'),command="$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+parameters+"'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Caption $parameters.caption";return(await run('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:20000})).stdout.trim()}
  const nativeTray=async(...captions)=>{const parameters=Buffer.from(JSON.stringify({processId:app.child.pid,captions:['截图贴图',...captions],script:path.resolve('tests/tauri-pin-tray.ps1')})).toString('base64'),command="$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+parameters+"'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Captions @($parameters.captions)";const result=JSON.parse((await run('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:30000})).stdout.trim());trayClicks.push(result);return result}
  try{
    await scenario('main creates one independent native pin and identical request replay cannot duplicate it or publish a file',async()=>{
      app=await launchTauri();await app.invoke('prototype_open_workspace');page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      page.on('pageerror',error=>errors.push(error.message));await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
      reference=await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const saved=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,ScreenshotAutoCopy:false,ScreenshotAutoAddToClipboardHistory:false,ScreenshotAfterAction:'edit',PinnedImageOpacityPercent:100,PinnedImageTopmost:true,PinnedImageMouseThrough:false}},state);if(!saved.ok)throw Error(saved.error);const canvas=document.createElement('canvas');canvas.width=160;canvas.height=100;canvas.getContext('2d').fillStyle='#38b264';canvas.getContext('2d').fillRect(0,0,160,100);const png=new Uint8Array(await(await new Promise(resolve=>canvas.toBlob(resolve))).arrayBuffer()),created=await window.dustdesk.createScreenshotDocument(png);if(!created.ok)throw Error(created.error);window.__nativePinPayload=created.payload;return[...png]})
      const first=await create('pin-once');assert.equal(first.ok,true,JSON.stringify(first));assert.ok(first.pinId);pinId=first.pinId
      pin=await waitFor(()=>pins().find(target=>new URL(target.url()).searchParams.get('pin')===pinId));await loaded(pin)
      assert.deepEqual(await create('pin-once'),first);assert.equal(pins().length,1);assert.equal((await info()).version,0)
      assert.deepEqual(await bytes(pin,pinId,0),reference);assert.deepEqual(await outputs(),[])
      await page.evaluate(async()=>{const payload=window.__nativePinPayload;await window.dustdesk.discardScreenshotDocument(payload.document.id)})
    })
    await scenario('another native pin and non-pin roles cannot read control save or impersonate this owner',async()=>{
      await page.evaluate(async bytes=>{window.__nativePinPayload=(await window.dustdesk.createScreenshotDocument(new Uint8Array(bytes))).payload},reference)
      const result=await create('second-pin');assert.equal(result.ok,true,JSON.stringify(result));otherId=result.pinId;other=await waitFor(()=>pins().find(target=>new URL(target.url()).searchParams.get('pin')===otherId));await loaded(other)
      for(const target of [app.page,page,other])await assert.rejects(invoke('screenshot_pin_info',{id:pinId},target),/not allowed|权限|不是贴图|贴图已关闭/i)
      for(const command of ['workspace_load','workspace_save','clipboard_read','screenshot_source','screenshot_create','screenshot_finish','screenshot_start','screenshot_editor_pending','system_pick','application_quit'])await assert.rejects(invoke(command,{},pin),/not allowed|权限|不允许/i)
      await assert.rejects(invoke('plugin:event|listen',{event:'workspace:snapshot',target:{kind:'Any'},handler:0},pin),/not allowed|权限|不允许/i)
      await assert.rejects(control('close',undefined,other,pinId),/权限/)
      await assert.rejects(invoke('screenshot_pin_source',{id:pinId,version:99},pin),/更新/)
      await assert.rejects(control('options',{opacity:'not-a-number'}),/invalid|无效/i)
    })
    await scenario('native channel replacement rejects stale and foreign detach tokens and cannot redirect private events',async()=>{
      const attach=(target,name)=>target.evaluate(async name=>{window[name]=[];const callback=window.__TAURI_INTERNALS__.transformCallback(frame=>{if(frame.message)window[name].push(frame.message)});return window.__TAURI_INTERNALS__.invoke('screenshot_pin_attach',{channel:'__CHANNEL__:'+callback,label:'workspace-main',target:{kind:'Any'}})},name)
      for(const target of [app.page,page])await assert.rejects(invoke('screenshot_pin_attach',{channel:'__CHANNEL__:1'},target),/not allowed|权限|不允许/i)
      const stale=await attach(pin,'__oldPinPackets'),current=await attach(pin,'__newPinPackets'),foreign=await attach(other,'__otherPinPackets');assert.notEqual(stale,current)
      await invoke('screenshot_pin_detach',{token:stale},pin);await invoke('screenshot_pin_detach',{token:current},other);await invoke('screenshot_pin_detach',{token:foreign},pin)
      await control('options',{opacity:80});await waitFor(()=>pin.evaluate(()=>window.__newPinPackets.length===1))
      assert.deepEqual(await pin.evaluate(()=>window.__oldPinPackets),[]);assert.deepEqual(await other.evaluate(()=>window.__otherPinPackets),[])
      assert.deepEqual(await pin.evaluate(()=>window.__newPinPackets.map(packet=>({event:packet.event,token:packet.token}))),[{event:'pin:changed',token:current}])
      await control('options',{opacity:90},other,otherId);await waitFor(()=>other.evaluate(()=>window.__otherPinPackets.length===1))
      await pin.reload();await loaded(pin);await other.reload();await loaded(other);await control('options',{opacity:100});await control('options',{opacity:100},other,otherId)
    })
    await scenario('actual copy preserves pixels while wheel scaling opacity lock and click-through change only native presentation',async()=>{
      clipboard=await clipboardFixture();await control('copy');const actual=await clipboard.request('inspect');assert.deepEqual(actual.image,{width:160,height:100,first:[56,178,100,255]})
      await pin.mouse.move(60,50);await pin.mouse.wheel(0,-120);await waitFor(async()=>(await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='screenshot-pin-'+pinId).width>160)
      await control('options',{opacity:30,topmost:false,locked:true,mouseThrough:true})
      const before=(await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='screenshot-pin-'+pinId);assert.equal(before.opacity,77);assert.equal(before.alwaysOnTop,false);assert.equal(before.mouseThrough,true)
      await control('move',{x:300,y:300});await control('resize',{width:500,height:300});const after=(await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='screenshot-pin-'+pinId)
      assert.deepEqual([after.x,after.y,after.width,after.height],[before.x,before.y,before.width,before.height]);assert.deepEqual(await bytes(pin,pinId,0),reference)
      await app.invoke('prototype_restore_windows');const restored=await info();assert.equal(restored.opacity,100);assert.equal(restored.locked,false);assert.equal(restored.mouseThrough,false)
      const flags=(await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='screenshot-pin-'+pinId);assert.equal(flags.opacity,255);assert.equal(flags.mouseThrough,false)
      await control('move',{x:100,y:90});await control('resize',{width:320,height:200});await waitFor(async()=>(await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='screenshot-pin-'+pinId).width===320)
    })
    await scenario('real native pin menu dispatches exactly one toggle through the shared tray menu handler',async()=>{
      const pending=control('menu');const listed=JSON.parse(await nativeMenu(''));assert.ok(listed.some(item=>item.name==='重新编辑'));await nativeMenu('置顶');await pending
      await waitFor(async()=>(await info()).topmost===true)
      await new Promise(resolve=>setTimeout(resolve,200));assert.equal((await info()).topmost,true,'A duplicated global/window menu listener must not undo the toggle')
    })
    await scenario('the shared pin keyboard save uses the existing Worker and native picker can cancel or save an exact PNG',async()=>{
      await pin.evaluate(()=>{window.__pinSaves=[];const original=window.fetch;window.fetch=async(input,options)=>{const url=typeof input==='string'?input:input.url;if(!url.endsWith('/screenshot_pin_save'))return original.call(window,input,options);const record={started:Date.now()};window.__pinSaves.push(record);try{return await original.call(window,input,options)}finally{record.finished=Date.now()}}})
      await other.evaluate(()=>{window.__foreignPinSaves=0;const original=window.fetch;window.fetch=async(input,options)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/screenshot_pin_save'))window.__foreignPinSaves++;return original.call(window,input,options)}})
      await pin.keyboard.press('Control+s');console.log('Pin save keyboard dispatched');await operateDialog(app,'另存为截图','cancel');console.log('Pin save keyboard picker cancelled');await waitFor(()=>pin.evaluate(()=>window.__pinSaves.length===1&&window.__pinSaves[0].finished));assert.equal(await pin.getByRole('alert').count(),0);assert.equal(await other.evaluate(()=>window.__foreignPinSaves),0,'Another pin must not receive this pin save event')
      assert.deepEqual(await outputs(),[]);const target=path.join(app.root,'贴图保存🪶.png'),pending=save(pin,pinId,0)
      console.log('Pin binary save dispatched',target);await operateDialog(app,'另存为截图','select',target);console.log('Pin binary save picker selected');const result=await Promise.race([pending,new Promise((resolve,reject)=>setTimeout(()=>reject(Error('Native selected pin save did not settle')),10000))]);console.log('Pin binary save settled',result);assert.equal(result.ok,true,JSON.stringify(result));assert.deepEqual([...await readFile(target)],reference)
      assert.equal((await info()).version,0);assert.deepEqual(await outputs(),[])
    })
    await scenario('the shared pin Worker saves a real JPEG under the configured default format',async()=>{
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,ScreenshotFormat:'jpg'}},state);if(!result.ok)throw Error(result.error)})
      const target=path.join(app.root,'贴图默认格式.jpg');await pin.keyboard.press('Control+s');await operateDialog(app,'另存为截图','select',target)
      await waitFor(()=>pin.evaluate(()=>window.__pinSaves.length===3&&window.__pinSaves.every(record=>record.finished)))
      const jpeg=await readFile(target);assert.deepEqual([...jpeg.subarray(0,3)],[255,216,255])
      const actual=await page.evaluate(async bytes=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)]));const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return{width:canvas.width,height:canvas.height,pixel:[...context.getImageData(50,50,1,1).data]}},[...jpeg])
      assert.equal(actual.width,160);assert.equal(actual.height,100);assert.ok(actual.pixel.every((value,index)=>Math.abs(value-[56,178,100,255][index])<=3));assert.equal(await pin.getByRole('alert').count(),0)
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,ScreenshotFormat:'png'}},state);if(!result.ok)throw Error(result.error)})
    })
    await scenario('actual reedit preserves original source and annotations while update replaces only its intended pin',async()=>{
      const metadata=await reedit();assert.equal(metadata.document.targetPinId,pinId);assert.equal(metadata.document.annotations.length,0);assert.equal(metadata.initialAction,undefined)
      await overlay.getByRole('button',{name:'矩形',exact:true}).click();const point=await overlay.locator('.screenshot-image').evaluate(canvas=>{const rect=canvas.getBoundingClientRect();return{x:rect.left,y:rect.top,scale:rect.width/canvas.width}})
      await overlay.mouse.move(point.x+20*point.scale,point.y+20*point.scale);await overlay.mouse.down();await overlay.mouse.move(point.x+60*point.scale,point.y+50*point.scale,{steps:8});await overlay.mouse.up()
      await overlay.getByRole('button',{name:'更新贴图',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined;await waitFor(async()=>(await info()).version===1)
      const changed=await bytes(pin,pinId,1);assert.notDeepEqual(changed,reference);assert.deepEqual(await bytes(other,otherId,0),reference)
      const pixels=await page.evaluate(async bytes=>{const image=await createImageBitmap(new Blob([new Uint8Array(bytes)]));const canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close();return{outline:[...context.getImageData(40,20,1,1).data],untouched:[...context.getImageData(100,70,1,1).data]}},changed)
      assert.deepEqual(pixels,{outline:[255,77,87,255],untouched:[56,178,100,255]})
      const next=await reedit();assert.equal(next.document.annotations.length,1);assert.deepEqual(next.document.annotations[0].points.map(point=>({x:Math.round(point.x*1e9)/1e9,y:Math.round(point.y*1e9)/1e9})),[{x:20,y:20},{x:60,y:50}])
      const source=await overlay.evaluate(async id=>[...new Uint8Array(await window.__TAURI_INTERNALS__.invoke('screenshot_overlay_source',{id}))],next.document.id);assert.deepEqual(source,reference)
      await cancelEditor();await assert.rejects(save(pin,pinId,0),/更新/)
    })
    await scenario('closing a pin during actual reedit rejects update without silently creating a replacement and permits explicit new pin',async()=>{
      await control('edit',undefined,other,otherId);overlay=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('capture.html')));await waitFor(()=>overlay.getByRole('button',{name:'更新贴图',exact:true}).isEnabled())
      const target=other;await control('close',undefined,target,otherId).catch(error=>{if(!target.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error});await waitFor(()=>target.isClosed());other=undefined
      await overlay.getByRole('button',{name:'更新贴图',exact:true}).click();await overlay.getByRole('alert').filter({hasText:'贴图已关闭'}).waitFor();assert.equal(overlay.isClosed(),false)
      await overlay.getByRole('button',{name:'贴图',exact:true}).click();await waitFor(()=>overlay.isClosed());overlay=undefined
      other=await waitFor(()=>pins().find(target=>new URL(target.url()).searchParams.get('pin')!==pinId));otherId=new URL(other.url()).searchParams.get('pin');await loaded(other)
      assert.notEqual(otherId,pinId);assert.equal((await info(other,otherId)).version,0)
    })
    await scenario('main reload and backup restore preserve independent pin source authority and later reediting',async()=>{
      const before=await bytes(pin,pinId,1);await page.reload();await page.locator('.app-shell').waitFor();assert.deepEqual(await bytes(pin,pinId,1),before)
      const backup=await api('createBackup');assert.equal(backup.ok,true,JSON.stringify(backup));const listed=await api('listBackups');assert.ok(listed.length>0)
      const preview=await api('previewBackup',listed[0].path);assert.ok(preview.fingerprint);const restored=await api('restoreBackup',listed[0].path,preview.fingerprint);assert.equal(restored.ok,true,JSON.stringify(restored))
      assert.deepEqual(await bytes(pin,pinId,1),before);const edited=await reedit();assert.equal(edited.document.annotations.length,1);await cancelEditor()
    })
    await scenario('pin reload retries a failed first binary delivery without reencoding or losing options',async()=>{
      await pin.addInitScript(()=>{const original=window.fetch;window.__pinFail=true;window.fetch=async(input,options)=>{const url=typeof input==='string'?input:input.url;if(url.endsWith('/screenshot_pin_source')&&window.__pinFail){return new Response(JSON.stringify('pin binary delivery interrupted'),{status:400,headers:{'Content-Type':'application/json','Tauri-Response':'error'}})}return original.call(window,input,options)}})
      await pin.reload();await pin.getByRole('alert').filter({hasText:'pin binary delivery interrupted'}).waitFor();await pin.evaluate(()=>{window.__pinFail=false});await pin.getByRole('button',{name:'重试读取',exact:true}).click();await loaded(pin);assert.equal((await info()).version,1)
    })
    await scenario('actual tray clicks toggle all visibility restore locked click-through pins and dispatch one native per-pin option with main hidden',async()=>{
      const original=await bytes(pin,pinId,1),second=await bytes(other,otherId,0),before=await info()
      await api('hideMainWindow');await control('options',{opacity:40,locked:true,mouseThrough:true})
      await nativeTray('贴图 '+pinId.slice(0,8),'置顶');await waitFor(async()=>(await info()).topmost!==before.topmost)
      await new Promise(resolve=>setTimeout(resolve,200));assert.equal((await info()).topmost,!before.topmost)
      const windows=async()=>(await app.invoke('prototype_diagnostics')).windows.filter(target=>target.label.startsWith('screenshot-pin-'))
      await nativeTray('显示/隐藏所有贴图');await waitFor(async()=>(await windows()).every(target=>!target.visible));assert.equal((await windows()).length,2)
      assert.equal((await info()).locked,true);assert.equal((await info()).mouseThrough,true)
      await nativeTray('显示/隐藏所有贴图');await waitFor(async()=>(await windows()).every(target=>target.visible))
      await nativeTray('恢复所有贴图鼠标操作');await waitFor(async()=>(await info()).mouseThrough===false)
      const restored=await info();assert.equal(restored.opacity,100);assert.equal(restored.locked,false);assert.equal(restored.topmost,!before.topmost)
      assert.equal((await app.invoke('prototype_diagnostics')).windows.find(target=>target.label==='workspace-main').visible,false)
      assert.deepEqual(await bytes(pin,pinId,1),original);assert.deepEqual(await bytes(other,otherId,0),second);await api('showMainWindow')
    })
    await scenario('closing a pin cancels its own native picker and releases the maintenance veto without touching another source',async()=>{
      const retained=await bytes(pin,pinId,1),target=other,pending=save(other,otherId,0).then(value=>({value}),error=>({error:String(error)}))
      await operateDialog(app,'另存为截图','visible');await assert.rejects(invoke('drafts_prepare',{},page),/截图正在进行/)
      await control('close',undefined,target,otherId).catch(error=>{if(!target.isClosed()||!String(error).includes('Target page, context or browser has been closed'))throw error});await waitFor(()=>target.isClosed());other=undefined
      const result=await pending;if(result.error)assert.match(result.error,/closed|destroyed|disconnected/i);else assert.equal(result.value.canceled,true)
      const prepared=await waitFor(async()=>{try{return await invoke('drafts_prepare',{},page)}catch(error){if(String(error).includes('截图正在进行'))return false;throw error}});await invoke('drafts_end',{requestId:prepared.requestId},page);await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));assert.deepEqual(await bytes(pin,pinId,1),retained)
    })
    await scenario('a real sealed maintenance checkpoint refuses a tray batch close and preserves the native pin source for explicit resume',async()=>{
      const source=await bytes(pin,pinId,1),prepared=await invoke('drafts_prepare',{},page)
      try{
        await nativeTray('关闭所有桌面贴图');await pin.getByRole('alert').filter({hasText:'迁移维护'}).waitFor();assert.equal(pin.isClosed(),false)
        await assert.rejects(invoke('screenshot_pin_info',{id:pinId},pin),/维护/)
      }finally{await invoke('drafts_end',{requestId:prepared.requestId},page)}
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));await pin.getByRole('button',{name:'重试读取',exact:true}).click();await loaded(pin);assert.deepEqual(await bytes(pin,pinId,1),source)
    })
    await scenario('the actual tray closes every pin and its owned save picker without destroying the main or silently publishing a file',async()=>{
      await page.evaluate(async bytes=>{window.__nativePinPayload=(await window.dustdesk.createScreenshotDocument(new Uint8Array(bytes))).payload},reference)
      const created=await create('tray-close-extra');assert.equal(created.ok,true,JSON.stringify(created));otherId=created.pinId;other=await waitFor(()=>pins().find(target=>new URL(target.url()).searchParams.get('pin')===otherId));await loaded(other)
      const directory=await outputs(),pending=save(other,otherId,0).then(value=>({value}),error=>({error:String(error)})),old=[pin,other]
      await operateDialog(app,'另存为截图','visible');await nativeTray('关闭所有桌面贴图');await waitFor(()=>old.every(target=>target.isClosed()))
      const result=await pending;if(result.error)assert.match(result.error,/closed|destroyed|disconnected/i);else assert.equal(result.value.canceled,true)
      assert.equal(page.isClosed(),false);assert.deepEqual(await outputs(),directory);await waitFor(async()=>!(await app.invoke('prototype_diagnostics')).windows.some(target=>target.label.startsWith('screenshot-pin-')))
      await assert.rejects(nativeTray('关闭所有桌面贴图'),/Native tray item disabled/)
      await page.evaluate(async bytes=>{window.__nativePinPayload=(await window.dustdesk.createScreenshotDocument(new Uint8Array(bytes))).payload},reference)
      const replacement=await create('after-tray-close');assert.equal(replacement.ok,true,JSON.stringify(replacement));pinId=replacement.pinId;pin=await waitFor(()=>pins().find(target=>new URL(target.url()).searchParams.get('pin')===pinId));await loaded(pin);other=undefined
    })
    await scenario('an idle native pin does not veto normal application quit',async()=>{
      const pending=invoke('application_quit',{},page).then(()=>({}),error=>({error:String(error)}));await waitFor(()=>app.child.exitCode!==null,22000)
      const result=await pending;if(result.error)assert.match(result.error,/closed|destroyed|disconnected/i);assert.equal(app.child.exitCode,0)
    })
    assert.deepEqual(errors,[])
    await writeFile(report,JSON.stringify({verified:true,productionReady:false,migrationComplete:false,evidence,errors,trayClicks,pending:['physical-mixed-DPI-IME-hotplug','full-screenshot-maintenance-quit-checkpoints','Release-performance-and-package']},null,2))
  }catch(error){failed=true;await writeFile(report,JSON.stringify({verified:false,productionReady:false,migrationComplete:false,evidence,errors,trayClicks,failure:String(error),root:app?.root},null,2));throw error}
  finally{try{if(clipboard)await clipboard.close()}finally{if(app)await app.close({preserve:failed})}}
})
