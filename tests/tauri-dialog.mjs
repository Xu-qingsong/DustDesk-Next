import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
const run=promisify(execFile)
export async function operateDialog(application,title,action='snapshot',target){
  const parameters=Buffer.from(JSON.stringify({processId:application.child.pid,title,action,path:target??'',script:path.resolve('tests/tauri-dialog.ps1')})).toString('base64')
  const command="$parameters=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+parameters+"')) | ConvertFrom-Json; [Console]::OutputEncoding=[Text.Encoding]::UTF8; & ([scriptblock]::Create([IO.File]::ReadAllText($parameters.script,[Text.Encoding]::UTF8))) -ProcessId $parameters.processId -Title $parameters.title -Action $parameters.action -Path $parameters.path"
  const result=await run('pwsh.exe',['-Mta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true,timeout:18000,maxBuffer:1024*1024})
  return result.stdout.trim()
}
