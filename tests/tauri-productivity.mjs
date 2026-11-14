import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import ts from 'typescript'

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')
const shared = await import(moduleUrl(await readFile(new URL('../src/shared/productivity.ts', import.meta.url), 'utf8')))
await test('Rust productivity actions match actual Electron IPC and update shared React pages', async suite => {
  const reportPath = 'artifacts/tauri-migration/productivity-native.json'
  await rm(reportPath, { force: true })
  const application = await launchTauri()
  const location = path.join(application.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')
  let failed = false
  const scenario = (name, callback) => suite.test(name, async context => { try { await callback(context) } catch (error) { failed = true; throw error } })
  try {
    const electron = await mainFixture(suite)
    await electron.load()
    const initial = await electron.load()
    await application.invoke('prototype_workspace_initialize', { state: initial })
    await application.invoke('prototype_open_workspace')
    const page = await waitFor(() => application.browser.contexts().flatMap(context => context.pages()).find(target => target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors = []
    page.on('pageerror', error => errors.push(String(error)))
    const load = () => page.evaluate(() => window.dustdesk.loadWorkspace())
    const action = value => page.evaluate(value => window.dustdesk.productivity(value), value)
    const differential = async value => {
      const before = await load()
      await writeFile(path.join(electron.data, 'workspace.json'), JSON.stringify(before))
      const started = Date.now()
      const expectedResult = await electron.invoke('productivity:action', value)
      const actualResult = await action(value)
      const ended = Date.now()
      assert.deepEqual(actualResult, expectedResult, value.type + ' result')
      const expected = await electron.load()
      const actual = await load()
      const stamp = (target, source, key) => {
        const parsed = Date.parse(source[key])
        assert.ok(parsed >= started && parsed <= ended, value.type + ' must generate a real current timestamp: ' + key)
        target[key] = source[key]
      }
      if (actualResult.ok) {
        if (value.type === 'capture') {
          const key = value.kind === 'task' ? 'Todos' : 'Notes'
          const current = actual[key].find(item => item.Id === value.requestId)
          const previous = before[key].find(item => item.Id === value.requestId)
          if (current && !previous) {
            const target = expected[key].find(item => item.Id === value.requestId)
            stamp(target,current,'CreatedAt')
            if (value.kind === 'note') stamp(target,current,'UpdatedAt')
          }
        }
        if (value.type === 'note-edit') stamp(expected.Notes.find(item => item.Id === value.id),actual.Notes.find(item => item.Id === value.id),'UpdatedAt')
        if (value.type === 'focus-start') {
          assert.match(actual.ActiveFocus.Id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
          expected.ActiveFocus.Id = actual.ActiveFocus.Id
          for (const key of ['StartedAt','RunningSince','CheckpointAt']) stamp(expected.ActiveFocus,actual.ActiveFocus,key)
        }
        if (value.type === 'focus-pause') {
          stamp(expected.ActiveFocus,actual.ActiveFocus,'CheckpointAt')
          expected.ActiveFocus.ElapsedSeconds = shared.focusElapsed(before.ActiveFocus,Date.parse(actual.ActiveFocus.CheckpointAt))
        }
        if (value.type === 'focus-resume' && before.ActiveFocus.RunningSince === null) {
          stamp(expected.ActiveFocus,actual.ActiveFocus,'RunningSince')
          stamp(expected.ActiveFocus,actual.ActiveFocus,'CheckpointAt')
        }
        if (value.type === 'focus-finish' && actual.FocusSessions.length > before.FocusSessions.length) {
          const current = actual.FocusSessions.at(-1)
          const target = expected.FocusSessions.at(-1)
          stamp(target,current,'EndedAt')
          target.Seconds = Math.floor(shared.focusElapsed(before.ActiveFocus,Date.parse(current.EndedAt)))
          target.Completed = target.Seconds >= before.ActiveFocus.PlannedSeconds
        }
      }
      assert.deepEqual(actual, expected, value.type + ' complete persisted workspace')
      return actualResult
    }
    await scenario('captures are stable-id idempotent, preserve copied note fields and reject UTF-16 overflow', async () => {
      const source = initial.Notes[0]
      await differential({ type:'capture',kind:'note',title:'  原子便签  ',text:'新正文',requestId:'stable-note',sourceNoteId:source.Id })
      await differential({ type:'capture',kind:'note',title:'重试',text:'重复内容不能覆盖',requestId:'stable-note' })
      await differential({ type:'capture',kind:'task',title:'原子任务',text:'任务备注',requestId:'stable-task' })
      await differential({ type:'capture',kind:'note',title:'😀'.repeat(151),text:'',requestId:'overflow' })
      await differential({ type:'task-complete',id:'stable-task',completed:true })
      await differential({ type:'task-complete',id:'missing',completed:true })
      const beforeNullRequest = await load()
      assert.equal((await action({type:'capture',kind:'task',title:'空请求键不能变成新记录',text:'',requestId:null})).ok,false)
      assert.deepEqual(await load(),beforeNullRequest)
    })
    await scenario('note edit conflicts and deleted notes keep the public error codes and cannot resurrect records', async () => {
      const note = (await load()).Notes.find(item => item.Id === 'stable-note')
      const edit = { type:'note-edit',id:note.Id,title:'并发后标题',text:'并发后正文',previousTitle:note.Title,previousText:note.Text }
      await differential(edit)
      assert.equal((await differential(edit)).code,'NOTE_CONFLICT')
      const baseline = await load()
      await page.evaluate(({ baseline }) => window.dustdesk.saveWorkspace({ ...baseline, Notes:baseline.Notes.filter(item => item.Id !== 'stable-note') },baseline),{ baseline })
      assert.equal((await differential(edit)).code,'NOTE_DELETED')
      await differential({ type:'capture',kind:'note',title:'不能从回收站复活',text:'',requestId:'stable-note' })
    })
    await scenario('shared recycle UI restores full note records and permanent deletion matches Electron', async () => {
      const state = await load()
      const entry = state.RecycleBin.find(item => item.kind === 'note' && item.value.Id === 'stable-note')
      assert.ok(entry)
      await page.getByRole('button',{name:'回收站',exact:true}).click()
      await page.locator('.feature-row').filter({hasText:'并发后标题'}).getByRole('button',{name:'恢复',exact:true}).click()
      await waitFor(async () => (await load()).Notes.some(item => item.Id === 'stable-note'))
      assert.deepEqual((await load()).Notes.find(item => item.Id === 'stable-note'),entry.value)
      await differential({type:'recycle-restore',id:entry.Id})
      const baseline = await load()
      await page.evaluate(baseline => window.dustdesk.saveWorkspace({...baseline,Todos:baseline.Todos.filter(item=>item.Id!=='stable-task')},baseline),baseline)
      const removed = (await load()).RecycleBin.find(item=>item.value.Id==='stable-task')
      await differential({type:'recycle-empty',ids:[removed.Id]})
      assert.ok(!(await load()).RecycleBin.some(item=>item.Id===removed.Id))
    })
    await scenario('organizer rules match Electron validation and stale general saves cannot overwrite backend-owned rules', async () => {
      const before = await load()
      const rule = {Id:'rule',Enabled:true,Match:'extension',Pattern:'*.pdf，docx',CategoryId:before.DesktopCategories[0].Id,Unknown:{keep:true}}
      await differential({type:'rules-save',rules:[rule]})
      await differential({type:'rules-save',rules:[rule,rule]})
      await differential({type:'rules-save',rules:[{...rule,Pattern:'，*.，.'}]})
      await differential({type:'rules-save',rules:[{...rule,CategoryId:'missing'}]})
      await page.evaluate(before=>window.dustdesk.saveWorkspace({...before,OrganizerRules:[]},before),before)
      assert.deepEqual((await load()).OrganizerRules,[rule])
    })
    await scenario('focus actions match IPC semantics and the shared focus page responds to native state', async () => {
      await differential({type:'focus-start',taskId:'missing',projectId:'',minutes:1})
      await differential({type:'focus-start',taskId:'',projectId:'',minutes:.5})
      await differential({type:'focus-start',taskId:'',projectId:'',minutes:1.25})
      await page.getByRole('button',{name:'专注计时',exact:true}).click()
      await page.getByRole('button',{name:'暂停',exact:true}).waitFor()
      const since = Date.now()
      await waitFor(()=>Date.now()-since>1100)
      await differential({type:'focus-pause'})
      await page.getByRole('button',{name:'继续',exact:true}).waitFor()
      await differential({type:'focus-resume'})
      await differential({type:'focus-finish'})
      await page.getByRole('button',{name:'开始专注',exact:true}).waitFor()
      assert.ok((await load()).FocusSessions.at(-1).Seconds>=1)
      await differential({type:'focus-start',taskId:'',projectId:'',minutes:1})
      await differential({type:'focus-cancel'})
    })
    await scenario('an atomic action fails without committing bytes and can be retried after a disk failure', async () => {
      const before = await readFile(location)
      await rm(location+'.bak')
      await mkdir(location+'.bak')
      const request = {type:'capture',kind:'task',title:'失败后重试',text:'',requestId:'retry-after-disk'}
      const failed = await action(request)
      assert.equal(failed.ok,false)
      assert.deepEqual(await readFile(location),before)
      await rmdir(location+'.bak')
      await differential(request)
      await differential(request)
      assert.equal((await load()).Todos.filter(item=>item.Id===request.requestId).length,1)
      await assert.rejects(application.invoke('workspace_productivity',{action:request}),/not allowed|权限/i)
    })
    assert.deepEqual(errors,[])
    assert.equal(failed,false)
    await mkdir('artifacts/tauri-migration',{recursive:true})
    void application.invoke('prototype_quit').catch(()=>{})
    await waitFor(()=>application.child.exitCode!==null)
    assert.equal(application.child.exitCode,0)
    await writeFile(reportPath,JSON.stringify({ok:true,executable:application.executable,scope:'atomic-productivity-and-shared-pages',checks:['actual-Electron-IPC-differential','stable-capture-request-id','UTF16-length-validation','note-conflict-codes','no-deleted-note-resurrection','shared-recycle-page','rules-validation-and-ownership','focus-command-and-shared-page','disk-failure-and-retry','window-role-boundary','normal-quit'],resourceRelinkVerification:'tests/tauri-resources.mjs',pending:['native-focus-notification','full-migration-gates']},null,2))
  } finally { await application.close() }
})
