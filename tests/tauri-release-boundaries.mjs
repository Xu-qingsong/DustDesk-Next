import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { waitFor } from './tauri-harness.mjs'

const executable = path.resolve(process.env.DUSTDESK_PACKAGE_EXECUTABLE ?? 'src-tauri/target/x86_64-pc-windows-msvc/release/DustDesk.exe')
const root = await mkdtemp(path.join(os.tmpdir(),'dustdesk-release-boundary-'))
let child
try {
  child=spawn(executable,['--prototype'],{windowsHide:true,stdio:'ignore',env:{...process.env,DUSTDESK_TEST_USER_DATA_DIR:root,DUSTDESK_TAURI_DISABLE_HOTKEYS:'1'}})
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
  await waitFor(()=>child.exitCode!==null,10000)
  assert.equal(child.exitCode,1,'Release must refuse the debug prototype entry')
  assert.deepEqual(await readdir(root),[],'Refusing a debug entry must not initialize a profile')
  console.log('Release prototype entry is disabled')
} finally {
  if(child?.exitCode===null) child.kill()
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()))
  await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:300})
}
