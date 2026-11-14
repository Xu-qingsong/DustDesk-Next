import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { acquireWorkspaceOwnership } from './workspace-ownership-module.mjs'
import { createElectronDraftTransactions, electronDraftTransactionFile } from './draft-transaction-module.mjs'
import { draftModuleUrl } from './draft-module.mjs'

const migration = await import(draftModuleUrl), digest = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = 'artifacts/tauri-migration/electron-draft-handoff'
const sources = ['tests/reference/src/main/draftTransaction.ts','tests/reference/src/main/draftLineage.ts','tests/reference/src/main/workspaceOwnership.ts','src/shared/draftMigration.ts','src-tauri/src/workspace/draft_transaction.rs','src-tauri/src/workspace/draft_browser.rs','src-tauri/src/workspace/mod.rs','src-tauri/src/draft_startup.rs','tests/tauri-electron-draft-handoff.mjs','tests/draft-transaction-module.mjs','tests/draft-lineage-module.mjs','tests/tauri-harness.mjs']
function storage() { const values = new Map(); return { get length() { return values.size }, key:index=>[...values.keys()][index]??null, getItem:key=>values.get(key)??null, setItem:(key,value)=>{values.set(key,value)}, removeItem:key=>{values.delete(key)} } }
const snapshot = (target, keys) => ({ journal:target.getItem(migration.draftMigrationJournalKey),receipts:target.getItem(migration.draftMigrationReceiptsKey),values:Object.fromEntries(keys.map(key=>[key,target.getItem(key)])) })

