import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, rmdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'

await test('hidden Rust services recover focus, freeze suspended time, and retry completion without a WebView', async context => {
  const reportPath = 'artifacts/tauri-migration/productivity-background.json'
  await rm(reportPath,{force:true})
  const root = await mkdtemp(path.join(os.tmpdir(),'dustdesk-focus-background-'))
  const workspace = path.join(root,'tauri-preview','Workspace')
  const location = path.join(workspace,'workspace.json')
  const executable = path.resolve(process.env.DUSTDESK_TAURI_EXECUTABLE || 'src-tauri/target/debug/DustDesk.exe')
  const electron = await mainFixture(context)
  await electron.load()
  const state = await electron.load()
  const now = Date.now()
  const active = {Id:'recover-focus',TaskId:'',TaskTitle:'自由专注',ProjectId:'',ProjectName:'未关联项目',StartedAt:new Date(now-10000).toISOString(),PlannedSeconds:60,ElapsedSeconds:0,RunningSince:new Date(now-10000).toISOString(),CheckpointAt:new Date(now-7000).toISOString()}
  state.ActiveFocus = active
  await mkdir(workspace,{recursive:true})
  await writeFile(location,JSON.stringify(state))
  let child
  let output = ''
  const start = async () => {
    const env = {...process.env,DUSTDESK_TEST_USER_DATA_DIR:root,DUSTDESK_TAURI_DISABLE_HOTKEYS:'1'}
    delete env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    child = spawn(executable,['--hidden','--workspace'],{windowsHide:true,env,stdio:['ignore','pipe','pipe']})
    child.stdout.on('data',bytes=>{output+=bytes})
    child.stderr.on('data',bytes=>{output+=bytes})
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
  }
  const stop = async () => {
    if (child?.pid && child.exitCode === null) {
      try {execFileSync('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'})} catch {}
      await waitFor(()=>child.exitCode!==null)
    }
  }
  const read = async () => {
    if (child?.exitCode !== null) throw Error('Background application exited: '+output)
    return JSON.parse(await readFile(location,'utf8'))
  }
  const replace = async value => {
    const temporary = path.join(workspace,'test-replacement.json')
    assert.equal(path.dirname(path.resolve(temporary)),path.resolve(workspace))
    assert.equal(path.dirname(path.resolve(location)),path.resolve(workspace))
    await writeFile(temporary,JSON.stringify(value))
    await rename(temporary,location)
  }
  const processTree = () => {
    const script = '$rows = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[int]]::new(); [void]$ids.Add('+child.pid+'); do { $added = $false; foreach ($row in $rows) { if ($ids.Contains([int]$row.ParentProcessId) -and $ids.Add([int]$row.ProcessId)) { $added = $true } } } while ($added); @($rows | Where-Object { $ids.Contains([int]$_.ProcessId) } | Select-Object ProcessId,Name) | ConvertTo-Json -Compress'
    const result = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true}))
    return Array.isArray(result)?result:[result]
  }
  try {
    await start()
    await waitFor(async()=> (await read()).ActiveFocus.RunningSince === null)
    assert.equal((await read()).ActiveFocus.ElapsedSeconds,3)
    let processes = processTree()
    assert.ok(processes.every(item=>item.ProcessId===child.pid||item.Name.toLowerCase()==='conhost.exe'))
    let current = await read()
    const resumedAt = new Date().toISOString()
    current.ActiveFocus = {...active,ElapsedSeconds:10,StartedAt:resumedAt,RunningSince:resumedAt,CheckpointAt:resumedAt}
    await replace(current)
    await waitFor(async()=>Date.parse((await read()).ActiveFocus.CheckpointAt)>Date.parse(resumedAt))
    await stop()
    const crashed = JSON.parse(await readFile(location,'utf8'))
    const expectedElapsed = Math.min(60,10+Math.max(0,(Date.parse(crashed.ActiveFocus.CheckpointAt)-Date.parse(resumedAt))/1000))
    await start()
    await waitFor(async()=> (await read()).ActiveFocus.RunningSince === null)
    assert.equal((await read()).ActiveFocus.ElapsedSeconds,expectedElapsed)
    current = await read()
    const suspendedAt = Date.now()
    current.ActiveFocus = {...active,Id:'suspend-focus',StartedAt:new Date(suspendedAt-120000).toISOString(),RunningSince:new Date(suspendedAt-120000).toISOString(),CheckpointAt:new Date(suspendedAt-115000).toISOString()}
    await replace(current)
    await waitFor(async()=> (await read()).ActiveFocus.RunningSince === null)
    assert.equal((await read()).ActiveFocus.ElapsedSeconds,5)
    assert.equal((await read()).FocusSessions.length,0)
    current = await read()
    const completingAt = Date.now()
    current.ActiveFocus = {...active,Id:'complete-once',StartedAt:new Date(completingAt-61000).toISOString(),RunningSince:new Date(completingAt-61000).toISOString(),CheckpointAt:new Date(completingAt).toISOString()}
    current.Todos = [{Id:'due-background-task',Title:'后台任务提醒 🪶',IsCompleted:false,CreatedAt:new Date(completingAt).toISOString(),ReminderAt:new Date(completingAt-1000).toISOString(),ReminderRepeat:'None',ReminderNotifiedAt:null}]
    await rm(location+'.bak')
    await mkdir(location+'.bak')
    await replace(current)
    const outputOffset = output.length
    await waitFor(()=>output.slice(outputOffset).includes('后台维护失败'))
    assert.equal((await read()).ActiveFocus.Id,'complete-once')
    assert.equal((await read()).FocusSessions.length,0)
    assert.equal((await read()).Todos[0].ReminderNotifiedAt,null)
    assert.equal(output.slice(outputOffset).includes('DustDesk test notification:'),false)
    await rmdir(location+'.bak')
    await waitFor(async()=> (await read()).ActiveFocus === null)
    const completed = await read()
    assert.equal(completed.FocusSessions.length,1)
    assert.equal(completed.FocusSessions[0].Id,'complete-once')
    assert.equal(completed.FocusSessions[0].Seconds,60)
    assert.equal(completed.FocusSessions[0].Completed,true)
    assert.ok(completed.Todos[0].ReminderNotifiedAt)
    await waitFor(()=>output.slice(outputOffset).split('DustDesk test notification:').length===3)
    const notifications = output.slice(outputOffset).split(/\r?\n/).filter(line=>line.startsWith('DustDesk test notification:')).map(line=>JSON.parse(line.slice('DustDesk test notification:'.length)))
    assert.deepEqual(notifications,[{title:'DustDesk 任务提醒',body:'后台任务提醒 🪶'},{title:'专注完成',body:'本轮专注已记录，可以休息一下。'}])
    processes = processTree()
    assert.ok(processes.every(item=>item.ProcessId===child.pid||item.Name.toLowerCase()==='conhost.exe'))
    await mkdir('artifacts/tauri-migration',{recursive:true})
    await writeFile(reportPath,JSON.stringify({ok:true,executable,checks:['no-window-and-no-WebView-services','startup-checkpoint-recovery','crash-restart-checkpoint-recovery','suspend-gap-not-counted','real-background-ticks','failed-write-retains-live-session','background-retry-completes-once'],processes,performanceGateSatisfied:false,pending:['physical-sleep-resume','native-notification','full-release-gates']},null,2))
  } finally {
    await stop()
    const resolved = path.resolve(root)
    assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()))
    assert.ok(path.basename(resolved).startsWith('dustdesk-focus-background-'))
    await rm(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:300})
  }
})
