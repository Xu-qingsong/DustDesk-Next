import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createInterface} from 'node:readline'
import path from 'node:path'
import {waitFor} from './tauri-harness.mjs'

export async function clipboardFixture(){
  const child=spawn('pwsh.exe',['-Sta','-NoLogo','-NoProfile','-NonInteractive','-File',path.resolve('tests/tauri-clipboard-helper.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  const lines=[];let errors='';child.stderr.on('data',bytes=>{errors+=bytes});const reader=createInterface({input:child.stdout});reader.on('line',line=>{lines.push(JSON.parse(line))})
  const next=async()=>{await waitFor(()=>{if(lines.length)return true;if(child.exitCode!==null)throw Error(errors||'Clipboard fixture stopped unexpectedly');return false},15000);return lines.shift()}
  assert.equal((await next()).ready,true)
  const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64')+'\n'
  const request=async(action,args={})=>{child.stdin.write(encode({action,...args}));const result=await next();assert.equal(typeof result.sequence,'number',errors);return result}
  const close=async()=>{child.stdin.end(encode({action:'restore'}));const response=await next();assert.equal(response.restored,true);await waitFor(()=>child.exitCode!==null);assert.equal(child.exitCode,0,errors);reader.close()}
  return {request,close}
}

export async function holdClipboard(){
  const child=spawn('pwsh.exe',['-Sta','-NoProfile','-NonInteractive','-File',path.resolve('tests/tauri-clipboard-lock.ps1')],{windowsHide:true,stdio:['pipe','pipe','pipe']})
  let output='';let errors='';child.stdout.on('data',bytes=>{output+=bytes});child.stderr.on('data',bytes=>{errors+=bytes})
  try{await waitFor(()=>{if(child.exitCode!==null)throw Error(errors||'Clipboard holder stopped');return output.includes('ready')},10000)}catch(error){child.stdin.end();throw error}
  return async()=>{child.stdin.end('\n');await waitFor(()=>child.exitCode!==null);assert.equal(child.exitCode,0,errors)}
}
