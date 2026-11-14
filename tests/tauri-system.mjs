import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'

const run=promisify(execFile)
await test('native STA dialogs and scoped Shell opens preserve cancellation and shutdown',async suite=>{
  const reportPath='artifacts/tauri-migration/system-native.json'
  await rm(reportPath,{force:true})
  const app=await launchTauri()
  let failed=false
  const scenarios=[]
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Native system scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite)
    await electron.load()
    const state=await electron.load()
    state.Settings.AutomaticBackupEnabled=false
    const fixture=path.join(app.root,'安全打开.exe')
    const source=path.join(app.root,'NativeOpenFixture.cs')
    await writeFile(source,'using System; using System.IO; using System.Reflection; public class NativeOpenFixture { public static void Main(string[] arguments) { File.WriteAllText(Assembly.GetExecutingAssembly().Location + ".opened", "args=" + arguments.Length); } }')
    await run('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/out:'+fixture,source],{windowsHide:true})
    const selected=path.join(app.root,'已选择 中文.exe')
    await writeFile(selected,await readFile(fixture))
    state.Launchers=[{Id:'native-launch',Name:'原生打开验证',Path:fixture},{Id:'missing',Name:'需要选择的新路径',Path:path.join(app.root,'missing.exe')}]
    state.Projects=[];state.LinkGroups=[];state.DesktopCategories=[]
    await app.invoke('prototype_workspace_initialize',{state})
    await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const dialog=(title,action='snapshot',target)=>operateDialog(app,title,action,target)
    const start=async(method,title)=>{
      await page.evaluate(({method,title})=>{window.__nativePick=window.dustdesk[method](title)}, {method,title})
      try { return JSON.parse(await dialog(title)) } catch(error) {
        const reply=await page.evaluate(()=>Promise.race([window.__nativePick,new Promise(resolve=>setTimeout(()=>resolve('still pending'),50))]))
        throw Error(String(error)+' picker reply: '+JSON.stringify(reply))
      }
    }
    await scenario('invalid paths, unsafe protocols and unauthorized callers never dispatch a native open',async()=>{
      for(const target of ['','relative.exe','http://example.com',fixture+' --arguments','\\\\.\\C:','C:/file:stream',fixture+'\0ignored']) assert.equal((await api('openPath',target)).ok,false,target)
      assert.match((await api('openPath',selected)).error,/未授权/)
      assert.equal((await api('openPath',state.Launchers[1].Path)).ok,false)
      for(const target of ['javascript:alert(1)','file:///C:/Windows','ftp://example.com','//example.com','http:example.com','https://','http://localhost/\0ignored']) assert.equal((await api('openUrl',target)).ok,false,target)
      await assert.rejects(app.invoke('system_open',{target:fixture,url:false}),/not allowed|权限|denied/i)
      await assert.rejects(app.invoke('system_pick',{folder:false,title:'越权窗口'}),/not allowed|权限|denied/i)
    })
    await scenario('ShellExecute opens an authorized Unicode executable directly with no command parameters',async()=>{
      assert.equal((await api('openPath',fixture)).ok,true)
      await waitFor(async()=>{try{return await readFile(fixture+'.opened','utf8')==='args=0'}catch{return false}})
      assert.equal(await readFile(fixture+'.opened','utf8'),'args=0')
    })
    await scenario('file picker exposes current-folder choice, rejects concurrent dialogs and returns cancellation',async()=>{
      const title='DustDesk 取消验证'
      const controls=await start('pickPath',title)
      await mkdir('artifacts/tauri-migration',{recursive:true})
      await writeFile('artifacts/tauri-migration/dialog-controls.json',JSON.stringify(controls,null,2))
      assert.ok(controls.some(control=>control.name==='选择当前文件夹'))
      assert.ok(controls.some(control=>control.id==='1'&&control.className==='Button'&&/^(打开|Open)/.test(control.name)))
      assert.match((await api('pickFolder','不能重复打开')).error,/已有文件选择窗口/)
      await dialog(title,'cancel')
      const actual=await page.evaluate(()=>window.__nativePick)
      electron.electron.dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]})
      assert.deepEqual(actual,await electron.invoke('path:pick',title))
      assert.equal((await api('pickPath','invalid\0title')).ok,false)
    })
    await scenario('real file selection grants only the selected path and matches the existing picker reply',async()=>{
      const title='DustDesk 文件选择验证'
      await start('pickPath',title)
      await dialog(title,'select',selected)
      const actual=await page.evaluate(()=>window.__nativePick)
      assert.equal(actual.ok,true)
      assert.equal(actual.path,selected)
      electron.electron.dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]})
      assert.deepEqual(actual,await electron.invoke('path:pick',title))
      assert.equal((await api('openPath',selected)).ok,true)
      await waitFor(async()=>{try{return await readFile(selected+'.opened','utf8')==='args=0'}catch{return false}})
      assert.match((await api('openPath',source)).error,/未授权/)
    })
    await scenario('folder-only picker selects a real directory without exposing file-selection controls',async()=>{
      const title='DustDesk 文件夹验证'
      const folder=path.join(app.root,'原生文件夹')
      await mkdir(folder)
      const controls=await start('pickFolder',title)
      assert.ok(!controls.some(control=>control.name==='选择当前文件夹'))
      await dialog(title,'select',folder)
      assert.deepEqual(await page.evaluate(()=>window.__nativePick),{ok:true,path:folder})
    })
    await scenario('general picker can choose the current directory without changing process working directory',async()=>{
      const title='DustDesk 当前文件夹验证'
      const before=process.cwd()
      await start('pickPath',title)
      await dialog(title,'current',app.root)
      assert.deepEqual(await page.evaluate(()=>window.__nativePick),{ok:true,path:app.root})
      assert.equal(process.cwd(),before)
    })
    await scenario('shared resource relink uses the actual native selection and rechecks the saved result',async()=>{
      await page.getByRole('button',{name:'资源检查',exact:true}).click()
      await page.getByRole('button',{name:'开始检查',exact:true}).click()
      await page.getByRole('button',{name:'开始检查',exact:true}).waitFor()
      await page.locator('.feature-row').filter({hasText:'需要选择的新路径'}).getByRole('button',{name:'重新关联',exact:true}).click()
      await page.getByRole('button',{name:'选择',exact:true}).click()
      await dialog('选择新的资源位置','select',selected)
      await waitFor(async()=>await page.getByRole('textbox',{name:'新的资源地址'}).inputValue()===selected)
      await page.getByRole('button',{name:'保存关联',exact:true}).click()
      await waitFor(async()=>(await api('loadWorkspace')).Launchers.find(item=>item.Id==='missing').Path===selected)
      await page.getByRole('button',{name:'开始检查',exact:true}).waitFor()
      assert.equal(await page.locator('.feature-row').filter({hasText:'需要选择的新路径'}).count(),0)
    })
    await scenario('restore cancels a live tracked picker before flushing and does not deadlock on the modal dialog',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true)
      const title='DustDesk 恢复取消验证'
      await start('pickPath',title)
      const started=Date.now()
      assert.equal((await api('restoreBackup',backup.path)).ok,true)
      assert.deepEqual(await page.evaluate(()=>window.__nativePick),{ok:false,canceled:true})
      assert.ok(Date.now()-started<4000)
      assert.equal(await page.evaluate(()=>document.documentElement.inert),false)
    })
    await scenario('failed quit cancels its modal picker and returns to an editable session that can pick again',async()=>{
      await page.evaluate(()=>{window.__systemStop=window.dustdesk.onBeforeQuit(async()=>{throw Error('native dialog quit draft failure')})})
      await start('pickPath','DustDesk 失败退出取消验证')
      await assert.rejects(page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')),/draft failure/)
      assert.deepEqual(await page.evaluate(()=>window.__nativePick),{ok:false,canceled:true})
      await page.evaluate(()=>window.__systemStop())
      assert.equal(app.child.exitCode,null)
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
      const title='DustDesk 失败退出后重试'
      await start('pickPath',title)
      await dialog(title,'cancel')
      assert.deepEqual(await page.evaluate(()=>window.__nativePick),{ok:false,canceled:true})
    })
    await scenario('native quit cancels a live dialog, resolves the tracked picker and exits without a save timeout',async()=>{
      const title='DustDesk 退出取消验证'
      await start('pickPath',title)
      const started=Date.now()
      void page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')).catch(()=>{})
      await waitFor(()=>app.child.exitCode!==null,8000)
      assert.equal(app.child.exitCode,0)
      assert.ok(Date.now()-started<8000)
    })
    if(failed)throw Error('A native system scenario failed')
    await mkdir('artifacts/tauri-migration',{recursive:true})
    await writeFile(reportPath,JSON.stringify({productionReady:false,scenarios,pending:['actual-default-browser-dispatch','physical-IME-in-file-dialog','shell-association-failure-and-network-drive','full-migration-gates']},null,2))
  }finally{await app.close()}
})
