import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, writeFile, rm, rmdir, symlink, access, open } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'

const execute=promisify(execFile)
async function powershell(script){return (await execute('pwsh.exe',['-Mta','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{windowsHide:true,timeout:20000,maxBuffer:1024*1024})).stdout.trim()}
async function shortcuts(requests){
  const payload=Buffer.from(JSON.stringify(requests)).toString('base64')
  await powershell("$ErrorActionPreference='Stop';$requests=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+payload+"'))|ConvertFrom-Json;$shell=New-Object -ComObject WScript.Shell;try{foreach($request in $requests){$link=$shell.CreateShortcut($request.file);try{$link.TargetPath=$request.target;if($request.icon){$link.IconLocation=$request.icon};if($request.args){$link.Arguments=$request.args};$link.Save()}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)}}}finally{[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)}")
}
async function handles(pid){return JSON.parse(await powershell('Add-Type -TypeDefinition \'using System; using System.Runtime.InteropServices; public static class IconHandles { [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr process,uint flags); }\';$process=Get-Process -Id '+pid+';@{gdi=[IconHandles]::GetGuiResources($process.Handle,0);user=[IconHandles]::GetGuiResources($process.Handle,1)}|ConvertTo-Json -Compress'))}
function ico(bytes){const header=Buffer.alloc(22);header.writeUInt16LE(1,2);header.writeUInt16LE(1,4);header[6]=32;header[7]=32;header.writeUInt16LE(1,10);header.writeUInt16LE(32,12);header.writeUInt32LE(bytes.length,14);header.writeUInt32LE(22,18);return Buffer.concat([header,bytes])}

await test('Rust reads real Shell and embedded icons without executing linked programs',async suite=>{
  const reportPath='artifacts/tauri-migration/icons-native.json'
  await rm(reportPath,{force:true})
  const app=await launchTauri()
  let failed=false
  const scenarios=[];const differences=[];const previews=[]
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Native icon scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite)
    electron.childProcess.execFile=execFile
    electron.electron.app.getFileIcon=()=>{throw Error('The real resource/Shell reader must supply the reference icon')}
    const state=await electron.load();state.Settings.AutomaticBackupEnabled=false
    const source=path.join(app.root,'icon-samples');await mkdir(source)
    const png=Buffer.from(await app.page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const context=canvas.getContext('2d');context.fillStyle='#cf263b';context.fillRect(3,2,22,13);context.fillStyle='rgba(12,99,225,0.5)';context.fillRect(10,18,20,12);return canvas.toDataURL('image/png').split(',')[1]}),'base64')
    const custom=path.join(source,'中文，图标,ProductIcon');await writeFile(custom,ico(png))
    const raster=path.join(source,'半透明图标.png');await writeFile(raster,png)
    const jpeg=path.join(source,'图标.jpg');await writeFile(jpeg,Buffer.from(await app.page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;const context=canvas.getContext('2d');context.fillStyle='#286ad3';context.fillRect(0,0,32,32);return canvas.toDataURL('image/jpeg').split(',')[1]}),'base64'))
    const gif=path.join(source,'图标.gif');await writeFile(gif,Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64'))
    const bmp=path.join(source,'图标.bmp');const bitmap=Buffer.alloc(58);bitmap.write('BM');bitmap.writeUInt32LE(58,2);bitmap.writeUInt32LE(54,10);bitmap.writeUInt32LE(40,14);bitmap.writeInt32LE(1,18);bitmap.writeInt32LE(1,22);bitmap.writeUInt16LE(1,26);bitmap.writeUInt16LE(24,28);bitmap.writeUInt32LE(4,34);bitmap[54]=120;await writeFile(bmp,bitmap)
    const oversized=path.join(source,'oversized.png');const oversizedFile=await open(oversized,'w');await oversizedFile.write(png);await oversizedFile.truncate(4*1024*1024+1);await oversizedFile.close()
    const wide=path.join(source,'wide.png');await writeFile(wide,Buffer.from(await app.page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=1025;canvas.height=1;return canvas.toDataURL('image/png').split(',')[1]}),'base64'))
    const files=[]
    const add=(target,kind)=>{files.push({target,kind});return target}
    const program=add(process.execPath,'program')
    add(path.join(process.env.SystemRoot,'System32','shell32.dll'),'resource')
    add(custom,'icon')
    const directIcon=path.join(source,'直接图标.ico');await writeFile(directIcon,ico(png));add(directIcon,'icon')
    for(const name of ['folder','folder.txt','folder.exe','folder.lnk']){const target=path.join(source,name);await mkdir(target);add(target,'directory')}
    for(const extension of ['txt','pdf','docx','xlsx','pptx','png','zip','json','unknown','URL','']){const target=path.join(source,'document'+(extension?'.'+extension:''));await writeFile(target,extension==='URL'?'[InternetShortcut]\r\nURL=https://example.com\r\n':'');add(target,'file')}
    const dotfile=path.join(source,'.gitignore');await writeFile(dotfile,'');add(dotfile,'file')
    const shortcutFiles=[
      {file:path.join(source,'默认图标.lnk'),target:program},
      {file:path.join(source,'自定义资源.lnk'),target:path.join(source,'missing.exe'),icon:custom+',0'},
      {file:path.join(source,'无效索引.lnk'),target:program,icon:custom+',9999'},
      {file:path.join(source,'丢失资源.lnk'),target:program,icon:path.join(source,'missing.ico')+',0'},
      {file:path.join(source,'自定义图片.lnk'),target:path.join(source,'missing.exe'),icon:raster+',0'},
      {file:path.join(source,'负数索引.lnk'),target:program,icon:custom+',-9999'},
      ...[jpeg,gif,bmp,oversized,wide].map(target=>({file:target+'.lnk',target:program,icon:target+',0'})),
      {file:path.join(source,'环境变量资源.lnk'),target:program,icon:'%SystemRoot%/System32/shell32.dll,0'},
      {file:path.join(source,'相对资源.lnk'),target:program,icon:path.basename(directIcon)+',0'}
    ]
    await shortcuts(shortcutFiles)
    for(const request of shortcutFiles)add(request.file,'shortcut')
    const missing=path.join(source,'deleted.exe');const damaged=path.join(source,'broken.lnk');await writeFile(damaged,'not-a-shortcut')
    add(missing,'missing');add(damaged,'damaged');add(path.parse(source).root,'drive')
    state.Launchers=files.map((item,index)=>({Id:'icon-'+index,Name:path.basename(item.target)||item.kind,Path:item.target}))
    await app.invoke('prototype_workspace_initialize',{state});await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors=[];page.on('pageerror',error=>errors.push(String(error)))
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const pixels=dataUrl=>page.evaluate(async dataUrl=>{const image=new Image();image.src=dataUrl;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);return {width:canvas.width,height:canvas.height,data:[...context.getImageData(0,0,canvas.width,canvas.height).data]}},dataUrl)
    const compare=async(target)=>{
      const expected=await electron.invoke('path:icon',target);const actual=await api('getPathIcon',target)
      assert.equal(actual.isDirectory,expected.isDirectory,target)
      assert.match(expected.dataUrl,/^data:image\/png;base64,/,target)
      assert.match(actual.dataUrl,/^data:image\/png;base64,/,target)
      const reference=await pixels(expected.dataUrl);const native=await pixels(actual.dataUrl)
      assert.equal(native.width,reference.width,target);assert.equal(native.height,reference.height,target)
      let maximum=0
      for(let index=0;index<native.data.length;index+=4){
        const alpha=native.data[index+3]/255;const expectedAlpha=reference.data[index+3]/255
        maximum=Math.max(maximum,Math.abs(native.data[index+3]-reference.data[index+3]))
        for(let channel=0;channel<3;channel++)for(const background of [0,255])maximum=Math.max(maximum,Math.abs(native.data[index+channel]*alpha+background*(1-alpha)-reference.data[index+channel]*expectedAlpha-background*(1-expectedAlpha)))
      }
      differences.push({name:path.basename(target)||target,maximumCompositeChannelDifference:maximum})
      previews.push({name:path.basename(target)||target,expected:expected.dataUrl,actual:actual.dataUrl})
      assert.ok(maximum<=4,'Native pixels differ from Electron: '+target+'; max='+maximum)
      return actual
    }
    await scenario('folders with misleading extensions preserve their real directory icon rather than a volume icon',async()=>{
      const drive=await compare(path.parse(source).root)
      const results=[]
      for(const item of files.filter(item=>item.kind==='directory'))results.push(await compare(item.target))
      for(const result of results){assert.equal(result.isDirectory,true);assert.equal(result.dataUrl,results[0].dataUrl);assert.notEqual(result.dataUrl,drive.dataUrl)}
    })
    await scenario('documents, dotfiles, extensionless files and URL shortcuts match real Electron Shell pixels',async()=>{
      for(const item of files.filter(item=>item.kind==='file'))await compare(item.target)
    })
    await scenario('programs and shortcuts use embedded or custom resources with index and target fallbacks',async()=>{
      for(const item of files.filter(item=>['program','resource','icon','shortcut'].includes(item.kind)))await compare(item.target)
      const customResult=await api('getPathIcon',shortcutFiles[1].file);const rasterResult=await api('getPathIcon',shortcutFiles[4].file)
      const expectedPixels=await pixels('data:image/png;base64,'+png.toString('base64'))
      assert.deepEqual(await pixels(rasterResult.dataUrl),expectedPixels,'Raster custom icons preserve their decoded RGBA pixels')
      const resourcePixels=await pixels(customResult.dataUrl)
      assert.equal(resourcePixels.width,32);assert.equal(resourcePixels.height,32)
      for(let index=0;index<resourcePixels.data.length;index+=4){
        const alpha=expectedPixels.data[index+3]
        assert.equal(resourcePixels.data[index+3],alpha,'ICO transparency must survive native rendering')
        for(let channel=0;channel<3;channel++)assert.ok(Math.abs(resourcePixels.data[index+channel]-expectedPixels.data[index+channel])*alpha/255<=2,'Only Windows premultiplied-alpha rounding may change visible ICO pixels')
      }
    })
    await scenario('invalid, unauthorized, missing and reparse-point inputs fall back without leaking file type',async()=>{
      const secret=path.join(app.root,'private-folder');await mkdir(secret)
      for(const target of [null,42,{},[],true,secret,path.join(source,'not-referenced.txt'),'', 'relative.txt','https://example.com','C:\\file.txt:stream','\\\\?\\C:\\file.txt','bad\0name','x'.repeat(4097)])assert.deepEqual(await api('getPathIcon',target),{},String(target))
      assert.deepEqual(await api('getPathIcon'),{})
      assert.deepEqual(await api('getPathIcon',missing),{})
      const broken=await api('getPathIcon',damaged);assert.equal(broken.isDirectory,false)
      const junction=path.join(source,'redirect');await symlink(secret,junction,'junction')
      try{const baseline=await api('loadWorkspace');await api('saveWorkspace',{...baseline,Launchers:[...baseline.Launchers,{Id:'junction-icon',Name:'junction',Path:junction}]},baseline);assert.deepEqual(await api('getPathIcon',junction),{})}finally{await rmdir(junction)}
      await assert.rejects(app.invoke('system_icon',{target:program}),/not allowed|权限|denied/i)
    })
    await scenario('revoking workspace references blocks cached results and exact picker grants do not authorize siblings',async()=>{
      const baseline=await api('loadWorkspace');await api('saveWorkspace',{...baseline,Launchers:baseline.Launchers.filter(item=>item.Path!==program)},baseline)
      assert.deepEqual(await api('getPathIcon',program),{})
      const selection=path.join(app.root,'selected-only.txt');await writeFile(selection,'selected')
      await page.evaluate(()=>{window.__iconPick=window.dustdesk.pickPath('图标授权选择')})
      await operateDialog(app,'图标授权选择','select',selection)
      assert.equal((await page.evaluate(()=>window.__iconPick)).ok,true)
      assert.match((await api('getPathIcon',selection)).dataUrl,/^data:image\/png;base64,/)
      assert.deepEqual(await api('getPathIcon',path.dirname(selection)),{})
    })
    await scenario('concurrent reads release GDI and USER resources and never execute shortcut arguments',async()=>{
      const marker=path.join(app.root,'must-not-execute.txt')
      const dangerous=path.join(source,'禁止执行.lnk')
      await shortcuts([{file:dangerous,target:program,args:'-e "require(\'fs\').writeFileSync('+JSON.stringify(marker).replaceAll('"','\\"')+',\'executed\')"'}])
      const batch=[]
      for(let index=0;index<64;index++){const target=path.join(source,'leak-'+index+'.txt');await writeFile(target,'');batch.push(target)}
      batch.push(dangerous)
      const baseline=await api('loadWorkspace');await api('saveWorkspace',{...baseline,Launchers:[...baseline.Launchers,...batch.map((target,index)=>({Id:'leak-'+index,Name:'handle check '+index,Path:target}))]},baseline)
      const before=await handles(app.child.pid)
      for(let offset=0;offset<batch.length;offset+=8){const results=await Promise.all(batch.slice(offset,offset+8).map(target=>api('getPathIcon',target)));assert.ok(results.every(result=>result.dataUrl?.startsWith('data:image/png;base64,')))}
      const after=await handles(app.child.pid)
      assert.ok(after.gdi<=before.gdi+4,JSON.stringify({before,after}));assert.ok(after.user<=before.user+4,JSON.stringify({before,after}))
      await assert.rejects(access(marker),{code:'ENOENT'})
      assert.deepEqual(errors,[])
    })
    if(failed)throw Error('Native icon suite failed')
    await mkdir('artifacts/tauri-migration',{recursive:true})
    await page.evaluate(previews=>{
      const gallery=document.createElement('section');gallery.id='native-icon-gallery';gallery.style.cssText='position:absolute;inset:0 auto auto 0;z-index:99999;background:#f6f7f9;color:#172033;width:1000px;padding:24px;font:14px Segoe UI;box-sizing:border-box'
      const title=document.createElement('h2');title.textContent='Windows native icon comparison';gallery.append(title)
      const description=document.createElement('p');description.textContent='Diagnostic fixtures only · Electron reference (left) / Rust (right)';gallery.append(description)
      const grid=document.createElement('div');grid.style.cssText='display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:12px'
      for(const preview of previews){const card=document.createElement('div');card.style.cssText='padding:12px;background:#fff;border:1px solid #d9dee7;border-radius:8px;overflow:hidden';const label=document.createElement('div');label.textContent=preview.name;label.style.cssText='font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:14px';card.append(label);for(const dataUrl of [preview.expected,preview.actual]){const image=document.createElement('img');image.src=dataUrl;image.width=48;image.height=48;image.style.cssText='margin:0 10px 4px 0;object-fit:contain';card.append(image)}grid.append(card)}
      gallery.append(grid);document.body.append(gallery)
    },previews)
    await page.locator('#native-icon-gallery img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())))
    await page.locator('#native-icon-gallery').screenshot({path:'artifacts/tauri-migration/icons-native-comparison.png'})
    await writeFile(reportPath,JSON.stringify({productionReady:false,scope:'isolated-native-path-icons',scenarios,differences,pending:['all-widget-callers','mixed-DPI-icons','remote-shell-extensions','physical-network-drive-disconnect','release-package-assets']},null,2))
  }finally{await app.close()}
})
