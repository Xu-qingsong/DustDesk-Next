import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { launchTauri } from './tauri-harness.mjs'

const report='artifacts/tauri-migration/launch-failure-native.json'
await mkdir(path.dirname(report),{recursive:true});await rm(report,{force:true})
await test('failed native startup preserves caller-owned evidence and cleans only harness-owned roots',async suite=>{
  const evidence=[]
  const assertStopped=diagnostics=>{
    assert.equal(diagnostics.stage,'debug-endpoint')
    assert.ok(diagnostics.pid>0)
    const command='@(Get-CimInstance Win32_Process -Filter "ProcessId = '+diagnostics.pid+'" | Where-Object {$_.ExecutablePath -eq \''+diagnostics.executable.replaceAll("'","''")+'\'}).Count'
    assert.equal(Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true}).trim()),0)
  }
  await suite.test('missing startup page retains a reused workspace root for the caller to inspect',async()=>{
    const root=await mkdtemp(path.join(os.tmpdir(),'dustdesk-tauri-test-'))
    const sentinel=path.join(root,'caller-owned.fixture')
    try{
      await writeFile(sentinel,'caller-owned diagnostic evidence🪶')
      await assert.rejects(launchTauri({rootDirectory:root,widgetStartup:'todo',startupTimeoutMs:1500}),error=>{
        assert.match(error.message,/Timed out waiting/)
        assert.equal(error.launchDiagnostics.root,root);assert.equal(error.launchDiagnostics.callerOwnsRoot,true);assertStopped(error.launchDiagnostics)
        evidence.push(error.launchDiagnostics);return true
      })
      assert.equal(await readFile(sentinel,'utf8'),'caller-owned diagnostic evidence🪶')
    }finally{
      assert.ok(root.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(root).startsWith('dustdesk-tauri-test-'))
      await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300})
    }
  })
  await suite.test('missing startup page still cleans a fresh root allocated by the harness',async()=>{
    let diagnostics
    await assert.rejects(launchTauri({widgetStartup:'todo',startupTimeoutMs:1500}),error=>{
      diagnostics=error.launchDiagnostics;assert.equal(diagnostics.callerOwnsRoot,false);assertStopped(diagnostics);evidence.push(diagnostics);return true
    })
    await assert.rejects(stat(diagnostics.root),{code:'ENOENT'})
  })
  await writeFile(report,JSON.stringify({productionReady:false,scope:'isolated-harness-startup-failure-ownership-and-diagnostics',evidence},null,2))
})
