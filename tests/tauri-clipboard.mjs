import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm,rename,symlink,rmdir} from 'node:fs/promises'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'
import {clipboardFixture,holdClipboard} from './tauri-clipboard-support.mjs'

const report='artifacts/tauri-migration/clipboard-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('native clipboard read, copy and scoped image previews use real Windows data without preview side effects',async suite=>{
  const guard=await clipboardFixture();let app;const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Clipboard scenario failed: '+name)}
  try{
    app=await launchTauri();const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.DesktopCategories=[]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const png=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=320;canvas.height=240;const context=canvas.getContext('2d');context.fillStyle='rgba(255,0,0,0.5)';context.fillRect(0,0,160,240);context.fillStyle='rgb(0,255,0)';context.fillRect(160,0,160,240);return canvas.toDataURL('image/png').split(',')[1]})
    const pixels=encoded=>page.evaluate(async encoded=>{const image=await createImageBitmap(new Blob([Uint8Array.from(atob(encoded),character=>character.charCodeAt(0))],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const context=canvas.getContext('2d');context.drawImage(image,0,0);const first=Array.from(context.getImageData(0,0,1,1).data);const last=Array.from(context.getImageData(image.width-1,0,1,1).data);image.close();return {width:canvas.width,height:canvas.height,first,last}},encoded)
    const workspace=path.join(app.root,'user-data','tauri-preview','Workspace');const text='剪贴板 Unicode 😀\r\n第二行';const created=new Date().toISOString()
    const state=await api('loadWorkspace');state.ClipboardHistory=[{Id:'image-fixture',Kind:'Image',Text:'图片说明',ImagePngBase64:png,ImageFileName:'fixture.png',ImageSha256:'legacy-fingerprint',CreatedAt:created,IsPinned:true,IsLocked:false},{Id:'text-fixture',Kind:'Text',Text:text,ImagePngBase64:'',ImageFileName:'',ImageSha256:'text-fingerprint',CreatedAt:created,IsPinned:false,IsLocked:true}];assert.equal((await api('saveWorkspace',state)).ok,true)
    const disk=JSON.parse(await readFile(path.join(workspace,'workspace.json'),'utf8'));const asset=path.join(workspace,'ClipboardImages',disk.ClipboardHistory[0].ImageAssetName);assert.equal(disk.ClipboardHistory[0].ImagePngBase64,'')
    await scenario('real Unicode text reads and writes preserve the public shape and recordId ignores caller-supplied content',async()=>{
      await guard.request('set-text',{text});assert.deepEqual(await api('readClipboard'),{text,imagePngBase64:''})
      await api('writeClipboard',{text:'原生复制 😀\r\nline'});assert.equal((await guard.request('inspect')).text,'原生复制 😀\r\nline')
      await api('writeClipboard',{recordId:'text-fixture',text:'must be ignored'});assert.equal((await guard.request('inspect')).text,text)
      electron.electron.clipboard.readText=()=>text;electron.electron.clipboard.readImage=()=>({isEmpty:()=>true});assert.deepEqual(await api('readClipboard'),await electron.invoke('clipboard:read'))
    })
    await scenario('external GDI bitmap data is read as PNG and native PNG/DIBV5 copies preserve dimensions and transparency',async()=>{
      await guard.request('set-bitmap');const external=await api('readClipboard');assert.deepEqual(await pixels(external.imagePngBase64),{width:3,height:2,first:[10,20,30,255],last:[12,20,30,255]})
      await api('writeClipboard',{imagePngBase64:png});const native=await api('readClipboard');assert.equal(native.text,'');assert.deepEqual(await pixels(native.imagePngBase64),await pixels(png))
      const foreign=await guard.request('inspect');assert.equal(foreign.image.width,320);assert.equal(foreign.image.height,240);assert.ok(foreign.formats.includes('PNG'))
      await api('writeClipboard',{recordId:'image-fixture'});assert.deepEqual(await pixels((await api('readClipboard')).imagePngBase64),await pixels(png))
      evidence.image='native PNG pixels and alpha match the browser fixture; external GDI-only bitmap and native DIBV5/PNG are interoperable'
    })
    await scenario('thumbnail and full previews read only authorized records without changing clipboard sequence or workspace bytes',async()=>{
      const sequence=(await guard.request('sequence')).sequence;const before=await readFile(path.join(workspace,'workspace.json'))
      const thumb=await api('previewClipboardImage','image-fixture');const full=await api('previewClipboardImage','image-fixture',false);assert.equal(thumb.ok,true);assert.equal(full.ok,true)
      assert.equal(thumb.image.width,320);assert.equal(thumb.image.height,240);assert.equal(full.image.width,320);assert.equal(full.image.height,240)
      const reduced=await pixels(thumb.image.dataUrl.split(',')[1]);assert.deepEqual([reduced.width,reduced.height],[160,120]);assert.deepEqual(await pixels(full.image.dataUrl.split(',')[1]),await pixels(png))
      for(const id of ['', 'missing', '../private.png', 'text-fixture', 'a'.repeat(129)])assert.equal((await api('previewClipboardImage',id)).ok,false)
      assert.equal((await page.evaluate(()=>window.dustdesk.previewClipboardImage('image-fixture','bad'))).ok,false)
      assert.equal((await guard.request('sequence')).sequence,sequence);assert.deepEqual(await readFile(path.join(workspace,'workspace.json')),before)
      await assert.rejects(app.invoke('clipboard_preview',{recordId:'image-fixture',thumbnail:true}),/not allowed|权限|denied/i)
      for(const command of ['clipboard_read','clipboard_write'])await assert.rejects(app.invoke(command,{content:{text:'denied'}}),/not allowed|权限|denied/i)
    })
    await scenario('invalid input and missing/corrupt assets fail before emptying the system clipboard and can be retried',async()=>{
      await guard.request('set-text',{text:'must survive invalid copy'});const sequence=(await guard.request('sequence')).sequence
      for(const content of [{},{text:null},{text:'bad\0text'},{text:'do not overwrite',imagePngBase64:'eA=='},{imagePngBase64:'a'},{recordId:'missing'}])await assert.rejects(api('writeClipboard',content))
      const bytes=await readFile(asset);await writeFile(asset,'corrupt')
      try{assert.equal((await api('previewClipboardImage','image-fixture')).ok,false);await assert.rejects(api('writeClipboard',{recordId:'image-fixture'}));assert.equal((await guard.request('sequence')).sequence,sequence)}finally{await writeFile(asset,bytes)}
      assert.equal((await api('previewClipboardImage','image-fixture')).ok,true)
      const relocated=asset+'.held';await rename(asset,relocated)
      try{assert.equal((await api('previewClipboardImage','image-fixture')).ok,false);await assert.rejects(api('writeClipboard',{recordId:'image-fixture'}))}finally{await rename(relocated,asset)}
      assert.equal((await guard.request('inspect')).text,'must survive invalid copy')
    })
    await scenario('junction redirects are refused rather than authorizing arbitrary image paths',async()=>{
      const directory=path.dirname(asset);const held=directory+'.held';const outside=path.join(app.root,'outside-images');await mkdir(outside);await writeFile(path.join(outside,path.basename(asset)),Buffer.from(png,'base64'))
      assert.equal(path.dirname(directory),workspace);assert.equal(path.dirname(held),workspace)
      await rename(directory,held);try{await symlink(outside,directory,'junction');try{assert.equal((await api('previewClipboardImage','image-fixture')).ok,false);await assert.rejects(api('writeClipboard',{recordId:'image-fixture'}))}finally{await rmdir(directory)}}finally{await rename(held,directory)}
      assert.equal((await api('previewClipboardImage','image-fixture')).ok,true)
    })
    await scenario('clipboard contention preserves existing data, previews require no clipboard lock, and a released lock is retried',async()=>{
      await guard.request('set-text',{text:'busy data'});let release=await holdClipboard()
      try{await assert.rejects(api('readClipboard'),/占用/);await assert.rejects(api('writeClipboard',{text:'must not replace'}),/占用/);assert.equal((await api('previewClipboardImage','image-fixture')).ok,true)}finally{await release()}
      assert.equal((await guard.request('inspect')).text,'busy data')
      release=await holdClipboard();const pending=api('writeClipboard',{text:'retried after lock'});await new Promise(resolve=>setTimeout(resolve,100));await release();await pending;assert.equal((await guard.request('inspect')).text,'retried after lock')
    })
    await scenario('shared clipboard page loads thumbnails and full previews without modifying the clipboard, then copies a selected record',async()=>{
      const sequence=(await guard.request('sequence')).sequence;await page.getByRole('button',{name:'剪贴板',exact:true}).click()
      const row=page.locator('[data-clipboard-id="image-fixture"]');await row.locator('img').waitFor();assert.equal(await row.locator('img').getAttribute('alt'),'缩略图：fixture.png')
      await row.getByRole('button',{name:'预览内容：fixture.png',exact:true}).click();const modal=page.getByRole('dialog',{name:'图片预览',exact:true});await modal.getByText('320 × 240 px',{exact:true}).waitFor();assert.equal((await guard.request('sequence')).sequence,sequence)
      await page.getByText('无法读取小组件状态，请重试',{exact:true}).waitFor({state:'hidden',timeout:10000});await page.screenshot({path:'artifacts/tauri-migration/clipboard-preview-shared-native.png',fullPage:true})
      await modal.getByRole('button',{name:'复制图片',exact:true}).click();assert.deepEqual(await pixels((await api('readClipboard')).imagePngBase64),await pixels(png))
      await modal.getByRole('button',{name:'关闭',exact:true}).click();await modal.waitFor({state:'hidden'});await page.getByRole('button',{name:'概览',exact:true}).click()
      assert.deepEqual(errors,[])
    })
    await scenario('quit rejects new reads, copies and previews and returns to a usable session after a veto',async()=>{
      await page.evaluate(()=>{window.__clipboardQuitRemove=window.dustdesk.onBeforeQuit(async()=>{window.__clipboardQuitResults=await Promise.all(['clipboard_read','clipboard_write','clipboard_preview'].map(command=>window.__TAURI_INTERNALS__.invoke(command,{content:{text:'denied'},recordId:'image-fixture',thumbnail:true}).then(()=> 'unexpected success',String)));throw Error('clipboard quit veto')})})
      const sequence=(await guard.request('sequence')).sequence;await assert.rejects(app.invoke('application_quit',{},page),/clipboard quit veto/)
      for(const error of await page.evaluate(()=>window.__clipboardQuitResults))assert.match(error,/退出/)
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));await page.evaluate(()=>window.__clipboardQuitRemove());assert.equal((await guard.request('sequence')).sequence,sequence)
      assert.equal((await api('previewClipboardImage','image-fixture')).ok,true)
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'native-clipboard-io-and-record-scoped-previews',scenarios,evidence,pending:['WM_CLIPBOARDUPDATE-background-ingestion','onClipboardChanged-event','all-widget-callers','notification-dedup-and-save-retry','delayed-rendering-owner-timeouts','full-legacy-format-matrix','release-memory-and-production-takeover']},null,2))
  }finally{try{await app?.close()}finally{await guard.close()}}
})
