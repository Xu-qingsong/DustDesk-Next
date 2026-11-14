import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launchTauri, waitFor } from './tauri-harness.mjs'

const { version: currentVersion } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const run=promisify(execFile)
const report='artifacts/tauri-migration/update-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
async function native(app,action='snapshot',title='发现新版本') {
  const payload=Buffer.from(JSON.stringify({processId:app.child.pid,action,title,script:path.resolve('tests/tauri-update-dialog.ps1')})).toString('base64')
  const command="$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Action $parameters.action -Title $parameters.title"
  return (await run('pwsh.exe',['-Mta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:18000,maxBuffer:1024*1024})).stdout.trim()
}
await test('native release check keeps trusted URLs shared confirmations and cancellable lifecycle',async suite=>{
  let app;let page;let failed=false;let policy={};let requests=[];const evidence=[]
  const server=createServer(async(request,response)=>{
    const active=policy;requests.push({url:request.url,headers:request.headers})
    if(active.hang)return
    if(active.delay)await new Promise(resolve=>setTimeout(resolve,active.delay))
    const status=request.url==='/releases/latest'?(active.status??200):(active.repositoryStatus??200)
    response.writeHead(status,{'Content-Type':'application/json',...(active.headers??{})})
    if(active.chunked){response.write(' '.repeat(600_000));response.end(' '.repeat(600_000));return}
    response.end(request.url==='/releases/latest'?(active.raw??JSON.stringify(active.release===undefined?{tag_name:`v${currentVersion}`,draft:false,prerelease:false,body:'说明'}:active.release)):'{}')
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  const base='http://127.0.0.1:'+server.address().port
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();evidence.push(name)}catch(error){failed=true;await writeFile('artifacts/tauri-migration/update-native-failure-state.json',JSON.stringify({name,requests,output:app?.output?.(),error:String(error)},null,2));throw error}});if(failed)throw Error('Native release check failed: '+name)}
  const configure=value=>{policy=value;requests=[]}
  const api=()=>{const pending=page.evaluate(()=>window.dustdesk.checkForUpdate());void pending.catch(()=>{});return pending}
  const opened=async()=>readFile(path.join(app.root,'update-opened.txt'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error})
  const newer=(extra={})=>({release:{tag_name:'v2.0.0+test',body:'安全更新说明🪶',html_url:'file:///untrusted.exe',...extra}})
  try {
    app=await launchTauri({updateBase:base,releaseDelayMs:120})
    await app.invoke('prototype_open_workspace')
    page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
    await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
    await scenario('native update command is denied to prototype and widget roles',async()=>{
      await assert.rejects(app.invoke('release_check'),/not allowed|权限|不允许/i)
      assert.equal((await page.evaluate(()=>window.dustdesk.setWidgetVisibility('todo',true))).ok,true)
      const widget=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')))
      await widget.getByLabel('桌面新增任务').waitFor()
      await assert.rejects(app.invoke('release_check',{},widget),/not allowed|权限|不允许/i)
      await page.evaluate(()=>window.dustdesk.setWidgetVisibility('todo',false))
    })
    await scenario('same and older releases preserve current version and exact request headers without a confirmation',async()=>{
      for(const tag of [`v${currentVersion}`,'v1.0.1',`v${currentVersion}-rc.1`]){
        configure({release:{tag_name:tag,body:'说明'}})
        const result=await api();assert.equal(result.ok,true);assert.equal(result.available,false);assert.equal(result.currentVersion,currentVersion)
        assert.equal(requests.length,1);assert.equal(requests[0].url,'/releases/latest');assert.equal(requests[0].headers.accept,'application/vnd.github+json');assert.equal(requests[0].headers['user-agent'],`DustDesk/${currentVersion}`)
      }
      assert.equal(await opened(),'')
    })
    await scenario('concurrent checks share one native confirmation and decline is the default',async()=>{
      configure({...newer(),delay:250})
      const first=api();const second=api()
      const snapshot=JSON.parse(await native(app));await writeFile('artifacts/tauri-migration/update-dialog-snapshot.json',JSON.stringify(snapshot,null,2));assert.ok(snapshot.controls.some(control=>control.name==='暂不更新'))
      const names=snapshot.controls.map(control=>control.name).join('\n');assert.match(names,/安全更新说明🪶/);assert.ok(names.includes(`当前版本：${currentVersion}`));assert.match(names,/不会自动下载或安装/)
      assert.equal(requests.length,1)
      await native(app,'default');const [left,right]=await Promise.all([first,second]);assert.deepEqual(left,right);assert.equal(left.available,true);assert.equal(await opened(),'')
    })
    await scenario('affirmation opens only the repository-derived encoded URL not html_url',async()=>{
      configure(newer());const pending=api();await native(app,'accept')
      const result=await pending;assert.equal(result.ok,true);assert.equal(result.releaseUrl,'https://github.com/Xu-qingsong/DustDesk-Next/releases/tag/v2.0.0%2Btest')
      assert.equal((await opened()).trim(),result.releaseUrl)
    })
    await scenario('empty repository is distinct from inaccessible repository and retries are not cached',async()=>{
      configure({status:404});const empty=await api();assert.equal(empty.ok,true);assert.equal(empty.available,false);assert.equal(empty.message,'当前仓库尚未发布正式版本');assert.deepEqual(requests.map(request=>request.url),['/releases/latest','/'])
      configure({status:404,repositoryStatus:404});assert.match((await api()).error,/无法访问项目仓库/)
      configure({});assert.equal((await api()).ok,true)
    })
    await scenario('GitHub errors rate limits malformed releases and redirects fail without opening a browser',async()=>{
      const before=await opened()
      for(const value of [{status:403},{status:429},{status:500},{raw:'not json'},{release:null},{release:{tag_name:123}},{release:{tag_name:'v2.0.0',draft:true}},{release:{tag_name:'v2.0.0',prerelease:true}},{release:{tag_name:'01.0.0'}},{status:302,headers:{Location:'https://untrusted.invalid/'}}]){
        configure(value);const result=await api();assert.equal(result.ok,false,JSON.stringify(value));assert.equal(result.available,false);assert.ok(result.error);assert.equal(requests.length,1)
      }
      assert.equal(await opened(),before)
    })
    await scenario('bounded response rejects oversized chunked JSON and subsequent checks retry',async()=>{
      configure({chunked:true});assert.match((await api()).error,/信息过大/)
      configure({});assert.equal((await api()).ok,true)
    })
    await scenario('release notes use fallback and cap UTF16 length with Unicode retained',async()=>{
      for(const body of ['   ','🪶'.repeat(12_000)]){
        configure(newer({body}));const pending=api();await native(app,'decline');const result=await pending
        if(body.trim())assert.equal(result.releaseNotes.length,20_000);else assert.equal(result.releaseNotes,'此版本未提供更新说明，请查看版本发布页面。')
      }
    })
    await scenario('real settings check button invokes the same native confirmation',async()=>{
      configure(newer());await page.getByRole('button',{name:'设置',exact:true}).click();await page.locator('#settings-update').getByText('v1.0.3 框架升级', {exact:true}).waitFor();await page.locator('#settings-update').getByText('Rust + Tauri 2', {exact:false}).waitFor();await page.getByRole('button',{name:'检查更新',exact:true}).click()
      await native(app,'decline');await waitFor(async()=>!(await page.getByRole('button',{name:'检查更新',exact:true}).isDisabled()))
      assert.equal(requests.length,1)
    })
    await scenario('native tray check shares a settings request and confirmation',async()=>{
      configure({...newer(),delay:1000});const pending=api();await native(app,'tray-update');await native(app,'decline');assert.equal((await pending).available,true);assert.equal(requests.length,1)
    })
    await scenario('native tray shows no-update status through one cancellable native dialog',async()=>{
      configure({});await native(app,'tray-update');const snapshot=JSON.parse(await native(app,'snapshot','检查更新'));assert.match(snapshot.controls.map(control=>control.name).join(' '),/当前已是最新版本/);await native(app,'dismiss','检查更新')
    })
    await scenario('main navigation cancels old confirmation and a reloaded adapter can check again',async()=>{
      configure(newer());const before=await opened();const pending=api();await native(app)
      await page.reload();await pending.catch(error=>assert.match(String(error),/destroyed|navigation|closed/i));await page.locator('.app-shell').waitFor()
      configure({});assert.equal((await api()).ok,true);assert.equal(await opened(),before)
    })
    await scenario('hidden main is retained while a native update confirmation is active',async()=>{
      configure(newer());const pending=api();await native(app);await page.evaluate(()=>window.dustdesk.hideMainWindow())
      await new Promise(resolve=>setTimeout(resolve,600));assert.ok(!page.isClosed());await native(app,'decline');assert.equal((await pending).ok,true)
      await waitFor(()=>page.isClosed())
      await app.invoke('prototype_open_workspace');page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>!target.isClosed()&&target.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    })
    await scenario('draft maintenance cancels confirmation before waiting for tracked renderer work',async()=>{
      configure(newer());const pending=api();await native(app);const preparing=app.invoke('drafts_prepare',{},page)
      assert.match((await pending).error,/取消|维护/);const checkpoint=await preparing;assert.equal(await app.invoke('drafts_end',{requestId:checkpoint.requestId},page),true);await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
    })
    await scenario('draft maintenance cancels an in-flight network request without waiting fifteen seconds',async()=>{
      configure({hang:true});const pending=api();await waitFor(()=>requests.length===1)
      const start=Date.now();const preparing=app.invoke('drafts_prepare',{},page);assert.match((await pending).error,/取消|维护/);const checkpoint=await preparing;assert.ok(Date.now()-start<8000);assert.equal(await app.invoke('drafts_end',{requestId:checkpoint.requestId},page),true);await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
    })
    await scenario('shared fifteen-second timeout covers hung requests and allows retry',async()=>{
      configure({hang:true});const start=Date.now();const result=await api();assert.match(result.error,/超时/);assert.ok(Date.now()-start>=14_000&&Date.now()-start<23_000)
      configure({});assert.equal((await api()).ok,true)
    })
    await scenario('native quit cancels confirmation before waiting for tracked checks and exits cleanly',async()=>{
      configure(newer());const before=await opened();const pending=api();await native(app);await native(app,'tray-quit');assert.match((await pending).error,/取消|退出/)
      await waitFor(()=>app.child.exitCode!==null||app.child.signalCode!==null);assert.equal(app.child.exitCode,0);assert.equal(await opened(),before)
    })
    await scenario('pure tray checks and confirmation work without a workspace or any WebView process',async()=>{
      const executable=app.executable;await app.close();app=undefined
      const root=await mkdtemp(path.join(os.tmpdir(),'dustdesk-tauri-test-'))
      const environment={...process.env,DUSTDESK_TEST_USER_DATA_DIR:path.join(root,'user-data'),DUSTDESK_TAURI_DISABLE_HOTKEYS:'1',DUSTDESK_TAURI_TEST_UPDATE_BASE:base}
      delete environment.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
      const child=spawn(executable,['--hidden'],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:environment})
      let output='';child.stdout.on('data',bytes=>{output+=bytes});child.stderr.on('data',bytes=>{output+=bytes})
      app={child,root,output:()=>output,close:async()=>{
        if(child.pid&&child.exitCode===null){try{execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})}catch{}}
        assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('dustdesk-tauri-test-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300})
      }}
      await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
      await new Promise(resolve=>setTimeout(resolve,1500));assert.equal(child.exitCode,null,output)
      configure(newer());await native(app,'tray-update');await native(app,'accept');await waitFor(async()=>Boolean(await opened()))
      assert.equal((await opened()).trim(),'https://github.com/Xu-qingsong/DustDesk-Next/releases/tag/v2.0.0%2Btest');assert.equal(requests.length,1)
      const script='$rows=@(Get-CimInstance Win32_Process);$ids=[System.Collections.Generic.HashSet[int]]::new();[void]$ids.Add('+child.pid+');do{$added=$false;foreach($row in $rows){if($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)){$added=$true}}}while($added);@($rows|Where-Object{$ids.Contains([int]$_.ProcessId)}|Select-Object ProcessId,Name)|ConvertTo-Json -Compress'
      const result=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}));const processes=Array.isArray(result)?result:[result]
      assert.ok(processes.every(process=>process.ProcessId===child.pid||process.Name.toLowerCase()==='conhost.exe'),JSON.stringify(processes))
      await assert.rejects(readFile(path.join(root,'user-data','tauri-preview','Workspace','workspace.json')),{code:'ENOENT'})
      configure({});await native(app,'tray-update');await native(app,'dismiss','检查更新');await native(app,'tray-quit');await waitFor(()=>child.exitCode!==null||child.signalCode!==null);assert.equal(child.exitCode,0,output)
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-native-release-check-dialog-network-and-lifecycle',evidence,remaining:['actual-packaged-artifact','real-GitHub-connectivity','physical-tray-input-and-DPI','production-cutover']},null,2))
  }finally{await app?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
