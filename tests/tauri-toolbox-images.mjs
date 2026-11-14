import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { browserReference } from './browser-reference.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { readZip } from './zip-files.mjs'
import { chooseSelect } from './ui-controls.mjs'

const report='artifacts/tauri-migration/toolbox-images-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
const defaults={format:'png',quality:85,resize:'none',percent:100,width:32,height:24,fit:'contain',upscale:false,background:'#ffffff',watermark:'none',text:'DustDesk',position:8,margin:2,watermarkSize:8,opacity:50,color:'#ffffff'}
const cases=[{},{format:'jpeg',resize:'percent',percent:50},{format:'webp',resize:'dimensions',width:20,height:20,fit:'cover'},{watermark:'text',text:'中文 A'},{watermark:'image'},{category:'avatar',avatarShape:'circle',width:32,height:32,resize:'dimensions',fit:'cover',upscale:true},{category:'portrait',dpi:300,width:30,height:42,resize:'dimensions',fit:'cover',upscale:true,format:'jpeg'}]
const runWorker=(page,worker,bytes,options)=>page.evaluate(async({worker,bytes,options})=>{
  const result=await new Promise((resolve,reject)=>{const task=new Worker(new URL('assets/'+worker,location.href),{type:'module'});const timer=setTimeout(()=>{task.terminate();reject(Error('Image Worker timed out'))},15000);task.onerror=error=>{clearTimeout(timer);task.terminate();reject(Error(error.message))};task.onmessage=event=>{clearTimeout(timer);task.terminate();if(event.data.error)reject(Error(event.data.error));else resolve(event.data.result)};task.postMessage({bytes:new Uint8Array(bytes),options,...(options.watermark==='image'?{watermark:new Uint8Array(bytes)}:{})})})
  const bitmap=await createImageBitmap(new Blob([result.bytes]));const canvas=new OffscreenCanvas(bitmap.width,bitmap.height);const context=canvas.getContext('2d');context.drawImage(bitmap,0,0);const pixels=[...context.getImageData(0,0,bitmap.width,bitmap.height).data];bitmap.close();return {...result,bytes:[...result.bytes],pixels}
},{worker,bytes,options})