test('actual Tauri export is accepted by the prepared Electron write-ahead kernel and incomplete Electron metadata blocks native startup', {timeout:120000}, async suite => {
  await fs.mkdir(directory,{recursive:true})
  const report={verified:false,productionReady:false,migrationComplete:false,checks:[],scope:'Real Tauri export and startup/working-directory guard; actual prepared Electron persistence module in Node with an in-memory target, not the Electron product importer or its actual browser/profile/maintenance workflow'}
  let app,owner,root,profile,page,failed=false
  const scenario=async(name,run)=>{await suite.test(name,async()=>{try{await run();report.checks.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Electron draft handoff scenario failed: '+name)}
  const stop=async()=>{await owner?.release();owner=undefined;if(app){await app.close({preserve:true});app=undefined}}
  const open=async(blocked=false)=>{app=await launchTauri({rootDirectory:root,workspace:true,expectRecoveryBlock:blocked});page=app.page}
  const attach=async()=>{owner=await acquireWorkspaceOwnership(profile);return createElectronDraftTransactions(owner)}
  let serialized,verified,original,pending,recordPath,api,target,keys
  const binding='e'.repeat(64) // Fixture binding only; no real Electron profile claim.
  try {
    report.inputs=Object.fromEntries(await Promise.all(sources.map(async file=>[file,digest(await fs.readFile(file))])))
    const fixture=await mainFixture(suite), initial=await fixture.load()
    initial.Settings.AutomaticBackupEnabled=false;initial.Settings.ClipboardMonitoringEnabled=false;initial.Settings.WidgetPlacements={};initial.Settings.WidgetLayoutPresets={};initial.DesktopCategories=[];initial.Launchers=[]
    app=await launchTauri();root=app.root;profile=path.join(root,'user-data','tauri-preview','Workspace');recordPath=path.join(profile,electronDraftTransactionFile)
    report.executableSha256=digest(await fs.readFile(app.executable))
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    await scenario('real native save dialog publishes a Tauri archive and normal exit releases its actual physical workspace',async()=>{
      await page.evaluate(()=>localStorage.setItem('widget-task-draft:v1:todo',JSON.stringify({title:'原生反向移交草稿🪶',requestId:'native-handoff'})))
      const destination=path.join(root,'tauri-reverse.json')
      const exporting=app.invoke('drafts_export',{},page)
      await operateDialog(app,'导出迁移草稿','select',destination)
      const result=await exporting;assert.equal(result.entries,1)
      serialized=await fs.readFile(destination,'utf8');verified=await migration.verifyDraftArchive(serialized)
      assert.equal(verified.payload.source.runtime,'tauri');keys=verified.payload.entries.map(entry=>entry.key)
      original=await fs.readFile(path.join(profile,'workspace.json'))
      const child=app.child
      await app.invoke('application_quit',{},page).catch(error=>assert.match(String(error),/closed|destroyed|disconnected/i))
      await waitFor(()=>child.exitCode!==null||child.signalCode!==null);assert.equal(child.exitCode,0)
      await stop()
    })
    await scenario('prepared native module persists a plan before browser writes and actual Tauri startup refuses its pending record',async()=>{
      api=await attach();target=storage()
      pending=(await api.begin(randomUUID(),serialized,digest(original),binding,snapshot(target,keys),()=>{})).record
      assert.equal(pending.decision,'pending');assert.equal(target.getItem(migration.draftMigrationJournalKey),null)
      const before=await fs.readFile(recordPath)
      await stop();await open(true)
      await page.getByRole('alert').filter({hasText:/Electron.*受控恢复/}).waitFor()
      assert.equal(await page.locator('.app-shell,.widget-head,input,textarea').count(),0)
      await assert.rejects(app.invoke('workspace_load',{},page),/恢复|启动/)
      assert.deepEqual(await fs.readFile(recordPath),before);assert.deepEqual(await fs.readFile(path.join(profile,'workspace.json')),original)
      await stop()
    })
    await scenario('explicit native abort and verified browser result permit the actual Tauri startup again',async()=>{
      api=await attach()
      const recovery=await api.recover(binding,snapshot(target,keys));assert.equal(recovery.decision.decision,'abort')
      await migration.recoverNativeDraftImport(target,recovery.decision)
      const completed=await recovery.complete(snapshot(target,keys));assert.equal(completed.completed,true)
      await stop();await open();await page.locator('.app-shell').waitFor()
      assert.deepEqual(await fs.readFile(path.join(profile,'workspace.json')),original)
      await stop()
    })
    await scenario('even an irreversible commit blocks Rust until the prepared native kernel verifies completion',async()=>{
      api=await attach();await (await api.recover(binding,snapshot(target,keys))).complete(snapshot(target,keys))
      pending=(await api.begin(randomUUID(),serialized,digest(original),binding,snapshot(target,keys),()=>{})).record
      const staged=(await migration.prepareDraftImport(serialized,digest(original))).stage(target,()=>true)
      assert.equal(staged.result.importedKeys.length,1)
      const committed=await api.decide(pending.requestId,pending.transactionId,true,binding,snapshot(target,keys),()=>{});assert.equal(committed.decision,'commit')
      const before=await fs.readFile(recordPath)
      await stop();await open(true);await page.getByRole('alert').filter({hasText:/Electron.*受控恢复/}).waitFor()
      assert.equal(await page.locator('.app-shell,.widget-head,input,textarea').count(),0);assert.deepEqual(await fs.readFile(recordPath),before)
      await stop();api=await attach()
      const recovery=await api.recover(binding,snapshot(target,keys));await migration.recoverNativeDraftImport(target,recovery.decision);await recovery.complete(snapshot(target,keys))
      assert.equal(target.getItem(keys[0]),verified.payload.entries[0].value)
      await stop();await open();await page.locator('.app-shell').waitFor()
      assert.deepEqual(await fs.readFile(path.join(profile,'workspace.json')),original)
    })
    for(const[file,expected]of Object.entries(report.inputs))assert.equal(digest(await fs.readFile(file)),expected,file)
    assert.equal(digest(await fs.readFile(app.executable)),report.executableSha256)
    report.verified=true
  }catch(error){report.error=String(error.stack??error);report.output=app?.output();throw error}
  finally{await owner?.release();await app?.close();if(root&&!app)await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify(report,null,2))}
})
