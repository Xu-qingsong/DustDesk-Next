import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { toolboxModules } from './toolbox-fixture.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'
import { clipboardFixture, holdClipboard } from './tauri-clipboard-support.mjs'

const report='artifacts/tauri-migration/toolbox-text-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('shared text Worker exports and copies through scoped native dialogs without changing workspace data',async suite=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'dustdesk-tauri-test-'))
  const guard=await clipboardFixture();let app;let page;let failed=false;const evidence=[]
  const references=[['unicode','中文🪶\r\nCafé\n=SUM(1,2)\t"quoted"\0end'],['empty',''],['json','{\n  "中文": "🪶",\n  "ok": true\n}'],['long','中文🪶'.repeat(120_000)]]
  const workerCases=[['JSON 格式化','{"中文":"🪶","count":2}'],['JSON 压缩','{\n "count": 2, "ok": true\n}'],['URL 编码','中文 /?a=🪶'],['URL 解码','%E4%B8%AD%E6%96%87%20%2F'],['Base64 编码','中文🪶\nCafé'],['Base64 解码',Buffer.from('中文🪶\nCafé').toString('base64')],['正则测试','a12b34'],['文本对比','第一行\n删除行\n末行','第一行\n新增行\n末行'],['按行去重','乙\n甲\n乙\n\n甲'],['自然排序','文件10\n文件2\n文件1'],['文本统计','中文🪶\nCafé'],['转大写','DustDesk Café'],['转小写','DUSTDESK CAFÉ']]
  const processCase=async(target,[tool,input,second])=>{
    await target.getByRole('button',{name:tool,exact:true}).click();await target.getByLabel('文本输入',{exact:true}).fill(input)
    if(tool==='正则测试')await target.locator('.toolbox-options input').first().fill(String.fromCharCode(92)+'d+')
    if(tool==='文本对比')await target.getByLabel('对比文本',{exact:true}).fill(second)
    await waitFor(async()=>!(await target.getByRole('button',{name:'导出文本',exact:true}).isDisabled()))
  }
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();evidence.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Text toolbox failed: '+name)}
  const api=(method,text)=>{const pending=page.evaluate(({method,text})=>window.dustdesk.toolbox[method](text),{method,text});void pending.catch(()=>{});return pending}
  const exportTo=async(text,target)=>{const pending=api('exportText',text);await operateDialog(app,'导出 UTF-8 文本','select',target);return pending}
  const location=()=>path.join(app.root,'user-data','tauri-preview','Workspace','workspace.json')
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
  try{
    await scenario('UTF8 and unchanged text algorithm fixtures define byte clipboard and Worker expectations',async()=>{
      for(const [name,text] of references) await writeFile(path.join(root,'reference-'+name+'.txt'),Buffer.from(text,'utf8'))
      for(const text of ['中文🪶\r\nCafé','before\0after']) await writeFile(path.join(root,text.includes('\0')?'reference-clipboard-nul.txt':'reference-clipboard.txt'),text.split('\0')[0])
      const modules = await toolboxModules(suite)
      const tools=['json','jsonCompact','urlEncode','urlDecode','base64Encode','base64Decode','regex','diff','dedupe','sort','stats','upper','lower']
      for(const [index,[label,input,second]] of workerCases.entries()){
        const result=modules.text.processText({tool:tools[index],input,second:second??'',pattern:'\\d+',flags:'g',trim:false,ignoreEmpty:false})
        await writeFile(path.join(root,'reference-worker-'+index+'.txt'),result.text)
      }
    })
    await scenario('only the actual main has toolbox text capability and widget/prototype calls are denied',async()=>{
      app=await launchTauri();await app.invoke('prototype_open_workspace')
      page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      await page.getByRole('button',{name:'创建工作区',exact:true}).click();await page.locator('.app-shell').waitFor()
      await page.evaluate(async()=>{const state=await window.dustdesk.loadWorkspace();const result=await window.dustdesk.saveWorkspace({...state,Settings:{...state.Settings,AutomaticBackupEnabled:false,ClipboardMonitoringEnabled:false,SidebarHidden:state.Settings.SidebarHidden.filter(id=>id!=='textTools')}},state);if(!result.ok)throw Error(result.error)})
      assert.equal((await page.evaluate(()=>window.dustdesk.setWidgetVisibility('todo',true))).ok,true)
      const widget=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')));await widget.getByLabel('桌面新增任务').waitFor()
      for(const target of [app.page,widget])for(const command of ['toolbox_export_text','toolbox_copy_text'])await assert.rejects(app.invoke(command,{text:'denied'},target),/not allowed|权限|不允许/i)
      await page.evaluate(()=>window.dustdesk.setWidgetVisibility('todo',false))
    })
    await scenario('native save cancellation matches saved expectations and does not mutate the workspace',async()=>{
      const before=await readFile(location());const pending=api('exportText','cancel');const controls=JSON.parse(await operateDialog(app,'导出 UTF-8 文本'))
      await writeFile('artifacts/tauri-migration/toolbox-text-dialog-controls.json',JSON.stringify(controls,null,2))
      assert.ok(controls.some(control=>control.type==='ControlType.Edit'))
      await operateDialog(app,'导出 UTF-8 文本','cancel');assert.deepEqual(await pending,{canceled:true});assert.deepEqual(await readFile(location()),before)
    })
    await scenario('Unicode NUL line endings empty and long text exports match reference fixtures bytes without a BOM',async()=>{
      const before=await readFile(location())
      for(const [name,text] of references){
        const target=path.join(root,'native-'+name+(name==='json'?'.json':'.txt'))
        assert.deepEqual(await exportTo(text,target),{path:target});assert.deepEqual(await readFile(target),await readFile(path.join(root,'reference-'+name+'.txt')))
      }
      assert.deepEqual(await readFile(location()),before)
    })
    await scenario('40 MiB UTF8 validation rejects oversized text and wrong types before opening a dialog',async()=>{
      for(const method of ['exportText','copyText'])await assert.rejects(page.evaluate(method=>window.dustdesk.toolbox[method]('a'.repeat(40*1024*1024+1)),method),/40 MiB/)
      for(const command of ['toolbox_export_text','toolbox_copy_text'])await assert.rejects(app.invoke(command,{text:12},page),/string|字符串|invalid/i)
      assert.equal((await exportTo('retry after validation',path.join(root,'validation-retry.txt'))).path,path.join(root,'validation-retry.txt'))
    })
    await scenario('exact UTF8 output boundary is not silently truncated',async()=>{
      const pending=page.evaluate(()=>window.dustdesk.toolbox.exportText('🪶'.repeat(10*1024*1024)));void pending.catch(()=>{})
      const target=path.join(root,'boundary.txt');await operateDialog(app,'导出 UTF-8 文本','select',target);assert.deepEqual(await pending,{path:target})
      const bytes=await readFile(target);assert.equal(bytes.length,40*1024*1024);assert.equal(digest(bytes),digest(Buffer.from('🪶'.repeat(10*1024*1024))))
    })
    await scenario('internal data destinations are rejected without changing native or browser data',async()=>{
      const before=await readFile(location());const target=path.join(app.root,'user-data','tauri-preview','forbidden.txt')
      await assert.rejects(exportTo('must not write',target),/内部数据目录/);await assert.rejects(readFile(target),{code:'ENOENT'});assert.deepEqual(await readFile(location()),before)
    })
    await scenario('concurrent native saves share the picker exclusion but never inherit another chosen path',async()=>{
      const pending=api('exportText','first');await operateDialog(app,'导出 UTF-8 文本')
      await assert.rejects(api('exportText','second'),/已有文件选择窗口/)
      const pick=await page.evaluate(()=>window.dustdesk.pickPath('must not open'));assert.equal(pick.ok,false);assert.match(pick.error,/已有文件选择窗口/)
      await operateDialog(app,'导出 UTF-8 文本','cancel');assert.deepEqual(await pending,{canceled:true})
    })
    await scenario('clipboard Unicode and NUL behavior matches reference fixtures without changing saved history',async()=>{
      const before=await readFile(location())
      for(const text of ['中文🪶\r\nCafé','before\0after']){
        await api('copyText',text);assert.equal((await guard.request('inspect')).text,await readFile(path.join(root,text.includes('\0')?'reference-clipboard-nul.txt':'reference-clipboard.txt'),'utf8'))
      }
      const text='x'.repeat(6*1024*1024);await api('copyText',text);assert.equal((await guard.request('inspect')).text,text)
      await api('copyText','');assert.equal((await guard.request('inspect')).text,'');assert.deepEqual(await readFile(location()),before)
    })
    await scenario('occupied clipboard reports an error and succeeds after the actual holder releases it',async()=>{
      await guard.request('set-text',{text:'preserve clipboard on lock'});const release=await holdClipboard()
      try{await assert.rejects(api('copyText','not written'),/剪贴板|占用/)}finally{await release()}
      assert.equal((await guard.request('inspect')).text,'preserve clipboard on lock');await api('copyText','clipboard retry');assert.equal((await guard.request('inspect')).text,'clipboard retry')
    })
    await scenario('the unchanged text Worker and shared page support format conversion copy and export',async()=>{
      await page.getByRole('button',{name:'文本工具箱',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).waitFor()
      const input='{"中文":"🪶","ok":true}';const formatted=JSON.stringify(JSON.parse(input),null,2)
      await page.getByLabel('文本输入',{exact:true}).fill(input);await waitFor(async()=>await page.getByLabel('文本结果',{exact:true}).inputValue()===formatted)
      await page.getByRole('button',{name:'复制结果',exact:true}).click();await waitFor(async()=>(await guard.request('inspect')).text===formatted)
      await page.getByRole('button',{name:'导出文本',exact:true}).click();const target=path.join(root,'actual-worker.json');await operateDialog(app,'导出 UTF-8 文本','select',target);await waitFor(async()=>readFile(target,'utf8').catch(()=>''));assert.equal(await readFile(target,'utf8'),formatted)
      await page.getByRole('button',{name:'Base64 编码',exact:true}).click();const encoded=Buffer.from(input).toString('base64');await waitFor(async()=>await page.getByLabel('文本结果',{exact:true}).inputValue()===encoded)
      await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'文本工具箱',exact:true}).click();assert.equal(await page.getByLabel('文本输入',{exact:true}).inputValue(),input)
      await page.getByRole('button',{name:'Base64 解码',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).fill(encoded);await waitFor(async()=>await page.getByLabel('文本结果',{exact:true}).inputValue()===input)
    })
    await scenario('draft maintenance cancels the native dialog before waiting for the tracked text export',async()=>{
      const pending=api('exportText','maintenance');await operateDialog(app,'导出 UTF-8 文本');const preparing=app.invoke('drafts_prepare',{},page)
      assert.deepEqual(await pending,{canceled:true});const checkpoint=await preparing
      for(const command of ['toolbox_export_text','toolbox_copy_text'])await assert.rejects(app.invoke(command,{text:'maintenance denied'},page),/维护|退出/)
      assert.equal(await app.invoke('drafts_end',{requestId:checkpoint.requestId},page),true);await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
    })
    await scenario('all thirteen unchanged Worker tools export the same results as the reference fixtures page',async()=>{
      await page.getByRole('button',{name:'文本工具箱',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).waitFor()
      for(const [index,entry] of workerCases.entries()){
        await processCase(page,entry);const target=path.join(root,'native-worker-'+index+'.txt')
        await page.getByRole('button',{name:'导出文本',exact:true}).click();await operateDialog(app,'导出 UTF-8 文本','select',target)
        await waitFor(async()=>readFile(target,'utf8').catch(()=>''));assert.deepEqual(await readFile(target),await readFile(path.join(root,'reference-worker-'+index+'.txt')),entry[0])
      }
      await page.getByRole('button',{name:'JSON 格式化',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).fill('{broken')
      await page.locator('.toolbox-error').waitFor();assert.match(await page.locator('.toolbox-error').innerText(),/JSON/);assert.equal(await page.getByRole('button',{name:'导出文本',exact:true}).isDisabled(),true)
    })
    await scenario('main navigation cancels the prior native save session and the reloaded adapter can export again',async()=>{
      const pending=api('exportText','navigation');await operateDialog(app,'导出 UTF-8 文本','visible')
      await page.reload();await pending.catch(error=>assert.match(String(error),/navigation|destroyed|closed/i));await page.locator('.app-shell').waitFor()
      const target=path.join(root,'after-navigation.txt');assert.deepEqual(await exportTo('new adapter',target),{path:target});assert.equal(await readFile(target,'utf8'),'new adapter')
    })
    await scenario('completed exports leave no sibling temporary files or workspace changes',async()=>{
      const before=await readFile(location());assert.deepEqual(await exportTo('final text',path.join(root,'final-text.txt')),{path:path.join(root,'final-text.txt')})
      assert.deepEqual(await readFile(location()),before);assert.ok(!(await readdir(root)).some(name=>name.startsWith('.dustdesk-export-')))
    })
    await scenario('native quit cancels the open text dialog and finishes the tracked adapter without deadlock',async()=>{
      const pending=api('exportText','quit');await operateDialog(app,'导出 UTF-8 文本');const quitting=app.invoke('application_quit',{},page).catch(error=>{if(app.child.exitCode===null)assert.match(String(error),/closed|destroyed|disconnected/i)})
      assert.deepEqual(await pending,{canceled:true});await waitFor(()=>app.child.exitCode!==null||app.child.signalCode!==null);await quitting;assert.equal(app.child.exitCode,0)
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-native-text-export-copy-and-existing-webview-worker',evidence,remaining:['full-image-toolbox-and-LAN','actual-packaged-artifact','physical-DPI-IME-and-native-drop','production-cutover']},null,2))
  }finally{await app?.close();await guard.close();assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('dustdesk-tauri-test-'));await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300})}
})
