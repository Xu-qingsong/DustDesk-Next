import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rm, access, symlink, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'

await test('native smart organizer preserves rule previews, confirmed batch semantics and transactional failures', async suite => {
  const report = 'artifacts/tauri-migration/organizer-smart-native.json'
  await rm(report, { force:true })
  const app = await launchTauri()
  const scenarios = []
  let failed = false
  const scenario = async (name, action) => {
    await suite.test(name, async () => { try { await action(); scenarios.push(name) } catch(error) { failed=true; throw error } })
    if(failed) throw Error('Smart organizer scenario failed: '+name)
  }
  try {
    const electron = await mainFixture(suite)
    const initial = await electron.load()
    initial.Settings.AutomaticBackupEnabled = false
    initial.DesktopCategories = ['首分类','工作','开发','工具','文件'].map((Name,index)=>({ Id:'category-'+index,Name,IsCollapsed:false,ItemPaths:[],Unknown:{keep:7} }))
    initial.OrganizerRules = []
    const desktop = path.join(app.root,'desktop')
    const legacyDesktop = path.join(electron.root,'desktop')
    await mkdir(desktop); await mkdir(legacyDesktop)
    const data = path.join(app.root,'user-data','tauri-preview','Workspace')
    const location = path.join(data,'workspace.json')
    assert.ok(path.resolve(location+'.bak').startsWith(path.resolve(app.root)+path.sep))
    await app.invoke('prototype_workspace_initialize',{state:initial})
    await app.invoke('prototype_open_workspace')
    const page = await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api = (method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const remap = (value,source,target) => typeof value==='string'?value.replaceAll(source,target):Array.isArray(value)?value.map(item=>remap(item,source,target)):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item,source,target)])):value
    const legacyState = async()=>{
      const state = remap(remap(await api('loadWorkspace'),data,electron.data),desktop,legacyDesktop)
      await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(state))
    }
    const ordered = plan => plan.sort((left,right)=>left.SourcePath.localeCompare(right.SourcePath))
    const comparePlan = async()=>{
      await legacyState()
      const before=await readFile(location)
      const expected=await electron.invoke('organizer:plan-smart')
      const actual=await api('planSmartOrganize')
      assert.deepEqual(ordered(remap(actual,desktop,'<DESKTOP>')),ordered(remap(expected,legacyDesktop,'<DESKTOP>')))
      assert.deepEqual(await readFile(location),before)
      return actual
    }
    const rule=(Id,Enabled,Match,Pattern,CategoryId)=>({Id,Enabled,Match,Pattern,CategoryId})
    const saveRules=async rules=>{const result=await api('productivity',{type:'rules-save',rules});assert.equal(result.ok,true,JSON.stringify(result))}
    const item=(source,category='category-1')=>({SourcePath:source,CategoryId:category,CategoryName:'不可信的旧分类名'})
    const sample=async name=>{const source=path.join(desktop,name);await writeFile(source,'original '+name);return source}
    await scenario('default extensions, directories, Unicode and configured rules match actual Electron preview IPC without moving files',async()=>{
      const names=['报告.DOC','报告.docx','sheet.XLSX','slides.ppt','manual.pdf','readme.MD','code.JS','code.tsx','code.cs','code.cpp','code.h','code.py','code.json','code.css','code.HTML','setup.EXE','setup.msi','shortcut.lnk','script.BAT','script.cmd','image.PNG','archive.tar.gz','plain','报告-special.png','Special-case.bin','İ-prefix.bin','ΟΣ.bin','desktop.INI']
      for(const name of names){await sample(name);await writeFile(path.join(legacyDesktop,name),'original '+name)}
      await mkdir(path.join(desktop,'directory.TS'));await mkdir(path.join(legacyDesktop,'directory.TS'))
      const defaults=await comparePlan();assert.equal(defaults.length,names.length);assert.ok(!defaults.some(item=>path.basename(item.SourcePath).toLowerCase()==='desktop.ini'))
      await saveRules([
        rule('disabled',false,'name','报告','category-3'),
        rule('extensions',true,'extension',' , ， *.PDF，.TxT,docx ','category-2'),rule('name',true,'name',' 报告，SPECIAL ','category-0'),
        rule('unicode',true,'name','i̇,ος','category-1')
      ])
      await comparePlan()
      await saveRules([rule('bom',true,'extension','\uFEFF *.PDF \uFEFF','category-3'),rule('nel',true,'extension','\u0085doc','category-2')]);await comparePlan()
      await saveRules([])
      for(const name of names)assert.equal(await readFile(path.join(desktop,name),'utf8'),'original '+name)
    })
    await scenario('missing malformed oversized and duplicate confirmations match legacy replies without implicit rescans',async()=>{
      const source=await sample('confirmed.txt');await writeFile(path.join(legacyDesktop,'confirmed.txt'),'original confirmed.txt')
      for(const plan of [undefined,{},[item(source),null],[{SourcePath:7,CategoryId:'category-1'}],Array(5001).fill(item(source)),[]]){
        await legacyState();const expected=await electron.invoke('organizer:execute-smart',remap(plan,desktop,legacyDesktop));const actual=await api('executeSmartOrganize',plan);assert.deepEqual(actual,expected)
        assert.equal(await readFile(source,'utf8'),'original confirmed.txt')
      }
      const plan=[item(source),item(source,'category-2')];await legacyState()
      assert.deepEqual(await api('executeSmartOrganize',plan),await electron.invoke('organizer:execute-smart',remap(plan,desktop,legacyDesktop)))
      assert.equal(await readFile(path.join(data,'DesktopOrganizer','工作','confirmed.txt'),'utf8'),'original confirmed.txt');assert.equal((await api('undoOrganizerMove')).ok,true);assert.equal(await readFile(source,'utf8'),'original confirmed.txt')
    })
    await scenario('partial failures retain successes, reject non-desktop and junction paths and keep recorded undo ahead of recovered collisions',async()=>{
      const collision=await sample('batch-collision.txt');const success=await sample('batch-success.txt');const missing=await sample('batch-missing-category.txt')
      const target=path.join(data,'DesktopOrganizer','工作','batch-collision.txt');await writeFile(target,'unrelated target')
      const outside=path.join(app.root,'outside.txt');await writeFile(outside,'private');const nested=path.join(desktop,'directory.TS','nested.txt');await writeFile(nested,'nested')
      const junction=path.join(desktop,'batch-junction');await symlink(path.dirname(outside),junction,'junction')
      try{
        for(const source of [collision,success,missing])await writeFile(path.join(legacyDesktop,path.basename(source)),await readFile(source))
        const legacyTarget=path.join(electron.data,'DesktopOrganizer','工作','batch-collision.txt');await writeFile(legacyTarget,'unrelated target')
        const legacyOutside=path.join(electron.root,'outside.txt');await writeFile(legacyOutside,'private');await writeFile(path.join(legacyDesktop,'directory.TS','nested.txt'),'nested');await symlink(electron.root,path.join(legacyDesktop,'batch-junction'),'junction')
        const plan=[item(collision),item(success),item(outside),item(nested),item(missing,'deleted'),item(junction)]
        await legacyState();const expected=await electron.invoke('organizer:execute-smart',remap(remap(plan,desktop,legacyDesktop),outside,legacyOutside))
        const result=await api('executeSmartOrganize',plan);assert.deepEqual(result,expected)
        assert.deepEqual(result,{ok:false,moved:1,error:'已整理 1 项，5 项失败，请重新扫描；已完成的项目可逐项撤销'})
        assert.equal(await readFile(target,'utf8'),'unrelated target');assert.equal(await readFile(collision,'utf8'),'original batch-collision.txt');assert.equal(await readFile(outside,'utf8'),'private');assert.equal(await readFile(nested,'utf8'),'nested');await assert.rejects(access(success),{code:'ENOENT'})
        assert.equal((await api('undoOrganizerMove')).ok,true);assert.equal(await readFile(success,'utf8'),'original batch-success.txt');assert.equal(await readFile(target,'utf8'),'unrelated target')
        assert.match(await readFile(path.join(data,'Logs','organizer-move.log'),'utf8'),/智能收纳/)
      }finally{await rmdir(junction);await rm(target)}
    })
    await scenario('execution uses current category ownership and safe directory names rather than the preview label',async()=>{
      const source=await sample('renamed-category.txt');const plan=[item(source)]
      const state=await api('loadWorkspace');state.DesktopCategories.find(category=>category.Id==='category-1').Name='工作:已更名';assert.equal((await api('saveWorkspace',state)).ok,true)
      assert.deepEqual(await api('executeSmartOrganize',plan),{ok:true,moved:1})
      assert.equal(await readFile(path.join(data,'DesktopOrganizer','工作_已更名','renamed-category.txt'),'utf8'),'original renamed-category.txt')
      const next=await api('loadWorkspace');assert.deepEqual(next.DesktopCategories[0].Unknown,{keep:7});assert.equal((await api('undoOrganizerMove')).ok,true)
    })
    await scenario('metadata failure compensates every attempted file without advancing workspace or undo and role checks deny preview windows',async()=>{
      const first=await sample('fault-first.txt');const second=await sample('fault-second.txt');const before=await readFile(location)
      await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      try{
        const result=await api('executeSmartOrganize',[item(first),item(second)]);assert.equal(result.ok,false);assert.equal(result.moved,0);assert.deepEqual(await readFile(location),before);assert.equal(await readFile(first,'utf8'),'original fault-first.txt');assert.equal(await readFile(second,'utf8'),'original fault-second.txt');await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'})
        await assert.rejects(app.invoke('workspace_organizer',{action:'plan'}),/not allowed|权限|denied/i);await assert.rejects(app.invoke('workspace_organizer',{action:'execute',plan:[item(first)]}),/not allowed|权限|denied/i)
      }finally{await rmdir(location+'.bak')}
    })
    await scenario('shared Lucide preview and confirmed execution move real fixture files then expose successful per-item undo',async()=>{
      await page.getByRole('button',{name:'桌面收纳',exact:true}).click();await page.getByRole('button',{name:'智能预览',exact:true}).click()
      await page.getByRole('list',{name:'整理预览列表'}).waitFor();const plan=await api('planSmartOrganize');assert.ok(plan.length>10)
      assert.equal(await page.locator('.organizer-plan-row').count(),plan.length)
      await page.screenshot({path:'artifacts/tauri-migration/organizer-smart-preview-native.png',fullPage:true})
      await page.getByRole('button',{name:'执行计划',exact:true}).click();await waitFor(async()=>!(await page.getByRole('list',{name:'整理预览列表'}).count()))
      for(const entry of plan)await assert.rejects(access(entry.SourcePath),{code:'ENOENT'})
      assert.equal(await readFile(path.join(desktop,'desktop.INI'),'utf8'),'original desktop.INI')
      const current=await api('loadWorkspace');assert.ok(current.OrganizerUndoStack.length>=plan.length)
      const latest=current.OrganizerUndoStack.at(-1);await page.getByRole('button',{name:'撤销',exact:true}).click();await waitFor(async()=>{try{await access(latest.source);return true}catch{return false}})
      await page.screenshot({path:'artifacts/tauri-migration/organizer-smart-shared-native.png',fullPage:true});assert.deepEqual(errors,[])
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-smart-preview-and-confirmed-batch',scenarios,relatedReports:['organizer-session-native.json','organizer-cross-volume.json'],pending:['slow-filesystem-storage-queue','physical-removable-disconnect','ACL-stream-metadata-parity','all-widget-callers','production-takeover']},null,2))
  }finally{await app.close()}
})
