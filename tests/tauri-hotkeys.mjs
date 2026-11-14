import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawn,execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createInterface} from 'node:readline'
import {createServer} from 'node:net'
import {mkdir,readFile,writeFile,rm,readdir} from 'node:fs/promises'
import path from 'node:path'
import {chromium} from 'playwright'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {clipboardFixture,holdClipboard} from './tauri-clipboard-support.mjs'

const run=promisify(execFile), report='artifacts/tauri-migration/hotkeys-native.json'
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const combo=number=>'Ctrl+Alt+Shift+F'+number
const keys={mainWindow:combo(13),widgets:combo(14),screenshot:combo(15),pin:combo(16),quickCapture:combo(17)}
const fields={mainWindow:'MainWindowHotKey',widgets:'DesktopWidgetsHotKey',screenshot:'ScreenshotHotKey',pin:'PinScreenshotHotKey',quickCapture:'QuickCaptureHotKey'}

async function fixture(){
  const child=spawn('pwsh.exe',['-NoProfile','-NonInteractive','-File',path.resolve('tests/tauri-hotkey-helper.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  const lines=[];let errors='';child.stderr.on('data',bytes=>{errors+=bytes});const reader=createInterface({input:child.stdout});reader.on('line',line=>lines.push(JSON.parse(line)))
  const next=async()=>{await waitFor(()=>{if(lines.length)return true;if(child.exitCode!==null)throw Error(errors);return false});return lines.shift()}
  assert.equal((await next()).ready,true)
  const request=async(action,args={})=>{child.stdin.write(Buffer.from(JSON.stringify({action,...args})).toString('base64')+'\n');return next()}
  return {request,press:number=>request('press',{key:111+number}),close:async()=>{await request('stop');child.stdin.end();await waitFor(()=>child.exitCode!==null);reader.close();assert.equal(child.exitCode,0,errors)}}
}
async function tray(pid,...captions){
  const payload=Buffer.from(JSON.stringify({pid,captions,script:path.resolve('tests/tauri-pin-tray.ps1')})).toString('base64')
  const command="$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($p.script,[Text.Encoding]::UTF8))) -ProcessId $p.pid -Captions @($p.captions)"
  return JSON.parse((await run('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:30000})).stdout)
}

await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('configured OS shortcuts and clipboard pins preserve native ownership and transactional settings',{timeout:300000},async suite=>{
  let seed,child,browser,root,page,clipboard,keyboard,output='',failed=false,completed=false,executable
  const scenarios=[],evidence={clicks:[],sources:[]},errors=[]
  const pages=()=>browser?.contexts().flatMap(context=>context.pages()).filter(target=>!target.isClosed())??[]
  const connect=async()=>{if(browser?.isConnected())return true;try{if(!(await fetch(evidence.endpoint+'/json/version',{signal:AbortSignal.timeout(1000)})).ok)return false;browser=await chromium.connectOverCDP(evidence.endpoint);return true}catch{return false}}
  const invoke=(command,args={},target=page)=>target.evaluate(({command,args})=>window.__TAURI_INTERNALS__.invoke(command,args),{command,args})
  const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
  const scenario=async(name,callback)=>{await suite.test(name,{timeout:60000},async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Native shortcut scenario failed: '+name+'\n'+output)}
  const find=async(suffix,selector)=>{const target=await waitFor(async()=>await connect()&&pages().find(target=>target.url().includes(suffix)));target.on('pageerror',error=>errors.push(error.message));if(selector)await target.locator(selector).waitFor();return target}
  const closePin=async target=>{const id=new URL(target.url()).searchParams.get('pin');await invoke('screenshot_pin_control',{id,action:'close',value:null},target).catch(error=>{if(!target.isClosed()||!String(error).includes('closed'))throw error});await waitFor(()=>target.isClosed());await delay(250)}
  const source=(target,pin,id)=>target.evaluate(async({pin,id})=>{
    const bytes=new Uint8Array(await window.__TAURI_INTERNALS__.invoke(pin?'screenshot_pin_source':'screenshot_overlay_source',pin?{id,version:0}:{id}))
    const image=await createImageBitmap(new Blob([bytes])),canvas=new OffscreenCanvas(image.width,image.height),context=canvas.getContext('2d');context.drawImage(image,0,0);image.close()
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data
    const hex=value=>[...new Uint8Array(value)].map(byte=>byte.toString(16).padStart(2,'0')).join('')
    return {width:canvas.width,height:canvas.height,pixelSha256:hex(await crypto.subtle.digest('SHA-256',pixels)),sha256:hex(await crypto.subtle.digest('SHA-256',bytes)),pixels:canvas.width===3?[...pixels]:undefined}
  },{pin,id})
  const pinSource=async target=>source(target,true,new URL(target.url()).searchParams.get('pin'))
  const newPin=async action=>{const before=new Set(pages());await action();const pin=await waitFor(async()=>await connect()&&pages().find(target=>!before.has(target)&&target.url().includes('pin.html')));await pin.getByAltText('贴图',{exact:true}).waitFor();return pin}
  try{
    keyboard=await fixture();clipboard=await clipboardFixture()
    for(let number=13;number<=23;number++){assert.equal((await keyboard.request('hold',{key:111+number})).ok,true,'fixture keys must be initially free');assert.equal((await keyboard.request('release',{key:111+number})).ok,true)}
    await scenario('seed isolated settings and start with no main window and real OS registration',async()=>{
      seed=await launchTauri({workspace:true});root=seed.root;executable=seed.executable
      await seed.page.getByRole('button',{name:'创建工作区',exact:true}).click();await seed.page.locator('.app-shell').waitFor()
      assert.equal((await seed.page.evaluate(keys=>window.dustdesk.setHotkeys(keys),keys)).ok,true)
      await seed.page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,DesktopHotKeyWidgetKeys:['todo','notes'],WidgetPlacements:{},ScreenshotDelaySeconds:0,ScreenshotAutoCopy:false,ScreenshotAutoAddToClipboardHistory:false,ScreenshotAfterAction:'edit'}},state);if(!result.ok)throw Error(result.error)})
      await seed.close({preserve:true});seed=undefined
      const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));evidence.endpoint='http://127.0.0.1:'+port
      child=spawn(executable,['--hidden','--workspace'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,DUSTDESK_TEST_USER_DATA_DIR:path.join(root,'user-data'),DUSTDESK_TEST_DATA_DIR:path.join(root,'data'),DUSTDESK_TEST_DESKTOP_DIR:path.join(root,'desktop'),DUSTDESK_TAURI_DISABLE_HOTKEYS:undefined,DUSTDESK_TAURI_TEST_RELEASE_DELAY_MS:'150',WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port='+port+' --remote-debugging-address=127.0.0.1 --no-first-run'}})
      child.stdout.on('data',bytes=>{output+=bytes});child.stderr.on('data',bytes=>{output+=bytes});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
      await waitFor(()=>output.includes('全局快捷键已应用（5 项）'))
      assert.equal((await keyboard.request('hold',{key:124})).ok,false)
      for(let number=14;number<=17;number++)assert.equal((await keyboard.request('hold',{key:111+number})).ok,false)
      const processRows=JSON.parse((await run('powershell.exe',['-NoProfile','-NonInteractive','-Command','ConvertTo-Json -InputObject @(Get-CimInstance Win32_Process | Where-Object {$_.ParentProcessId -eq '+child.pid+'} | Select-Object Name,ProcessId) -Compress'],{windowsHide:true})).stdout);evidence.backgroundChildren=processRows
      assert.ok(processRows.every(row=>row.Name.toLowerCase()==='conhost.exe'),JSON.stringify(processRows))
    })
    await scenario('empty clipboard shortcut reports a native error and does not create a WebView',async()=>{
      await clipboard.request('clear');await keyboard.press(16);await waitFor(()=>output.includes('剪贴板中没有图片'))
    })
    await scenario('clipboard DIB shortcut opens only its own pin and preserves exact pixels and clipboard sequence',async()=>{
      const before=await clipboard.request('set-bitmap');await keyboard.press(16)
      await waitFor(async()=>{try{return (await fetch(evidence.endpoint+'/json/version')).ok}catch{return false}});browser=await chromium.connectOverCDP(evidence.endpoint)
      const pin=await find('pin.html');await pin.getByAltText('贴图',{exact:true}).waitFor();assert.ok(pages().every(target=>target.url().includes('pin.html')))
      const image=await pinSource(pin);evidence.sources.push(image);assert.equal(image.width,3);assert.equal(image.height,2)
      const pixels=[];for(let row=0;row<2;row++)for(let column=0;column<3;column++)pixels.push(10+column,20+row,30,255);assert.deepEqual(image.pixels,pixels)
      assert.equal((await clipboard.request('sequence')).sequence,before.sequence)
      for(const command of ['hotkeys_set','hotkeys_status','clipboard_read','workspace_load'])await assert.rejects(invoke(command,{keys},pin),/not allowed|权限|不允许/i)
      await closePin(pin)
      const offset=output.length;await clipboard.request('clear');await keyboard.press(16);await waitFor(()=>output.slice(offset).includes('剪贴板中没有图片'));assert.equal(pages().filter(target=>target.url().includes('pin.html')).length,0)
    })
    await scenario('cancelled capture does not replace the fallback and successful annotated output supplies its exact rendered pixels',async()=>{
      await keyboard.press(15);const overlay=await find('capture.html','.region-live-selector')
      const selected=await invoke('screenshot_overlay_region',{rect:{x:100,y:100,width:120,height:90}},overlay);evidence.cancelledCapture=await source(overlay,false,selected.document.id)
      await invoke('screenshot_overlay_cancel',{},overlay).catch(error=>{if(!overlay.isClosed()||!String(error).includes('closed'))throw error});await waitFor(()=>pages().every(target=>!target.url().includes('capture.html')))
      const offset=output.length;await keyboard.press(16);await waitFor(()=>output.slice(offset).includes('剪贴板中没有图片'))
      await keyboard.press(15);const editor=await find('capture.html','.region-live-selector');await waitFor(()=>editor.locator('.screenshot-viewport').evaluate(element=>element.style.cursor!=='progress'));await editor.mouse.move(100,100);await editor.mouse.down();await editor.mouse.move(220,190,{steps:10});await editor.mouse.up();await editor.locator('.editor-selection').waitFor()
      await editor.evaluate(()=>{window.__sourceDelivered=false;const original=window.fetch;window.fetch=async(input,options)=>{const result=await original.call(window,input,options),url=typeof input==='string'?input:input.url;if(url.endsWith('/screenshot_overlay_source')&&result.ok)window.__sourceDelivered=true;return result}})
      await editor.getByRole('button',{name:'矩形',exact:true}).click();await editor.mouse.move(120,120);await editor.mouse.down();await editor.mouse.move(170,155,{steps:10});await editor.mouse.up()
      await waitFor(()=>editor.evaluate(()=>window.__sourceDelivered))
      const document=(await invoke('screenshot_overlay_document',{},editor)).document,original=await source(editor,false,document.id)
      const pin=await newPin(()=>editor.getByRole('button',{name:'贴图',exact:true}).click());await waitFor(()=>editor.isClosed());const rendered=await pinSource(pin);assert.notEqual(rendered.pixelSha256,original.pixelSha256);evidence.lastOutput=rendered;await closePin(pin)
      await keyboard.press(15);const cancelled=await find('capture.html','.region-live-selector');await invoke('screenshot_overlay_region',{rect:{x:200,y:200,width:80,height:70}},cancelled);await invoke('screenshot_overlay_cancel',{},cancelled).catch(error=>{if(!cancelled.isClosed()||!String(error).includes('closed'))throw error});await waitFor(()=>cancelled.isClosed())
      const fallback=await newPin(()=>keyboard.press(16));assert.deepEqual(await pinSource(fallback),rendered);assert.ok(pages().every(target=>target.url().includes('pin.html')));await closePin(fallback)
    })
    await scenario('clipboard imports do not replace the last successful output and native tray uses the same image entry',async()=>{
      await clipboard.request('set-bitmap');const first=await newPin(()=>keyboard.press(16));assert.equal((await pinSource(first)).width,3);await closePin(first)
      await clipboard.request('clear');const fallback=await newPin(async()=>{evidence.clicks.push(await tray(child.pid,'截图贴图','剪贴板贴图'))});assert.deepEqual(await pinSource(fallback),evidence.lastOutput);await closePin(fallback)
    })
    await scenario('quick capture and configured widget shortcuts work without the main page',async()=>{
      await keyboard.press(17);const quick=await find('quick.html');await quick.getByLabel('记录标题').waitFor();for(const command of ['hotkeys_set','hotkeys_status'])await assert.rejects(invoke(command,{keys},quick),/not allowed|权限|不允许/i);await quick.getByLabel('记录标题').fill('快捷键保留草稿');await quick.keyboard.press('Escape');await waitFor(()=>quick.isClosed())
      await keyboard.press(14);await waitFor(()=>pages().filter(target=>target.url().includes('widget.html')).length===2)
      for(const target of pages().filter(target=>target.url().includes('widget.html'))){await target.locator('.widget-head').waitFor();for(const command of ['hotkeys_set','hotkeys_status'])await assert.rejects(invoke(command,{keys},target),/not allowed|权限|不允许/i)}
      await keyboard.press(14);await waitFor(()=>pages().every(target=>!target.url().includes('widget.html')));assert.ok(pages().every(target=>!target.url().includes('tauri.html')))
    })
    await scenario('main shortcut opens the shared app and canonical aliases cannot duplicate another action',async()=>{
      await keyboard.press(13);page=await find('tauri.html','.app-shell');assert.deepEqual(await invoke('hotkeys_status'),{disabled:false,error:null})
      const before=await api('loadWorkspace');const bytes=await readFile(path.join(root,'user-data','tauri-preview','Workspace','workspace.json'))
      for(const patch of [{mainWindow:'bad+syntax'}, {mainWindow:'Shift+Alt+Control+F17'}, {pin:null},{unknown:'F2'}]){const result=await invoke('hotkeys_set',{keys:patch});assert.equal(result.ok,false);assert.deepEqual(await readFile(path.join(root,'user-data','tauri-preview','Workspace','workspace.json')),bytes)}
      assert.deepEqual((await api('loadWorkspace')).Settings,before.Settings)
    })
    await scenario('OS registration conflicts keep every old binding and persisted settings',async()=>{
      assert.equal((await keyboard.request('hold',{key:134})).ok,true)
      try{const before=await api('loadWorkspace'),result=await api('setHotkeys',{mainWindow:combo(23),quickCapture:combo(22)});assert.equal(result.ok,false);assert.match(result.error,/占用/);assert.equal((await api('loadWorkspace')).Settings.MainWindowHotKey,before.Settings.MainWindowHotKey);for(let number=13;number<=17;number++)assert.equal((await keyboard.request('hold',{key:111+number})).ok,false)
        assert.equal((await keyboard.request('hold',{key:133})).ok,true);assert.equal((await keyboard.request('release',{key:133})).ok,true)
      }finally{await keyboard.request('release',{key:134})}
      await keyboard.press(17);const quick=await find('quick.html');await quick.getByLabel('记录标题').waitFor();assert.equal(await quick.getByLabel('记录标题').inputValue(),'快捷键保留草稿');await api('hideQuickCapture');await waitFor(()=>quick.isClosed())
    })
    await scenario('workspace replacement failure restores old native bindings and leaves bytes unchanged',async()=>{
      const location=path.join(root,'user-data','tauri-preview','Workspace','workspace.json'),before=await readFile(location);await keyboard.request('lock',{path:location})
      try{const result=await api('setHotkeys',{mainWindow:combo(18),quickCapture:combo(19)});assert.equal(result.ok,false);assert.deepEqual(await readFile(location),before);assert.equal((await keyboard.request('hold',{key:124})).ok,false);for(const number of [18,19]){assert.equal((await keyboard.request('hold',{key:111+number})).ok,true);await keyboard.request('release',{key:111+number})}}
      finally{await keyboard.request('unlock')}
      assert.equal((await api('setHotkeys',keys)).ok,true)
    })
    await scenario('shared settings dialog saves a new key and releases the old OS binding',async()=>{
      await page.locator('.floating-shortcuts').click();const dialog=page.getByRole('dialog',{name:'快捷键',exact:true});await dialog.getByLabel('主窗口',{exact:true}).fill(combo(18));await dialog.getByRole('button',{name:'保存快捷键',exact:true}).click();await waitFor(()=>dialog.count().then(count=>count===0))
      assert.equal((await api('loadWorkspace')).Settings.MainWindowHotKey,combo(18));assert.equal((await keyboard.request('hold',{key:124})).ok,true);await keyboard.request('release',{key:124});assert.equal((await keyboard.request('hold',{key:129})).ok,false)
    })
    await scenario('swapping registered actions changes dispatch without dropping either key',async()=>{
      assert.equal((await api('setHotkeys',{mainWindow:combo(17),quickCapture:'Shift+Alt+Control+F18'})).ok,true)
      await keyboard.press(18);const quick=await find('quick.html');await quick.getByLabel('记录标题').waitFor();await api('hideQuickCapture');await waitFor(()=>quick.isClosed());for(const number of [17,18])assert.equal((await keyboard.request('hold',{key:111+number})).ok,false)
    })
    await scenario('maintenance blocks settings and native pin creation then resumes the same shortcuts',async()=>{
      const checkpoint=await invoke('drafts_prepare');const count=pages().length
      try{await assert.rejects(invoke('hotkeys_set',{keys}),/退出|维护/);await keyboard.press(16);await keyboard.press(18);await keyboard.press(14);await delay(400);assert.equal(pages().length,count)}
      finally{assert.equal(await invoke('drafts_end',{requestId:checkpoint.requestId}),true)}
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));const pin=await newPin(()=>keyboard.press(16));assert.deepEqual(await pinSource(pin),evidence.lastOutput);await closePin(pin)
    })
    await scenario('clipboard contention refuses publication and an explicit retry preserves the last successful output',async()=>{
      const release=await holdClipboard(),offset=output.length
      try{await keyboard.press(16);await waitFor(()=>output.slice(offset).includes('剪贴板正被其他程序占用'));assert.ok(pages().every(target=>!target.url().includes('pin.html')))}finally{await release()}
      const pin=await newPin(()=>keyboard.press(16));assert.deepEqual(await pinSource(pin),evidence.lastOutput);await closePin(pin)
    })
    await scenario('delayed image timeout retains native busy state until its worker ends and never publishes a late pin',async()=>{
      let trace='',error='';const owner=spawn('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-File',path.resolve('tests/tauri-clipboard-delayed.ps1'),'-Image'],{windowsHide:true,stdio:['pipe','pipe','pipe']});owner.stdout.on('data',bytes=>trace+=bytes);owner.stderr.on('data',bytes=>error+=bytes)
      try{
        await waitFor(()=>{if(owner.exitCode!==null)throw Error(error||trace);return trace.includes('ready')})
        const offset=output.length,start=Date.now();await keyboard.press(16);await waitFor(()=>trace.includes('rendering'))
        await assert.rejects(invoke('drafts_prepare'),/截图正在进行/)
        await waitFor(()=>output.slice(offset).includes('读取剪贴板超时'),15000);evidence.delayedImageTimeoutMs=Date.now()-start;assert.ok(evidence.delayedImageTimeoutMs>=9000);assert.ok(pages().every(target=>!target.url().includes('pin.html')))
        await assert.rejects(invoke('drafts_prepare'),/截图正在进行/)
        owner.stdin.write('\n');await waitFor(()=>trace.includes('released'));owner.stdin.end('\n');await waitFor(()=>owner.exitCode!==null);assert.equal(owner.exitCode,0,error)
        await delay(200);assert.ok(pages().every(target=>!target.url().includes('pin.html')))
        const pin=await newPin(()=>keyboard.press(16));const image=await pinSource(pin);assert.equal(image.width,1);assert.equal(image.height,1);await closePin(pin)
        await clipboard.request('clear');const raw=await newPin(()=>keyboard.press(16));assert.deepEqual(await pinSource(raw),evidence.lastOutput);await closePin(raw)
      }finally{if(owner.exitCode===null){owner.stdin.end('\n\n');await waitFor(()=>owner.exitCode!==null,10000).catch(async()=>run('taskkill.exe',['/PID',String(owner.pid),'/T','/F'],{windowsHide:true}))}}
    })
    await scenario('saved general settings refresh registrations and empty keys disable individual actions',async()=>{
      const state=await api('loadWorkspace');assert.equal((await api('saveWorkspace',{...state,Settings:{...state.Settings,MainWindowHotKey:combo(20)}},state)).ok,true)
      await waitFor(async()=>!(await invoke('hotkeys_status')).error);await delay(200);assert.equal((await keyboard.request('hold',{key:131})).ok,false);assert.equal((await keyboard.request('hold',{key:128})).ok,true);await keyboard.request('release',{key:128})
      assert.equal((await api('setHotkeys',{quickCapture:''})).ok,true);assert.equal((await keyboard.request('hold',{key:129})).ok,true);await keyboard.request('release',{key:129});await keyboard.press(18);await delay(300);assert.ok(pages().every(target=>!target.url().includes('quick.html')))
      const saved=await api('loadWorkspace');evidence.finalKeys=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,saved.Settings[field]]));const data=await readdir(path.join(root,'user-data','tauri-preview','Workspace'));assert.ok(!data.includes('Screenshots'));assert.equal(saved.ClipboardHistory.length,0)
    })
    await scenario('external settings conflicts are reported while old native keys remain and backup restore reapplies saved bindings',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true);const preview=await api('previewBackup',backup.path);assert.ok(preview.fingerprint)
      assert.equal((await keyboard.request('hold',{key:134})).ok,true)
      try{const state=await api('loadWorkspace');assert.equal((await api('saveWorkspace',{...state,Settings:{...state.Settings,MainWindowHotKey:combo(23)}},state)).ok,true);await waitFor(async()=>(await invoke('hotkeys_status')).error?.includes('占用'));assert.equal((await api('loadWorkspace')).Settings.MainWindowHotKey,combo(23));assert.equal((await keyboard.request('hold',{key:131})).ok,false)}finally{await keyboard.request('release',{key:134})}
      assert.equal((await api('setHotkeys',{mainWindow:combo(21)})).ok,true);assert.equal((await keyboard.request('hold',{key:132})).ok,false)
      assert.equal((await api('restoreBackup',preview.path,preview.fingerprint)).ok,true);await page.locator('.app-shell').waitFor();await waitFor(async()=>(await api('loadWorkspace')).Settings.MainWindowHotKey===combo(20));await delay(200);assert.equal((await keyboard.request('hold',{key:131})).ok,false);assert.equal((await keyboard.request('hold',{key:132})).ok,true);await keyboard.request('release',{key:132});assert.equal((await invoke('hotkeys_status')).error,null)
    })
    await scenario('main-thread status reads remain responsive while a worker changes native registrations',async()=>{
      for(const number of [21,20]){const changed=api('setHotkeys',{mainWindow:combo(number)});const statuses=await Promise.all(Array.from({length:24},()=>invoke('hotkeys_status')));assert.equal((await changed).ok,true);assert.ok(statuses.every(status=>status.disabled===false));assert.equal((await keyboard.request('hold',{key:111+number})).ok,false)}
      evidence.concurrentStatusReads=48
    })
    await scenario('ordinary quit releases every OS key and exits successfully',async()=>{
      await invoke('application_quit').catch(error=>{if(!String(error).includes('closed'))throw error});await waitFor(()=>child.exitCode!==null);assert.equal(child.exitCode,0,output)
      for(let number=13;number<=23;number++){assert.equal((await keyboard.request('hold',{key:111+number})).ok,true);await keyboard.request('release',{key:111+number})}
      assert.deepEqual(errors,[])
    })
    completed=true
  }finally{
    if(failed){evidence.failure={root,output,pages:await Promise.all(pages().map(async target=>({url:target.url(),body:await target.locator('body').innerText().catch(()=>'<closed>')})))}}
    await writeFile(report,JSON.stringify({verified:completed&&!failed,productionReady:false,scenarios,evidence,errors},null,2))
    await seed?.close();await browser?.close().catch(()=>{});if(child&&child.exitCode===null)await run('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true}).catch(()=>{})
    await clipboard?.close();await keyboard?.close();if(root)await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300})
  }
})
