import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir,readFile,writeFile,rm,rename,stat,access,rmdir } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri,waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { quitOrganizer } from './tauri-organizer-session-support.mjs'

await test('native quit choices and persistent desktop sessions preserve ownership, edits and legacy file identities',async suite=>{
  const report='artifacts/tauri-migration/organizer-session-native.json';await rm(report,{force:true})
  let app=await launchTauri();let page;const scenarios=[];let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Session scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.DesktopCategories=[{Id:'session',Name:'分类',IsCollapsed:false,ItemPaths:[],Unknown:{keep:7}}]
    const desktop=path.join(app.root,'desktop');await mkdir(desktop);const data=path.join(app.root,'user-data','tauri-preview','Workspace');const location=path.join(data,'workspace.json')
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const bind=async()=>{page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()}
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const restart=async()=>{const root=app.root;await app.close({preserve:true});app=await launchTauri({workspace:true,rootDirectory:root});await bind()}
    await bind();const source=path.join(desktop,'会话.txt');await writeFile(source,'original bytes');const moved=await api('moveIntoCategory','session',source);assert.equal(moved.ok,true,JSON.stringify(moved));const managed=moved.path
    await scenario('native cancellation defaults to Cancel and resumes editing without changing files or classification',async()=>{
      const before=await readFile(location);const outcome=await quitOrganizer(app,page,'cancel');assert.match(outcome.error,/取消/);assert.deepEqual(await readFile(location),before);assert.equal(await readFile(managed,'utf8'),'original bytes');const state=await api('loadWorkspace');state.DesktopCategories[0].IsCollapsed=true;assert.equal((await api('saveWorkspace',state)).ok,true)
    })
    await scenario('restore-and-quit avoids desktop collisions, retains references and undo, and recollects same-identity edits after a real process restart',async()=>{
      await writeFile(source,'unrelated namesake');const before=await api('loadWorkspace');await quitOrganizer(app,page,'restore')
      const state=JSON.parse(await readFile(location,'utf8'));assert.deepEqual(state.DesktopCategories,before.DesktopCategories);assert.deepEqual(state.OrganizerUndoStack,before.OrganizerUndoStack);assert.equal(state.OrganizerDesktopRestores.length,1);const record=state.OrganizerDesktopRestores[0];assert.equal(record.target,path.join(desktop,'会话 (1).txt'));const info=await stat(record.target);assert.equal(record.ino,info.ino);assert.equal(record.birthtimeMs,info.birthtimeMs);await assert.rejects(access(managed),{code:'ENOENT'});await writeFile(record.target,'edited while closed')
      await restart();assert.equal(await readFile(managed,'utf8'),'edited while closed');assert.equal(await readFile(source,'utf8'),'unrelated namesake');await assert.rejects(access(record.target),{code:'ENOENT'});assert.deepEqual((await api('loadWorkspace')).OrganizerDesktopRestores,[])
    })
    await scenario('keep-and-quit leaves managed bytes in place without a temporary restoration record',async()=>{
      await quitOrganizer(app,page,'keep');assert.equal(await readFile(managed,'utf8'),'edited while closed');assert.deepEqual(JSON.parse(await readFile(location,'utf8')).OrganizerDesktopRestores,[]);await restart()
    })
    await scenario('metadata failure after confirmation cancels quit, compensates the physical move and restores editing before retry',async()=>{
      const before=await readFile(location)
      try{const outcome=await quitOrganizer(app,page,'restore',async()=>{await rm(location+'.bak',{force:true});await mkdir(location+'.bak')});assert.match(outcome.error,/失败|拒绝|denied|directory|目录|os error/i);assert.deepEqual(await readFile(location),before);assert.equal(await readFile(managed,'utf8'),'edited while closed');await assert.rejects(access(path.join(data,'organizer.pending.json')),{code:'ENOENT'})}finally{await rmdir(location+'.bak')}
      const state=await api('loadWorkspace');state.DesktopCategories[0].IsCollapsed=false;assert.equal((await api('saveWorkspace',state)).ok,true)
    })
    await scenario('a desktop replacement with the same name and bytes is not mistaken for the temporarily restored original',async()=>{
      await quitOrganizer(app,page,'restore');const state=JSON.parse(await readFile(location,'utf8'));const record=state.OrganizerDesktopRestores[0];await rename(record.target,record.target+'.kept');await writeFile(record.target,'edited while closed');await restart();assert.equal(await readFile(record.target,'utf8'),'edited while closed');await assert.rejects(access(managed),{code:'ENOENT'});assert.deepEqual((await api('loadWorkspace')).OrganizerDesktopRestores,[])
    })
    await scenario('native-produced desktop identity records are accepted by the real Electron recollection implementation',async()=>{
      const source=path.join(desktop,'native-to-electron.txt');await writeFile(source,'native identity bytes');assert.equal((await api('moveIntoCategory','session',source)).ok,true);await quitOrganizer(app,page,'restore')
      const state=JSON.parse(await readFile(location,'utf8'));assert.equal(state.OrganizerDesktopRestores.length,1);const legacyDesktop=path.join(electron.root,'desktop');await mkdir(legacyDesktop,{recursive:true});await mkdir(path.join(electron.data,'DesktopOrganizer','分类'),{recursive:true});await rename(state.OrganizerDesktopRestores[0].target,path.join(legacyDesktop,'native-to-electron.txt'))
      const remap=value=>typeof value==='string'?value.replaceAll(data,electron.data).replaceAll(desktop,legacyDesktop):Array.isArray(value)?value.map(remap):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item)])):value
      await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(remap(state)));await electron.resumeOrganizerSession();assert.equal(await readFile(path.join(electron.data,'DesktopOrganizer','分类','native-to-electron.txt'),'utf8'),'native identity bytes');assert.deepEqual((await electron.load()).OrganizerDesktopRestores,[]);await restart()
    })
    await scenario('Electron-produced identity records are consumed on native startup without regenerating category ownership',async()=>{
      const legacyDesktop=path.join(electron.root,'desktop');await mkdir(legacyDesktop,{recursive:true});const legacySource=path.join(legacyDesktop,'legacy.txt');await writeFile(legacySource,'legacy identity bytes');const state=await electron.load();state.DesktopCategories=[{Id:'session',Name:'分类',IsCollapsed:false,ItemPaths:[]}];await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(state));assert.equal((await electron.invoke('organizer:move','session',legacySource)).ok,true);await electron.restoreOrganizerForQuit();const restored=await electron.load();assert.equal(restored.OrganizerDesktopRestores.length,1)
      const anchor=path.join(desktop,'restart-anchor.txt');await writeFile(anchor,'restart anchor');assert.equal((await api('moveIntoCategory','session',anchor)).ok,true)
      await quitOrganizer(app,page,'keep');const oldRoot=app.root;await app.close({preserve:true});const record=restored.OrganizerDesktopRestores[0];const destination=path.join(desktop,'legacy.txt');await rename(record.target,destination)
      const remap=value=>typeof value==='string'?value.replaceAll(electron.data,data).replaceAll(legacyDesktop,desktop):Array.isArray(value)?value.map(remap):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item)])):value
      await writeFile(location,JSON.stringify(remap(restored)));app=await launchTauri({workspace:true,rootDirectory:oldRoot});await bind();assert.equal(await readFile(path.join(data,'DesktopOrganizer','分类','legacy.txt'),'utf8'),'legacy identity bytes');await assert.rejects(access(destination),{code:'ENOENT'});assert.deepEqual((await api('loadWorkspace')).OrganizerDesktopRestores,[])
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-native-quit-and-restart-session',scenarios,relatedReports:['organizer-cross-volume.json'],pending:['slow-filesystem-queue','physical-removable-disconnect','all-widget-editors','production-takeover']},null,2))
  }finally{await app.close()}
})
