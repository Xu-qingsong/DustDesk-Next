import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { waitFor } from './tauri-harness.mjs'

const execute=promisify(execFile)
export const organizerDialog = async (app, action='snapshot') => JSON.parse((await execute('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','tests/tauri-organizer-quit.ps1','-ProcessId',String(app.child.pid),'-Action',action],{windowsHide:true,encoding:'utf8',timeout:20000})).stdout.trim())

export async function quitOrganizer(app, page, choice, beforeClick) {
  const result=app.invoke('application_quit',{},page).then(value=>({value}),error=>({error:String(error)}))
  let dialog
  try{dialog=await organizerDialog(app)}catch(error){const state=await Promise.race([result,new Promise(resolve=>setTimeout(()=>resolve('quit still pending'),1000))]);throw Error(String(error)+'\n'+JSON.stringify(state)+'\n'+app.output())}
  assert.equal(dialog.defaultButton,2,'The safe default must be Cancel')
  await beforeClick?.()
  await organizerDialog(app,choice)
  if(choice==='cancel'||beforeClick){
    const outcome=await result
    assert.ok(outcome.error,JSON.stringify(outcome))
    await waitFor(()=>page.evaluate(()=>!document.documentElement.inert))
    assert.equal(app.child.exitCode,null)
    return outcome
  }
  await waitFor(()=>app.child.exitCode!==null)
  assert.equal(app.child.exitCode,0,app.output())
  await result
}
