import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'
import {clipboardFixture,holdClipboard} from './tauri-clipboard-support.mjs'
import {operateMenu} from './tauri-menu.mjs'

const run=promisify(execFile)
const report='artifacts/tauri-migration/widget-business-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('native shared widgets use only current role-owned resources and independent search sessions',async suite=>{
  const guard=await clipboardFixture();let app;let failed=false;const scenarios=[];const evidence={};const errors=[]
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;console.error('Native output:',app.output());throw error}});if(failed)throw Error('Widget business scenario failed: '+name)}
  try{
    app=await launchTauri({clipboardMonitoring:true});const electron=await mainFixture(suite);const initial=await electron.load()
    initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.Settings.WidgetPlacements={};initial.Settings.WidgetLayoutPresets={}
    initial.Settings.SearchDesktopFiles=false;initial.Settings.SearchStartMenuApps=false;initial.Settings.SearchAppData=false;initial.Settings.SearchProjectPaths=false;initial.Settings.SearchCustomPaths=true
    const searchRoot=path.join(app.root,'search');await mkdir(searchRoot);initial.Settings.SearchCustomRoots=[searchRoot]
    const source=path.join(app.root,'WidgetBusinessFixture.cs');await writeFile(source,'using System;using System.IO;using System.Reflection;public class WidgetBusinessFixture{public static void Main(string[] arguments){File.WriteAllText(Assembly.GetExecutingAssembly().Location+".opened","args="+arguments.Length);}}')
    const launcherPath=path.join(app.root,'组件启动.exe');await run('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/out:'+launcherPath,source],{windowsHide:true})
    const organizerPath=path.join(app.root,'收纳启动.exe');const foreignPath=path.join(app.root,'其他分类.exe');const privatePath=path.join(app.root,'主窗引用.exe');const widgetResult=path.join(searchRoot,'widget-search-only.exe');const mainResult=path.join(searchRoot,'main-search-only.exe')
    for(const target of [organizerPath,foreignPath,privatePath,widgetResult,mainResult])await writeFile(target,await readFile(launcherPath))
    const imageSource=path.join(app.root,'组件便签.png');const png=Buffer.from(await app.page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=3;canvas.height=2;const context=canvas.getContext('2d');context.fillStyle='#247abf';context.fillRect(0,0,3,2);return canvas.toDataURL('image/png').split(',')[1]}),'base64');await writeFile(imageSource,png)
    initial.Launchers=[{Id:randomUUID(),Name:'组件启动验证',Path:launcherPath},{Id:randomUUID(),Name:'授权便签源图',Path:imageSource}]
    const groupId=randomUUID();const otherGroupId=randomUUID();const projectId=randomUUID();const linkId=randomUUID()
    initial.DesktopCategories=[{Id:groupId,Name:'组件分类',IsCollapsed:false,ItemPaths:[organizerPath]},{Id:otherGroupId,Name:'其他分类',IsCollapsed:false,ItemPaths:[foreignPath]}]
    initial.Projects=[{Id:projectId,Name:'组件项目验证',ProjectPath:privatePath,Phases:[]}]
    initial.LinkGroups=[{Id:randomUUID(),Name:'组件链接分类',Links:[{Id:linkId,Name:'离线链接展示',Url:'https://example.invalid/widget-saved',Note:'',CreatedAt:new Date().toISOString(),UpdatedAt:new Date().toISOString()}]}]
    initial.Notes=initial.Notes.slice(0,1);initial.Notes[0].Title='组件图片便签一';initial.Notes[0].ImageOnly=true;initial.Notes.push({...initial.Notes[0],Id:randomUUID(),Title:'组件图片便签二'})
    const firstNote=initial.Notes[0].Id;const secondNote=initial.Notes[1].Id
    initial.ClipboardHistory=[{Id:'widget-text',Kind:'Text',Text:'组件复制 Unicode 😀',ImagePngBase64:'',ImageFileName:'',ImageSha256:'widget-text',CreatedAt:new Date().toISOString(),IsLocked:false,IsPinned:false},{Id:'widget-image',Kind:'Image',Text:'组件图片记录',ImagePngBase64:png.toString('base64'),ImageFileName:'widget.png',ImageSha256:'widget-image',CreatedAt:new Date().toISOString(),IsLocked:false,IsPinned:false}]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const call=(target,method,...args)=>target.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const api=(method,...args)=>call(page,method,...args)
    const listen=target=>target.on('pageerror',error=>errors.push({url:target.url(),message:String(error)}));listen(page)
    const show=async key=>{assert.equal((await api('setWidgetVisibility',key,true)).ok,true);const target=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')&&new URL(target.url()).searchParams.get('widget')===key));await target.locator('.widget-shell').waitFor();await waitFor(()=>target.evaluate(()=>Boolean(window.dustdesk)));listen(target);return target}
    const hide=async key=>assert.equal((await api('hideWidget',key)).ok,true)
    const load=()=>api('loadWorkspace')
    const save=async callback=>{const state=await load();callback(state);assert.equal((await api('saveWorkspace',state)).ok,true)}
    const opened=target=>waitFor(async()=>{try{return await readFile(target+'.opened','utf8')==='args=0'}catch{return false}})
    let launcher;let organizer;let group;let clipboard;let search
    await scenario('launcher opens its exact saved executable but cannot inherit main project grants or parent paths',async()=>{
      launcher=await show('launcher');await launcher.getByRole('button',{name:/组件启动验证/}).click();await opened(launcherPath)
      assert.ok((await call(launcher,'getPathIcon',launcherPath)).dataUrl);assert.ok((await api('getPathIcon',privatePath)).dataUrl)
      for(const target of [privatePath,organizerPath,app.root]){assert.equal((await call(launcher,'openPath',target)).ok,false);assert.deepEqual(await call(launcher,'getPathIcon',target),{})}
      await assert.rejects(call(launcher,'sampleSystemMetrics'),/权限/);await assert.rejects(call(launcher,'searchFiles','widget-search-only','forged'),/权限/)
      await assert.rejects(app.invoke('system_open',{target:launcherPath,url:false},app.page),/not allowed|权限|denied/i)
      await save(state=>{state.Launchers=state.Launchers.filter(item=>item.Path!==launcherPath)})
      assert.equal((await call(launcher,'openPath',launcherPath)).ok,false);assert.deepEqual(await call(launcher,'getPathIcon',launcherPath),{});await hide('launcher')
    })
    await scenario('organizer and single-category widgets use native icons menus and exact category ownership',async()=>{
      organizer=await show('organizer');const key='organizer-group:'+groupId;group=await show(key)
      assert.ok((await call(organizer,'getPathIcon',foreignPath)).dataUrl);assert.ok((await call(group,'getPathIcon',organizerPath)).dataUrl)
      const scoped=await call(group,'loadWorkspace');assert.deepEqual(scoped.DesktopCategories.map(item=>item.Id),[groupId])
      await group.getByRole('button',{name:path.basename(organizerPath),exact:true}).click();await opened(organizerPath)
      assert.equal((await call(group,'openPath',foreignPath)).ok,false);assert.deepEqual(await call(group,'getPathIcon',foreignPath),{})
      assert.equal((await call(group,'showPathContextMenu',foreignPath)).ok,false)
      await group.getByRole('button',{name:path.basename(organizerPath),exact:true}).click({button:'right'})
      assert.deepEqual(JSON.parse(await operateMenu(app)).map(item=>item.name),['打开','在资源管理器中显示','复制路径'])
      assert.equal(await operateMenu(app,'copy',organizerPath),'completed')
      let release=await holdClipboard();try{assert.equal((await call(group,'showPathContextMenu',organizerPath)).ok,true);await operateMenu(app,'copy-busy');await group.getByText('剪贴板被占用，请稍后重试',{exact:true}).waitFor();assert.equal(await page.getByText('剪贴板被占用，请稍后重试',{exact:true}).count(),0)}finally{await release()}
      await save(state=>{state.DesktopCategories.find(item=>item.Id===groupId).ItemPaths=[]})
      assert.equal((await call(group,'showPathContextMenu',organizerPath)).ok,false);assert.equal((await call(organizer,'openPath',organizerPath)).ok,false)
      await hide(key);await hide('organizer')
    })
    await scenario('generic and single-note shared editors render saved images without authorizing another note or role',async()=>{
      const first=await api('importNoteBackground',firstNote,imageSource);const second=await api('importNoteBackground',secondNote,imageSource);assert.equal(first.ok,true);assert.equal(second.ok,true);assert.notEqual(first.path,second.path)
      const notes=await show('notes');const key='note:'+firstNote;const note=await show(key)
      await note.getByRole('img',{name:'组件图片便签一'}).waitFor();await notes.getByRole('img',{name:'组件图片便签一'}).waitFor()
      await waitFor(()=>note.getByRole('img',{name:'组件图片便签一'}).evaluate(image=>image.complete&&image.naturalWidth===3))
      assert.equal((await call(note,'readImageFile',first.path)).ok,true);assert.equal((await call(note,'readImageFile',second.path)).ok,false)
      assert.equal((await call(notes,'readImageFile',second.path)).ok,true);await assert.rejects(call(launcher,'readImageFile',first.path),/权限/)
      await note.screenshot({path:'artifacts/tauri-migration/widget-business-note.png'});await hide(key);await hide('notes')
    })
    await scenario('clipboard widget previews and copies saved text and images but cannot read or write arbitrary OS data',async()=>{
      clipboard=await show('clipboard');await clipboard.getByRole('button',{name:'组件复制 Unicode 😀',exact:true}).click();await waitFor(async()=>(await guard.request('inspect')).text==='组件复制 Unicode 😀')
      const preview=await call(clipboard,'previewClipboardImage','widget-image');assert.equal(preview.ok,true,JSON.stringify(preview))
      const image=clipboard.getByRole('button',{name:/组件图片记录/});await image.locator('img').waitFor();await waitFor(()=>image.locator('img').evaluate(target=>target.complete&&target.naturalWidth>0))
      await image.click();const actual=await waitFor(async()=>{const result=await guard.request('inspect');return result.image?result:false});assert.equal(actual.image.width,3);assert.equal(actual.image.height,2)
      assert.equal((await call(clipboard,'previewClipboardImage','widget-image',false)).ok,true)
      const before=(await guard.request('sequence')).sequence
      for(const content of [{text:'arbitrary'},{imagePngBase64:png.toString('base64')},{recordId:'widget-text',text:'forged'},{recordId:'missing'}])await assert.rejects(call(clipboard,'writeClipboard',content))
      await assert.rejects(call(clipboard,'readClipboard'),/not allowed|权限|denied/i);await assert.rejects(call(launcher,'writeClipboard',{recordId:'widget-text'}),/权限/)
      assert.equal((await guard.request('sequence')).sequence,before)
      await clipboard.screenshot({path:'artifacts/tauri-migration/widget-business-clipboard.png'})
    })
    await scenario('record notifications reach only main and the registered clipboard widget and contain no image bytes',async()=>{
      const targets=[page,clipboard,launcher,group];for(const target of targets)await target.evaluate(()=>{window.__widgetClipboardRecords=[];window.__widgetClipboardStop=window.dustdesk.onClipboardChanged(record=>window.__widgetClipboardRecords.push(record))})
      await save(state=>{state.Settings.ClipboardMonitoringEnabled=true});const text='native-widget-event-'+randomUUID();await guard.request('set-text',{text})
      await waitFor(()=>clipboard.evaluate(text=>window.__widgetClipboardRecords.some(item=>item.Text===text),text));await waitFor(()=>page.evaluate(text=>window.__widgetClipboardRecords.some(item=>item.Text===text),text))
      for(const target of targets.slice(2))assert.deepEqual(await target.evaluate(()=>window.__widgetClipboardRecords),[])
      await guard.request('set-bitmap');await waitFor(()=>clipboard.evaluate(()=>window.__widgetClipboardRecords.some(item=>item.Kind==='Image')))
      const records=await clipboard.evaluate(()=>window.__widgetClipboardRecords);const image=records.find(item=>item.Kind==='Image');assert.equal(image.ImagePngBase64,'');assert.ok(image.ImageAssetName);assert.ok((await call(clipboard,'previewClipboardImage',image.Id)).ok)
      await save(state=>{state.Settings.ClipboardMonitoringEnabled=false});evidence.clipboardEvents=records.map(({Id,Kind})=>({Id,Kind}));await hide('clipboard')
    })
    await scenario('search sessions with identical request IDs isolate cancellation exact grants and the shared search widget UI',async()=>{
      search=await show('search');const first=await api('searchFiles','main-search-only','same-owner-request');const second=await call(search,'searchFiles','widget-search-only','same-owner-request');assert.equal(first.length,1);assert.equal(second.length,1)
      assert.ok((await api('getPathIcon',mainResult)).dataUrl);assert.ok((await call(search,'getPathIcon',widgetResult)).dataUrl)
      assert.equal((await api('openPath',widgetResult)).ok,false);assert.equal((await call(search,'openPath',mainResult)).ok,false);assert.equal((await call(launcher,'openPath',widgetResult)).ok,false)
      await api('cancelFileSearch','same-owner-request');assert.ok((await call(search,'getPathIcon',widgetResult)).dataUrl);assert.equal((await api('openPath',mainResult)).ok,false)
      await api('searchFiles','main-search-only','same-owner-request');await call(search,'cancelFileSearch','same-owner-request');assert.ok((await api('getPathIcon',mainResult)).dataUrl);assert.equal((await call(search,'openPath',widgetResult)).ok,false)
      await search.getByPlaceholder('搜索桌面文件').fill('widget-search-only');await search.getByRole('button',{name:'widget-search-only.exe',exact:true}).waitFor();await waitFor(()=>search.evaluate(()=>outerHeight>=350))
      await search.getByRole('button',{name:'widget-search-only.exe',exact:true}).click();await opened(widgetResult);await search.screenshot({path:'artifacts/tauri-migration/widget-business-search.png'})
      await search.getByPlaceholder('搜索桌面文件').fill('');await waitFor(()=>search.evaluate(()=>outerHeight<=60));await hide('search')
    })
    await scenario('monitor links project and countdown widgets render scoped business without borrowing another role',async()=>{
      const monitor=await show('monitor');const metrics=await call(monitor,'sampleSystemMetrics');assert.ok(metrics.TotalMemoryBytes>0);assert.ok(Number.isFinite(metrics.CpuPercent));assert.ok(metrics.UptimeSeconds>0)
      await assert.rejects(call(clipboard,'sampleSystemMetrics'),/权限/);await assert.rejects(call(monitor,'searchFiles','main','denied'),/权限/);await monitor.screenshot({path:'artifacts/tauri-migration/widget-business-monitor.png'});await hide('monitor')
      const links=await show('links');await links.getByRole('tab',{name:'组件链接分类'}).waitFor();await links.getByRole('button',{name:/离线链接展示/}).waitFor()
      assert.equal((await call(links,'openUrl','https://example.invalid/not-saved')).ok,false);assert.equal((await call(links,'openUrl','file:///C:/Windows')).ok,false);assert.equal((await call(links,'openPath',privatePath)).ok,false);assert.equal((await call(launcher,'openUrl','https://example.invalid/widget-saved')).ok,false);await hide('links')
      for(const key of ['projects','project:'+projectId]){const target=await show(key);await target.getByText('组件项目验证',{exact:true}).waitFor();const state=await call(target,'loadWorkspace');assert.deepEqual(state.Notes,[]);assert.equal(state.Projects.length,1);await hide(key)}
      const countdown=await show('countdown');await countdown.getByRole('heading',{name:'下班倒计时'}).waitFor();await hide('countdown');assert.deepEqual(errors,[])
    })
    await scenario('backup restore revokes both main and hidden widget search grants rather than only one owner',async()=>{
      await api('searchFiles','main-search-only','before-restore');await call(search,'searchFiles','widget-search-only','before-restore');assert.ok((await call(search,'getPathIcon',widgetResult)).dataUrl)
      const backup=await api('createBackup');assert.equal(backup.ok,true);const preview=await api('previewBackup',backup.path);assert.equal((await api('restoreBackup',backup.path,preview.fingerprint)).ok,true)
      assert.equal((await call(search,'openPath',widgetResult)).ok,false);assert.equal((await api('openPath',mainResult)).ok,false);evidence.searchOwners='main and registered search widget have separate result grants and cancellation, including the same request ID; restore revokes both'
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'native-role-scoped-widget-business-and-per-window-search',scenarios,evidence,pending:['saved-link-positive-Shell-navigation','hidden-window-reclamation','mixed-DPI-IME-sleep-external-drop','Electron-draft-migration','full-product-release-performance','production-data-takeover']},null,2))
  }finally{await app?.close();await guard.close()}
})
