import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile, rm, rmdir, symlink, rename, access } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { operateMenu } from './tauri-menu.mjs'
const run=promisify(execFile)
async function holdClipboard(){
  const child=spawn('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-File',path.resolve('tests/tauri-clipboard-lock.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  let output='';let errors='';child.stdout.on('data',bytes=>{output+=bytes});child.stderr.on('data',bytes=>{errors+=bytes})
  try{await waitFor(()=>{if(child.exitCode!==null)throw Error(errors||'Clipboard holder exited early');return output.includes('ready')},10000)}catch(error){child.stdin.end();throw error}
  return async()=>{child.stdin.end(String.fromCharCode(10));await waitFor(()=>child.exitCode!==null,5000);assert.equal(child.exitCode,0,errors)}
}
async function explorer(directory,close=false){
  const encoded=Buffer.from(directory).toString('base64')
  const command="$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8;$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+encoded+"'));$shell=New-Object -ComObject Shell.Application;try{$results=@(foreach($window in $shell.Windows()){try{if($window.Document.Folder.Self.Path -eq $target){"+(close?"$window.Quit()":"@{handle=[long]$window.HWND;selected=@($window.Document.SelectedItems()|ForEach-Object {$_.Path})}")+"}}catch{}});ConvertTo-Json -InputObject $results -Compress}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}"
  const result=await run('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:15000,maxBuffer:1024*1024})
  return JSON.parse(result.stdout.trim())
}
await test('isolated desktop listing and native path menus preserve legacy UI without granting arbitrary paths',async suite=>{
  const reportPath='artifacts/tauri-migration/desktop-native.json';await rm(reportPath,{force:true})
  const app=await launchTauri();let failed=false
  const scenarios=[];const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Native desktop scenario failed: '+name)}
  const desktop=path.join(app.root,'desktop')
  try{
    await mkdir(desktop)
    const electron=await mainFixture(suite);await electron.load();const state=await electron.load();state.Settings.AutomaticBackupEnabled=false
    state.Launchers=[];state.Projects=[];state.DesktopCategories=[]
    const folders=['资料.exe','阿目录','folder.lnk','Folder.txt']
    const names=['中.txt','阿.txt','Z.txt','a.txt','A大.txt','é.txt','é.txt','!重要.txt','1.txt','10.txt','2.txt','文件夹.txt','😀.txt','文档,空 格&.txt','.gitignore','Desktop.INI']
    for(const name of folders){await mkdir(path.join(desktop,name));await writeFile(path.join(desktop,name,'nested.txt'),'nested')}
    for(const name of names)await writeFile(path.join(desktop,name),'preserved desktop fixture')
    const executable=path.join(desktop,'安全菜单打开.exe');const code=path.join(app.root,'MenuFixture.cs')
    await writeFile(code,'using System;using System.IO;using System.Reflection;public class MenuFixture{public static void Main(string[] args){File.WriteAllText(Assembly.GetExecutingAssembly().Location+".opened","args="+args.Length);}}')
    await run('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/out:'+executable,code],{windowsHide:true})
    await app.invoke('prototype_workspace_initialize',{state});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const dismiss=()=>page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('system_cancel_picker'))
    const show=async target=>{const result=await api('showPathContextMenu',target);assert.equal(result.ok,true,JSON.stringify(result));return JSON.parse(await operateMenu(app))}
    const readdir=electron.fileSystem.readdir
    electron.fileSystem.readdir=(target,...args)=>readdir(target===path.join(electron.root,'desktop')?desktop:target,...args)
    const expectedEntries=async()=>{
      const expected=await electron.invoke('organizer:list');return expected.map(entry=>({...entry,Path:path.join(desktop,entry.Name)}))
    }
    await scenario('direct desktop children and zh-CN ordering match actual Electron IPC including punctuation and accents',async()=>{
      assert.deepEqual(await api('listDesktopEntries'),await expectedEntries())
      assert.ok((await api('listDesktopEntries')).every(entry=>path.dirname(entry.Path)===desktop&&entry.Name.toLowerCase()!=='desktop.ini'))
      await assert.rejects(app.invoke('system_desktop_entries'),/not allowed|权限|denied/i)
    })
    await scenario('returned exact desktop paths can load icons while unlisted parents, nested items and junction targets remain denied',async()=>{
      const file=path.join(desktop,'阿.txt');assert.match((await api('getPathIcon',file)).dataUrl,/^data:image\/png;base64,/)
      const folder=path.join(desktop,folders[0]);assert.equal((await api('getPathIcon',folder)).isDirectory,true)
      assert.deepEqual(await api('getPathIcon',desktop),{})
      assert.deepEqual(await api('getPathIcon',path.join(folder,'nested.txt')),{})
      const outside=path.join(app.root,'outside');await mkdir(outside);await writeFile(path.join(outside,'private.txt'),'not-authorized')
      const junction=path.join(desktop,'链接目录');await symlink(outside,junction,'junction')
      try{assert.deepEqual(await api('listDesktopEntries'),await expectedEntries());assert.deepEqual(await api('getPathIcon',junction),{});assert.equal((await api('showPathContextMenu',junction)).ok,false);assert.equal((await api('openPath',junction)).ok,false)}finally{await rmdir(junction)}
    })
    await scenario('shared organizer renders actual native thumbnails and exposes the original three-item native menu',async()=>{
      await page.getByRole('button',{name:'桌面收纳',exact:true}).click()
      await waitFor(async()=>await page.locator('.organizer-entry').count()===folders.length+names.length)
      const tile=page.getByRole('button',{name:'打开 阿.txt',exact:true})
      await waitFor(async()=>await tile.locator('img').evaluate(image=>image.complete&&image.naturalWidth>0).catch(()=>false))
      await tile.click({button:'right'})
      const controls=JSON.parse(await operateMenu(app));assert.deepEqual(controls.map(control=>control.name),['打开','在资源管理器中显示','复制路径']);assert.ok(controls.every(control=>control.enabled))
      assert.equal((await api('showPathContextMenu',executable)).ok,false)
      const started=Date.now();const baseline=await api('loadWorkspace')
      await api('saveWorkspace',{...baseline,QuickNote:'native menu does not block workspace saves'},baseline)
      assert.equal((await api('loadWorkspace')).QuickNote,'native menu does not block workspace saves')
      assert.ok(Date.now()-started<2000,'A native menu must not stall unrelated workspace IPC')
      assert.deepEqual(JSON.parse(await operateMenu(app)).map(control=>control.name),['打开','在资源管理器中显示','复制路径'])
      await dismiss()
      await mkdir('artifacts/tauri-migration',{recursive:true});await page.screenshot({path:'artifacts/tauri-migration/desktop-shared-native.png',fullPage:true})
    })
    await scenario('copy path preserves Unicode exactly and restores the pre-test clipboard after verification',async()=>{
      const target=path.join(desktop,'文档,空 格&.txt')
      await show(target)
      try{assert.equal(await operateMenu(app,'copy',target),'completed')}catch(error){throw Error(String(error)+'; UI errors: '+JSON.stringify(await page.locator('[data-sonner-toast]').allTextContents()))}
    })
    await scenario('clipboard contention reports a retryable error without emptying existing clipboard data',async()=>{
      await show(path.join(desktop,'阿.txt'))
      const release=await holdClipboard()
      try{await operateMenu(app,'copy-busy');await waitFor(async()=>await page.getByText('剪贴板被占用，请稍后重试',{exact:true}).count()>0)}finally{await release()}
    })
    await scenario('open dispatches the selected authorized executable with no arbitrary arguments',async()=>{
      await show(executable);await operateMenu(app,'open')
      await waitFor(async()=>{try{return await readFile(executable+'.opened','utf8')==='args=0'}catch{return false}})
      assert.equal(await readFile(executable+'.opened','utf8'),'args=0')
    })
    await scenario('Explorer reveal selects the real Unicode file via PIDL and closes only its unique test window',async()=>{
      const target=path.join(desktop,'阿.txt');assert.deepEqual(await explorer(desktop),[])
      try{await show(target);await operateMenu(app,'reveal');await waitFor(async()=>{const windows=await explorer(desktop);return windows.some(window=>window.selected.some(selected=>selected.toLowerCase()===target.toLowerCase()))},12000)}finally{await explorer(desktop,true)}
    })
    await scenario('revoked references and deleted or invalid targets never execute late menu actions',async()=>{
      const unrelated=path.join(app.root,'unrelated.exe');await writeFile(unrelated,await readFile(executable))
      for(const target of [unrelated,'relative.exe','https://example.com',executable+'\0ignored',executable+':stream'])assert.equal((await api('showPathContextMenu',target)).ok,false,target)
      await assert.rejects(app.invoke('system_path_menu',{target:executable}),/not allowed|权限|denied/i)
      const temporary=path.join(desktop,'late.exe');await writeFile(temporary,await readFile(executable));await api('listDesktopEntries');await show(temporary)
      await rename(temporary,temporary+'.moved');await api('listDesktopEntries');await operateMenu(app,'open')
      await waitFor(async()=>await page.getByText(/路径未授权|不存在|无法读取/).count()>0)
      await assert.rejects(access(temporary+'.opened'),{code:'ENOENT'})
      assert.deepEqual(await api('getPathIcon',temporary),{})
    })
    await scenario('failed scans revoke stale grants without recreating missing desktop roots or following redirected roots',async()=>{
      const original=path.join(app.root,'desktop-original');await rename(desktop,original)
      try{assert.deepEqual(await api('listDesktopEntries'),[]);await assert.rejects(access(desktop),{code:'ENOENT'});assert.deepEqual(await api('getPathIcon',path.join(desktop,'阿.txt')),{})
        await symlink(original,desktop,'junction');try{assert.deepEqual(await api('listDesktopEntries'),[])}finally{await rmdir(desktop)}
      }finally{await rename(original,desktop)}
      assert.ok((await api('listDesktopEntries')).length>0)
    })
    await scenario('restore cancels a live native menu before flushing and a failed quit can reopen a fresh menu',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true)
      await show(executable);assert.equal((await api('restoreBackup',backup.path)).ok,true)
      await api('listDesktopEntries');await show(executable);await dismiss()
      await page.evaluate(()=>{window.__stopMenuQuit=window.dustdesk.onBeforeQuit(async()=>{throw Error('menu quit draft failed')})})
      await show(executable);await assert.rejects(page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')),/draft failed/)
      await page.evaluate(()=>window.__stopMenuQuit());await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
      await show(executable);await dismiss();assert.equal(app.child.exitCode,null)
    })
    await scenario('native quit cancels a visible menu without waiting for its selection',async()=>{
      await show(executable);assert.deepEqual(errors,[])
      void page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')).catch(()=>{})
      await waitFor(()=>app.child.exitCode!==null,8000);assert.equal(app.child.exitCode,0)
    })
    if(failed)throw Error('Native desktop suite failed')
    await writeFile(reportPath,JSON.stringify({productionReady:false,scope:'isolated-desktop-enumeration-and-path-menu',scenarios,pending:['physical-desktop-redirection','network-drive-disconnect','mixed-DPI-menu-location','organizer-moves-and-undo','all-widget-callers','production-takeover']},null,2))
  }finally{await explorer(desktop,true).catch(()=>{});await app.close()}
})
