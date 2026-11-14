import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir,readFile,writeFile,rm,readdir,access,symlink,rmdir } from 'node:fs/promises'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'
await test('native organizer transactions preserve files and match Electron ownership semantics',async suite=>{
  const report='artifacts/tauri-migration/organizer-native.json';await rm(report,{force:true})
  const app=await launchTauri();const scenarios=[];let failed=false
  const scenario=async(name,action)=>{await suite.test(name,async()=>{try{await action();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Organizer scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false
    initial.DesktopCategories=[{Id:'first',Name:'文档:项目',IsCollapsed:false,ItemPaths:[],Unknown:{keep:7}},{Id:'next',Name:'第二分类',IsCollapsed:true,ItemPaths:[]}]
    initial.UnknownOrganizer={keep:[1,2]}
    const desktop=path.join(app.root,'desktop');await mkdir(desktop);const electronDesktop=path.join(electron.root,'desktop');await mkdir(electronDesktop)
    const root=path.join(app.root,'user-data','tauri-preview','Workspace');const data=path.join(root,'workspace.json')
    const source=path.join(desktop,'原始文件.txt');await writeFile(source,'原始内容');await writeFile(path.join(electronDesktop,path.basename(source)),'原始内容')
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const remap=(value,replacements)=>typeof value==='string'?replacements.reduce((text,[source,target])=>text.replaceAll(source,target),value):Array.isArray(value)?value.map(item=>remap(item,replacements)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item,replacements)])):value
    const mapped=value=>remap(value,[[root,'<DATA>'],[electron.data,'<DATA>'],[desktop,'<DESKTOP>'],[electronDesktop,'<DESKTOP>']])
    const compare=async(channel,method,...args)=>{
      const before=await api('loadWorkspace');const legacy=remap(before,[[root,electron.data],[desktop,electronDesktop]])
      await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(legacy))
      const legacyArgs=args.map(argument=>typeof argument==='string'?argument.replace(root,electron.data).replace(desktop,electronDesktop):argument)
      const expected=await electron.invoke(channel,...legacyArgs);const actual=await api(method,...args);assert.equal(actual.ok,expected.ok,JSON.stringify({actual,expected}));assert.deepEqual(mapped(actual),mapped(expected))
      if(actual.ok){const next=mapped(await api('loadWorkspace'));const legacyNext=mapped(await electron.load());delete next.OrganizerTransactionId;delete legacyNext.OrganizerTransactionId;assert.deepEqual(next.DesktopCategories.find(category=>category.Id==='first').Unknown,{keep:7});for(const category of next.DesktopCategories)delete category.Unknown;for(const action of next.OrganizerUndoStack??[])if(action.sourceCategory)delete action.sourceCategory.Unknown;assert.deepEqual(next,legacyNext);assert.deepEqual(await readFile(actual.path),await readFile(expected.path))}
      return actual
    }
    let first
    await scenario('manual collect, category transfer, undo and restore match actual Electron IPC and original bytes',async()=>{
      first=(await compare('organizer:move','moveIntoCategory','first',source)).path;assert.ok(first);await assert.rejects(access(source),{code:'ENOENT'})
      const transferred=await compare('organizer:move','moveIntoCategory','next',first);assert.equal(transferred.ok,true)
      assert.equal((await compare('organizer:undo','undoOrganizerMove')).path,first)
      assert.equal((await compare('organizer:restore','restoreToDesktop','first',first)).path,source)
      assert.equal(await readFile(source,'utf8'),'原始内容')
    })
    await scenario('metadata failures compensate the real move and keep source bytes, ownership and undo unchanged',async()=>{
      const before=await readFile(data);await rm(data+'.bak',{force:true});await mkdir(data+'.bak')
      try{const result=await api('moveIntoCategory','first',source);assert.equal(result.ok,false);assert.equal(await readFile(source,'utf8'),'原始内容');assert.deepEqual(await readFile(data),before);await assert.rejects(access(first),{code:'ENOENT'});await assert.rejects(access(path.join(root,'organizer.pending.json')),{code:'ENOENT'})}finally{await rmdir(data+'.bak')}
      assert.match(await readFile(path.join(root,'Logs','organizer-move.log'),'utf8'),/move/)
    })
    await scenario('collisions and unowned paths never overwrite an existing file or publish a new reference',async()=>{
      await writeFile(first,'unrelated target');const before=await readFile(data)
      assert.equal((await api('moveIntoCategory','first',source)).ok,false);assert.equal(await readFile(first,'utf8'),'unrelated target');assert.equal(await readFile(source,'utf8'),'原始内容');assert.deepEqual(await readFile(data),before);await rm(first)
      const outside=path.join(app.root,'outside.txt');await writeFile(outside,'private')
      assert.equal((await api('moveIntoCategory','first',outside)).ok,false);assert.equal((await api('restoreToDesktop','first',outside)).ok,false);assert.equal(await readFile(outside,'utf8'),'private')
      await assert.rejects(app.invoke('workspace_organizer',{action:'move',categoryId:'first',source}),/not allowed|权限|denied/i)
    })
    await scenario('directory moves preserve nested files and reject source or destination junctions',async()=>{
      const directory=path.join(desktop,'目录');await mkdir(path.join(directory,'空目录'),{recursive:true});await writeFile(path.join(directory,'nested.bin'),Buffer.from([0,1,255]))
      const moved=await api('moveIntoCategory','first',directory);assert.equal(moved.ok,true,JSON.stringify(moved));assert.deepEqual(await readFile(path.join(moved.path,'nested.bin')),Buffer.from([0,1,255]));assert.deepEqual(await readdir(path.join(moved.path,'空目录')),[])
      assert.equal((await api('restoreToDesktop','first',moved.path)).ok,true)
      const junction=path.join(desktop,'junction');await symlink(directory,junction,'junction');try{assert.equal((await api('moveIntoCategory','first',junction)).ok,false)}finally{await rmdir(junction)}
      const target=path.join(root,'DesktopOrganizer','第二分类');const outside=path.join(app.root,'outside');await mkdir(outside);await rmdir(target);await symlink(outside,target,'junction');try{assert.equal((await api('moveIntoCategory','next',source)).ok,false);assert.deepEqual(await readdir(outside),[])}finally{await rmdir(target)}
    })
    await scenario('shared organizer collects from its real category menu then undo restores the original desktop item',async()=>{
      await page.getByRole('button',{name:'桌面收纳',exact:true}).click();const tile=page.locator('.organizer-entry').filter({hasText:'原始文件.txt'});await tile.waitFor()
      await tile.getByRole('button',{name:'收纳 原始文件.txt 到分类',exact:true}).click();await page.getByRole('menuitem',{name:/文档:项目/}).click()
      await waitFor(async()=>{try{await access(first);return true}catch{return false}});assert.equal(await readFile(first,'utf8'),'原始内容')
      await page.getByRole('button',{name:'撤销',exact:true}).click();await waitFor(async()=>{try{return await readFile(source,'utf8')==='原始内容'}catch{return false}})
      await mkdir('artifacts/tauri-migration',{recursive:true});await page.screenshot({path:'artifacts/tauri-migration/organizer-shared-native.png',fullPage:true});assert.deepEqual(errors,[])
    })
    if(failed)throw Error('Organizer scenario failed')
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-manual-organizer-transactions',scenarios,relatedReports:['organizer-smart-native.json','organizer-session-native.json','organizer-cross-volume.json'],pending:['physical-removable-device','all-widget-callers','physical-filesystem-faults','production-takeover']},null,2))
  }finally{await app.close()}
})
