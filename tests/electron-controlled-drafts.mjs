import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import ts from 'typescript'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'
import { recordDraftProvenance } from './draft-lineage-module.mjs'
import { createElectronDraftTransactions } from './draft-transaction-module.mjs'
import { draftModuleUrl } from './draft-module.mjs'
import { waitFor } from './tauri-harness.mjs'

const migration = await import(draftModuleUrl), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = 'artifacts/tauri-migration/electron-controlled-drafts'
const sources = ['tests/reference/src/main/draftBrowser.ts','tests/reference/src/main/draftStartup.ts','tests/reference/src/main/draftTransaction.ts','tests/reference/src/main/index.ts','tests/reference/src/preload/index.ts','tests/reference/src/preload/draftControl.ts','src/shared/draftMigration.ts','tests/electron-controlled-drafts.mjs','tests/electron-harness.mjs']

test('actual Electron session uses an empty controlled page, native observations and physical profile binding', {timeout:120000}, async suite => {
  await fs.mkdir(directory,{recursive:true})
  const report = {verified:false,productionReady:false,migrationComplete:false,checks:[],scope:'Actual Electron controlled native browser service in the ordinary app session and file URL, with a separate isolated native transaction root owned by Node. This is not the product import menu or its all-editor maintenance.'}
  const inputs = Object.fromEntries(await Promise.all(sources.map(async file=>[file,hash(await fs.readFile(file))])))
  const mainUrl = pathToFileURL(path.resolve('out/main/index.js')).href
  const compiled = ts.transpileModule(await fs.readFile('tests/reference/src/main/draftBrowser.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll("'../shared/draftMigration'",JSON.stringify(draftModuleUrl)).replaceAll('"../shared/draftMigration"',JSON.stringify(draftModuleUrl)).replaceAll('import.meta.url',JSON.stringify(mainUrl))
  const modulePath = path.resolve(directory,'runtime.mjs'); await fs.writeFile(modulePath,compiled)
  let app,owner,failed=false
  const requests=[],server=createServer((request,response)=>{requests.push(request.url);response.end('must never execute')})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const scenario=async(name,run)=>{await suite.test(name,async()=>{try{await run();report.checks.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Controlled browser scenario failed: '+name)}
  let location,binding,api,serialized,pending,keys,entry,baseline
  const call=(method,...args)=>app.electronApp.evaluate(async(_electron,{method,args})=>globalThis.__controlledDraft[method](...args),{method,args})
  const open=async target=>app.electronApp.evaluate(async({BrowserWindow},options)=>{
    const owner=BrowserWindow.getAllWindows().find(window=>window.webContents.getURL()===options.owner)
    const {openDraftBrowser}=await globalThis.__loadControlledDraft()
    globalThis.__controlledOwner=owner
    globalThis.__controlledAbort=new AbortController()
    globalThis.__controlledDraft=await openDraftBrowser(owner.webContents.session,options.location,{signal:globalThis.__controlledAbort.signal,assertActive(){if(globalThis.__controlledAbort.signal.aborted)throw Error('原生夹具已取消')}})
    globalThis.__controlledNativeWindow=BrowserWindow.getAllWindows().find(window=>window!==owner)
    return globalThis.__controlledDraft.binding
  },{owner:location,location:target??location,module:pathToFileURL(modulePath).href})
  try {
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'dustdesk-controlled-browser-')),bootstrap=path.join(root,'bootstrap.cjs')
    await fs.writeFile(bootstrap,'globalThis.__loadControlledDraft=()=>import('+JSON.stringify(pathToFileURL(modulePath).href)+'); require('+JSON.stringify(path.resolve('out/main/index.js'))+');')
    app=await launchDustDesk({tempRoot:root,bootstrap});location=app.window.url()
    await app.window.evaluate(async()=>{
      const state=await window.dustdesk.loadWorkspace();state.Settings.ClipboardMonitoringEnabled=false;state.Settings.AutomaticBackupEnabled=false;state.Settings.WidgetPlacements={};state.Settings.WidgetLayoutPresets={};state.DesktopCategories=[];state.Launchers=[]
      const result=await window.dustdesk.saveWorkspace(state);if(!result.ok)throw Error(result.error)
      localStorage.setItem('unrelated-controlled-secret','must-not-read');document.documentElement.inert=true
    })
    baseline=await fs.readFile(path.join(app.tempRoot,'data','workspace.json'))
    const nativeRoot=path.join(app.tempRoot,'controlled-native-state');owner=await acquireWorkspaceOwnership(nativeRoot)
    await fs.writeFile(path.join(nativeRoot,'workspace.json'),baseline);api=createElectronDraftTransactions(owner)
    entry={key:'widget-note:controlled-native-only',value:'{ "title":"原生受控页面🪶", "text":"正文", "previousTitle":"", "previousText":"" }'};keys=[entry.key]
    serialized=await migration.createDraftArchive([entry],{runtime:'tauri',appVersion:'1.0.2',workspaceFingerprint:hash(baseline)})
    await recordDraftProvenance(owner,serialized,hash(baseline))
    await scenario('exact native entry creates a blank sandbox without the desktop bridge and observes only whitelisted values',async()=>{
      binding=await open();assert.match(binding,/^[a-f0-9]{64}$/)
      const observed=await call('snapshot',keys);assert.equal(observed.journal,null);assert.equal(observed.values[entry.key],null);assert.equal(Object.hasOwn(observed.values,'unrelated-controlled-secret'),false)
      await assert.rejects(call('snapshot',['unrelated-controlled-secret']),/观察键无效/)
      const facts=await app.electronApp.evaluate(async({BrowserWindow})=>{
        const page=globalThis.__controlledNativeWindow
        const preferences=page.webContents.getLastWebPreferences()
        return {bridge:await page.webContents.executeJavaScript('typeof window.dustdesk'),require:await page.webContents.executeJavaScript('typeof require'),body:await page.webContents.executeJavaScript('document.body.innerHTML'),sandbox:preferences.sandbox,isolated:preferences.contextIsolation,node:preferences.nodeIntegration,hidden:!page.isVisible()}
      })
      assert.deepEqual(facts,{bridge:'undefined',require:'undefined',body:'',sandbox:true,isolated:true,node:false,hidden:true})
      report.profileBinding=binding
    })
    await scenario('write-ahead is on disk before actual browser staging and forged foreign responses cannot authorize a result',async()=>{
      pending=(await api.begin(randomUUID(),serialized,hash(baseline),binding,await call('snapshot',keys),()=>{})).record
      assert.equal(JSON.parse(await fs.readFile(path.join(owner.root,'ElectronMigrationTransaction.json'))).decision,'pending')
      assert.equal((await call('snapshot',keys)).journal,null)
      await app.electronApp.evaluate(({ipcMain,BrowserWindow})=>{
        globalThis.__foreignResponseCount=0
        const owner=globalThis.__controlledOwner
        const fake=(event,token,id)=>{if(event.sender===owner.webContents)return;++globalThis.__foreignResponseCount;ipcMain.emit('draft-control:result',{sender:owner.webContents,senderFrame:owner.webContents.mainFrame},token,id,'forged response')}
        globalThis.__foreignResponseListener=fake;ipcMain.prependListener('draft-control:result',fake)
      })
      await call('stage',serialized,hash(baseline))
      const staged=await call('snapshot',keys);assert.equal(staged.values[entry.key],entry.value);assert.equal(staged.receipts,null);assert.equal(hash(staged.journal),pending.journalSha256)
      assert.ok(await app.electronApp.evaluate(()=>globalThis.__foreignResponseCount)>0)
      await app.electronApp.evaluate(({ipcMain})=>ipcMain.removeListener('draft-control:result',globalThis.__foreignResponseListener))
      const committed=await api.decide(pending.requestId,pending.transactionId,true,binding,staged,()=>{});assert.equal(committed.decision,'commit')
      const recovery=await api.recover(binding,await call('snapshot',keys));await call('recover',recovery.decision);await call('flush')
      assert.equal((await recovery.complete(await call('snapshot',keys))).completed,true)
      assert.equal((await call('snapshot',keys)).values[entry.key],entry.value)
    })
    await scenario('closing restores the protocol and the same actual physical profile binds identically without reviving consumed input',async()=>{
      await call('close')
      assert.equal(await app.electronApp.evaluate(({session})=>session.defaultSession.protocol.isProtocolHandled('file')),false)
      await app.window.evaluate(key=>localStorage.removeItem(key),entry.key)
      assert.equal(await open(),binding)
      const recovery=await api.recover(binding,await call('snapshot',keys));await call('recover',recovery.decision);await recovery.complete(await call('snapshot',keys))
      assert.equal((await call('snapshot',keys)).values[entry.key],null)
      await call('close')
    })
    await scenario('native cancellation during an unanswered stage keeps the pending plan and a new controlled page explicitly aborts it',async()=>{
      assert.equal(await open(),binding)
      const incoming={key:'widget-note:cancelled-native-only',value:'{"saved":true}'}
      const archive=await migration.createDraftArchive([incoming],{runtime:'tauri',appVersion:'1.0.2',workspaceFingerprint:hash(baseline)})
      await recordDraftProvenance(owner,archive,hash(baseline));keys=[incoming.key]
      pending=(await api.begin(randomUUID(),archive,hash(baseline),binding,await call('snapshot',keys),()=>{})).record
      const before=await fs.readFile(path.join(owner.root,'ElectronMigrationTransaction.json'))
      await app.electronApp.evaluate(({BrowserWindow})=>{
        const page=globalThis.__controlledNativeWindow
        page.webContents.send=()=>{setTimeout(()=>globalThis.__controlledAbort.abort(),10)}
      })
      await assert.rejects(call('stage',archive,hash(baseline)),/取消|销毁|失效/)
      assert.deepEqual(await fs.readFile(path.join(owner.root,'ElectronMigrationTransaction.json')),before)
      await assert.rejects(call('snapshot',keys),/取消|失效|销毁/);await call('close')
      assert.equal(await open(),binding)
      const recovery=await api.recover(binding,await call('snapshot',keys));assert.equal(recovery.decision.decision,'abort');await call('recover',recovery.decision);await recovery.complete(await call('snapshot',keys))
      assert.equal((await call('snapshot',keys)).values[incoming.key],null);await call('close')
    })
    await scenario('a poisoned native file is never executed and wrong protocols, temporary profiles and existing handlers are rejected',async()=>{
      const poison=path.join(app.tempRoot,'poison.html'),origin='http://127.0.0.1:'+server.address().port
      await fs.writeFile(poison,'<!doctype html><script>fetch('+JSON.stringify(origin+'/script')+');window.open('+JSON.stringify(origin+'/window')+');localStorage.setItem("poison","ran")</script><img src="'+origin+'/image"><iframe src="'+origin+'/frame"></iframe>')
      const poisonBinding=await open(pathToFileURL(poison).href);assert.notEqual(poisonBinding,binding)
      const safe=await app.electronApp.evaluate(async({BrowserWindow})=>{
        const page=globalThis.__controlledNativeWindow
        return page.webContents.executeJavaScript('({body:document.body.innerHTML,poison:localStorage.getItem("poison"),bridge:typeof window.dustdesk})')
      });assert.deepEqual(safe,{body:'',poison:null,bridge:'undefined'});assert.deepEqual(requests,[]);await call('close')
      await assert.rejects(open('https://example.invalid/'),/file URL/)
      await app.electronApp.evaluate(({session})=>session.defaultSession.protocol.handle('file',()=>new Response('existing')))
      try {await assert.rejects(open(),/已有处理器/);assert.equal(await app.electronApp.evaluate(({session})=>session.defaultSession.protocol.isProtocolHandled('file')),true)}finally{await app.electronApp.evaluate(({session})=>session.defaultSession.protocol.unhandle('file'))}
      await assert.rejects(app.electronApp.evaluate(async({session},options)=>{const {openDraftBrowser}=await globalThis.__loadControlledDraft();return openDraftBrowser(session.fromPartition('temporary-controlled-fixture'),options.location,{signal:new AbortController().signal,assertActive(){}})},{location}),/持久化/)
    })
    assert.deepEqual(await fs.readFile(path.join(app.tempRoot,'data','workspace.json')),baseline)
    assert.equal(await app.window.evaluate(()=>localStorage.getItem('unrelated-controlled-secret')),'must-not-read')
    assert.equal(await app.electronApp.evaluate(({BrowserWindow,ipcMain})=>BrowserWindow.getAllWindows().filter(window=>window!==globalThis.__controlledOwner).length+ipcMain.listenerCount('draft-control:ready')+ipcMain.listenerCount('draft-control:result')),0)
    for(const[file,expected]of Object.entries(inputs))assert.equal(hash(await fs.readFile(file)),expected,file)
    report.inputs=inputs;report.verified=true
  }catch(error){report.error=String(error.stack??error);throw error}
  finally{await owner?.release();if(app){await app.electronApp.evaluate(async()=>{await globalThis.__controlledDraft?.close().catch(()=>{})}).catch(()=>{});await app.window.evaluate(()=>{document.documentElement.inert=false}).catch(()=>{});await closeDustDesk(app)}await new Promise(resolve=>server.close(resolve));await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2))}
})
