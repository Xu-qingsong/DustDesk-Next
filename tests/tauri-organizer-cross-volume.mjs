import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,mkdtemp,writeFile,readFile,rm,rename,access,stat,readdir} from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'
import {quitOrganizer} from './tauri-organizer-session-support.mjs'
await test('real NTFS volumes verify organizer moves and automatic reverse-copy compensation in both directions',async suite=>{
  const output=path.resolve('artifacts/tauri-migration');await mkdir(output,{recursive:true})
  const report=path.join(output,'organizer-cross-volume.json');await rm(report,{force:true})
  const desktop=await mkdtemp(path.join(output,'cross-volume-desktop-'))
  assert.ok(path.resolve(desktop).startsWith(output+path.sep))
  let app
  const scenarios=[];let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Real cross-volume scenario failed: '+name)}
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
  try{
    app=await launchTauri({desktopDirectory:desktop})
    const data=path.join(app.root,'user-data','tauri-preview','Workspace');const location=path.join(data,'workspace.json')
    assert.ok(path.resolve(location+'.bak').startsWith(path.resolve(app.root)+path.sep))
    const volumes={desktop:(await stat(desktop)).dev,data:(await stat(app.root)).dev}
    assert.notEqual(volumes.desktop,volumes.data,'This verification requires two different filesystem volumes; a forced-copy test is not equivalent')
    const probe=path.join(desktop,'volume-probe');const relocated=path.join(app.root,'volume-probe');await writeFile(probe,'probe')
    await assert.rejects(rename(probe,relocated),{code:'EXDEV'});await rm(probe)
    const electron=await mainFixture(suite);const state=await electron.load();state.Settings.AutomaticBackupEnabled=false;state.DesktopCategories=[{Id:'cross',Name:'跨卷分类',IsCollapsed:false,ItemPaths:[]}]
    await app.invoke('prototype_workspace_initialize',{state});await app.invoke('prototype_open_workspace')
    let page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const source=path.join(desktop,'跨卷目录');await mkdir(path.join(source,'nested','empty'),{recursive:true});const bytes=Buffer.alloc(8*1024*1024);for(let index=0;index<bytes.length;index++)bytes[index]=index%251;await writeFile(path.join(source,'nested','content.bin'),bytes);await writeFile(path.join(source,'zero'),[])
    let collected
    await scenario('actual cross-volume collection preserves a nested tree and SHA256 before removing the original',async()=>{
      const result=await api('moveIntoCategory','cross',source);assert.equal(result.ok,true,JSON.stringify(result));collected=result.path
      assert.equal(digest(await readFile(path.join(collected,'nested','content.bin'))),digest(bytes));assert.deepEqual(await readdir(path.join(collected,'nested','empty')),[]);assert.equal((await stat(path.join(collected,'zero'))).size,0);await assert.rejects(access(source),{code:'ENOENT'});await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'})
    })
    await scenario('actual reverse-volume restore and persistent undo return all original bytes without orphan stages',async()=>{
      const restored=await api('restoreToDesktop','cross',collected);assert.equal(restored.ok,true,JSON.stringify(restored));assert.equal(restored.path,source);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes));await assert.rejects(access(collected),{code:'ENOENT'})
      const next=await api('moveIntoCategory','cross',source);assert.equal(next.ok,true,JSON.stringify(next));assert.equal((await api('undoOrganizerMove')).ok,true);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes));assert.ok(!(await readdir(desktop)).some(name=>name.startsWith('.dustdesk-move-')))
    })
    await scenario('metadata failure across real volumes reverse-copies original bytes before removing the failed target',async()=>{
      const before=await readFile(location);await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      const result=await api('moveIntoCategory','cross',source);assert.equal(result.ok,false)
      assert.deepEqual(await readFile(location),before);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes));assert.deepEqual(await readdir(path.join(source,'nested','empty')),[]);await assert.rejects(access(path.join(data,'DesktopOrganizer','跨卷分类','跨卷目录')),{code:'ENOENT'});await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'})
      assert.deepEqual(await api('loadWorkspace'),JSON.parse(before.toString()));assert.ok(!(await readdir(desktop)).some(name=>name.startsWith('.dustdesk-move-')))
      await rm(location+'.bak',{recursive:true});const retry=await api('moveIntoCategory','cross',source);assert.equal(retry.ok,true,JSON.stringify(retry));collected=retry.path
    })
    await scenario('failed desktop restore reverse-copies back to the managed volume and preserves undo metadata',async()=>{
      const before=await readFile(location);await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      const result=await api('restoreToDesktop','cross',collected);assert.equal(result.ok,false);assert.deepEqual(await readFile(location),before);assert.equal(digest(await readFile(path.join(collected,'nested','content.bin'))),digest(bytes));await assert.rejects(access(source),{code:'ENOENT'});await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'});assert.deepEqual(await api('loadWorkspace'),JSON.parse(before.toString()))
      assert.ok(!(await readdir(path.dirname(collected))).some(name=>name.startsWith('.dustdesk-move-')));await rm(location+'.bak',{recursive:true});assert.equal((await api('restoreToDesktop','cross',collected)).ok,true);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes))
    })
    await scenario('confirmed smart batches use actual cross-volume transactions and compensate metadata failures before permitting retry',async()=>{
      const plan=(await api('planSmartOrganize')).filter(item=>item.SourcePath===source);assert.equal(plan.length,1)
      const before=await readFile(location);await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      try{
        const result=await api('executeSmartOrganize',plan);assert.equal(result.ok,false);assert.equal(result.moved,0);assert.deepEqual(await readFile(location),before);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes));await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'})
      }finally{await rm(location+'.bak',{recursive:true})}
      assert.deepEqual(await api('executeSmartOrganize',plan),{ok:true,moved:1});await assert.rejects(access(source),{code:'ENOENT'});assert.equal((await api('undoOrganizerMove')).ok,true);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes))
    })
    await scenario('cross-volume quit persists destination identity and startup compensation refreshes copied identity before a successful retry',async()=>{
      const moved=await api('moveIntoCategory','cross',source);assert.equal(moved.ok,true,JSON.stringify(moved));const managed=moved.path;const before=await api('loadWorkspace')
      await quitOrganizer(app,page,'restore');const restored=JSON.parse(await readFile(location,'utf8'));assert.deepEqual(restored.DesktopCategories,before.DesktopCategories);assert.deepEqual(restored.OrganizerUndoStack,before.OrganizerUndoStack);assert.equal(restored.OrganizerDesktopRestores.length,1);const record=restored.OrganizerDesktopRestores[0];const info=await stat(source);assert.equal(record.ino,info.ino);assert.equal(record.birthtimeMs,info.birthtimeMs);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes));await writeFile(path.join(source,'nested','edited.txt'),'edited while closed')
      const root=app.root;await app.close({preserve:true});await rm(location+'.bak',{force:true});await mkdir(location+'.bak');app=await launchTauri({rootDirectory:root,desktopDirectory:desktop})
      try{
        await assert.rejects(app.invoke('prototype_workspace_load'),/补偿|完整|保留/);assert.equal(digest(await readFile(path.join(source,'nested','content.bin'))),digest(bytes));assert.equal(await readFile(path.join(source,'nested','edited.txt'),'utf8'),'edited while closed');const journal=JSON.parse(await readFile(path.join(data,'organizer.pending.json'),'utf8'));assert.ok(journal.rollback?.tree);assert.equal(await readFile(path.join(managed,'nested','edited.txt'),'utf8'),'edited while closed')
      }finally{await rm(location+'.bak',{recursive:true})}
      const resumed=await app.invoke('prototype_workspace_load');assert.deepEqual(resumed.state.DesktopCategories,before.DesktopCategories);assert.deepEqual(resumed.state.OrganizerUndoStack,before.OrganizerUndoStack);assert.deepEqual(resumed.state.OrganizerDesktopRestores,[]);assert.equal(digest(await readFile(path.join(managed,'nested','content.bin'))),digest(bytes));assert.equal(await readFile(path.join(managed,'nested','edited.txt'),'utf8'),'edited while closed');await assert.rejects(access(source),{code:'ENOENT'});await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'})
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'actual-distinct-volume-NTFS-fixtures',volumes,renameRejectedAs:'EXDEV',scenarios,pending:['physical-removable-drive-disconnect','ACL-stream-metadata-parity','partial-copy-manual-repair-ui','production-takeover']},null,2))
  }finally{
    await app?.close()
    const absolute=path.resolve(desktop);assert.ok(absolute.startsWith(output+path.sep)&&path.basename(absolute).startsWith('cross-volume-desktop-'))
    await rm(absolute,{recursive:true,force:true,maxRetries:5,retryDelay:100})
  }
})
