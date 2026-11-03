import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { readZip } from './zip-files.mjs'

const first=await launchDustDesk({ showToolMenus: true }), second=await launchDustDesk({ showToolMenus: true })
const waitForTransfer = async (page, id) => {
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    const task = (await page.evaluate(() => window.dustdesk.toolbox.lanSnapshot())).tasks.find(task => task.id === id)
    if (task && !['preparing', 'waiting', 'transferring'].includes(task.status)) return task
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail(`Transfer ${id} did not settle`)
}
async function sendAndWait(page, device, assets, text) {
  const previous = (await page.evaluate(() => window.dustdesk.toolbox.lanSnapshot())).tasks.map(task => task.id)
  await page.evaluate(({ device, assets, text }) => window.dustdesk.toolbox.lanSend(device, assets, text), { device, assets, text })
  const task = (await page.evaluate(() => window.dustdesk.toolbox.lanSnapshot())).tasks.find(task => !previous.includes(task.id))
  assert.ok(task)
  await waitForTransfer(page, task.id)
}
try {
  const page=first.window, source=path.join(first.tempRoot,'拖入.png')
  const png=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=12;canvas.height=8;const ctx=canvas.getContext('2d');ctx.fillStyle='#087f6c';ctx.fillRect(0,0,12,8);return [...new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve))).arrayBuffer())]})
  await fs.writeFile(source,Buffer.from(png))
  await page.locator('.sidebar').getByText('图片工具箱',{exact:true}).click()
  await page.locator('.image-tool-layout').waitFor()
  await page.evaluate(()=>{const input=document.createElement('input');input.type='file';input.id='native-toolbox-file';document.body.append(input)})
  await page.locator('#native-toolbox-file').setInputFiles(source)
  const paths=await page.evaluate(()=>window.dustdesk.getDroppedPaths([...document.querySelector('#native-toolbox-file').files]))
  assert.equal(paths[0],source,'Electron webUtils must retain the native path')
  await page.evaluate(()=>{const dt=new DataTransfer();dt.items.add(document.querySelector('#native-toolbox-file').files[0]);document.querySelector('.toolbox-page:has(.image-tool-layout)').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:dt}));document.querySelector('#native-toolbox-file').remove()})
  await page.locator('.image-tool-thumb').waitFor()
  // Mock the native clipboard boundary without modifying the user's real clipboard.
  await first.electronApp.evaluate(({clipboard,nativeImage},bytes)=>{clipboard.readImage=()=>nativeImage.createFromBuffer(Buffer.from(bytes));clipboard.readText=()=>''},png)
  await page.getByRole('button',{name:'粘贴图片',exact:true}).click();await page.getByText('剪贴板.png',{exact:true}).waitFor()
  await page.getByRole('button',{name:'批量预览',exact:true}).click();await page.getByText('处理完成：2 成功',{exact:true}).waitFor()
  await first.electronApp.evaluate(({dialog},target)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:target})},path.join(first.tempRoot,'图片.zip'))
  await page.getByRole('button',{name:'导出全部',exact:true}).click();await page.getByText('导出完成：2 成功',{exact:true}).waitFor()
  const images=await readZip(path.join(first.tempRoot,'图片.zip'));assert.equal(images.size,2)
  assert.deepEqual([...images.keys()],['拖入-处理后.png','剪贴板-处理后.png'])
  for(const bytes of images.values()) assert.equal(bytes.subarray(1,4).toString(),'PNG')
  assert.equal((await fs.readdir(first.tempRoot)).some(name=>name.startsWith('.dustdesk-images-')),false)
  assert.deepEqual(await fs.readFile(source),Buffer.from(png))
  const receiverDirectory=path.join(second.tempRoot,'received')
  for(const instance of [first,second]) await instance.electronApp.evaluate(({dialog},root)=>{
    globalThis.__toolboxDialogs=[]
    dialog.showMessageBox=async(...args)=>{const options=args.at(-1);globalThis.__toolboxDialogs.push({title:options.title,detail:options.detail});return {response:1}}
    dialog.showOpenDialog=async()=>({canceled:false,filePaths:[root]})
  },instance===first?first.tempRoot:receiverDirectory)
  await second.electronApp.evaluate(({dialog},root)=>{const original=dialog.showMessageBox;dialog.showMessageBox=async(...args)=>{const result=await original(...args);if(args.at(-1).title==='接收局域网内容'&&!args.at(-1).detail.startsWith('文本'))return {response:2};return result}},receiverDirectory)
  await page.locator('.sidebar').getByText('局域网传输',{exact:true}).click()
  await second.window.locator('.sidebar').getByText('局域网传输',{exact:true}).click()
  await page.getByRole('button',{name:'开启局域网传输',exact:true}).click();await second.window.getByRole('button',{name:'开启局域网传输',exact:true}).click()
  const state=await second.window.evaluate(()=>window.dustdesk.toolbox.lanSnapshot())
  const device=await page.evaluate(port=>window.dustdesk.toolbox.lanConnect('127.0.0.1',port),state.port)
  const pairs=await Promise.all([first.electronApp.evaluate(()=>globalThis.__toolboxDialogs.filter(d=>d.title==='局域网设备配对')),second.electronApp.evaluate(()=>globalThis.__toolboxDialogs.filter(d=>d.title==='局域网设备配对'))])
  assert.equal(pairs[0].length,1);assert.equal(pairs[1].length,1);assert.equal(pairs[0][0].detail.match(/\b\d{6}\b/)[0],pairs[1][0].detail.match(/\b\d{6}\b/)[0])
  const folder=path.join(first.tempRoot,'发送文件夹');await fs.mkdir(path.join(folder,'空目录'),{recursive:true});await fs.writeFile(path.join(folder,'内容.txt'),'真实 Electron 传输')
  const imported=await page.evaluate(target=>window.dustdesk.toolbox.registerPaths([target],'transfer'),folder)
  await second.window.evaluate(()=>window.dustdesk.hideMainWindow())
  await sendAndWait(page,device.id,imported.map(a=>a.id))
  const received=(await second.window.evaluate(()=>window.dustdesk.toolbox.lanSnapshot())).tasks[0]
  assert.equal(received.status,'completed');assert.equal(await fs.readFile(path.join(received.directory,'发送文件夹','内容.txt'),'utf8'),'真实 Electron 传输')
  assert.ok((await fs.stat(path.join(received.directory,'发送文件夹','空目录'))).isDirectory())
  await sendAndWait(page,device.id,[],'真实 Electron 文本')
  assert.equal((await second.window.evaluate(()=>window.dustdesk.toolbox.lanSnapshot())).tasks.find(t=>t.text)?.text,'真实 Electron 文本')
  const dialogs=await second.electronApp.evaluate(()=>globalThis.__toolboxDialogs.filter(d=>d.title==='接收局域网内容'));assert.equal(dialogs.length,2)
  if(process.platform==='win32') {
    const lockedPath=path.join(first.tempRoot,'占用文件.txt');await fs.writeFile(lockedPath,'保留源文件')
    const locker=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$lockStream = [System.IO.File]::Open($env:DUSTDESK_LOCK_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None); try { [Console]::WriteLine('LOCKED'); [Console]::ReadLine() | Out-Null } finally { $lockStream.Dispose() }"],{windowsHide:true,env:{...process.env,DUSTDESK_LOCK_TEST_FILE:lockedPath},stdio:['pipe','pipe','pipe']})
    const exit=new Promise(resolve=>locker.once('exit',resolve))
    try {
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('File lock startup timeout')),10000);locker.stdout.on('data',bytes=>{if(bytes.toString().includes('LOCKED')){clearTimeout(timer);resolve()}});locker.once('error',reject)})
      const imported=await page.evaluate(target=>window.dustdesk.toolbox.registerPaths([target],'transfer'),lockedPath)
      await sendAndWait(page,device.id,imported.map(a=>a.id))
      const failed=(await page.evaluate(()=>window.dustdesk.toolbox.lanSnapshot())).tasks.find(task=>task.name==='占用文件.txt')
      assert.equal(failed.status,'failed');assert.match(failed.error,/占用|权限/)
    } finally {locker.stdin.end('\n');await exit}
    assert.equal(await fs.readFile(lockedPath,'utf8'),'保留源文件')
    const failed=(await page.evaluate(()=>window.dustdesk.toolbox.lanSnapshot())).tasks.find(task=>task.name==='占用文件.txt')
    await page.evaluate(id=>window.dustdesk.toolbox.lanControl(id,'resume'),failed.id);await waitForTransfer(page,failed.id)
    assert.equal((await page.evaluate(()=>window.dustdesk.toolbox.lanSnapshot())).tasks.find(task=>task.id===failed.id).status,'completed')
  }
  await page.setViewportSize({width:1280,height:800});await page.screenshot({path:'test-artifacts/toolbox-native.png'})
  console.log(JSON.stringify({nativeDrop:true,clipboardImport:true,imageExport:true,tlsPairing:true,trayReceive:true,fileFolderText:true,lockedSourceRetry:process.platform==='win32'}))
  // Exercise the normal before-quit path, including durable transfer state.
  await first.electronApp.evaluate(({app})=>{setTimeout(()=>app.quit(),10)})
  await new Promise(resolve=>first.electronApp.once('close',resolve))
  await second.electronApp.evaluate(({app})=>{setTimeout(()=>app.quit(),10)})
  await new Promise(resolve=>second.electronApp.once('close',resolve))
} finally {await closeDustDesk(first);await closeDustDesk(second)}
