import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm,rmdir,symlink,access} from 'node:fs/promises'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const run=promisify(execFile)
await test('native filename search matches configured Electron scopes and supports cancellation, cache and exact grants',async suite=>{
  const report='artifacts/tauri-migration/search-native.json';await rm(report,{force:true})
  const app=await launchTauri();const scenarios=[];let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Search scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.DesktopCategories=[];initial.Projects=[];initial.Launchers=[]
    const desktop=path.join(app.root,'desktop');const legacyDesktop=path.join(electron.root,'desktop');const data=path.join(app.root,'user-data','tauri-preview','Workspace');const appData=path.dirname(data);const legacyAppData=path.join(electron.root,'appData')
    const custom=path.join(app.root,'custom');const project=path.join(app.root,'project');const nested=path.join(project,'nested')
    for(const directory of [desktop,legacyDesktop,appData,legacyAppData,custom,nested])await mkdir(directory,{recursive:true})
    for(const base of [desktop,legacyDesktop])await writeFile(path.join(base,'needle-桌面.txt'),'desktop bytes')
    for(const base of [appData,legacyAppData]){await writeFile(path.join(base,'needle-appdata.txt'),'appdata');const start=path.join(base,'Microsoft','Windows','Start Menu','Programs');await mkdir(start,{recursive:true});await writeFile(path.join(start,'needle-start-app.txt'),'start')}
    await writeFile(path.join(project,'needle-project.txt'),'project');await writeFile(path.join(nested,'needle-subtask.txt'),'subtask');await writeFile(path.join(custom,'needle-custom.txt'),'custom');await writeFile(path.join(custom,'NEEDLE-大写.txt'),'upper');await writeFile(path.join(custom,'😀.txt'),'emoji');await mkdir(path.join(custom,'needle-folder'));await writeFile(path.join(custom,'needle-folder','needle-child.txt'),'child')
    initial.Settings.SearchDesktopFiles=true;initial.Settings.SearchStartMenuApps=true;initial.Settings.SearchAppData=true;initial.Settings.SearchProjectPaths=true;initial.Settings.SearchCustomPaths=true;initial.Settings.SearchCustomRoots=[custom,project,nested,custom]
    initial.Projects=[{Id:'search-project',Name:'Search fixture',ProjectPath:project,Phases:[{Id:'phase',Title:'phase',Status:'NotStarted',ProgressPercent:0,ProjectPath:path.join(project,'needle-project.txt'),Subtasks:[{Id:'subtask',Title:'subtask',IsCompleted:false,FilePath:path.join(nested,'needle-subtask.txt')}]}]}]
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const remap=(value,source,target)=>typeof value==='string'?value.replaceAll(source,target):Array.isArray(value)?value.map(item=>remap(item,source,target)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item,source,target)])):value
    const legacy=async()=>{const state=await api('loadWorkspace');await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(state))}
    const compare=async query=>{await legacy();const expected=await electron.invoke('search:files',query,crypto.randomUUID());const actual=await api('searchFiles',query,crypto.randomUUID());assert.deepEqual(remap(remap(actual,desktop,'<DESKTOP>'),appData,'<APPDATA>'),remap(remap(expected,legacyDesktop,'<DESKTOP>'),legacyAppData,'<APPDATA>'));return actual}
    const settings=async changes=>{const state=await api('loadWorkspace');Object.assign(state.Settings,changes);assert.equal((await api('saveWorkspace',state)).ok,true)}
    const customOnly=async roots=>settings({SearchDesktopFiles:false,SearchStartMenuApps:false,SearchAppData:false,SearchProjectPaths:false,SearchCustomPaths:true,SearchCustomRoots:roots})
    await scenario('desktop start-menu isolated appdata project phases subtasks and custom roots match actual Electron IPC in breadth-first order',async()=>{
      const before=await readFile(path.join(data,'workspace.json'));const items=await compare('  NeEdLe  ');assert.ok(items.length>=8);assert.equal(new Set(items.map(item=>item.Path.toLowerCase())).size,items.length);assert.deepEqual(await readFile(path.join(data,'workspace.json')),before)
      await compare('😀');for(const query of ['a',' a ','\uFEFFa\uFEFF','x'.repeat(257),'😀'.repeat(129)])assert.deepEqual(await compare(query),[])
      await settings({SearchDesktopFiles:false,SearchStartMenuApps:false,SearchAppData:false,SearchProjectPaths:false,SearchCustomPaths:false});assert.deepEqual(await compare('needle'),[])
    })
    await scenario('duplicate nested roots result cap and ten-root selection match legacy without recursive content reads',async()=>{
      const capped=path.join(app.root,'capped');await mkdir(capped);for(let index=0;index<52;index++)await writeFile(path.join(capped,'cap-'+String(index).padStart(2,'0')+'.txt'),'content is not searched')
      await customOnly([capped,capped]);assert.equal((await compare('cap-')).length,40);assert.deepEqual(await api('searchFiles','content is not searched'),[])
      const roots=[];for(let index=0;index<12;index++){const directory=path.join(app.root,'root-'+index);await mkdir(directory);await writeFile(path.join(directory,'tenroot-'+index),'root');roots.push(directory)}await customOnly(roots);assert.equal((await compare('tenroot')).length,10)
    })
    await scenario('cache retains two-second legacy snapshots then expires and settings changes do not reuse another root set',async()=>{
      await customOnly([custom]);const source=path.join(custom,'cache-token-one');await writeFile(source,'old');assert.equal((await api('searchFiles','cache-token')).length,1);await rm(source);const next=path.join(custom,'cache-token-two');await writeFile(next,'new');assert.equal((await api('searchFiles','cache-token'))[0].Path,source);assert.equal((await api('openPath',source)).ok,false);await new Promise(resolve=>setTimeout(resolve,2100));assert.equal((await api('searchFiles','cache-token'))[0].Path,next);await customOnly([]);assert.deepEqual(await api('searchFiles','cache-token'),[])
    })
    await scenario('junctions device paths and arbitrary caller roots cannot expand the configured search boundary',async()=>{
      const outside=path.join(app.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'private-boundary.txt'),'private');const junction=path.join(custom,'private-junction');await symlink(outside,junction,'junction')
      try{await customOnly([custom,junction]);assert.deepEqual(await api('searchFiles','private'),[]);assert.deepEqual(await page.evaluate(outside=>window.__TAURI_INTERNALS__.invoke('system_search_files',{query:'private',requestId:'untrusted-roots',roots:[outside]}),outside),[]);const device=String.fromCharCode(92,92,46,92)+'NUL';await customOnly([device,custom+':stream']);assert.deepEqual(await api('searchFiles','needle'),[]);assert.equal((await api('openPath',path.join(outside,'private-boundary.txt'))).ok,false);await assert.rejects(app.invoke('system_search_files',{query:'needle',requestId:'role'}),/not allowed|权限|denied/i);await assert.rejects(app.invoke('system_search_cancel',{requestId:'role'}),/not allowed|权限|denied/i)}finally{await rmdir(junction)}
    })
    await scenario('cancelled and superseded scans do not overwrite newer results or hold the workspace save queue',async()=>{
      const broad=path.join(app.root,'broad');await mkdir(broad);for(let index=0;index<220;index++){const directory=path.join(broad,'folder-'+index);await mkdir(directory);await Promise.all(Array.from({length:10},(_,file)=>writeFile(path.join(directory,'scan-file-'+file),'scan')))}await customOnly([broad])
      const cancelled=await page.evaluate(async()=>{const search=window.dustdesk.searchFiles('scan-file','cancel-active');await window.dustdesk.cancelFileSearch('cancel-active');return search});assert.deepEqual(cancelled,[])
      const state=await api('loadWorkspace');const start=Date.now();const pending=api('searchFiles','does-not-match','save-concurrency');state.Notes[0].Text='saved during file scan';assert.equal((await api('saveWorkspace',state)).ok,true);assert.ok(Date.now()-start<2000);await api('cancelFileSearch','save-concurrency');await pending;assert.equal(JSON.parse(await readFile(path.join(data,'workspace.json'),'utf8')).Notes[0].Text,'saved during file scan')
      const next=await page.evaluate(async()=>{const old=window.dustdesk.searchFiles('scan-file','old');const latest=window.dustdesk.searchFiles('newer-no-match','new');await window.dustdesk.cancelFileSearch('old');return {old:await old,next:await latest}});assert.deepEqual(next.next,[]);assert.ok(Array.isArray(next.old));if(next.old.length)assert.equal((await api('openPath',next.old[0].Path)).ok,false)
    })
    await scenario('only exact current results may supply file icons or Shell open and the shared search bar opens without extra parameters',async()=>{
      const fixture=path.join(custom,'native-search-marker.exe');const source=path.join(app.root,'SearchFixture.cs');await writeFile(source,'using System;using System.IO;using System.Reflection;public class SearchFixture{public static void Main(string[] args){File.WriteAllText(Assembly.GetExecutingAssembly().Location+".opened","args="+args.Length);}}');await run('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/out:'+fixture,source],{windowsHide:true})
      await customOnly([custom]);assert.equal((await api('openPath',fixture)).ok,false);const results=await api('searchFiles','native-search-marker.exe','exact-grant');assert.equal(results.length,1);assert.ok(await api('getPathIcon',fixture));assert.equal((await api('openPath',custom)).ok,false);await api('cancelFileSearch','other-request');assert.ok((await api('getPathIcon',fixture)).dataUrl);await api('cancelFileSearch','exact-grant');assert.equal((await api('openPath',fixture)).ok,false)
      await api('searchFiles','query-with-no-results');assert.equal((await api('openPath',fixture)).ok,false)
      const search=page.getByRole('combobox',{name:'全局搜索'});await search.fill('native-search-marker.exe');await page.getByRole('option',{name:/native-search-marker.exe/}).waitFor();await page.screenshot({path:'artifacts/tauri-migration/search-shared-native.png',fullPage:true});await search.press('Enter');await waitFor(async()=>{try{return await readFile(fixture+'.opened','utf8')==='args=0'}catch{return false}});assert.equal(await search.inputValue(),'')
      assert.deepEqual(errors,[])
    })
    await scenario('successful backup restore revokes search capabilities and cached results',async()=>{
      const fixture=path.join(custom,'native-search-marker.exe');await api('searchFiles','native-search-marker.exe');const created=await api('createBackup');assert.equal(created.ok,true);const preview=await api('previewBackup',created.path);assert.equal((await api('restoreBackup',created.path,preview.fingerprint)).ok,true);assert.equal((await api('openPath',fixture)).ok,false);await assert.rejects(access(path.join(app.root,'uncreated')),{code:'ENOENT'})
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-native-filename-search',scenarios,pending:['production-known-folders','physical-network-disconnect','all-widget-callers','slow-disk-six-second-timeout-UX','release-performance','production-takeover']},null,2))
  }finally{await app.close()}
})
