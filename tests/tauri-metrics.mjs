import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdir,readFile,writeFile,rm,open} from 'node:fs/promises'
import {randomBytes} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import path from 'node:path'
import {launchTauri,waitFor} from './tauri-harness.mjs'
import {mainFixture} from './main-headless-harness.mjs'

const run=promisify(execFile)
const delay=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds))
const report='artifacts/tauri-migration/metrics-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})

await test('native monitoring preserves the shared contract, cache, UI and lifecycle without collector subprocesses',async suite=>{
  const app=await launchTauri();const scenarios=[];const evidence={};let failed=false
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Metrics scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite);const initial=await electron.load();initial.Settings.AutomaticBackupEnabled=false;initial.DesktopCategories=[]
    for(const key of ['MonitorShowCpu','MonitorShowMemory','MonitorShowDownload','MonitorShowUpload','MonitorShowDiskIo','MonitorShowDiskSpace','MonitorShowPing','MonitorShowUptime'])initial.Settings[key]=true
    await app.invoke('prototype_workspace_initialize',{state:initial});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().includes('tauri.html')));await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const reference=async()=>JSON.parse((await run('pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File','tests/tauri-metrics-reference.ps1','-AppProcessId',String(app.child.pid)],{windowsHide:true,timeout:30000})).stdout.trim())
    const validate=metrics=>{
      for(const key of ['CpuPercent','MemoryPercent'])assert.ok(Number.isFinite(metrics[key])&&metrics[key]>=0&&metrics[key]<=100,key)
      for(const key of ['UsedMemoryBytes','TotalMemoryBytes','DownloadBytesPerSecond','UploadBytesPerSecond','UptimeSeconds'])assert.ok(Number.isFinite(metrics[key])&&metrics[key]>=0,key)
      assert.ok(metrics.TotalMemoryBytes>0);assert.ok(metrics.UsedMemoryBytes<=metrics.TotalMemoryBytes)
      assert.ok(Math.abs(metrics.MemoryPercent-metrics.UsedMemoryBytes/metrics.TotalMemoryBytes*100)<0.000001)
      for(const key of ['DiskReadBytesPerSecond','DiskWriteBytesPerSecond'])assert.ok(metrics[key]===null||(Number.isFinite(metrics[key])&&metrics[key]>=0),key)
      assert.ok(Number.isInteger(metrics.PingMilliseconds)&&metrics.PingMilliseconds>=-1)
      assert.ok(Array.isArray(metrics.DiskSpaces))
      for(const disk of metrics.DiskSpaces){assert.deepEqual(Object.keys(disk).sort(),['DriveName','FreeBytes','TotalBytes']);assert.match(disk.DriveName,/^[A-Z]:$/i);assert.ok(disk.TotalBytes>0&&disk.FreeBytes>=0&&disk.FreeBytes<=disk.TotalBytes)}
    }
    await scenario('native response preserves every Electron IPC metric key and unavailable-value semantics',async()=>{
      const legacy=await electron.invoke('system:sample');const actual=await api('sampleSystemMetrics');validate(actual)
      assert.deepEqual(Object.keys(actual).sort(),Object.keys(legacy).sort())
      assert.equal(legacy.DiskReadBytesPerSecond,null);assert.equal(legacy.DiskWriteBytesPerSecond,null);assert.equal(legacy.PingMilliseconds,-1)
      evidence.first=actual;evidence.contractComparison='keys-and-invariants-only; Electron headless OS metrics are mocked, not exact real-time values'
    })
    await scenario('real native memory, uptime and every ready drive agree with independent Windows references',async()=>{
      const expected=await reference();const actual=await api('sampleSystemMetrics');validate(actual)
      assert.equal(actual.TotalMemoryBytes,expected.TotalMemoryBytes)
      assert.ok(Math.abs(actual.UsedMemoryBytes-expected.UsedMemoryBytes)<Math.max(512*1024**2,expected.TotalMemoryBytes*0.05))
      assert.ok(Math.abs(actual.UptimeSeconds-expected.UptimeSeconds)<=10)
      assert.ok(expected.DiskSpaces.length>0)
      assert.deepEqual(actual.DiskSpaces.map(disk=>disk.DriveName).sort(),expected.DiskSpaces.map(disk=>disk.DriveName).sort())
      for(const disk of expected.DiskSpaces){const sampled=actual.DiskSpaces.find(item=>item.DriveName===disk.DriveName);assert.equal(sampled.TotalBytes,disk.TotalBytes);assert.ok(Math.abs(sampled.FreeBytes-disk.FreeBytes)<256*1024**2)}
      if(expected.DiskIo!==null){assert.notEqual(actual.DiskReadBytesPerSecond,null,'working Windows disk counters must not be silently unavailable');assert.notEqual(actual.DiskWriteBytesPerSecond,null)}
      evidence.reference=expected
    })
    await scenario('concurrent callers share identical samples, cached reads are immediate and expired reads refresh',async()=>{
      await delay(2100)
      const samples=await page.evaluate(()=>Promise.all(Array.from({length:16},()=>window.dustdesk.sampleSystemMetrics())))
      for(const sample of samples)assert.deepEqual(sample,samples[0]);validate(samples[0])
      const start=Date.now();assert.deepEqual(await api('sampleSystemMetrics'),samples[0]);assert.ok(Date.now()-start<500)
      await delay(2100);const next=await api('sampleSystemMetrics');validate(next);assert.ok(next.UptimeSeconds>=samples[0].UptimeSeconds+2)
    })
    await scenario('sampling does not block workspace saves or create PowerShell, cmd, ping or Node child processes',async()=>{
      await delay(2100)
      const pending=api('sampleSystemMetrics');const start=Date.now();const state=await api('loadWorkspace');state.Notes[0].Text='保存与原生系统采样并发';assert.equal((await api('saveWorkspace',state)).ok,true);assert.ok(Date.now()-start<2000)
      const observed=await reference();validate(await pending)
      assert.equal(JSON.parse(await readFile(path.join(app.root,'user-data','tauri-preview','Workspace','workspace.json'),'utf8')).Notes[0].Text,state.Notes[0].Text)
      for(const child of observed.Children)assert.doesNotMatch(child,/^(?:pwsh|powershell|cmd|ping|node|wmic)\.exe$/i)
      const source=await readFile('src-tauri/src/platform/metrics.rs','utf8');assert.doesNotMatch(source,/Command::|std::process|PowerShell|systeminformation/)
      evidence.children=observed.Children
    })
    await scenario('native disk counters observe actual flushed writes instead of permanently reporting zero',async()=>{
      await delay(2100)
      const file=await open(path.join(app.root,'monitor-disk-workload.bin'),'w');const bytes=randomBytes(1024**2)
      let sampled
      try{
        const sampling=api('sampleSystemMetrics')
        for(let index=0;index<64;index++){await file.write(bytes,0,bytes.length,0);await file.sync();await delay(20)}
        sampled=await sampling
      }finally{await file.close()}
      validate(sampled);assert.ok(sampled.DiskWriteBytesPerSecond>0,'flushed disk writes must produce a positive native disk throughput')
      evidence.diskWriteWorkload={totalBytesWritten:64*bytes.length,writeBytesPerSecond:sampled.DiskWriteBytesPerSecond}
    })
    await scenario('shared Monitor page renders live metrics, refreshes periodically and persists display settings',async()=>{
      await page.getByRole('button',{name:'系统检测',exact:true}).click();await page.getByRole('heading',{name:'系统检测',exact:true}).waitFor()
      await waitFor(async()=>/\d+%/.test(await page.locator('.monitor-metrics .metric').first().innerText()))
      const stamp=await page.locator('.monitor-metrics .metric').last().locator('small').innerText()
      await waitFor(async()=>await page.locator('.monitor-metrics .metric').last().locator('small').innerText()!==stamp,7000)
      await page.getByRole('button',{name:'立即刷新',exact:true}).click()
      await page.getByTitle('隐藏CPU',{exact:true}).click();await waitFor(async()=>!(await api('loadWorkspace')).Settings.MonitorShowCpu)
      assert.equal(await page.locator('.monitor-metrics .metric').filter({hasText:'CPU 使用率'}).count(),0)
      await page.reload();await page.locator('.app-shell').waitFor();await page.getByRole('button',{name:'系统检测',exact:true}).click();await page.getByTitle('显示CPU',{exact:true}).waitFor()
      await page.getByTitle('显示CPU',{exact:true}).click();await waitFor(async()=>(await api('loadWorkspace')).Settings.MonitorShowCpu)
      await waitFor(async()=>/\d+%/.test(await page.locator('.monitor-metrics .metric').first().innerText()))
      await page.getByText('无法读取小组件状态，请重试',{exact:true}).waitFor({state:'hidden',timeout:10000})
      await page.getByText('显示设置已保存',{exact:true}).waitFor({state:'hidden',timeout:10000})
      await page.screenshot({path:'artifacts/tauri-migration/monitor-shared-native.png',fullPage:true})
      await page.getByRole('button',{name:'概览',exact:true}).click()
    })
    await scenario('shared UI distinguishes nullable disk and failed ping from zero and reports rejected samples using controlled adapter faults',async()=>{
      await page.evaluate(async()=>{window.__metricsOriginal=window.dustdesk.sampleSystemMetrics;const native=await window.__metricsOriginal();window.dustdesk.sampleSystemMetrics=async()=>({...native,DiskReadBytesPerSecond:null,DiskWriteBytesPerSecond:null,PingMilliseconds:-1})})
      try{
        await page.getByRole('button',{name:'系统检测',exact:true}).click()
        for(const label of ['磁盘读取','磁盘写入','延迟'])await waitFor(async()=>await page.locator('.health-grid > div').filter({hasText:label}).locator('strong').innerText()==='暂不可用')
        await page.evaluate(()=>{window.dustdesk.sampleSystemMetrics=async()=>{throw Error('controlled adapter failure')}})
        await page.getByRole('button',{name:'立即刷新',exact:true}).click();await page.getByText('系统指标暂时不可用',{exact:true}).waitFor()
        evidence.uiFaults='adapter-injected null disk, ping -1 and rejected request; not evidence of physical Windows counter or ICMP failure'
      }finally{
        await page.evaluate(()=>{window.dustdesk.sampleSystemMetrics=window.__metricsOriginal;delete window.__metricsOriginal})
        await page.getByRole('button',{name:'立即刷新',exact:true}).click();await page.getByRole('button',{name:'概览',exact:true}).click()
      }
    })
    await scenario('prototype roles cannot sample and native quit rejects new samples before callback acknowledgement',async()=>{
      await assert.rejects(app.invoke('system_sample'),/not allowed|权限|denied/i)
      await page.evaluate(()=>{window.__metricsQuitRemove=window.dustdesk.onBeforeQuit(async()=>{try{await window.__TAURI_INTERNALS__.invoke('system_sample');window.__metricsQuitOutcome='unexpected success'}catch(error){window.__metricsQuitOutcome=String(error)}throw Error('metrics quit veto')})})
      await assert.rejects(app.invoke('application_quit',{},page),/metrics quit veto/)
      assert.match(await page.evaluate(()=>window.__metricsQuitOutcome),/退出/)
      await waitFor(()=>page.evaluate(()=>!document.documentElement.inert));await page.evaluate(()=>window.__metricsQuitRemove());validate(await api('sampleSystemMetrics'))
    })
    await scenario('repeated expired native queries release PDH and ICMP handles rather than growing without bound',async()=>{
      const before=await reference()
      for(let index=0;index<4;index++){await delay(2100);validate(await api('sampleSystemMetrics'))}
      const after=await reference();assert.ok(after.HandleCount-before.HandleCount<32,JSON.stringify({before:before.HandleCount,after:after.HandleCount}));assert.deepEqual(errors,[])
      evidence.handles={before:before.HandleCount,after:after.HandleCount,cycles:4,maximumAllowedGrowth:31}
    })
    await writeFile(report,JSON.stringify({productionReady:false,scope:'native-monitor-main-window-only',scenarios,evidence,pending:['monitor-widget-runtime','physical-default-route-change-and-disconnect','disabled-disk-counters-and-blocked-ICMP-real-machine','slow-unavailable-network-drive','mixed-DPI','full-release-performance','production-takeover']},null,2))
  }finally{await app.close()}
})
