import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, readdir, rm, rmdir, symlink } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l1sAAAAASUVORK5CYII=', 'base64')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
await test('native backup compatibility, shared UI, transactional failure and explicit startup recovery', async suite => {
  const reportPath = 'artifacts/tauri-migration/backup-native.json'
  await rm(reportPath, { force: true })
  const application = await launchTauri()
  const root = path.join(application.root, 'user-data', 'tauri-preview', 'Workspace')
  const location = path.join(root, 'workspace.json')
  const directory = path.join(root, 'Backups')
  let failed = false
  const completed = []
  const scenario = (name, callback) => suite.test(name, async () => {
    try { await callback(); completed.push(name) }
    catch (error) {
      failed = true
      const diagnostics = { name, error: String(error), output: application.output(), disk: await readFile(location, 'utf8').catch(String), pages: await Promise.all(application.browser.contexts().flatMap(context => context.pages()).map(async page => ({ url: page.url(), body: (await page.locator('body').innerText().catch(String)).slice(0, 16384), input: await page.locator('.quick-note').inputValue().catch(() => null), inert: await page.evaluate(() => document.documentElement.inert).catch(() => null) }))) }
      await mkdir('artifacts/tauri-migration', { recursive: true }); await writeFile('artifacts/tauri-migration/backup-failure-' + Date.now() + '.json', JSON.stringify(diagnostics, null, 2))
      throw error
    }
  })
  try {
    const electron = await mainFixture(suite)
    await electron.load()
    const initial = await electron.load()
    initial.Settings.AutomaticBackupEnabled = true
    initial.UnknownBackupCompatibility = { text:'保留未知字段', nested:[1,2,3] }
    await mkdir(path.join(root, 'NoteBackgrounds'), { recursive:true })
    initial.Notes[0].BackgroundImagePath = path.join(root, 'NoteBackgrounds', 'original.png')
    initial.Notes[0].BackgroundImageFileName = 'original.png'
    await writeFile(initial.Notes[0].BackgroundImagePath, png)
    initial.RecycleBin = [{ Id:'deleted-entry', kind:'note', DeletedAt:'2026-11-01T00:00:00Z', ExpiresAt:'2099-01-01T00:00:00Z', value:{ ...initial.Notes[0], Id:'deleted-note', Title:'回收站背景', BackgroundImagePath:path.join(root,'NoteBackgrounds','deleted.png'), BackgroundImageFileName:'deleted.png' } }]
    await writeFile(initial.RecycleBin[0].value.BackgroundImagePath, png)
    initial.ClipboardHistory = [{Id:'clipboard-image',Kind:'Image',Text:'',ImagePngBase64:png.toString('base64'),ImageFileName:'clip.png',CreatedAt:'2026-11-09T00:00:00Z'}]
    await application.invoke('prototype_workspace_initialize', { state:initial })
    await application.invoke('prototype_open_workspace')
    const page = await waitFor(() => application.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    const api = (method, ...args) => page.evaluate(({ method, args }) => window.dustdesk[method](...args), {method,args})
    const canonical = async (state, managedRoot) => {
      const copy = structuredClone(state)
      const notes = [...copy.Notes,...copy.RecycleBin.filter(item => item.kind === 'note').map(item => item.value)]
      for (const note of notes) {
        if (!note.BackgroundImagePath) continue
        assert.equal(path.dirname(note.BackgroundImagePath),path.join(managedRoot,'NoteBackgrounds'))
        assert.deepEqual(await readFile(note.BackgroundImagePath),png)
        note.BackgroundImagePath = '<managed-image>'
        note.BackgroundImageFileName = '<managed-image>'
      }
      for (const item of copy.ClipboardHistory) if (item.Kind === 'Image') {
        const bytes = item.ImagePngBase64 ? Buffer.from(item.ImagePngBase64,'base64') : await readFile(path.join(managedRoot,'ClipboardImages',item.ImageAssetName))
        assert.deepEqual(bytes,png)
        item.ImagePngBase64 = '<image-bytes>'
        delete item.ImageAssetName
      }
      return copy
    }
    let originalBackup
    let electronBackup
    await scenario('native maintenance creates a portable daily backup and reports its timestamp', async () => {
      const automatic = await waitFor(async () => (await api('listBackups')).find(entry => entry.name.startsWith('auto-')),15000)
      assert.equal(JSON.parse(await readFile(automatic.path,'utf8')).ClipboardHistory[0].ImagePngBase64,png.toString('base64'))
      assert.ok(Date.parse((await api('backupStatus')).lastAutomaticBackupAt) > 0)
      const current = await api('loadWorkspace')
      await api('saveWorkspace',{...current,Settings:{...current.Settings,AutomaticBackupEnabled:false}},current)
    })
    await scenario('Rust JSON is self-contained and Electron IPC restores its exact substantive records and assets', async () => {
      const result = await api('createBackup')
      assert.equal(result.ok,true)
      originalBackup = result.path
      const bytes = await readFile(originalBackup)
      const portable = JSON.parse(bytes)
      assert.equal(Object.keys(portable.BackupNoteAssets).length,2)
      assert.equal(portable.ClipboardHistory[0].ImagePngBase64,png.toString('base64'))
      const preview = await api('previewBackup',originalBackup)
      assert.equal(preview.fingerprint,digest(bytes))
      await mkdir(path.join(electron.data,'Backups'),{ recursive:true })
      const target = path.join(electron.data,'Backups','from-rust.json')
      await writeFile(target,bytes)
      const expectedPreview = await electron.invoke('maintenance:preview',target)
      assert.deepEqual({...expectedPreview,path:preview.path,modifiedAt:preview.modifiedAt},preview)
      assert.equal((await electron.invoke('maintenance:restore',target,expectedPreview.fingerprint)).ok,true)
      assert.deepEqual(await canonical(await electron.load(),electron.data),await canonical(await api('loadWorkspace'),root))
    })
    await scenario('Electron JSON restores into Rust with live and recycled paths remapped and real image decoding', async () => {
      const result = await electron.invoke('maintenance:backup')
      assert.equal(result.ok,true)
      electronBackup = path.join(directory,'from-electron.json')
      await writeFile(electronBackup,await readFile(result.path))
      const preview = await api('previewBackup',electronBackup)
      assert.equal((await api('restoreBackup',electronBackup,preview.fingerprint)).ok,true)
      const current = await api('loadWorkspace')
      assert.deepEqual(await canonical(current,root),await canonical(await electron.load(),electron.data))
      const image = await api('readImageFile',current.Notes[0].BackgroundImagePath)
      assert.equal(image.ok,true)
      assert.deepEqual(Buffer.from(image.dataUrl.split(',')[1],'base64'),png)
      assert.deepEqual(await page.evaluate(async dataUrl => { const image = new Image(); image.src=dataUrl; await image.decode(); return [image.naturalWidth,image.naturalHeight] },image.dataUrl),[1,1])
      const arbitrary = path.join(root,'NoteBackgrounds','unreferenced.png')
      await writeFile(arbitrary,png)
      assert.equal((await api('readImageFile',arbitrary)).ok,false)
      for (const command of ['workspace_backup_create','workspace_backup_list','workspace_backup_status','workspace_backup_restore']) await assert.rejects(application.invoke(command,{path:originalBackup,fingerprint:null}),/not allowed|权限|调用|窗口|denied/i)
    })
    await scenario('shared Settings creates, previews, confirms and broadcasts a real restore', async () => {
      await page.getByRole('button',{name:'设置',exact:true}).click()
      const before = new Set((await api('listBackups')).map(entry => entry.path))
      await page.getByRole('button',{name:'创建备份',exact:true}).click()
      const created = await waitFor(async () => (await api('listBackups')).find(entry => !before.has(entry.path)))
      const baseline = await api('loadWorkspace')
      await api('saveWorkspace',{...baseline,QuickNote:'必须由恢复替换'},baseline)
      await page.getByRole('button',{name:'刷新备份',exact:true}).click()
      await page.locator('.backup-row').first().getByRole('button',{name:'预览恢复',exact:true}).click()
      const region = page.getByRole('region',{name:'恢复预览',exact:true})
      await region.waitFor()
      await region.getByRole('button',{name:'确认',exact:true}).click()
      await waitFor(async () => (await api('loadWorkspace')).QuickNote === baseline.QuickNote)
      assert.equal((await api('previewBackup',created.path)).fingerprint,digest(await readFile(created.path)))
      assert.equal(await region.count(),0)
    })
    await scenario('pending debounced edits reach protection before restore, not the newly restored workspace', async () => {
      await page.getByRole('button',{name:'概览',exact:true}).click()
      const expected = JSON.parse(await readFile(originalBackup,'utf8')).QuickNote
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('恢复前待保存草稿')
      const preview = await api('previewBackup',originalBackup)
      assert.equal((await api('restoreBackup',originalBackup,preview.fingerprint)).ok,true)
      await waitFor(async () => await page.getByPlaceholder('把刚刚想到的事记下来...').inputValue() === expected)
      const protections = (await api('listBackups')).filter(entry => entry.name.startsWith('before-restore-'))
      assert.ok((await Promise.all(protections.map(async entry => JSON.parse(await readFile(entry.path,'utf8'))))).some(state => state.QuickNote === '恢复前待保存草稿'))
      await new Promise(resolve => setTimeout(resolve,700))
      assert.equal(JSON.parse(await readFile(location,'utf8')).QuickNote,expected)
    })
    await scenario('changed fingerprints, blocked metadata and failed flushes preserve data and resume editing', async () => {
      const candidate = path.join(directory,'changed.json')
      await writeFile(candidate,await readFile(originalBackup))
      const preview = await api('previewBackup',candidate)
      await writeFile(candidate,(await readFile(candidate,'utf8'))+' ')
      const before = await readFile(location)
      assert.equal((await api('restoreBackup',candidate,preview.fingerprint)).ok,false)
      assert.deepEqual(await readFile(location),before)
      const noteFiles = (await readdir(path.join(root,'NoteBackgrounds'))).sort()
      const clipboardFiles = (await readdir(path.join(root,'ClipboardImages'))).sort()
      await rm(location+'.bak',{force:true})
      await mkdir(location+'.bak')
      try {
        assert.equal((await api('restoreBackup',originalBackup)).ok,false)
        assert.deepEqual(await readFile(location),before)
        assert.deepEqual((await readdir(path.join(root,'NoteBackgrounds'))).sort(),noteFiles)
        assert.deepEqual((await readdir(path.join(root,'ClipboardImages'))).sort(),clipboardFiles)
      } finally { await rmdir(location+'.bak') }
      await page.evaluate(() => { window.__backupStop = window.dustdesk.onBeforeQuit(async () => { throw Error('test retained draft') }) })
      const outcome = await api('restoreBackup',originalBackup)
      assert.equal(outcome.ok,false)
      assert.match(outcome.error,/retained draft/)
      await page.evaluate(() => window.__backupStop())
      assert.equal(await page.evaluate(() => document.documentElement.inert),false)
      assert.deepEqual(await readFile(location),before)
      await page.getByPlaceholder('把刚刚想到的事记下来...').fill('失败恢复后继续保存')
      await waitFor(async () => JSON.parse(await readFile(location,'utf8')).QuickNote === '失败恢复后继续保存')
    })
    await scenario('backup junction escape and raw outside paths are rejected without changing external files', async () => {
      const outside = path.join(application.root,'outside')
      await mkdir(outside)
      const target = path.join(outside,'external.json')
      await writeFile(target,await readFile(originalBackup))
      const before = await readFile(target)
      const junction = path.join(directory,'escape')
      await symlink(outside,junction,'junction')
      try {
        await assert.rejects(api('previewBackup',path.join(junction,'external.json')),/重解析|链接|目录|路径/i)
        await assert.rejects(api('previewBackup',target),/目录|路径/i)
        assert.equal((await api('restoreBackup',path.join(junction,'external.json'))).ok,false)
        assert.deepEqual(await readFile(target),before)
      } finally { await rmdir(junction) }
    })
    await scenario('concurrent native quit waits for a failed restore flush without deadlock or losing drafts', async () => {
      const before = await readFile(location)
      await page.evaluate(target => {
        window.__backupConcurrentStop = window.dustdesk.onBeforeQuit(async () => {
          window.__backupFlushStarted = true
          await new Promise(resolve => { window.__backupReleaseFlush = resolve })
          throw Error('concurrent restore retained draft')
        })
        window.__backupConcurrent = window.dustdesk.restoreBackup(target)
      },originalBackup)
      await waitFor(() => page.evaluate(() => window.__backupFlushStarted))
      await page.evaluate(() => { window.__backupConcurrentQuit = window.__TAURI_INTERNALS__.invoke('application_quit').then(() => ({ok:true}),error => ({ok:false,error:String(error)})) })
      await new Promise(resolve => setTimeout(resolve,100))
      await page.evaluate(() => {window.__backupConcurrentStop(); window.__backupReleaseFlush()})
      const results = await page.evaluate(() => Promise.all([window.__backupConcurrent,window.__backupConcurrentQuit]))
      assert.ok(results.every(result => result.ok === false && /retained draft/.test(result.error)))
      await waitFor(() => page.evaluate(() => !document.documentElement.inert))
      assert.equal(application.child.exitCode,null)
      assert.deepEqual(await readFile(location),before)
    })
    await scenario('corrupt startup never mounts default App and offers previewed explicit recovery with raw protection', async () => {
      await writeFile(location,'{corrupt-main')
      await writeFile(location+'.bak','{corrupt-fallback')
      await page.reload()
      await page.locator('.tauri-workspace-start').waitFor()
      await page.getByRole('alert').first().waitFor()
      assert.equal(await page.locator('.app-shell').count(),0)
      await page.getByRole('button',{name:'从已有备份恢复',exact:true}).click()
      const recovery = page.getByTestId('tauri-backup-recovery')
      const row = recovery.locator('.backup-row').filter({hasText:path.basename(originalBackup)})
      await row.getByRole('button',{name:'预览恢复',exact:true}).click()
      const region = page.getByRole('region',{name:'启动恢复预览',exact:true})
      await region.waitFor()
      await page.screenshot({path:'artifacts/tauri-migration/backup-recovery.png',fullPage:true})
      await region.getByRole('button',{name:'确认恢复工作区',exact:true}).click()
      await page.locator('.app-shell').waitFor()
      const protectedFiles = (await api('listBackups')).filter(entry => entry.name.startsWith('before-restore-damaged-'))
      const protectedBytes = await Promise.all(protectedFiles.map(entry => readFile(entry.path,'utf8')))
      assert.ok(protectedBytes.includes('{corrupt-main'))
      assert.ok(protectedBytes.includes('{corrupt-fallback'))
      assert.deepEqual(await canonical(await api('loadWorkspace'),root),await canonical(JSON.parse(await readFile(originalBackup,'utf8')),root).then(state => {delete state.BackupNoteAssets;delete state.BackupWarnings;return state}))
    })
    assert.deepEqual(errors,[])
    if (failed) throw Error('A native backup scenario failed')
    await mkdir('artifacts/tauri-migration',{recursive:true})
    await page.screenshot({path:'artifacts/tauri-migration/backup-shared-app.png',fullPage:true})
    await writeFile(reportPath,JSON.stringify({productionReady:false,scope:'isolated-managed-backups',scenarios:completed,limits:{maximumBackupBytes:64*1024*1024,externalImagePicker:false,productionHandoff:false},hardwareGatesSatisfied:false},null,2))
  } finally { await application.close() }
})
