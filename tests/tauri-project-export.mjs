import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import XLSX from 'xlsx'
import { mainFixture } from './main-headless-harness.mjs'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'

const report = 'artifacts/tauri-migration/project-export-native.json'
await mkdir(path.dirname(report), { recursive: true }); await rm(report, { force: true })
await test('native project export matches frozen CSV/XLSX behavior while preserving scoped dialogs and lifecycle', async suite => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-tauri-test-'))

  let legacy; let app; let page; let state; let failed = false
  const evidence = []
  const scenario = async (name, callback) => {
    await suite.test(name, async () => { try { await callback(); evidence.push(name) } catch (error) { failed = true; throw error } })
    if (failed) throw Error('Project export failed: ' + name)
  }
  const api = (method, ...args) => page.evaluate(({method,args}) => window.dustdesk[method](...args), {method,args})
  const invoke = (command,args={}) => app.invoke(command,args,page)
  const exportTo = async target => {
    const pending = api('exportProjects')
    await operateDialog(app,'导出项目管理','select',target)
    return pending
  }
  const sheetRows = bytes => {
    const workbook = XLSX.read(bytes,{type:'buffer',cellFormula:true})
    assert.deepEqual(workbook.SheetNames,['项目管理'])
    const sheet = workbook.Sheets['项目管理']
    assert.ok(!Object.values(sheet).some(cell => cell && typeof cell === 'object' && cell.f), 'Exported project names must never become formulas')
    return XLSX.utils.sheet_to_json(sheet,{header:1,defval:'',blankrows:true})
  }
  try {
    await scenario('frozen Node reference exports the reference table with hierarchy progress and CSV injection protection', async () => {
      legacy = await mainFixture(suite, {realSpreadsheets:true})
      state = structuredClone(await legacy.load())
        state.Settings.ClipboardMonitoringEnabled=false; state.Settings.AutomaticBackupEnabled=false; state.Settings.WidgetPlacements={}; state.Settings.WidgetLayoutPresets={}
        state.Projects=[{Id:'empty',Name:'空项目🪶',ProjectPath:'D:\\空项目',Phases:[]},{Id:'hierarchy',Name:'=SUM(1,2)',ProjectPath:'D:\\路径,含逗号',Phases:[
          {Id:'doing',Title:'进行中',Status:'Doing',ProgressPercent:-1,ProjectPath:'',Subtasks:[]},
          {Id:'done',Title:'已完成',Status:'Done',ProgressPercent:-1,ProjectPath:'',Subtasks:[]},
          {Id:'explicit',Title:'显式',Status:'Todo',ProgressPercent:42,ProjectPath:'D:\\阶段',Subtasks:[]},
          {Id:'auto',Title:'自动\n进度',Status:'Todo',ProgressPercent:-1,ProjectPath:'',Subtasks:[{Id:'one',Title:'+公式',IsCompleted:true,FilePath:'D:\\文件"引号.txt'},{Id:'two',Title:'@链接',IsCompleted:false,FilePath:''},{Id:'three',Title:'-负号',IsCompleted:false,FilePath:''}]}
        ]}]
      const saved=await legacy.invoke('workspace:save',state); if(!saved.ok) throw Error(saved.error)
      state=await legacy.load()
      for(const extension of ['csv','xlsx']) {
        const target=path.join(root,'reference.'+extension)
        legacy.electron.dialog.showSaveDialog=async()=>({canceled:false,filePath:target})
        assert.deepEqual(await legacy.invoke('projects:export'),{ok:true,path:target})
      }

    })
    await scenario('isolated Tauri main uses a native-only export permission denied to prototype and widgets', async () => {
      app=await launchTauri(); await app.invoke('prototype_open_workspace')
      page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
      await page.getByRole('button',{name:'创建工作区',exact:true}).click(); await page.locator('.app-shell').waitFor()
      const baseline=await api('loadWorkspace'); assert.equal((await api('saveWorkspace',state,baseline)).ok,true)
      assert.equal((await api('setWidgetVisibility','todo',true)).ok,true)
      const widget=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('widget.html')))
      await widget.getByLabel('桌面新增任务').waitFor()
      for(const target of [app.page,widget]) await assert.rejects(app.invoke('projects_export',{path:path.join(root,'forged.csv')},target),/not allowed|权限|此窗口/i)
    })
    await scenario('canceling the actual save dialog returns canceled without creating a file', async () => {
      const pending=api('exportProjects'); await operateDialog(app,'导出项目管理','cancel')
      assert.deepEqual(await pending,{ok:false,canceled:true})
    })
    await scenario('Rust CSV is byte-identical to the frozen reference including BOM quotes multiline and formula prefixes', async () => {
      const target=path.join(root,'native.csv'); assert.deepEqual(await exportTo(target),{ok:true,path:target})
      assert.deepEqual(await readFile(target),await readFile(path.join(root,'reference.csv')))
    })
    await scenario('Rust XLSX matches frozen reference cell values sheet identity widths and string-only formula safety', async () => {
      const target=path.join(root,'native.xlsx'); assert.equal((await exportTo(target)).ok,true)
      assert.deepEqual(sheetRows(await readFile(target)),sheetRows(await readFile(path.join(root,'reference.xlsx'))))
      const workbook=XLSX.read(await readFile(target),{type:'buffer',cellStyles:true})
      assert.equal(workbook.Sheets['项目管理']['!cols'].length,9)
      for(const [index,width] of [20,34,22,12,10,34,24,10,42].entries()) assert.ok(Math.abs(workbook.Sheets['项目管理']['!cols'][index].wch-width)<1,'Excel column character widths remain within font rounding tolerance')
    })
    await scenario('actual shared Projects page exports through the same runtime adapter', async () => {
      await page.getByRole('button',{name:'项目',exact:true}).click()
      const target=path.join(root,'shared-page.csv')
      await page.getByRole('button',{name:/导出/}).click(); await operateDialog(app,'导出项目管理','select',target)
      await waitFor(async()=>{try{return (await readFile(target)).length>0}catch{return false}})
      assert.deepEqual(await readFile(target),await readFile(path.join(root,'reference.csv')))
    })
    await scenario('editing while the native dialog is open does not mix newer data into the captured export snapshot', async () => {
      const target=path.join(root,'captured-snapshot.csv')
      const pending=api('exportProjects'); await operateDialog(app,'导出项目管理')
      const baseline=await api('loadWorkspace'); const changed=structuredClone(baseline)
      changed.Projects[0].Name='选择期间的更新'
      assert.equal((await api('saveWorkspace',changed,baseline)).ok,true)
      await operateDialog(app,'导出项目管理','select',target); assert.equal((await pending).ok,true)
      assert.deepEqual(await readFile(target),await readFile(path.join(root,'reference.csv')))
      const current=await api('loadWorkspace'); assert.equal(current.Projects[0].Name,'选择期间的更新')
      assert.equal((await api('saveWorkspace',{...current,Projects:state.Projects},current)).ok,true)
    })
    await scenario('export refuses app internal directories instead of replacing workspace or profile assets', async () => {
      const target=path.join(app.root,'user-data','tauri-preview','Workspace','forbidden-export.xlsx')
      const result=await exportTo(target)
      assert.equal(result.ok,false); assert.match(result.error,/内部数据目录/)
      await assert.rejects(readFile(target),{code:'ENOENT'})
    })
    await scenario('empty projects fail before opening a dialog and remain retryable', async () => {
      const baseline=await api('loadWorkspace'); const empty={...baseline,Projects:[]}
      assert.equal((await api('saveWorkspace',empty,baseline)).ok,true)
      assert.deepEqual(await api('exportProjects'),{ok:false,error:'没有可导出的项目'})
      const current=await api('loadWorkspace'); assert.equal((await api('saveWorkspace',{...current,Projects:state.Projects},current)).ok,true)
      assert.equal((await exportTo(path.join(root,'retry.csv'))).ok,true)
    })
    await scenario('export never changes the persisted project snapshot', async () => {
      const location=path.join(app.root,'user-data','tauri-preview','Workspace','workspace.json')
      const before=await readFile(location)
      assert.equal((await exportTo(path.join(root,'unchanged-snapshot.csv'))).ok,true)
      const actual=await api('loadWorkspace'); assert.deepEqual(actual.Projects,state.Projects)
      assert.equal(createHash('sha256').update(await readFile(location)).digest('hex'),createHash('sha256').update(before).digest('hex'))
    })
    await scenario('concurrent requests cannot open a second native save session or inherit the selected path', async () => {
      const pending=api('exportProjects'); await operateDialog(app,'导出项目管理')
      const second=await api('exportProjects'); assert.equal(second.ok,false); assert.match(second.error,/已有文件选择/)
      await operateDialog(app,'导出项目管理','cancel'); assert.deepEqual(await pending,{ok:false,canceled:true})
    })
    await scenario('draft maintenance cancels the open save session before requiring all editor checkpoints', async () => {
      const pending=api('exportProjects'); await operateDialog(app,'导出项目管理')
      const preparing=invoke('drafts_prepare')
      assert.deepEqual(await pending,{ok:false,canceled:true})
      const checkpoint=await preparing; assert.match(checkpoint.workspaceFingerprint,/^[a-f0-9]{64}$/)
      assert.equal(await invoke('drafts_end',{requestId:checkpoint.requestId}),true)
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
    })
    await scenario('native quit cancels the open save dialog before waiting for tracked exports', async () => {
      const pending=api('exportProjects'); await operateDialog(app,'导出项目管理')
      const quitting=invoke('application_quit').catch(error=>{if(app.child.exitCode===null)assert.match(String(error),/closed|destroyed|disconnected/i)})
      assert.deepEqual(await pending,{ok:false,canceled:true})
      await waitFor(()=>app.child.exitCode!==null||app.child.signalCode!==null); await quitting
      assert.equal(app.child.exitCode,0)
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-project-export-native-dialog-and-electron-differential',evidence,remaining:['actual-packaged-artifact','physical-input-method-and-mixed-dpi','production-cutover']},null,2))
  } finally {
    await app?.close();
    assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('dustdesk-tauri-test-'))
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300})
  }
})
