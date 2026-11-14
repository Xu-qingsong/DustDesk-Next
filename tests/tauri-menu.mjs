import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
const run=promisify(execFile)
export async function operateMenu(application,action='snapshot',expectedPath=''){
  const payload=Buffer.from(JSON.stringify({processId:application.child.pid,action,expectedPath,script:path.resolve('tests/tauri-menu.ps1')})).toString('base64')
  const command="$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json;[Console]::OutputEncoding=[Text.Encoding]::UTF8;& ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Action $parameters.action -ExpectedPath $parameters.expectedPath"
  const result=await run('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:22000,maxBuffer:1024*1024})
  return result.stdout.trim()
}
