import { spawn } from 'node:child_process'
import path from 'node:path'
const executable = path.resolve(process.env.DUSTDESK_PACKAGE_EXECUTABLE ?? 'src-tauri/target/x86_64-pc-windows-msvc/release/DustDesk.exe')
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--test', 'tests/tauri-default-app.mjs'], { stdio: 'inherit', windowsHide: true, env: { ...process.env, DUSTDESK_TAURI_EXECUTABLE: executable } })
  child.once('error', reject); child.once('exit', resolve)
})
if (code !== 0) throw Error('Packaged Tauri application smoke test failed: ' + code)
const boundary = await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['tests/tauri-release-boundaries.mjs'],{stdio:'inherit',windowsHide:true,env:{...process.env,DUSTDESK_PACKAGE_EXECUTABLE:executable}})
  child.once('error',reject);child.once('exit',resolve)
})
if(boundary!==0) throw Error('Packaged Tauri release boundary failed: '+boundary)