await test('image toolbox uses scoped binary assets, native selection and collision-safe single or ZIP publication',{timeout:180000},async suite=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'dustdesk-tauri-test-'))
  let referenceBrowser;let app;let page;let failed=false;let images;const evidence=[];const references=[];let selected=[];let uiAsset;let uiStage='setup';const pageErrors=[]
  const scenario=async(name,callback)=>{await suite.test(name,{timeout:30000},async current=>{let completed=false;current.signal.addEventListener('abort',()=>{if(!completed){failed=true;void app?.invoke('system_cancel_picker',{},page).catch(()=>{})}},{once:true});try{await callback();evidence.push(name)}catch(error){failed=true;throw error}finally{completed=true}});if(failed)throw Error('Image toolbox failed: '+name)}
  const api=(method,...args)=>{const result=page.evaluate(({method,args})=>window.dustdesk.toolbox[method](...args),{method,args});void result.catch(()=>{});return result}
  const importImage=(bytes,name)=>page.evaluate(({bytes,name})=>window.dustdesk.toolbox.importImage(new Uint8Array(bytes),name),{bytes,name})
  const exportImage=(batch,name,bytes)=>page.evaluate(({batch,name,bytes})=>window.dustdesk.toolbox.exportImage(batch,name,new Uint8Array(bytes)),{batch,name,bytes})
  const begin=async(ids,format,target)=>{const existed=await readFile(target).then(()=>true).catch(()=>false);const pending=api('beginImageExport',ids,format);const selecting=operateDialog(app,ids.length===1?'保存图片':'保存图片压缩包','select',target);if(existed)await Promise.all([selecting,operateDialog(app,'确认另存为','confirm')]);else await selecting;return pending}
  const contents=()=>readdir(root)
  try{
    await scenario('independent browser supplies image bytes and shared Worker reference output',async()=>{
      referenceBrowser = await browserReference()
      images=await referenceBrowser.page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;const context=canvas.getContext('2d');context.fillStyle='#2580c0';context.fillRect(0,0,32,24);context.clearRect(0,0,4,4);const output={};for(const format of ['png','jpeg','webp'])output[format]=[...new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve,'image/'+format,.85))).arrayBuffer())];return output})
      for(const [format,bytes] of Object.entries(images)){
        await writeFile(path.join(root,'referenceBrowser-direct.'+format),Buffer.from(bytes))
      }
      const worker=(await readdir('out/tauri/assets')).find(file=>file.startsWith('image.worker-'))
      assert.ok(worker)
      for(const overrides of cases)references.push(await runWorker(referenceBrowser.page,worker,images.png,{...defaults,...overrides}))
      await referenceBrowser.close();referenceBrowser=undefined
      for(const format of ['png','jpeg','webp'])await writeFile(path.join(root,'源图.'+format),Buffer.from(images[format]))
    })
    await scenario('prototype and widget roles cannot invoke any of the main-only image commands',async()=>{
      app=await launchTauri();await app.invoke('prototype_open_workspace');page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      page.on('pageerror',error=>pageErrors.push(error.message))
      await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,SidebarHidden:[]}},state);if(!result.ok)throw Error(result.error)})
      assert.equal((await page.evaluate(()=>window.dustdesk.setWidgetVisibility('todo',true))).ok,true)
      const widget=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')))
      await widget.getByLabel('桌面新增任务').waitFor()
      for(const target of [app.page,widget])for(const command of ['toolbox_pick','toolbox_register_paths','toolbox_import_image','toolbox_read_asset','toolbox_release_assets','toolbox_begin_image_export','toolbox_export_image','toolbox_end_image_export'])await assert.rejects(app.invoke(command,{},target),/not allowed|权限|不允许/i)
      await page.evaluate(()=>window.dustdesk.setWidgetVisibility('todo',false))
    })
    await scenario('binary import and raw read preserve every byte and release revokes opaque IDs',async()=>{
      for(const [format,bytes] of Object.entries(images)){
        const asset=await importImage(bytes,'中文🪶.'+format);assert.equal(asset.size,bytes.length);assert.match(asset.id,/^[\da-f-]{36}$/)
        assert.deepEqual(await page.evaluate(async id=>[...await window.dustdesk.toolbox.readAsset(id)],asset.id),bytes)
        await api('releaseAssets',[asset.id]);await assert.rejects(api('readAsset',asset.id),/授权已失效/)
      }
      for(const bytes of [[],[71,73,70,56,57,97],[1,2,3]])await assert.rejects(importImage(bytes,'invalid.png'),/图片|PNG/)
      await assert.rejects(app.invoke('toolbox_import_image',{bytes:images.png,name:'json.png'},page),/文件名|二进制/)
      await assert.rejects(api('readAsset',path.join(root,'源图.png')),/授权已失效/)
      await assert.rejects(api('registerPaths',[path.join(root,'源图.png')],'image'),/未获原生选择授权/)
      const large=await page.evaluate(async png=>{const bytes=new Uint8Array(8*1024*1024);bytes.set(png);const asset=await window.dustdesk.toolbox.importImage(bytes,'8MiB.png');try{const output=await window.dustdesk.toolbox.readAsset(asset.id);return {size:asset.size,length:output.length,equal:output.every((value,index)=>value===bytes[index])}}finally{await window.dustdesk.toolbox.releaseAssets([asset.id])}},images.png)
      assert.deepEqual(large,{size:8*1024*1024,length:8*1024*1024,equal:true})
    })
    await scenario('native multi-selection registers only chosen files while cancellation grants nothing',async()=>{
      let pending=api('pick','image');await operateDialog(app,'导入图片','cancel');assert.deepEqual(await pending,[])
      const first=path.join(root,'源图.png'),second=path.join(root,'源图.jpeg')
      pending=api('pick','image');await operateDialog(app,'导入图片');await assert.rejects(api('pick','image'),/已有文件选择窗口/)
      await operateDialog(app,'导入图片','select','"'+first+'" "'+second+'"');selected=await pending;assert.equal(selected.length,2)
      assert.deepEqual(selected.map(asset=>asset.name).sort(),['源图.jpeg','源图.png'])
      assert.equal((await api('registerPaths',[first],'image')).length,1)
      await assert.rejects(api('registerPaths',[path.join(root,'源图.webp')],'image'),/未获原生选择授权/)
      const id=selected.find(asset=>asset.name.endsWith('.png')).id;await writeFile(first,'changed');await assert.rejects(api('readAsset',id),/PNG|图片/);await writeFile(first,Buffer.from(images.png))
    })
    await scenario('native save cancellation and invalid selections do not create a batch or output',async()=>{
      const before=await contents();const pending=api('beginImageExport',[selected[0].id],'png');await operateDialog(app,'保存图片','cancel');assert.deepEqual(await pending,{})
      await assert.rejects(api('beginImageExport',[],'png'),/参数无效/);await assert.rejects(api('beginImageExport',['revoked'],'png'),/授权已失效/);await assert.rejects(api('beginImageExport',[selected[0].id],'svg'),/参数无效/)
      assert.deepEqual(await contents(),before)
    })
    await scenario('single PNG JPEG and WebP outputs match the known source bytes and never overwrite an existing name',async()=>{
      for(const [format,bytes] of Object.entries(images)){
        const asset=await importImage(bytes,'wrong.extension');const extension=format==='jpeg'?'jpg':format;const target=path.join(root,'native.'+extension)
        await writeFile(target,'keep');const batch=await begin([asset.id],'original',target);assert.ok(batch.id)
        await exportImage(batch.id,'../../中文.'+extension,bytes);await assert.rejects(exportImage(batch.id,'overflow.png',images.png),/超过本次选择/)
        const output=await api('endImageExport',batch.id);assert.equal(output.count,1);assert.equal(output.path,path.join(root,'native-1.'+extension));assert.deepEqual(await readFile(output.path),await readFile(path.join(root,'referenceBrowser-direct.'+format)));assert.equal(await readFile(target,'utf8'),'keep')
        assert.deepEqual(await api('endImageExport',batch.id),{count:0})
      }
    })
    await scenario('ZIP export keeps partial successes duplicate-safe Unicode names and exact original bytes',async()=>{
      const batch=await begin([selected[0].id,selected[1].id,selected[0].id,selected[1].id],'png',path.join(root,'native-图片.zip'))
      await exportImage(batch.id,'中文.png',images.png);await exportImage(batch.id,'中文.png',images.png)
      await assert.rejects(exportImage(batch.id,'broken.png',[1,2,3]),/PNG|图片/)
      await exportImage(batch.id,'output.zip',images.png)
      const output=await api('endImageExport',batch.id);assert.equal(output.count,3);const entries=await readZip(output.path)
      assert.deepEqual([...entries.keys()],['中文.png','中文-1.png','output.zip']);for(const bytes of entries.values())assert.deepEqual(bytes,Buffer.from(images.png))
      assert.equal((await contents()).filter(name=>name.startsWith('.dustdesk-images-')).length,0)
    })
    await scenario('empty batches and internal-profile destinations leave no staged files or output',async()=>{
      let batch=await begin([selected[0].id],'png',path.join(root,'empty.png'));assert.deepEqual(await api('endImageExport',batch.id),{count:0})
      const pending=api('beginImageExport',[selected[0].id],'png');await operateDialog(app,'保存图片','select',path.join(app.root,'user-data','tauri-preview','protected.png'));await assert.rejects(pending,/内部数据目录/)
      assert.equal((await contents()).filter(name=>name.startsWith('.dustdesk-images-')).length,0)
    })
    await scenario('actual WebView2 Worker retains image options format dimensions alpha and browser-equivalent pixels',async()=>{
      const worker=(await readdir('out/tauri/assets')).find(file=>file.startsWith('image.worker-'));assert.ok(worker)
      for(const [index,overrides] of cases.entries()){
        const actual=await runWorker(page,worker,images.png,{...defaults,...overrides});const reference=references[index]
        for(const key of ['width','height','originalWidth','originalHeight','originalFormat','format','retainedOriginal'])assert.equal(actual[key],reference[key],index+' '+key)
        assert.equal(actual.pixels.length,reference.pixels.length);let maximum=0;let sum=0;for(let pixel=0;pixel<actual.pixels.length;pixel++){const difference=Math.abs(actual.pixels[pixel]-reference.pixels[pixel]);maximum=Math.max(maximum,difference);sum+=difference}
        if(actual.format==='png')assert.deepEqual(actual.pixels,reference.pixels,'lossless Worker pixels '+index)
        else {assert.ok(maximum<=8,'lossy maximum channel delta '+maximum);assert.ok(sum/actual.pixels.length<=2,'lossy mean channel delta')}
        await writeFile(path.join(root,'worker-native-'+index+'.'+actual.format),Buffer.from(actual.bytes))
      }
    })
    await scenario('shared image page imports through the native picker renders previews and exports through the unchanged Worker',async()=>{
      uiStage='navigate-and-import'
      await page.getByRole('button',{name:'图片工具箱',exact:true}).click();await page.getByRole('button',{name:'导入图片',exact:true}).click();await operateDialog(app,'导入图片','select',path.join(root,'源图.png'))
      uiStage='thumbnail-and-preview'
      await page.locator('.image-tool-thumb').waitFor();await waitFor(()=>page.locator('.image-tool-row').filter({hasText:'可导出'}).count())
      uiStage='format-and-export'
      const target=path.join(root,'shared-page.jpg');await chooseSelect(page.getByLabel('格式',{exact:true}),'jpeg')
      await page.getByRole('button',{name:'导出全部',exact:true}).click();await operateDialog(app,'保存图片','select',target)
      uiStage='published-result'
      await waitFor(async()=>readFile(target).then(bytes=>bytes.length>0).catch(()=>false));await waitFor(()=>page.locator('.image-tool-row').filter({hasText:'已导出'}).count())
      assert.equal((await readFile(target))[0],255)
      await page.screenshot({path:'artifacts/tauri-migration/toolbox-images-shared.png'})
      uiStage='navigation-retains-input'
      await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'图片工具箱',exact:true}).click();assert.equal(await page.locator('.image-tool-row').count(),1)
    })
    await scenario('shared-page cancellation publishes only completed Worker results and retains the rest for retry',async()=>{
      await page.evaluate(()=>{window.__originalImagePick=window.dustdesk.toolbox.pick;window.dustdesk.toolbox.pick=async(...args)=>{const result=await window.__originalImagePick(...args);window.__selectedImageIds=result.map(asset=>asset.id);return result}})
      await page.getByRole('button',{name:'导入图片',exact:true}).click();await operateDialog(app,'导入图片','select','"'+path.join(root,'源图.jpeg')+'" "'+path.join(root,'源图.webp')+'"')
      await waitFor(()=>page.locator('.image-tool-thumb').count().then(count=>count===3));await waitFor(()=>page.locator('.image-tool-name:disabled').count().then(count=>count===0))
      await chooseSelect(page.getByLabel('格式',{exact:true}),'png')
      await page.locator('.image-tool-name').first().click();await waitFor(()=>page.locator('.image-tool-row').first().filter({hasText:'可导出'}).count())
      await page.evaluate(()=>{window.dustdesk.toolbox.pick=window.__originalImagePick;window.__originalImageRead=window.dustdesk.toolbox.readAsset;const delayedId=window.__selectedImageIds[0];window.dustdesk.toolbox.readAsset=async id=>{const bytes=await window.__originalImageRead(id);if(id===delayedId){window.__imageReadHeld=true;await new Promise(resolve=>{window.__releaseImageRead=resolve})}return bytes}})
      const target=path.join(root,'shared-cancelled.zip');await page.getByRole('button',{name:'导出全部',exact:true}).click();await operateDialog(app,'保存图片压缩包','select',target)
      await waitFor(()=>page.evaluate(()=>window.__imageReadHeld===true));await page.getByRole('button',{name:'取消处理',exact:true}).click();await page.evaluate(()=>{window.dustdesk.toolbox.readAsset=window.__originalImageRead;window.__releaseImageRead()})
      await waitFor(()=>page.locator('.toolbox-path').innerText().then(value=>value===target));const entries=await readZip(target);assert.equal(entries.size,1);assert.ok([...entries.keys()][0].endsWith('.png'));assert.equal(await page.locator('.image-tool-row').count(),3)
      assert.equal((await contents()).filter(name=>name.startsWith('.dustdesk-images-')).length,0)
    })
    await scenario('maintenance cancels the picker and discards unpublished batches but preserves imported source assets',async()=>{
      uiAsset=await importImage(images.png,'maintenance.png');const target=path.join(root,'cancelled.png');const batch=await begin([uiAsset.id],'png',target);await exportImage(batch.id,'image.png',images.png)
      const pending=api('pick','image');await operateDialog(app,'导入图片');const prepared=await app.invoke('drafts_prepare',{},page);assert.deepEqual(await pending,[])
      await assert.rejects(api('importImage',images.png,'paused.png'),/恢复|退出|二进制|文件名/)
      assert.equal(await app.invoke('drafts_end',{requestId:prepared.requestId},page),true)
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
      assert.deepEqual(await api('endImageExport',batch.id),{count:0});assert.deepEqual(await page.evaluate(async id=>[...await window.dustdesk.toolbox.readAsset(id)],uiAsset.id),images.png)
      await assert.rejects(readFile(target),/ENOENT/);assert.equal((await contents()).filter(name=>name.startsWith('.dustdesk-images-')).length,0)
    })
    await scenario('main reload revokes old assets batches and file grants before installing a new adapter',async()=>{
      const asset=await importImage(images.png,'old.png');const batch=await begin([asset.id],'png',path.join(root,'reload.png'));await exportImage(batch.id,'old.png',images.png)
      await page.reload();await page.locator('.app-shell').waitFor();await assert.rejects(api('readAsset',asset.id),/授权已失效/);assert.deepEqual(await api('endImageExport',batch.id),{count:0})
      await assert.rejects(api('registerPaths',[path.join(root,'源图.png')],'image'),/未获原生选择授权/)
      const replacement=await importImage(images.png,'new.png');assert.deepEqual(await page.evaluate(async id=>[...await window.dustdesk.toolbox.readAsset(id)],replacement.id),images.png)
      assert.equal((await contents()).filter(name=>name.startsWith('.dustdesk-images-')).length,0)
    })
    await scenario('native quit cancels an outstanding image dialog and exits without leaving staged output',async()=>{
      const asset=await importImage(images.png,'quit.png');const batch=await begin([asset.id],'png',path.join(root,'quit.png'));await exportImage(batch.id,'quit.png',images.png)
      const pending=api('pick','image');await operateDialog(app,'导入图片');void app.invoke('application_quit',{},page).catch(()=>{})
      await waitFor(()=>app.child.exitCode!==null,10000);assert.equal(app.child.exitCode,0);await pending.catch(()=>{})
      assert.equal((await contents()).filter(name=>name.startsWith('.dustdesk-images-')).length,0);await assert.rejects(readFile(path.join(root,'quit.png')),/ENOENT/)
    })
    await writeFile(report,JSON.stringify({productionReady:false,evidence,workerCases:cases.length,pending:['native external-file drop','physical IME/DPI and long-session resources','full screenshot LAN production performance and package gates']},null,2))
  }finally{if(failed&&page&&!page.isClosed()){const diagnostics={uiStage,pageErrors,body:await page.locator('body').innerText().catch(()=>''),files:await contents(),nativeOutput:app.output()};await writeFile('artifacts/tauri-migration/toolbox-images-failure-'+Date.now()+'.json',JSON.stringify(diagnostics,null,2));await page.screenshot({path:'artifacts/tauri-migration/toolbox-images-failure.png'}).catch(()=>{})}await app?.close();if(referenceBrowser)await referenceBrowser.close();await rm(root,{recursive:true,force:true})}
})
