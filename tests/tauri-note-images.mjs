import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, readdir, rm, rmdir, symlink, open } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { operateDialog } from './tauri-dialog.mjs'

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=','base64')
await test('native note backgrounds match Electron, preserve assets and update the shared editor',async suite=>{
  const reportPath='artifacts/tauri-migration/note-images-native.json'
  await rm(reportPath,{force:true})
  const app=await launchTauri()
  let failed=false
  const scenarios=[]
  const scenario=async(name,callback)=>{await suite.test(name,async()=>{try{await callback();scenarios.push(name)}catch(error){failed=true;throw error}});if(failed)throw Error('Native note-image scenario failed: '+name)}
  try{
    const electron=await mainFixture(suite)
    await electron.load()
    const state=await electron.load()
    state.Settings.AutomaticBackupEnabled=false
    state.Notes[0].UnknownNativeImage={keep:[1,2,3]}
    const id=state.Notes[0].Id
    await app.invoke('prototype_workspace_initialize',{state})
    await app.invoke('prototype_open_workspace')
    const page=await waitFor(()=>app.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors=[]
    page.on('pageerror',error=>errors.push(String(error)))
    const root=path.join(app.root,'user-data','tauri-preview','Workspace')
    const location=path.join(root,'workspace.json')
    const api=(method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const current=async()=> (await api('loadWorkspace')).Notes.find(note=>note.Id===id)
    const files=async()=>{try{return (await readdir(path.join(root,'NoteBackgrounds'))).sort()}catch(error){if(error.code==='ENOENT')return [];throw error}}
    const source=path.join(app.root,'便签源图.PNG')
    await writeFile(source,png)
    const fixtures={png}
    const generated=await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=2;canvas.height=2;const context=canvas.getContext('2d');context.fillStyle='#12a97e';context.fillRect(0,0,2,2);return {jpg:canvas.toDataURL('image/jpeg').split(',')[1],webp:canvas.toDataURL('image/webp').split(',')[1]}})
    fixtures.jpg=Buffer.from(generated.jpg,'base64');fixtures.jpeg=fixtures.jpg;fixtures.webp=Buffer.from(generated.webp,'base64')
    fixtures.gif=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64')
    fixtures.bmp=Buffer.alloc(58);fixtures.bmp.write('BM');fixtures.bmp.writeUInt32LE(58,2);fixtures.bmp.writeUInt32LE(54,10);fixtures.bmp.writeUInt32LE(40,14);fixtures.bmp.writeInt32LE(1,18);fixtures.bmp.writeInt32LE(1,22);fixtures.bmp.writeUInt16LE(1,26);fixtures.bmp.writeUInt16LE(24,28);fixtures.bmp.writeUInt32LE(4,34);fixtures.bmp[54]=120
    const differential=async(method,sourcePath,expected)=>{
      const before=await api('loadWorkspace')
      await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(before))
      const channel=method==='importNoteBackground'?'notes:import-background':'notes:clear-background'
      const started=Date.now()
      const expectedResult=await electron.invoke(channel,id,...(method==='importNoteBackground'?[sourcePath,expected]:[expected]))
      const actual=await api(method,id,...(method==='importNoteBackground'?[sourcePath,expected]:[expected]))
      assert.equal(actual.ok,expectedResult.ok)
      if(!actual.ok){assert.equal(actual.error,expectedResult.error);return actual}
      const expectedState=await electron.load();const actualState=await api('loadWorkspace')
      const expectedNote=expectedState.Notes.find(note=>note.Id===id);const actualNote=actualState.Notes.find(note=>note.Id===id)
      assert.ok(Date.parse(actualNote.UpdatedAt)>=started&&Date.parse(actualNote.UpdatedAt)<=Date.now())
      expectedNote.UpdatedAt=actualNote.UpdatedAt
      if(method==='importNoteBackground'){
        const bytes=await readFile(sourcePath)
        assert.equal(path.dirname(actual.path),path.join(root,'NoteBackgrounds'))
        assert.equal(path.dirname(expectedResult.path),path.join(electron.data,'NoteBackgrounds'))
        assert.deepEqual(await readFile(actual.path),bytes)
        assert.deepEqual(await readFile(expectedResult.path),bytes)
        assert.equal(actual.dataUrl,expectedResult.dataUrl)
        assert.match(actual.fileName,/^note-[0-9a-f-]+\.(png|jpe?g|webp|gif|bmp)$/)
        expectedNote.BackgroundImagePath=actualNote.BackgroundImagePath
        expectedNote.BackgroundImageFileName=actualNote.BackgroundImageFileName
      }
      assert.deepEqual(actualState,expectedState)
      return actual
    }
    await scenario('managed image destination junctions never publish metadata or write outside the workspace',async()=>{
      const destination=path.join(root,'NoteBackgrounds')
      const outside=path.join(app.root,'outside-backgrounds');await mkdir(outside)
      await symlink(outside,destination,'junction')
      const before=await readFile(location)
      try{
        assert.equal((await api('importNoteBackground',id,source,null)).ok,false)
        assert.deepEqual(await readFile(location),before)
        assert.deepEqual(await readdir(outside),[])
        assert.deepEqual(await readFile(source),png)
      }finally{await rmdir(destination)}
    })
    await scenario('all six legacy image extensions copy original bytes and match actual Electron import and clear IPC',async()=>{
      for(const [extension,bytes] of Object.entries(fixtures)){
        const file=path.join(app.root,'image.'+extension)
        await writeFile(file,bytes)
        const note=await current()
        const imported=await differential('importNoteBackground',file,note.BackgroundImagePath||null)
        assert.equal(imported.ok,true)
        const decoded=await page.evaluate(async dataUrl=>{const image=new Image();image.src=dataUrl;await image.decode();return [image.naturalWidth,image.naturalHeight]},imported.dataUrl)
        assert.deepEqual(decoded,['jpg','jpeg','webp'].includes(extension)?[2,2]:[1,1])
        assert.deepEqual(await readFile(file),bytes)
        assert.equal((await api('readImageFile',imported.path)).dataUrl,imported.dataUrl)
        const cleared=await differential('clearNoteBackground',null,imported.path)
        assert.equal(cleared.ok,true)
        assert.deepEqual(await readFile(imported.path),bytes)
        assert.equal((await api('readImageFile',imported.path)).ok,false)
        assert.equal(JSON.parse(await readFile(location+'.bak','utf8')).Notes.find(note=>note.Id===id).BackgroundImagePath,imported.path)
      }
    })
    await scenario('stale expected backgrounds and deleted IDs never add files or change workspace bytes',async()=>{
      const first=await api('importNoteBackground',id,source,null);assert.equal(first.ok,true)
      const before=await readFile(location);const original=await files()
      await differential('importNoteBackground',source,null)
      await differential('clearNoteBackground',null,null)
      assert.equal((await api('importNoteBackground','deleted-note',source,null)).ok,false)
      assert.equal((await api('clearNoteBackground','deleted-note',null)).ok,false)
      assert.deepEqual(await readFile(location),before)
      assert.deepEqual(await files(),original)
      assert.equal((await api('importNoteBackground',id,source)).ok,true)
    })
    await scenario('invalid, empty, oversized, directory and reparse-point sources preserve originals',async()=>{
      const invalid=path.join(app.root,'invalid.svg');await writeFile(invalid,'<svg/>')
      const empty=path.join(app.root,'empty.png');await writeFile(empty,'')
      const large=path.join(app.root,'large.png');const handle=await open(large,'w');await handle.truncate(12*1024*1024+1);await handle.close()
      const directory=path.join(app.root,'directory.png');await mkdir(directory)
      const junction=path.join(app.root,'source-junction');await symlink(app.root,junction,'junction')
      const before=await readFile(location);const original=await files()
      try{
        for(const file of [invalid,empty,large,directory,path.join(junction,path.basename(source)),source+'\0.png']) assert.equal((await api('importNoteBackground',id,file)).ok,false,file)
      }finally{await rmdir(junction)}
      assert.deepEqual(await readFile(location),before);assert.deepEqual(await files(),original)
      assert.deepEqual(await readFile(source),png)
    })
    await scenario('metadata failures roll back only staged assets and never clear the current image',async()=>{
      const before=await readFile(location);const original=await files();const note=await current()
      await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      try{
        assert.equal((await api('importNoteBackground',id,source,note.BackgroundImagePath)).ok,false)
        assert.equal((await api('clearNoteBackground',id,note.BackgroundImagePath)).ok,false)
        assert.deepEqual(await files(),original);assert.deepEqual(await readFile(location),before)
        assert.deepEqual(await readFile(note.BackgroundImagePath),png)
      }finally{await rmdir(location+'.bak')}
      assert.equal((await api('importNoteBackground',id,source,note.BackgroundImagePath)).ok,true)
    })
    await scenario('shared note editor imports a typed path, decodes its preview and preserves text edits on clear',async()=>{
      await page.getByRole('button',{name:'便签',exact:true}).click()
      await page.locator('.note-text').fill('背景导入不覆盖正文')
      await waitFor(async()=>(await current()).Text==='背景导入不覆盖正文')
      await page.getByRole('textbox',{name:'背景图片路径',exact:true}).fill(source)
      await page.getByRole('button',{name:'导入背景',exact:true}).click()
      await waitFor(async()=>await page.locator('.note-background-preview').evaluate(image=>image.complete&&image.naturalWidth===1).catch(()=>false))
      await page.getByRole('button',{name:'清除背景',exact:true}).click()
      await waitFor(async()=>!(await current()).BackgroundImagePath)
      assert.equal(await page.locator('.note-background-preview').count(),0)
      assert.equal((await current()).Text,'背景导入不覆盖正文')
    })
    const dialog=(action='snapshot',target)=>operateDialog(app,'选择便签背景图片',action,target)
    const begin=async()=>{const note=await current();await page.evaluate(({id,expected})=>{window.__notePick=window.dustdesk.pickNoteBackground(id,expected)}, {id,expected:note.BackgroundImagePath||null});return JSON.parse(await dialog())}
    await scenario('native image picker filters files, returns cancellation and shares the one-dialog policy',async()=>{
      const controls=await begin()
      assert.ok(!controls.some(control=>control.name==='选择当前文件夹'))
      assert.equal((await api('pickFolder','已有图片窗口')).ok,false)
      await dialog('cancel')
      assert.deepEqual(await page.evaluate(()=>window.__notePick),{ok:false,canceled:true})
      await assert.rejects(app.invoke('workspace_note_import',{noteId:id,source,expectedPath:null,checkExpected:false}),/not allowed|权限|denied/i)
      await assert.rejects(app.invoke('workspace_note_clear',{noteId:id,expectedPath:null,checkExpected:false}),/not allowed|权限|denied/i)
      await assert.rejects(app.invoke('workspace_note_pick',{noteId:id,expectedPath:null,checkExpected:false}),/not allowed|权限|denied/i)
    })
    await scenario('background changed while a native dialog is open cannot be overwritten by its late selection',async()=>{
      await begin()
      const imported=await api('importNoteBackground',id,source,null);assert.equal(imported.ok,true)
      const before=await readFile(location);const original=await files()
      await dialog('select',source)
      const late=await page.evaluate(()=>window.__notePick)
      assert.equal(late.ok,false);assert.match(late.error,/其他窗口/)
      assert.deepEqual(await readFile(location),before);assert.deepEqual(await files(),original)
    })
    await scenario('shared choose-background button commits native selection and reloads the actual managed image',async()=>{
      await page.getByRole('button',{name:'选择背景图',exact:true}).click()
      await dialog('select',source)
      await waitFor(async()=>await page.locator('.note-background-preview').evaluate(image=>image.complete&&image.naturalWidth===1).catch(()=>false))
      const selected=await current();assert.equal(selected.Text,'背景导入不覆盖正文')
      await page.reload();await page.locator('.app-shell').waitFor()
      await page.getByRole('button',{name:'便签',exact:true}).click()
      await waitFor(async()=>await page.locator('.note-background-preview').evaluate(image=>image.complete&&image.naturalWidth===1).catch(()=>false))
      assert.equal((await current()).BackgroundImagePath,selected.BackgroundImagePath)
      await mkdir('artifacts/tauri-migration',{recursive:true})
      await page.screenshot({path:'artifacts/tauri-migration/note-background-shared.png',fullPage:true})
    })
    await scenario('backup restore carries the imported bytes and recycles never lose their shared backgrounds',async()=>{
      const baseline=await api('loadWorkspace');const note=baseline.Notes.find(note=>note.Id===id)
      const shared={...note,Id:'recycled-image-note'}
      await api('saveWorkspace',{...baseline,Notes:[...baseline.Notes,shared]},baseline)
      const withShared=await api('loadWorkspace')
      await api('saveWorkspace',{...withShared,Notes:withShared.Notes.filter(note=>note.Id!==shared.Id)},withShared)
      assert.ok((await api('loadWorkspace')).RecycleBin.some(entry=>entry.kind==='note'&&entry.value.Id===shared.Id&&entry.value.BackgroundImagePath===note.BackgroundImagePath))
      const backup=await api('createBackup');assert.equal(backup.ok,true)
      assert.equal((await api('clearNoteBackground',id,note.BackgroundImagePath)).ok,true)
      assert.deepEqual(await readFile(note.BackgroundImagePath),png)
      assert.equal((await api('readImageFile',note.BackgroundImagePath)).ok,true)
      assert.equal((await api('restoreBackup',backup.path)).ok,true)
      const restored=await current();assert.notEqual(restored.BackgroundImagePath,note.BackgroundImagePath)
      assert.deepEqual(await readFile(restored.BackgroundImagePath),png)
    })
    await scenario('restore and native quit cancel pending image pickers before draining tracked writes',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true)
      await begin()
      assert.equal((await api('restoreBackup',backup.path)).ok,true)
      assert.deepEqual(await page.evaluate(()=>window.__notePick),{ok:false,canceled:true})
      await begin()
      assert.deepEqual(errors,[])
      void page.evaluate(()=>window.__TAURI_INTERNALS__.invoke('application_quit')).catch(()=>{})
      await waitFor(()=>app.child.exitCode!==null,8000)
      assert.equal(app.child.exitCode,0)
    })
    if(failed)throw Error('Native image scenario failed')
    await writeFile(reportPath,JSON.stringify({productionReady:false,scope:'isolated-note-backgrounds',scenarios,pending:['native-file-drop','physical-IME-in-picker','network-drive-disconnect','all-widget-callers','full-migration-gates']},null,2))
  }finally{await app.close()}
})
