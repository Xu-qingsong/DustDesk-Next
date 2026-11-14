import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rename,stat,access,rm} from 'node:fs/promises'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {launchTauri} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const run=promisify(execFile)
const report='artifacts/tauri-migration/identity-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('fractional Windows creation times retain exact Electron identities through native JSON, startup recollection and backups',async suite=>{
  let app=await launchTauri();const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Identity scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const state=await electron.load();state.Settings.AutomaticBackupEnabled=false;state.Settings.ClipboardMonitoringEnabled=false;state.DesktopCategories=[{Id:'precision',Name:'精度测试',IsCollapsed:false,ItemPaths:[]}]
    const legacyDesktop=path.join(electron.root,'desktop');const desktop=path.join(app.root,'desktop');const data=path.join(app.root,'user-data','tauri-preview','Workspace');const location=path.join(data,'workspace.json')
    await mkdir(legacyDesktop,{recursive:true});await mkdir(desktop,{recursive:true});await mkdir(data,{recursive:true})
    const cases=Array.from({length:48},(_,index)=>({path:path.join(legacyDesktop,'精度-'+index+'.txt'),tick:15+index*137,body:'identity case '+index}))
    for(const item of cases)await writeFile(item.path,item.body)
    const payload=Buffer.from(JSON.stringify(cases)).toString('base64')
    const script="$ErrorActionPreference='Stop';$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json;foreach($item in $cases){$ticks=116444736000000000L+17942688000000000L+[long]$item.tick;[IO.File]::SetCreationTimeUtc($item.path,[DateTime]::FromFileTimeUtc($ticks))}"
    await run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:30000})
    await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(state))
    let imported;let importedRecords;let samples
    await scenario('real Electron restore records use the expected fixed fractional timestamps without native identity extensions',async()=>{
      for(const item of cases)assert.equal((await electron.invoke('organizer:move','precision',item.path)).ok,true)
      await electron.restoreOrganizerForQuit();const restored=await electron.load();assert.equal(restored.OrganizerDesktopRestores.length,cases.length)
      samples=await Promise.all(restored.OrganizerDesktopRestores.map(async record=>{const info=await stat(record.target);assert.equal(record.ino,info.ino);assert.equal(record.birthtimeMs,info.birthtimeMs);assert.equal(record.NativeTree,undefined);return {ino:info.ino,birthtimeMs:info.birthtimeMs}}))
      assert.equal(samples[0].birthtimeMs,1794268800000.0015)
      for(const record of restored.OrganizerDesktopRestores)await rename(record.target,path.join(desktop,path.basename(record.target)))
      const remap=value=>typeof value==='string'?value.replaceAll(electron.data,data).replaceAll(legacyDesktop,desktop):Array.isArray(value)?value.map(remap):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([key,item])=>[key,remap(item)])):value
      imported=remap(restored);importedRecords=structuredClone(imported.OrganizerDesktopRestores);imported.UnknownIdentityPrecision=samples
      evidence.records=cases.length;evidence.samples=samples.slice(0,6)
    })
    await scenario('strict native recollection accepts exact legacy values but never tolerates different inode or creation time',async()=>{
      for(const kind of ['inode','birth']){
        const target=path.join(desktop,'reject-'+kind+'.txt');const source=path.join(data,'DesktopOrganizer','精度测试',path.basename(target));await writeFile(target,'must remain on desktop');const info=await stat(target)
        const inode=info.ino+(kind==='inode'?Math.max(1,Math.abs(info.ino)*Number.EPSILON*2):0);const birth=info.birthtimeMs+(kind==='birth'?0.001:0)
        assert.notEqual(kind==='inode'?inode:birth,kind==='inode'?info.ino:info.birthtimeMs)
        imported.DesktopCategories[0].ItemPaths.push(source);imported.OrganizerDesktopRestores.push({source,target,categoryId:'precision',ino:inode,birthtimeMs:birth})
      }
      await app.close({preserve:true});await writeFile(location,JSON.stringify(imported));app=await launchTauri({workspace:true,rootDirectory:app.root});await app.page.locator('.app-shell').waitFor()
      for(let index=0;index<cases.length;index++){
        assert.equal(await readFile(importedRecords[index].source,'utf8'),cases[index].body);await assert.rejects(access(importedRecords[index].target),{code:'ENOENT'})
      }
      for(const kind of ['inode','birth']){
        assert.equal(await readFile(path.join(desktop,'reject-'+kind+'.txt'),'utf8'),'must remain on desktop');await assert.rejects(access(path.join(data,'DesktopOrganizer','精度测试','reject-'+kind+'.txt')),{code:'ENOENT'})
      }
      const native=await app.page.evaluate(()=>window.dustdesk.loadWorkspace());assert.deepEqual(native.OrganizerDesktopRestores,[]);assert.deepEqual(native.UnknownIdentityPrecision,samples)
    })
    await scenario('repeated native saves and process restarts retain every floating-point bit as parsed by Node',async()=>{
      for(let round=0;round<3;round++){
        const result=await app.page.evaluate(async round=>{const state=await window.dustdesk.loadWorkspace();state.QuickNote='precision-round-'+round;return window.dustdesk.saveWorkspace(state)},round);assert.equal(result.ok,true)
        assert.deepEqual(JSON.parse(await readFile(location,'utf8')).UnknownIdentityPrecision,samples)
        await app.close({preserve:true});app=await launchTauri({workspace:true,rootDirectory:app.root});await app.page.locator('.app-shell').waitFor();assert.deepEqual(await app.page.evaluate(async()=>(await window.dustdesk.loadWorkspace()).UnknownIdentityPrecision),samples)
      }
    })
    await scenario('native backup bytes and explicit restore preserve the same legacy numeric values without rounding or epsilon matching',async()=>{
      const created=await app.page.evaluate(()=>window.dustdesk.createBackup());assert.equal(created.ok,true)
      const backup=JSON.parse(await readFile(created.path,'utf8'));assert.deepEqual(backup.UnknownIdentityPrecision,samples)
      const preview=await app.page.evaluate(target=>window.dustdesk.previewBackup(target),created.path)
      const restored=await app.page.evaluate(async({target,fingerprint})=>window.dustdesk.restoreBackup(target,fingerprint),{target:created.path,fingerprint:preview.fingerprint});assert.equal(restored.ok,true)
      assert.deepEqual(JSON.parse(await readFile(location,'utf8')).UnknownIdentityPrecision,samples)
      evidence.roundTrips=3;evidence.backupRestore=true;evidence.strictMismatchesRejected=['different-inode','different-birthtime-by-0.001ms']
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'exact-legacy-file-identity-and-json-float-roundtrip',scenarios,evidence,pending:['production-takeover','all-filesystem-identity-matrix','release-performance']},null,2))
  }finally{await app.close()}
})
