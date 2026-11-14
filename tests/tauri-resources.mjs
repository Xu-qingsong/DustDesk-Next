import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, rm, rmdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'
import { organizerDialog } from './tauri-organizer-session-support.mjs'

await test('native resource checks and relinks match Electron with cancellation, progress and shared UI', async suite => {
  const reportPath = 'artifacts/tauri-migration/resources-native.json'
  await rm(reportPath,{force:true})
  const requests = []
  const sockets = new Set()
  const server = createServer((request,response) => {
    requests.push({method:request.method,url:request.url})
    if (request.url.startsWith('/hold')) return
    if (request.url === '/redirect-auth') { response.writeHead(302,{location:'http://user:secret@'+request.headers.host+'/ok'}); response.end(); return }
    if (request.url === '/redirect') { response.writeHead(302,{location:'/ok'}); response.end(); return }
    const status = request.url === '/private' ? 401 : request.url === '/missing' ? 404 : request.url === '/fallback' && request.method === 'HEAD' ? 405 : request.url === '/fallback501' && request.method === 'HEAD' ? 501 : 200
    response.writeHead(status); response.end('fixture')
  })
  server.on('connection',socket => { sockets.add(socket);socket.on('close',()=>sockets.delete(socket)) })
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve))
  const origin = 'http://127.0.0.1:'+server.address().port
  let application
  let failed = false
  const completed = []
  const scenario = (name,callback) => suite.test(name,async()=>{try{await callback();completed.push(name)}catch(error){failed=true;throw error}})
  try {
    application = await launchTauri()
    const electron = await mainFixture(suite)
    await electron.load()
    const state = await electron.load()
    const root = path.join(application.root,'user-data','tauri-preview','Workspace')
    const location = path.join(root,'workspace.json')
    const existing = path.join(application.root,'文件.txt')
    const replacement = path.join(application.root,'新的文件.txt')
    await writeFile(existing,'existing')
    await writeFile(replacement,'replacement')
    const category = path.join(root,'DesktopOrganizer','资源_分类')
    await mkdir(category,{recursive:true})
    const categoryFile = path.join(category,'原有文件.txt')
    await writeFile(categoryFile,'managed-original')
    state.Settings.AutomaticBackupEnabled = false
    state.Launchers = [{Id:'available-launcher',Name:'已有启动器',Path:existing},{Id:'missing-launcher',Name:'待修复启动器',Path:path.join(application.root,'missing.exe')}]
    state.Projects = [{Id:'project',Name:'资源项目',ProjectPath:application.root,Phases:[{Id:'phase',Title:'阶段',ProjectPath:existing,Subtasks:[{Id:'subtask',Title:'子任务',FilePath:existing}]}]}]
    state.DesktopCategories = [{Id:'category',Name:'资源:分类',ItemPaths:[categoryFile]}]
    state.LinkGroups = [{Id:'group',Name:'本机链接',Links:['ok','private','missing','fallback','fallback501','redirect'].map(route=>({Id:'link-'+route,Name:route,Url:origin+'/'+route,CreatedAt:'2026-11-09T00:00:00.000Z',UpdatedAt:'2026-11-09T00:00:00.000Z'})).concat({Id:'invalid-link',Name:'非法地址',Url:'javascript:alert(1)',CreatedAt:'2026-11-09T00:00:00.000Z',UpdatedAt:'2026-11-09T00:00:00.000Z'})}]
    state.LinkGroups[0].Links.push({Id:'credential-link',Name:'含凭据链接',Url:origin.replace('http://','http://user:secret@')+'/ok',CreatedAt:'2026-11-09T00:00:00.000Z',UpdatedAt:'2026-11-09T00:00:00.000Z'})
    state.LinkGroups[0].Links.push({Id:'credential-redirect',Name:'凭据重定向',Url:origin+'/redirect-auth',CreatedAt:'2026-11-09T00:00:00.000Z',UpdatedAt:'2026-11-09T00:00:00.000Z'})
    state.UnknownResourceTest = {keep:true}
    await application.invoke('prototype_workspace_initialize',{state})
    await application.invoke('prototype_open_workspace')
    const page = await waitFor(()=>application.browser.contexts().flatMap(context=>context.pages()).find(target=>target.url().includes('tauri.html')))
    await page.locator('.app-shell').waitFor()
    const errors = []
    page.on('pageerror',error=>errors.push(String(error)))
    const api = (method,...args)=>page.evaluate(({method,args})=>window.dustdesk[method](...args),{method,args})
    const save = async mutator => {const before=await api('loadWorkspace');const after=structuredClone(before);mutator(after);await api('saveWorkspace',after,before)}
    await page.evaluate(()=>{window.__resourceProgress=[];window.__resourceUnsubscribe=window.dustdesk.onResourceCheckProgress(value=>window.__resourceProgress.push(value))})
    let resources
    await scenario('all six resource kinds and HTTP outcomes match actual Electron IPC without deleting records',async()=>{
      const before = await api('loadWorkspace')
      await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(before))
      const expected = await electron.invoke('resources:check',{requestId:'electron-differential'})
      resources = await api('checkResources',{requestId:'native-differential'})
      assert.deepEqual(resources,expected)
      assert.equal(resources.find(item=>item.id==='missing-launcher').status,'missing')
      assert.equal(resources.find(item=>item.id==='link-private').detail,'HTTP 401，可能需要登录或受访问限制')
      assert.equal(resources.find(item=>item.id==='link-missing').status,'warning')
      assert.equal(resources.find(item=>item.id==='invalid-link').status,'warning')
      assert.equal(resources.find(item=>item.id==='credential-link').status,'warning')
      assert.equal(resources.find(item=>item.id==='credential-redirect').status,'warning')
      for(const route of ['fallback','fallback501']) assert.ok(requests.some(item=>item.method==='GET'&&item.url==='/'+route))
      assert.deepEqual(await api('loadWorkspace'),before)
      const progress = await page.evaluate(()=>window.__resourceProgress.filter(value=>value.requestId==='native-differential'))
      assert.equal(progress[0].completed,0)
      assert.equal(progress.at(-1).completed,resources.length)
      assert.ok(progress.every((value,index)=>value.completed===index&&value.total===resources.length))
      assert.equal(new Set(progress.slice(1).map(value=>value.item.kind+':'+value.item.id)).size,resources.length)
    })
    await scenario('single recheck validates parent and current target and rejects forged resources and caller roles',async()=>{
      const selected=resources.find(item=>item.kind==='phase')
      assert.deepEqual(await api('checkResources',{requestId:'single',resource:selected}),[selected])
      await assert.rejects(api('checkResources',{requestId:'stale',resource:{...selected,target:replacement}}),/资源已变化/)
      await assert.rejects(api('checkResources',{requestId:'stale-parent',resource:{...selected,parentId:'wrong'}}),/资源已变化/)
      await assert.rejects(api('checkResources',{requestId:''}),/请求无效/)
      await assert.rejects(application.invoke('workspace_resources_check',{request:null}),/not allowed|权限|denied/i)
      await assert.rejects(application.invoke('workspace_resources_cancel',{requestId:'single'}),/not allowed|权限|denied/i)
    })
    await scenario('launcher, project, phase, subtask and link relinks preserve complete Electron state semantics',async()=>{
      for(const kind of ['launcher','project','phase','subtask','link']) {
        const resource=resources.find(item=>item.kind===kind)
        const before=await api('loadWorkspace')
        await writeFile(path.join(electron.data,'workspace.json'),JSON.stringify(before))
        const action={type:'resource-relink',resource,replacement:kind==='link'?origin+'/ok?relinked':replacement}
        const started=Date.now()
        const expected=await electron.invoke('productivity:action',action)
        const actual=await api('productivity',action)
        assert.deepEqual(actual,expected)
        assert.equal(actual.ok,true)
        const expectedState=await electron.load()
        const actualState=await api('loadWorkspace')
        if(kind==='link') {
          const current=actualState.LinkGroups[0].Links.find(item=>item.Id===resource.id)
          assert.ok(Date.parse(current.UpdatedAt)>=started&&Date.parse(current.UpdatedAt)<=Date.now())
          expectedState.LinkGroups[0].Links.find(item=>item.Id===resource.id).UpdatedAt=current.UpdatedAt
        }
        assert.deepEqual(actualState,expectedState)
        const unchanged=await readFile(location)
        assert.equal((await api('productivity',action)).ok,false)
        assert.deepEqual(await readFile(location),unchanged)
      }
    })
    await scenario('relink path failures and blocked disk commits leave current bytes and referenced files unchanged',async()=>{
      const resource=(await api('checkResources',{requestId:'before-disk'})).find(item=>item.id==='missing-launcher')
      const before=await readFile(location)
      assert.equal((await api('productivity',{type:'resource-relink',resource,replacement:path.join(application.root,'nonexistent')})).ok,false)
      assert.equal((await api('productivity',{type:'resource-relink',resource,replacement:'😀'.repeat(2049)})).ok,false)
      assert.deepEqual(await readFile(location),before)
      await rm(location+'.bak',{force:true});await mkdir(location+'.bak')
      try {
        assert.equal((await api('productivity',{type:'resource-relink',resource,replacement})).ok,false)
        assert.deepEqual(await readFile(location),before)
        assert.equal(await readFile(replacement,'utf8'),'replacement')
      } finally {await rmdir(location+'.bak')}
    })
    await scenario('managed organizer relinks reject outside, duplicate case-insensitive ownership and junction escape',async()=>{
      const resource=resources.find(item=>item.kind==='organizer')
      const next=path.join(category,'重新关联.txt')
      await writeFile(next,'managed-new')
      const before=await readFile(location)
      assert.equal((await api('productivity',{type:'resource-relink',resource,replacement})).ok,false)
      const junction=path.join(category,'escape')
      await symlink(application.root,junction,'junction')
      try {assert.equal((await api('productivity',{type:'resource-relink',resource,replacement:path.join(junction,path.basename(existing))})).ok,false)} finally {await rmdir(junction)}
      assert.deepEqual(await readFile(location),before)
      await save(state=>state.DesktopCategories.push({Id:'other',Name:'Other',ItemPaths:[next.toUpperCase()]}))
      assert.match((await api('productivity',{type:'resource-relink',resource,replacement:next})).error,/已被收纳记录关联/)
      await save(state=>{state.DesktopCategories=state.DesktopCategories.filter(item=>item.Id!=='other')})
      assert.equal((await api('productivity',{type:'resource-relink',resource,replacement:next})).ok,true)
      assert.deepEqual((await api('loadWorkspace')).DesktopCategories[0].ItemPaths,[next])
      assert.equal(await readFile(categoryFile,'utf8'),'managed-original')
      assert.equal(await readFile(next,'utf8'),'managed-new')
    })
    await scenario('shared resource page reports issues, edits a missing reference and rechecks the saved target',async()=>{
      await page.getByRole('button',{name:'资源检查',exact:true}).click()
      await page.getByRole('button',{name:'开始检查',exact:true}).click()
      await page.getByRole('button',{name:'开始检查',exact:true}).waitFor()
      const row=page.locator('.feature-row').filter({hasText:'待修复启动器'})
      await row.getByRole('button',{name:'重新关联',exact:true}).click()
      await page.getByRole('textbox',{name:'新的资源地址',exact:true}).fill(replacement)
      await page.getByRole('button',{name:'保存关联',exact:true}).click()
      await waitFor(async()=> (await api('loadWorkspace')).Launchers.find(item=>item.Id==='missing-launcher').Path===replacement)
      await page.getByRole('button',{name:'开始检查',exact:true}).waitFor()
      assert.equal(await row.count(),0)
      await mkdir('artifacts/tauri-migration',{recursive:true})
      await page.screenshot({path:'artifacts/tauri-migration/resources-shared-page.png',fullPage:true})
    })
    let slow
    await scenario('timeouts remain warnings and a slow HTTP request never blocks workspace writes',async()=>{
      await save(state=>state.LinkGroups[0].Links.push({Id:'slow-link',Name:'Slow',Url:origin+'/hold-timeout',CreatedAt:'2026-11-09T00:00:00.000Z',UpdatedAt:'2026-11-09T00:00:00.000Z'}))
      slow={kind:'link',id:'slow-link',parentId:'group',name:'Slow',target:origin+'/hold-timeout',status:'warning',detail:''}
      await page.evaluate(resource=>{window.__resourceTimeout=window.dustdesk.checkResources({requestId:'timeout',resource})},slow)
      await waitFor(()=>requests.some(item=>item.url==='/hold-timeout'))
      const started=Date.now()
      assert.equal((await api('productivity',{type:'capture',kind:'task',title:'检查期间仍可保存',text:'',requestId:'scan-write'})).ok,true)
      assert.ok(Date.now()-started<2000)
      const result=await page.evaluate(()=>window.__resourceTimeout)
      assert.equal(result.length,1)
      assert.equal(result[0].status,'warning')
      assert.match(result[0].detail,/不会自动删除/)
      assert.ok((await api('loadWorkspace')).LinkGroups[0].Links.some(item=>item.Id==='slow-link'))
    })
    await scenario('cancel and replacement scans return promptly, keep partial results and suppress stale progress',async()=>{
      await page.evaluate(resource=>{window.__resourceCancelled=window.dustdesk.checkResources({requestId:'cancel-old',resource})},slow)
      await waitFor(async()=> (await page.evaluate(()=>window.__resourceProgress)).some(value=>value.requestId==='cancel-old'))
      const started=Date.now()
      await api('cancelResourceCheck','cancel-old')
      assert.deepEqual(await page.evaluate(()=>window.__resourceCancelled),[])
      assert.ok(Date.now()-started<1500)
      const after=await page.evaluate(()=>window.__resourceProgress.filter(value=>value.requestId==='cancel-old').length)
      await new Promise(resolve=>setTimeout(resolve,150))
      assert.equal(await page.evaluate(()=>window.__resourceProgress.filter(value=>value.requestId==='cancel-old').length),after)
      await page.evaluate(resource=>{window.__resourceReplaced=window.dustdesk.checkResources({requestId:'replaced',resource})},slow)
      await waitFor(async()=> (await page.evaluate(()=>window.__resourceProgress)).some(value=>value.requestId==='replaced'))
      const selected=(await api('loadWorkspace')).Launchers[0]
      const result=await api('checkResources',{requestId:'replacement',resource:{kind:'launcher',id:selected.Id,name:selected.Name,target:selected.Path,status:'ok',detail:''}})
      assert.equal(result.length,1)
      assert.deepEqual(await page.evaluate(()=>window.__resourceReplaced),[])
      await api('cancelResourceCheck','replaced')
    })
    await scenario('a full scan bounds slow HTTP concurrency to four and never starts queued probes after cancellation',async()=>{
      const original=(await api('loadWorkspace')).LinkGroups[0].Links
      await save(state=>{state.LinkGroups[0].Links=Array.from({length:12},(_,index)=>({Id:'bounded-'+index,Name:'Bounded '+index,Url:origin+'/hold-bounded-'+index,CreatedAt:'2026-11-09T00:00:00.000Z',UpdatedAt:'2026-11-09T00:00:00.000Z'}))})
      await page.evaluate(()=>{window.__resourceBounded=window.dustdesk.checkResources({requestId:'bounded'})})
      await waitFor(()=>requests.filter(item=>item.url.startsWith('/hold-bounded-')).length===4)
      await new Promise(resolve=>setTimeout(resolve,150))
      assert.equal(requests.filter(item=>item.url.startsWith('/hold-bounded-')).length,4)
      await api('cancelResourceCheck','bounded')
      const partial=await page.evaluate(()=>window.__resourceBounded)
      assert.ok(partial.length>0&&partial.every(item=>item.kind!=='link'))
      await new Promise(resolve=>setTimeout(resolve,150))
      assert.equal(requests.filter(item=>item.url.startsWith('/hold-bounded-')).length,4)
      await save(state=>{state.LinkGroups[0].Links=original})
    })
    await scenario('shared cancel control preserves completed records and page unmount cancels outstanding checks',async()=>{
      await page.getByRole('button',{name:'开始检查',exact:true}).click()
      await page.getByRole('button',{name:'取消检查',exact:true}).waitFor()
      await waitFor(async()=> (await page.evaluate(()=>window.__resourceProgress)).some(value=>value.item&&value.item.id!=='slow-link'))
      await page.getByRole('button',{name:'取消检查',exact:true}).click()
      await page.getByRole('button',{name:'开始检查',exact:true}).waitFor()
      await page.getByText('已取消，保留已完成的结果',{exact:true}).waitFor()
      await page.getByText(/已检查 [1-9]\d* 项/).waitFor()
      await page.evaluate(()=>{
        window.__resourceOriginalCheck=window.dustdesk.checkResources
        window.dustdesk.checkResources=request=>{
          window.__resourceUnmountRequest=request.requestId
          window.__resourceUnmountPromise=window.__resourceOriginalCheck(request)
          return window.__resourceUnmountPromise
        }
      })
      await page.getByRole('button',{name:'开始检查',exact:true}).click()
      await page.getByRole('button',{name:'取消检查',exact:true}).waitFor()
      const unmountStarted=Date.now()
      await page.getByRole('button',{name:'概览',exact:true}).click()
      await page.getByPlaceholder('把刚刚想到的事记下来...').waitFor()
      const unmounted=await Promise.race([page.evaluate(()=>window.__resourceUnmountPromise),new Promise((_,reject)=>setTimeout(()=>reject(Error('Page unmount failed to cancel resource scan')),1500))])
      assert.ok(unmounted.every(item=>item.id!=='slow-link'))
      assert.ok(Date.now()-unmountStarted<1500)
      await page.evaluate(()=>{window.dustdesk.checkResources=window.__resourceOriginalCheck})
      assert.equal(application.child.exitCode,null)
    })
    await scenario('successful restore and native quit cancel outstanding scans without waiting for HTTP timeout',async()=>{
      const backup=await api('createBackup');assert.equal(backup.ok,true)
      await page.evaluate(resource=>{window.__resourceRestore=window.dustdesk.checkResources({requestId:'restore-cancel',resource})},slow)
      await waitFor(async()=> (await page.evaluate(()=>window.__resourceProgress)).some(value=>value.requestId==='restore-cancel'))
      const restoreStarted=Date.now()
      assert.equal((await api('restoreBackup',backup.path)).ok,true)
      assert.deepEqual(await page.evaluate(()=>window.__resourceRestore),[])
      assert.ok(Date.now()-restoreStarted<2000)
      await page.evaluate(resource=>{window.__resourceQuit=window.dustdesk.checkResources({requestId:'quit-cancel',resource})},slow)
      await waitFor(async()=> (await page.evaluate(()=>window.__resourceProgress)).some(value=>value.requestId==='quit-cancel'))
      assert.deepEqual(errors,[])
      const quitStarted=Date.now()
      void page.getByRole('button',{name:'保存后退出',exact:true}).click().catch(()=>{})
      const confirmation=await organizerDialog(application)
      assert.equal(confirmation.defaultButton,2)
      assert.deepEqual(await page.evaluate(()=>window.__resourceQuit),[])
      await organizerDialog(application,'keep')
      await waitFor(()=>application.child.exitCode!==null,5000)
      assert.equal(application.child.exitCode,0)
      assert.ok(Date.now()-quitStarted<5000)
    })
    if(failed) throw Error('A native resource scenario failed')
    await writeFile(reportPath,JSON.stringify({productionReady:false,scope:'isolated-native-resources',scenarios:completed,checks:['actual-Electron-IPC-differential','all-six-resource-kinds','HEAD-405-501-fallback','progress-order','stale-reference-guard','role-boundary','relink-disk-failure','organizer-junction-and-ownership','shared-page','HTTP-timeout','cancel-and-replacement','restore-and-quit-cancellation'],pending:['native-path-picker','physical-network-disconnect','full-migration-gates']},null,2))
  } finally {
    await application?.close()
    for(const socket of sockets) socket.destroy()
    await new Promise(resolve=>server.close(resolve))
  }
})
