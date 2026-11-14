import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomUUID } from 'node:crypto'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { toolboxModules } from './toolbox-fixture.mjs'
import { operateDialog } from './tauri-dialog.mjs'
const run = promisify(execFile)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const listening = port => new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});let settled=false;const finish=value=>{if(!settled){settled=true;socket.destroy();resolve(value)}};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(2000,()=>finish(false))})
function peerRequest(ready,identity,route,body,stream) {
  const result=new Promise((resolve,reject)=>{
    const outgoing=https.request({host:'127.0.0.1',port:ready.port,path:route,method:'POST',key:identity.key,cert:identity.cert,rejectUnauthorized:false,headers:{'Content-Type':stream||Buffer.isBuffer(body)?'application/octet-stream':'application/json'}},async response=>{try{const chunks=[];for await(const chunk of response)chunks.push(chunk);resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())})}catch(error){reject(error)}})
    outgoing.on('error',reject);outgoing.setTimeout(12000,()=>outgoing.destroy(Error('test request timed out')))
    outgoing.on('socket',socket=>socket.once('secureConnect',()=>{if(hash(socket.getPeerCertificate().raw)!==ready.fingerprint)outgoing.destroy(Error('peer pin changed'))}))
    if(stream)stream(outgoing);else outgoing.end(Buffer.isBuffer(body)?body:JSON.stringify(body))
  });result.catch(()=>{});return result
}
const reportPath = 'artifacts/tauri-migration/lan-host-native.json'
test('desktop LAN host owns real TLS transfers, native decisions and lifecycle independently of the main WebView', {timeout:300000}, async suite => {
  await fs.rm(reportPath,{force:true})
  const report = {verified:false, productionReady:false, migrationComplete:false, checks:[], scope:'Isolated Debug desktop host and real WebView2 IPC, Windows native dialogs and old Electron LAN module over loopback; no physical two-machine or production takeover claim'}
  let app, page, old, stranger
  let receiveHold=false, continueOld
  const cleanup = []
  const api = (method,...args) => page.evaluate(({method,args})=>window.dustdesk.toolbox[method](...args),{method,args})
  const invoke = (command,args={}) => app.invoke(command,args,page)
  const observe = async (name,job) => { await job(); report.checks.push(name); console.log('PASS:',name) }
  const dialog = async (title,action='snapshot',button) => {
    const result = await run('pwsh.exe',['-NoProfile','-STA','-File','tests/tauri-lan-dialog.ps1','-ProcessId',String(app.child.pid),'-Title',title,'-Action',action,...(button?['-Button',button]:[])],{windowsHide:true,timeout:18000,maxBuffer:1024*1024})
    return ['snapshot','absent'].includes(action)?JSON.parse(result.stdout):result.stdout
  }
  const show = async () => {
    await app.invoke('prototype_open_workspace')
    page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>!target.isClosed()&&target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
  }
  const start = async () => { app=await launchTauri({lanLocalOnly:true,releaseDelayMs:400,...(app?{rootDirectory:app.root}: {})}) }
  const completed = id => waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.find(task=>task.id===id&&task.status==='completed')),20000)
  const oldDone = id => waitFor(()=>old.snapshot().tasks.find(task=>task.id===id&&task.status==='completed'),20000)
  try {
    await start()
    const electron=await mainFixture(suite); const state=await electron.load()
    state.Settings.AutomaticBackupEnabled=false;state.Settings.ClipboardMonitoringEnabled=false;state.Settings.SidebarHidden=[];state.DesktopCategories=[];state.Launchers=[];state.Settings.WidgetPlacements={};state.Settings.WidgetLayoutPresets={}
    await app.invoke('prototype_workspace_initialize',{state}); await show()
    const preview=path.join(app.root,'user-data','tauri-preview'), profile=path.join(preview,'LanTransfers')
    await fs.mkdir(path.join(preview,'Downloads'),{recursive:true})
    const modules=await toolboxModules({after:callback=>cleanup.push(callback)})
    const options=name=>({storage:path.join(modules.root,name),downloads:path.join(modules.root,'downloads'),host:'127.0.0.1',name,discovery:false,changed(){},confirmPair:async()=>true,confirmReceive:async()=>{if(receiveHold)await new Promise(resolve=>{continueOld=resolve});return path.join(modules.root,'downloads')}})
    await fs.mkdir(path.join(modules.root,'downloads'))
    old=modules.lan.createLanService(options('旧版设备')); await old.enable(true)
    const oldIdentity=JSON.parse(await fs.readFile(path.join(modules.root,'旧版设备','identity.json'),'utf8'))
    await observe('disabled snapshots create neither profile nor identity and other window roles cannot invoke LAN commands',async()=>{
      const snapshot=await api('lanSnapshot');assert.equal(snapshot.enabled,false);assert.deepEqual(snapshot.tasks,[])
      assert.equal(await fs.stat(profile).then(()=>true,()=>false),false)
      for(const command of ['toolbox_lan_attach','toolbox_lan_snapshot','toolbox_lan_enable','toolbox_lan_connect','toolbox_lan_send','toolbox_lan_control']) await assert.rejects(app.invoke(command,{lease:'forged',enabled:true,address:'127.0.0.1',port:12345,device:'peer',assets:[],text:'x',id:'id',action:'clear'}),/not allowed|权限|denied/i)
      await assert.rejects(api('registerPaths',[path.join(app.root,'unselected')],'transfer'),/未获原生选择授权/)
      await assert.rejects(api('lanSend','peer',['forged']),/授权/)
    })
    await observe('native page lease rejects old main commands after reload before they can change background service state',async()=>{
      const lease=await invoke('toolbox_lan_attach');await page.reload();await page.locator('.app-shell').waitFor()
      for(const command of ['toolbox_lan_snapshot','toolbox_lan_enable','toolbox_lan_connect','toolbox_lan_send','toolbox_lan_control'])await assert.rejects(invoke(command,{lease,enabled:true,address:'127.0.0.1',port:old.snapshot().port,device:'peer',assets:[],text:'late request',id:'old',action:'clear'}),/授权已失效/)
      await assert.rejects(invoke('toolbox_lan_enable',{lease,enabled:false}),/授权已失效/)
      assert.equal(await fs.stat(profile).then(()=>true,()=>false),false)
      assert.equal((await api('lanSnapshot')).enabled,false)
    })
    let handoffIdentity
    await observe('disabled desktop snapshots and explicit controls refuse a profile owned by the preparation module without reading or creating native state',async()=>{
      const owner=modules.lan.createLanService({...options('competing-owner'),storage:profile})
      await owner.enable(true);await owner.enable(false)
      handoffIdentity=await fs.readFile(path.join(profile,'identity.json'))
      const before=await fs.readFile(path.join(profile,'state.json'))
      try {
        for(const [method,...args] of [['lanSnapshot'],['lanEnable',true],['lanEnable',false]])await assert.rejects(api(method,...args),/另一个进程|锁访问被拒绝/)
        assert.deepEqual(await fs.readFile(path.join(profile,'state.json')),before)
        assert.deepEqual(await fs.readFile(path.join(profile,'identity.json')),handoffIdentity)
        assert.deepEqual((await fs.readdir(profile)).sort(),['identity.json','state.json'])
      } finally { await owner.dispose() }
      assert.equal((await api('lanSnapshot')).enabled,false)
    })
    await page.evaluate(()=>{window.__lanEvents=[];window.__lanUnsubscribe=window.dustdesk.toolbox.onLanChanged(snapshot=>window.__lanEvents.push(snapshot))})
    let enabled=await api('lanEnable',true)
    const identityBytes=await fs.readFile(path.join(profile,'identity.json')); const identity=JSON.parse(identityBytes)
    assert.deepEqual(identityBytes,handoffIdentity)
    assert.equal(enabled.enabled,true);assert.ok(enabled.port>0)
    await observe('the actual desktop service excludes a preparation-module restore or enable and preserves identity and saved state',async()=>{
      const refused=modules.lan.createLanService({...options('refused-owner'),storage:profile})
      const before=await fs.readFile(path.join(profile,'state.json'))
      try { await assert.rejects(refused.restore(),/另一个进程|锁访问被拒绝/);await assert.rejects(refused.enable(true),/另一个进程|锁访问被拒绝/) }
      finally { await refused.dispose() }
      assert.deepEqual(await fs.readFile(path.join(profile,'state.json')),before)
      assert.deepEqual(await fs.readFile(path.join(profile,'identity.json')),identityBytes)
    })
    let device
    await observe('main API starts native identity/TLS listener and explicit pairing persists the actual peer fingerprint',async()=>{
      const pending=api('lanConnect','127.0.0.1',old.snapshot().port);pending.catch(()=>{})
      const modal=await dialog('局域网设备配对');assert.equal(modal.visible,true)
      await dialog('局域网设备配对','click','配对码一致，继续');device=await pending
      assert.equal(device.fingerprint,oldIdentity.fingerprint)
      assert.ok(JSON.parse(await fs.readFile(path.join(profile,'state.json'),'utf8')).trusted.includes(oldIdentity.fingerprint))
      await waitFor(()=>page.evaluate(()=>window.__lanEvents.some(snapshot=>snapshot.enabled)))
    })
    await observe('public text submission settles through real old receiver and live events carry the declared snapshot shape',async()=>{
      const text='Tauri 主页面 → 旧版 😀\n中文文本 '+randomUUID()
      await api('lanSend',device.id,[],text)
      const sent=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.find(task=>task.direction==='send'&&task.text===text)))
      await completed(sent.id)
      assert.ok(old.snapshot().tasks.some(task=>task.direction==='receive'&&task.text===text&&task.status==='completed'))
      const event=await waitFor(()=>page.evaluate(id=>window.__lanEvents.find(snapshot=>snapshot.tasks.some(task=>task.id===id)),sent.id))
      assert.ok(Array.isArray(event.tasks));assert.equal(typeof event.enabled,'boolean')
    })
    let nativePeer=await old.connect('127.0.0.1',enabled.port)
    await observe('incoming text uses real native decline/accept decisions and is absent from restart files',async()=>{
      await old.send(nativePeer.id,[],'用户拒绝文本')
      const declined = old.snapshot().tasks.at(-1).id
      await dialog('接收局域网内容','click','取消')
      await waitFor(()=>old.snapshot().tasks.find(task=>task.id===declined&&task.status==='failed'))
      assert.ok(!(await api('lanSnapshot')).tasks.some(task=>task.text==='用户拒绝文本'))
      const text='旧版 → Tauri 😀 '+randomUUID();await old.send(nativePeer.id,[],text)
      await dialog('接收局域网内容','click','接收')
      await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.some(task=>task.text===text&&task.status==='completed')))
      assert.ok(!JSON.parse(await fs.readFile(path.join(profile,'state.json'),'utf8')).tasks.some(task=>task.manifest.text))
    })
    let fileAsset
    await observe('native files/folders return scoped asset IDs and actual file bytes arrive at the old endpoint',async()=>{
      const source=path.join(app.root,'原生发送 中文😀.bin');const bytes=Buffer.from('real file bytes 中文😀\0'.repeat(8000));await fs.writeFile(source,bytes)
      const pending=api('pick','files');pending.catch(()=>{});await operateDialog(app,'选择发送文件','select',source);[fileAsset]=await pending
      assert.equal(fileAsset.name,path.basename(source));assert.equal(fileAsset.size,bytes.length)
      await assert.rejects(api('readAsset',fileAsset.id),/授权/)
      await api('lanSend',device.id,[fileAsset.id])
      const sent=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.find(task=>task.name===fileAsset.name)))
      await completed(sent.id)
      const received=old.snapshot().tasks.find(task=>task.direction==='receive'&&task.name===fileAsset.name)
      assert.equal(hash(await fs.readFile(path.join(received.directory,fileAsset.name))),hash(bytes))
      const dir=path.join(app.root,'发送文件夹');await fs.mkdir(path.join(dir,'空目录'),{recursive:true});await fs.writeFile(path.join(dir,'one.txt'),'目录内容')
      const picking=api('pick','folder');picking.catch(()=>{});await operateDialog(app,'选择发送文件夹','select',dir);const assets=await picking
      assert.equal(assets.length,1);await api('lanSend',device.id,[assets[0].id])
      const task=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.find(task=>task.name==='发送文件夹')));await completed(task.id)
      const result=old.snapshot().tasks.find(task=>task.name==='发送文件夹'&&task.direction==='receive')
      assert.equal(await fs.readFile(path.join(result.directory,'发送文件夹','one.txt'),'utf8'),'目录内容')
      assert.equal((await fs.stat(path.join(result.directory,'发送文件夹','空目录'))).isDirectory(),true)
      await api('releaseAssets',[fileAsset.id]);await assert.rejects(api('lanSend',device.id,[fileAsset.id]),/授权/)
    })
    await observe('local receive pause waits for real streaming cleanup and revokes old network tokens before clear',async()=>{
      const id='native-local-control-'+randomUUID(), bytes=Buffer.alloc(1024*1024,37)
      const manifest={id,name:'接收暂停文件',entries:[{relative:'partial.bin',size:bytes.length,mtime:0,hash:hash(bytes)}],directories:[]}
      const request=(route,body,stream)=>{
        const result=new Promise((resolve,reject)=>{
          const outgoing=https.request({host:'127.0.0.1',port:enabled.port,path:route,method:'POST',key:oldIdentity.key,cert:oldIdentity.cert,rejectUnauthorized:false,headers:{'Content-Type':stream?'application/octet-stream':'application/json'}},async response=>{try{const chunks=[];for await(const chunk of response)chunks.push(chunk);resolve({status:response.statusCode,body:JSON.parse(Buffer.concat(chunks).toString())})}catch(error){reject(error)}})
          outgoing.on('error',reject);outgoing.setTimeout(12000,()=>outgoing.destroy(Error('test timeout')))
          outgoing.on('socket',socket=>socket.once('secureConnect',()=>{if(hash(socket.getPeerCertificate().raw)!==identity.fingerprint)outgoing.destroy(Error('pin changed'))}))
          if(stream)stream(outgoing);else outgoing.end(JSON.stringify(body))
        });result.catch(()=>{});return result
      }
      const offer=request('/offer',manifest);await dialog('接收局域网内容','click','接收到默认目录');const accepted=await offer;assert.equal(accepted.status,200)
      const nativeId=oldIdentity.fingerprint+'-'+id, token=accepted.body.token
      const stream=request(`/file?id=${id}&token=${token}&index=0&offset=0`,null,outgoing=>outgoing.write(bytes.subarray(0,128*1024)))
      const task=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.find(task=>task.id===nativeId&&task.done>=128*1024)))
      await api('lanControl',nativeId,'pause');await stream.catch(()=>{})
      assert.equal((await api('lanSnapshot')).tasks.find(task=>task.id===nativeId).status,'paused')
      await assert.rejects(api('lanControl',nativeId,'resume'),/发送电脑/)
      assert.equal((await request(`/file?id=${id}&token=${token}&index=0&offset=131072`,{})).status,400)
      await api('lanControl',nativeId,'clear');assert.ok(!(await api('lanSnapshot')).tasks.some(task=>task.id===nativeId))
      assert.deepEqual(await fs.readdir(task.directory),[])
    })
    await observe('maintenance cancels the actual incoming modal, joins LAN before checkpoint and restores saved preference',async()=>{
      await old.send(nativePeer.id,[],'维护期间待确认')
      await dialog('接收局域网内容')
      const checkpoint=await invoke('drafts_prepare')
      assert.equal((await dialog('接收局域网内容','absent')).absent,true)
      assert.equal(JSON.parse(await fs.readFile(path.join(profile,'state.json'),'utf8')).enabled,true)
      await assert.rejects(api('lanEnable',true),/正在/)
      assert.equal(await invoke('drafts_end',{requestId:checkpoint.requestId}),true)
      enabled=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.enabled&&snapshot))
      nativePeer=await old.connect('127.0.0.1',enabled.port)
    })
    await observe('renderer reload revokes its pending pairing without stopping the background host',async()=>{
      stranger=modules.lan.createLanService(options('另一个设备'));await stranger.enable(true)
      await page.evaluate(port=>{window.__pendingLan=window.dustdesk.toolbox.lanConnect('127.0.0.1',port).catch(String)},stranger.snapshot().port)
      await dialog('局域网设备配对');await page.reload();await page.locator('.app-shell').waitFor()
      await waitFor(async()=>(await dialog('局域网设备配对','absent')).absent)
      assert.equal((await api('lanSnapshot')).enabled,true)
    })
    await observe('workspace restore cancels pending main pairing, joins LAN and resumes the independent identity and receive service',async()=>{
      const backup=await page.evaluate(()=>window.dustdesk.createBackup());assert.equal(backup.ok,true)
      const pending=api('lanConnect','127.0.0.1',stranger.snapshot().port);pending.catch(()=>{})
      await dialog('局域网设备配对')
      const restored=await page.evaluate(target=>window.dustdesk.restoreBackup(target),backup.path)
      assert.equal(restored.ok,true,restored.error);await assert.rejects(pending,/取消|失效/)
      assert.equal((await dialog('局域网设备配对','absent')).absent,true)
      enabled=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.enabled&&snapshot))
      assert.deepEqual(await fs.readFile(path.join(profile,'identity.json')),identityBytes)
      nativePeer=await old.connect('127.0.0.1',enabled.port)
    })
    await observe('main WebView reclamation leaves native receiving alive and recreated main sees the received text',async()=>{
      const before=page;await page.evaluate(()=>window.dustdesk.hideMainWindow());await waitFor(()=>before.isClosed(),12000)
      const text='没有主窗口仍可接收 '+randomUUID();await old.send(nativePeer.id,[],text)
      await dialog('接收局域网内容','click','接收')
      const sent=old.snapshot().tasks.at(-1);await oldDone(sent.id)
      await show();assert.ok((await api('lanSnapshot')).tasks.some(task=>task.text===text&&task.status==='completed'))
    })
    await observe('failed state persistence still closes the real listener and native modal, and explicit disable can retry after storage recovers',async()=>{
      const pending=api('lanConnect','127.0.0.1',stranger.snapshot().port);pending.catch(()=>{});await dialog('局域网设备配对')
      const statePath=path.join(profile,'state.json'), preserved=path.join(profile,'state-test-preserved.json'),port=enabled.port
      await fs.rename(statePath,preserved);await fs.mkdir(statePath)
      try {
        await assert.rejects(api('lanEnable',false),/保存|目录|拒绝|denied|directory|目录名/i)
        await assert.rejects(pending,/取消|失效|关闭/)
        assert.equal(await listening(port),false,'failed state save must not leave TCP listening')
        assert.equal((await dialog('局域网设备配对','absent')).absent,true)
      }finally{await fs.rmdir(statePath);await fs.rename(preserved,statePath)}
      assert.equal((await api('lanEnable',false)).enabled,false)
      enabled=await api('lanEnable',true)
    })
    await observe('explicit disable closes the TCP listener, cancels a visible native modal and preserves identity',async()=>{
      const pending=api('lanConnect','127.0.0.1',stranger.snapshot().port);pending.catch(()=>{})
      await dialog('局域网设备配对');const previous=enabled.port
      const disabled=await api('lanEnable',false);assert.equal(disabled.enabled,false);await assert.rejects(pending,/取消|关闭/)
      assert.equal((await dialog('局域网设备配对','absent')).absent,true)
      assert.equal(JSON.parse(await fs.readFile(path.join(profile,'state.json'),'utf8')).enabled,false)
      await assert.rejects(old.connect('127.0.0.1',previous))
      const snapshot=await api('lanSnapshot'), textTask=snapshot.tasks.find(task=>task.text)
      assert.ok(textTask,'same-process suspend must retain text in RAM')
      await api('lanControl',textTask.id,'clear')
      assert.ok(!(await api('lanSnapshot')).tasks.some(task=>task.id===textTask.id))
      const fileTask=(await api('lanSnapshot')).tasks.find(task=>task.name===fileAsset.name)
      await api('lanControl',fileTask.id,'clear')
      assert.ok(!(await api('lanSnapshot')).tasks.some(task=>task.id===fileTask.id))
      enabled=await api('lanEnable',true);assert.deepEqual(await fs.readFile(path.join(profile,'identity.json')),identityBytes)
      assert.ok(enabled.tasks.some(task=>task.text),'reenable must restore remaining same-process text')
    })
    let pausedId, resumeName, resumeBytes, receiveRestart
    await observe('real partial receiving remains supervised while the desktop prepares to quit',async()=>{
      const bytes=Buffer.alloc(1024*1024+27,73),id='desktop-receive-restart-'+randomUUID(),offset=128*1024
      const manifest={id,name:'接收跨进程续传',entries:[{relative:'跨进程.bin',size:bytes.length,mtime:0,hash:hash(bytes)}],directories:[]}
      const ready={port:enabled.port,fingerprint:identity.fingerprint}
      const offer=peerRequest(ready,oldIdentity,'/offer',manifest);await dialog('接收局域网内容','click','接收到默认目录');const accepted=await offer;assert.equal(accepted.status,200)
      const token=accepted.body.token,taskId=oldIdentity.fingerprint+'-'+id
      const stream=peerRequest(ready,oldIdentity,`/file?id=${id}&token=${token}&index=0&offset=0`,null,outgoing=>outgoing.write(bytes.subarray(0,offset)))
      const task=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.tasks.find(task=>task.id===taskId&&task.done>=offset)))
      receiveRestart={bytes,manifest,offset,taskId,token,stream,directory:task.directory}
    })
    await observe('native sender can pause while old receiver confirmation is pending without accepting a late response',async()=>{
      device=await api('lanConnect','127.0.0.1',old.snapshot().port)
      resumeName='跨进程续传.bin';resumeBytes=Buffer.from('resume real bytes 中文😀'.repeat(10000));const source=path.join(app.root,resumeName);await fs.writeFile(source,resumeBytes)
      const picking=api('pick','files');picking.catch(()=>{});await operateDialog(app,'选择发送文件','select',source);const [asset]=await picking
      receiveHold=true;continueOld=undefined;await api('lanSend',device.id,[asset.id]);await waitFor(()=>Boolean(continueOld))
      pausedId=(await api('lanSnapshot')).tasks.find(task=>task.name===resumeName).id
      await api('lanControl',pausedId,'pause');receiveHold=false;continueOld();continueOld=undefined
      assert.equal((await api('lanSnapshot')).tasks.find(task=>task.id===pausedId).status,'paused')
      assert.ok(!old.snapshot().tasks.some(task=>task.name===resumeName))
    })
    await observe('normal quit stops LAN with enabled preference retained and a real process restart restores the same identity',async()=>{
      await invoke('application_quit').catch(error=>{if(!/closed|destroyed/i.test(String(error)))throw error})
      await waitFor(()=>app.child.exitCode===0,20000)
      await receiveRestart.stream.catch(()=>{})
      assert.equal(JSON.parse(await fs.readFile(path.join(profile,'state.json'),'utf8')).enabled,true)
      await app.close({preserve:true});await old.dispose();old=modules.lan.createLanService(options('旧版设备'));await old.enable(true);await start();await show()
      enabled=await waitFor(()=>api('lanSnapshot').then(snapshot=>snapshot.enabled&&snapshot));assert.ok(enabled.port>0)
      assert.deepEqual(await fs.readFile(path.join(profile,'identity.json')),identityBytes)
      assert.ok(!enabled.tasks.some(task=>task.text),'text must not survive process restart')
      assert.equal(enabled.tasks.find(task=>task.id===pausedId).status,'paused')
      assert.equal(enabled.tasks.find(task=>task.id===receiveRestart.taskId).status,'paused')
      await api('lanConnect','127.0.0.1',old.snapshot().port);await api('lanControl',pausedId,'resume');await completed(pausedId)
      const received=await waitFor(()=>old.snapshot().tasks.find(task=>task.name===resumeName&&task.status==='completed'))
      assert.equal(hash(await fs.readFile(path.join(received.directory,resumeName))),hash(resumeBytes))
    })
    await observe('restarted desktop requires native approval for the exact saved receive directory and resumes verified partial bytes',async()=>{
      const {manifest,bytes,offset,taskId,token,directory}=receiveRestart,ready={port:enabled.port,fingerprint:identity.fingerprint}
      assert.equal((await peerRequest(ready,oldIdentity,`/file?id=${manifest.id}&token=${token}&index=0&offset=${offset}`,Buffer.alloc(0))).status,400)
      const offered=peerRequest(ready,oldIdentity,'/offer',manifest);const modal=await dialog('接收局域网内容');assert.equal(modal.visible,true)
      await dialog('接收局域网内容','click','接收');const accepted=await offered;assert.equal(accepted.status,200);assert.notEqual(accepted.body.token,token)
      const actual=accepted.body.offsets[0];assert.equal(actual.size,offset);assert.equal(actual.hash,hash(bytes.subarray(0,offset)))
      const fresh=accepted.body.token
      assert.equal((await peerRequest(ready,oldIdentity,`/file?id=${manifest.id}&token=${fresh}&index=0&offset=${offset}`,bytes.subarray(offset))).status,200)
      assert.equal((await peerRequest(ready,oldIdentity,`/complete?id=${manifest.id}&token=${fresh}`,{})).status,200)
      const task=await completed(taskId);assert.equal(task.directory,directory);assert.equal(hash(await fs.readFile(path.join(directory,'跨进程.bin'))),hash(bytes))
    })
    await observe('unchanged shared React LAN page selects the real peer, sends text and displays native task events',async()=>{
      await page.getByRole('button',{name:'局域网传输',exact:true}).click()
      const peer=page.locator('.lan-device').filter({hasText:'旧版设备'});await peer.waitFor();await peer.click()
      await page.getByRole('button',{name:'文本',exact:true}).click()
      const text='共享 React 页面实际发送 '+randomUUID();await page.getByRole('textbox',{name:'发送文本',exact:true}).fill(text)
      await page.getByRole('button',{name:'发送',exact:true}).click()
      await waitFor(()=>old.snapshot().tasks.some(task=>task.direction==='receive'&&task.text===text&&task.status==='completed'))
      await waitFor(()=>page.locator('.lan-task').count().then(count=>count>0))
      await page.screenshot({path:'artifacts/tauri-migration/lan-host-shared.png'})
    })
    await observe('actual Windows OLE file drop reaches the LAN page and authorizes only the dropped path for real sending',async()=>{
      const helper=path.join(app.root,'lan-ole-source.exe')
      const vswhere=path.join(process.env['ProgramFiles(x86)'],'Microsoft Visual Studio','Installer','vswhere.exe')
      const visualStudio=(await run(vswhere,['-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],{windowsHide:true})).stdout.trim()
      assert.ok(path.isAbsolute(visualStudio))
      const compiler='"'+path.join(visualStudio,'Common7','Tools','VsDevCmd.bat')+'" -no_logo -arch=x64 && cl.exe /nologo /std:c++17 /EHsc /W4 /WX /utf-8 "'+path.resolve('tests/tauri-file-drop-native.cpp')+'" /Fe:"'+helper+'" /Fo:"'+path.join(app.root,'lan-ole-source.obj')+'" /link ole32.lib shell32.lib shlwapi.lib user32.lib'
      await run('cmd.exe',['/d','/s','/c','"'+compiler+'"'],{windowsVerbatimArguments:true,windowsHide:true,timeout:30000,maxBuffer:1024*1024})
      const name='实际拖入 中文😀.bin',source=path.join(app.root,name),sibling=path.join(app.root,'未拖入.bin'),bytes=Buffer.from('real OLE to actual LAN sender\0中文😀')
      await fs.writeFile(source,bytes);await fs.writeFile(sibling,'not authorized')
      await page.getByRole('button',{name:'文件 / 文件夹',exact:true}).click()
      const target=page.locator('.lan-send-body');await target.scrollIntoViewIfNeeded();const bounds=await target.boundingBox();assert.ok(bounds)
      const dragged=await run(helper,[app.root,String(app.child.pid),String(bounds.x+bounds.width/2),String(bounds.y+bounds.height/2),'drop',source],{windowsHide:true,timeout:15000,maxBuffer:1024*1024})
      const outcome=JSON.parse(dragged.stdout);assert.equal(outcome.hresult,0x40100);assert.equal(outcome.effect,1);assert.ok(outcome.queries>0);report.ole=outcome
      await page.locator('.lan-pending').getByText(name,{exact:true}).waitFor()
      const [asset]=await api('registerPaths',[source],'transfer');assert.equal(asset.name,name)
      for(const other of [sibling,app.root])await assert.rejects(api('registerPaths',[other],'transfer'),/授权/)
      await page.getByRole('button',{name:'发送',exact:true}).click()
      const received=await waitFor(()=>old.snapshot().tasks.find(task=>task.name===name&&task.status==='completed'))
      assert.equal(hash(await fs.readFile(path.join(received.directory,name))),hash(bytes))
      await page.reload();await page.locator('.app-shell').waitFor();await assert.rejects(api('registerPaths',[source],'transfer'),/授权/)
      await api('lanEnable',false)
    })
    report.verified=true
    report.inputs=Object.fromEntries(await Promise.all(['src-tauri/src/lan_host.rs','src-tauri/src/lan/files.rs','src-tauri/src/lan/publication.rs','src-tauri/src/lan/publication/legacy.rs','src-tauri/src/lan/receiver.rs','src-tauri/src/lan/state_store.rs', 'src-tauri/src/lan/ownership.rs','src-tauri/src/lan/storage.rs','src-tauri/src/system.rs','src-tauri/src/platform/shell.rs','src-tauri/src/toolbox/transfer_assets.rs','src-tauri/src/toolbox/image_api.rs','src-tauri/src/lifecycle.rs','src-tauri/src/draft_maintenance.rs','src-tauri/src/draft_startup.rs','src-tauri/src/workspace/backup_api.rs','src-tauri/src/main.rs','src-tauri/capabilities/workspace.json','src-tauri/permissions/toolbox-lan.toml','src/renderer/src/runtime/tauri.ts','tests/tauri-lan-host.mjs','tests/tauri-harness.mjs','tests/tauri-file-drop-native.cpp'].map(async name=>[name,hash(await fs.readFile(name))])))
    report.executableSha256=hash(await fs.readFile(app.executable))
    await fs.writeFile(reportPath,JSON.stringify(report,null,2))
  } catch(error) {
    report.failure=String(error);report.appOutput=app?.output();await fs.writeFile(reportPath.replace('.json','-failure.json'),JSON.stringify(report,null,2));throw error
  } finally {
    continueOld?.();await stranger?.dispose();await old?.dispose();await app?.close();for(const callback of cleanup)await callback()
  }
})
