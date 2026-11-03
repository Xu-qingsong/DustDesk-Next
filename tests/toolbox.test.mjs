import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import dgram from 'node:dgram'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { toolboxModules } from './toolbox-fixture.mjs'
import { readZip } from './zip-files.mjs'

async function waitForTransfer(service, id) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const task = service.snapshot().tasks.find(task => task.id === id)
    if (task && !['preparing', 'waiting', 'transferring'].includes(task.status)) return task
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw Error('Transfer did not settle: ' + JSON.stringify(service.snapshot()))
}
async function sendAndWait(service, ...args) {
  const previous = new Set(service.snapshot().tasks.map(task => task.id))
  await service.send(...args)
  const task = service.snapshot().tasks.find(task => !previous.has(task.id))
  assert.ok(task, 'Submission must create a task')
  return waitForTransfer(service, task.id)
}
async function resumeAndWait(service, id) {
  await service.control(id, 'resume')
  return waitForTransfer(service, id)
}

test('text tools preserve Unicode, report invalid inputs and generate reversible line changes', async t => {
  const { text } = await toolboxModules(t), run = text.processText
  const input = '中文 😀\nCafé'
  assert.equal(run({ tool:'base64Decode', input: run({ tool:'base64Encode', input }).text }).text, input)
  assert.equal(run({ tool:'urlDecode', input: run({ tool:'urlEncode', input }).text }).text, input)
  assert.throws(() => run({ tool:'base64Decode', input:'a?' }), /无效/)
  assert.throws(() => run({ tool:'base64Decode', input:'/w==' }), /UTF-8/)
  assert.throws(() => run({ tool:'urlDecode', input:'%XX' }), /无效/)
  assert.throws(() => run({ tool:'json', input:'{"x":' }), /JSON 错误/)
  assert.throws(() => run({ tool:'regex', input, pattern:'[' }), /regular expression/i)
  assert.deepEqual(JSON.parse(run({ tool:'regex',input:'a12b34',pattern:'(?<n>\\d+)',flags:'g' }).text).map(m => m.named.n), ['12','34'])
  assert.equal(run({ tool:'dedupe',input:'b\na\nb\n \na',trim:true,ignoreEmpty:true }).text,'b\na')
  assert.equal(run({ tool:'sort',input:'文件10\n文件2' }).text,'文件2\n文件10')
  assert.match(run({ tool:'stats',input:'😀' }).text,/码点）：1/)
  for (const [left,right] of [['a\nb','a\nc'],['','x'],['x',''],['a\nb\na','b\na\nc'],['相同','相同']]) {
    const diff = run({ tool:'diff',input:left,second:right }).diff
    assert.equal(diff.filter(r=>r.kind!=='add').map(r=>r.text).join('\n'),left)
    assert.equal(diff.filter(r=>r.kind!=='remove').map(r=>r.text).join('\n'),right)
  }
  assert.throws(() => run({ tool:'stats',input:'a'.repeat(10 * 1024 * 1024 + 1) }),/10 MiB/)
})

test('image import rejects animation and oversized dimensions; export never replaces original or conflicting names', async t => {
  const { image, assets, root } = await toolboxModules(t)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABoIJXOQAAAABJRU5ErkJggg==','base64')
  assert.equal(image.inspectToolImage(png).width,1)
  const huge = Buffer.from(png); huge.writeUInt32BE(64000001,16); assert.throws(()=>image.inspectToolImage(huge),/6400/)
  const animated = Buffer.concat([png.subarray(0,33),Buffer.from([0,0,0,0,97,99,84,76,0,0,0,0]),png.subarray(33)])
  assert.throws(()=>image.inspectToolImage(animated),/动画/)
  assert.throws(()=>image.inspectToolImage(Buffer.from('broken')),/静态/)
  const defaults = { resize:'dimensions',width:100,height:100,fit:'contain',upscale:false }
  assert.deepEqual(image.imageLayout(200,100,defaults),{width:100,height:50,x:0,y:0,drawWidth:100,drawHeight:50})
  const manager = assets.createToolAssets(), source = path.join(root,'源图.png'); await fs.writeFile(source,png)
  const [asset] = await manager.registerPaths([source],'image')
  assert.deepEqual(Buffer.from(await manager.readAsset(asset.id)),png)
  await assert.rejects(manager.readAsset(source),/授权/)
  const batch = await manager.beginBatch(path.join(root, 'images.zip'), 2)
  const first = await manager.exportImage(batch.id,'源图-处理后.png',png), second = await manager.exportImage(batch.id,'源图-处理后.png',png)
  assert.notEqual(first,second); assert.deepEqual(await fs.readFile(source),png)
  const output = await manager.endBatch(batch.id)
  const files = await readZip(output.path)
  assert.deepEqual([...files.keys()], ['源图-处理后.png', '源图-处理后-1.png'])
  for (const bytes of files.values()) assert.deepEqual(bytes, png)
  assert.equal((await fs.readdir(root)).some(n=>n.startsWith('.dustdesk-images-')), false)
  await assert.rejects(manager.exportImage(batch.id,'x.png',png),/结束/)
})

test('transfer manifests reject traversal, device names and conflicting case-insensitive paths', async t => {
  const { lan } = await toolboxModules(t)
  const base = { id:'task',name:'test',entries:[],directories:[] }
  for (const relative of ['../x','/x','C:/x','a\\b','CON.txt','x.','a/b/../../x']) assert.throws(()=>lan.validateManifest({...base,directories:[relative]}),/路径/)
  assert.throws(()=>lan.validateManifest({...base,directories:['a','A']}),/重复/)
  assert.throws(()=>lan.validateManifest({...base,entries:[{relative:'a',size:0,mtime:0,hash:'0'.repeat(64)}],directories:['a/b']}),/冲突/)
  assert.equal(lan.pairingCode('a','b'),lan.pairingCode('b','a'))
})

test('two encrypted LAN endpoints transfer files, empty folders and text without copying to clipboard', {timeout:30000}, async t => {
  const { lan, root } = await toolboxModules(t), source = path.join(root,'source'), downloads = path.join(root,'received')
  await fs.mkdir(path.join(source,'空目录'),{recursive:true}); await fs.writeFile(path.join(source,'中文.txt'),'你好 😀'); await fs.writeFile(path.join(source,'empty'),Buffer.alloc(0))
  let confirms = 0, pairs = 0
  const options = name => ({storage:path.join(root,name),downloads,name,host:'127.0.0.1',discovery:false,changed:()=>{},confirmPair:async()=>{pairs++;return true},confirmReceive:async()=>{confirms++;return downloads}})
  const a = lan.createLanService(options('a')), b = lan.createLanService(options('b'))
  t.after(async()=>{await a.dispose();await b.dispose()})
  await a.enable(true); await b.enable(true)
  const peer = await a.connect('127.0.0.1',b.snapshot().port)
  await sendAndWait(a,peer.id,[source])
  assert.equal(a.snapshot().tasks[0].status,'completed',JSON.stringify(a.snapshot()))
  const incoming = b.snapshot().tasks[0]; assert.equal(incoming.status,'completed')
  assert.equal(await fs.readFile(path.join(incoming.directory,'source','中文.txt'),'utf8'),'你好 😀')
  assert.ok((await fs.stat(path.join(incoming.directory,'source','空目录'))).isDirectory())
  assert.equal((await fs.stat(path.join(incoming.directory,'source','empty'))).size,0)
  assert.equal(await fs.readFile(path.join(source,'中文.txt'),'utf8'),'你好 😀')
  await sendAndWait(a,peer.id,[],'第二次文本')
  assert.equal(b.snapshot().tasks.find(t=>t.text)?.text,'第二次文本')
  assert.equal(confirms,2);assert.equal(pairs,2)
  await a.dispose(); await b.dispose()
  const state = JSON.parse(await fs.readFile(path.join(root,'b','state.json'),'utf8'))
  assert.equal(state.tasks.some(t=>t.manifest.text!==undefined),false)
})

test('paired devices stay discoverable without UDP and expire after HTTPS contact fails', async t => {
  const { lan, root } = await toolboxModules(t)
  const options = name => ({ storage: path.join(root, name), downloads: path.join(root, 'received'), name, host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => true, confirmReceive: async () => path.join(root, 'received') })
  const a = lan.createLanService(options('a')), b = lan.createLanService(options('b'))
  t.after(async () => { t.mock.timers.reset(); await a.dispose(); await b.dispose() })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  await a.enable(true); await b.enable(true)
  const peer = await a.connect('127.0.0.1', b.snapshot().port)
  t.mock.timers.tick(25000)
  // TLS and file I/O remain real; wait for the heartbeat response after advancing the discovery clock.
  for (let attempt = 0; attempt < 100 && !a.snapshot().devices.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(a.snapshot().devices[0]?.id, peer.id)
  assert.equal(b.snapshot().devices.length, 1)
  const task = await sendAndWait(a, peer.id, [], 'still online after discovery expiry')
  assert.equal(task.status, 'completed')
  await b.enable(false)
  t.mock.timers.tick(25000)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(a.snapshot().devices.length, 0)
})

test('discovery refreshes a paired endpoint without allowing a different fingerprint to replace it', async t => {
  const { lan, root } = await toolboxModules(t), sockets = []
  t.mock.method(dgram, 'createSocket', () => {
    const socket = Object.assign(new EventEmitter(), { bind: (_port, ready) => ready(), setBroadcast() {}, send() {}, close() {} })
    sockets.push(socket); return socket
  })
  const options = name => ({ storage: path.join(root, name), downloads: path.join(root, 'received'), name, host: '127.0.0.1', discovery: name === 'a', changed() {}, confirmPair: async () => true, confirmReceive: async () => path.join(root, 'received') })
  const a = lan.createLanService(options('a')), b = lan.createLanService(options('b'))
  t.after(async () => { t.mock.timers.reset(); await a.dispose(); await b.dispose() })
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() })
  await a.enable(true); await b.enable(true)
  const peer = await a.connect('127.0.0.1', b.snapshot().port)
  const packet = { protocol: 'dustdesk-1', id: peer.id, name: peer.name, port: peer.port, fingerprint: peer.fingerprint }
  sockets[0].emit('message', Buffer.from(JSON.stringify({ ...packet, fingerprint: '0'.repeat(64) })), { address: '127.0.0.1' })
  assert.equal(a.snapshot().devices[0].fingerprint, peer.fingerprint, 'Unverified discovery must not overwrite a paired identity')
  await b.enable(false); await b.enable(true)
  assert.notEqual(b.snapshot().port, peer.port)
  sockets[0].emit('message', Buffer.from(JSON.stringify({ ...packet, port: b.snapshot().port })), { address: '127.0.0.1' })
  t.mock.timers.tick(25000)
  for (let attempt = 0; attempt < 100 && !a.snapshot().devices.length; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(a.snapshot().devices[0]?.port, b.snapshot().port, 'Heartbeat must use the endpoint refreshed by discovery')
  assert.equal((await sendAndWait(a, peer.id, [], 'recovered through discovery')).status, 'completed')
  const c = lan.createLanService(options('c'))
  t.after(() => c.dispose())
  await c.enable(true); await a.connect('127.0.0.1', c.snapshot().port)
  sockets[0].emit('message', Buffer.from(JSON.stringify({ ...packet, port: c.snapshot().port })), { address: '127.0.0.1' })
  const redirected = await sendAndWait(a, peer.id, [], 'must not reach another trusted device')
  assert.equal(redirected.status, 'failed')
  assert.match(redirected.error, /设备身份已变化/)
  assert.equal(c.snapshot().tasks.length, 0, 'Discovery cannot redirect a transfer even to an already trusted device')
})

test('closing either service during pairing cannot persist a late approval after reopening', { timeout: 15000 }, async t => {
  const { lan, root } = await toolboxModules(t)
  for (const side of ['a', 'b']) {
    let notify, approve
    const confirming = new Promise(resolve => { notify = resolve }), decision = new Promise(resolve => { approve = resolve })
    const options = name => ({ storage: path.join(root, side, name), downloads: path.join(root, 'received'), name, host: '127.0.0.1', discovery: false, changed() {}, confirmPair: async () => { if (name === side) { notify(); return decision }; return true }, confirmReceive: async () => false })
    const a = lan.createLanService(options('a')), b = lan.createLanService(options('b'))
    t.after(async () => { approve(false); await a.dispose(); await b.dispose() })
    await a.enable(true); await b.enable(true)
    const connection = a.connect('127.0.0.1', b.snapshot().port).then(() => undefined, error => error)
    await confirming
    const target = side === 'a' ? a : b
    await target.enable(false); await target.enable(true)
    approve(true)
    assert.ok(await connection instanceof Error, 'A pairing approval belongs to the service session that requested it')
    // Let the receiver handler settle even if its closed socket already rejected the sender.
    await new Promise(resolve => setTimeout(resolve, 30))
    const state = JSON.parse(await fs.readFile(path.join(root, side, side, 'state.json'), 'utf8'))
    assert.deepEqual(state.trusted, [])
    assert.equal(target.snapshot().devices.length, 0)
  }
})

test('pausing a first transfer aborts an outstanding pairing request', { timeout: 10000 }, async t => {
  const { lan, root } = await toolboxModules(t)
  let socket, notify, approve
  t.mock.method(dgram, 'createSocket', () => socket = Object.assign(new EventEmitter(), { bind: (_port, ready) => ready(), setBroadcast() {}, send() {}, close() {} }))
  const confirming = new Promise(resolve => { notify = resolve }), decision = new Promise(resolve => { approve = resolve })
  const options = name => ({ storage: path.join(root, name), downloads: path.join(root, 'received'), name, host: '127.0.0.1', discovery: name === 'a', changed() {}, confirmPair: async () => { if (name === 'a') { notify(); return decision }; return true }, confirmReceive: async () => path.join(root, 'received') })
  const a = lan.createLanService(options('a')), b = lan.createLanService(options('b'))
  t.after(async () => { approve(false); await a.dispose(); await b.dispose() })
  await a.enable(true); await b.enable(true)
  const identity = JSON.parse(await fs.readFile(path.join(root, 'b', 'identity.json'), 'utf8'))
  socket.emit('message', Buffer.from(JSON.stringify({ protocol: 'dustdesk-1', id: identity.id, name: 'b', fingerprint: identity.fingerprint, port: b.snapshot().port })), { address: '127.0.0.1' })
  await a.send(identity.id, [], 'must stay unsent')
  await confirming
  const task = a.snapshot().tasks[0]
  let deadline
  try { await Promise.race([a.control(task.id, 'pause'), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Pause waited for a pairing decision')), 1000) })]) }
  finally { clearTimeout(deadline) }
  approve(true)
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(a.snapshot().tasks[0].status, 'paused')
  assert.equal(b.snapshot().tasks.length, 0)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'a', 'state.json'), 'utf8')).trusted, [])
})

test('submitting a transfer returns while the receiver is still confirming; pause settles the running work', {timeout:10000}, async t => {
  const { lan, root } = await toolboxModules(t), source = path.join(root, 'source.txt')
  await fs.writeFile(source, 'keep')
  let notify, decide
  const confirming = new Promise(resolve => { notify = resolve }), decision = new Promise(resolve => { decide = resolve })
  const options = name => ({ storage: path.join(root, name), downloads: path.join(root, 'received'), name, host: '127.0.0.1', discovery: false, changed: () => {}, confirmPair: async () => true, confirmReceive: async () => { notify(); return decision } })
  const a = lan.createLanService(options('a')), b = lan.createLanService(options('b'))
  t.after(async () => { decide(false); await a.dispose(); await b.dispose() })
  await a.enable(true); await b.enable(true)
  const peer = await a.connect('127.0.0.1', b.snapshot().port)
  let timer
  try {
    await Promise.race([a.send(peer.id, [source]), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Submission waited for transfer completion')), 1000) })])
  } finally { clearTimeout(timer) }
  await confirming
  const task = a.snapshot().tasks[0]
  assert.equal(task.status, 'waiting')
  await a.control(task.id, 'pause')
  assert.equal(a.snapshot().tasks[0].status, 'paused')
  assert.equal(b.snapshot().tasks.length, 0)
  assert.equal(await fs.readFile(source, 'utf8'), 'keep')
})

test('interrupted transfer resumes after both endpoints restart and rejects changed sources', {timeout:45000}, async t => {
  const { lan, root } = await toolboxModules(t), source = path.join(root,'large.bin'), downloads = path.join(root,'received')
  await fs.writeFile(source,Buffer.alloc(128 * 1024 * 1024,77))
  let a, b, stopped = false, interrupted
  const options = name => ({storage:path.join(root,name),downloads,name,host:'127.0.0.1',discovery:false,confirmPair:async()=>true,confirmReceive:async()=>downloads,changed:snapshot=>{
    const active = snapshot.tasks.find(t=>t.status==='transferring')
    if (name==='a' && !stopped && active) {stopped=true;interrupted=new Promise((resolve,reject)=>setTimeout(()=>a.control(active.id,'pause').then(resolve,reject),15))}
  }})
  a = lan.createLanService(options('a')); b = lan.createLanService(options('b'))
  t.after(async()=>{await a.dispose();await b.dispose()})
  await a.enable(true);await b.enable(true);const peer=await a.connect('127.0.0.1',b.snapshot().port)
  await sendAndWait(a,peer.id,[source]); await interrupted
  assert.equal(stopped,true,'transfer must actually interrupt before completion')
  assert.equal(a.snapshot().tasks[0].status,'paused')
  await a.dispose();await b.dispose()
  a=lan.createLanService(options('a'));b=lan.createLanService(options('b'));await a.restore();await b.restore()
  const task=a.snapshot().tasks[0]; assert.equal(task.status,'paused')
  // The persisted peer port can change after a restart; reconnect refreshes it.
  await a.connect('127.0.0.1',b.snapshot().port)
  await resumeAndWait(a,task.id)
  assert.equal(a.snapshot().tasks[0].status,'completed',JSON.stringify(a.snapshot()))
  const received=b.snapshot().tasks[0];assert.deepEqual(await fs.readFile(path.join(received.directory,'large.bin')),await fs.readFile(source))
  stopped=false
  await sendAndWait(a,peer.id,[source]);await interrupted
  const paused=a.snapshot().tasks.find(t=>t.status==='paused'); assert.ok(paused)
  await fs.writeFile(source,Buffer.from('changed'))
  await resumeAndWait(a,paused.id);assert.equal(a.snapshot().tasks.find(t=>t.id===paused.id).status,'failed')
  assert.match(a.snapshot().tasks.find(t=>t.id===paused.id).error,/发送源已变化/)
})

test('receiver rejects corrupted uploads, retries from a verified offset and cleans cancellation staging', {timeout:30000},async t=>{
  const {lan,root}=await toolboxModules(t),downloads=path.join(root,'received')
  let confirmations=0
  const options=name=>({storage:path.join(root,name),downloads,name,host:'127.0.0.1',discovery:false,changed:()=>{},confirmPair:async()=>true,confirmReceive:async()=>{confirmations++;return downloads}})
  const a=lan.createLanService(options('a')),b=lan.createLanService(options('b'));t.after(async()=>{await a.dispose();await b.dispose()})
  await a.enable(true);await b.enable(true);await a.connect('127.0.0.1',b.snapshot().port)
  const identity=JSON.parse(await fs.readFile(path.join(root,'a','identity.json'),'utf8'))
  const request=(route,body)=>new Promise((resolve,reject)=>{
    const req=https.request({hostname:'127.0.0.1',port:b.snapshot().port,path:route,method:'POST',key:identity.key,cert:identity.cert,rejectUnauthorized:false,agent:false},async res=>{const buffers=[];for await(const chunk of res)buffers.push(chunk);resolve({status:res.statusCode,...JSON.parse(Buffer.concat(buffers).toString())})});req.on('error',reject);req.end(Buffer.isBuffer(body)?body:JSON.stringify(body))
  })
  const good=Buffer.from('good'),manifest={id:'corrupt-test',name:'test',directories:[],entries:[{relative:'file.txt',size:4,mtime:0,hash:createHash('sha256').update(good).digest('hex')}]}
  const first=await request('/offer',manifest);assert.equal(first.status,200)
  const bad=await request(`/file?id=${manifest.id}&token=${first.token}&index=0&offset=0`,Buffer.from('evil'));assert.equal(bad.status,400);assert.match(bad.error,/校验失败/)
  assert.equal(b.snapshot().tasks[0].status,'failed');const directory=b.snapshot().tasks[0].directory
  await assert.rejects(fs.stat(path.join(directory,'file.txt')),/ENOENT/)
  const retry=await request('/offer',manifest);assert.equal(retry.offsets[0].size,0)
  assert.equal((await request(`/file?id=${manifest.id}&token=${retry.token}&index=0&offset=0`,good)).status,200)
  assert.equal((await request(`/complete?id=${manifest.id}&token=${retry.token}`,{})).status,200)
  assert.equal(await fs.readFile(path.join(directory,'file.txt'),'utf8'),'good')
  const second=await request('/offer',{...manifest,id:'cancel-test'});assert.equal(second.status,200)
  const canceledDirectory=b.snapshot().tasks.find(task=>task.id.endsWith('cancel-test')).directory
  assert.equal((await request(`/cancel?id=cancel-test&token=${second.token}`,{})).status,200)
  assert.equal((await fs.readdir(canceledDirectory)).some(name=>name.startsWith('.dustdesk-part')),false)
  assert.equal(confirmations,3)
})

test('refused receive and unavailable destination fail without changing sending files', {timeout:30000},async t=>{
  const {lan,root}=await toolboxModules(t),source=path.join(root,'input.txt'),downloads=path.join(root,'not-a-folder')
  await fs.writeFile(source,'original');await fs.writeFile(downloads,'occupied')
  let accept=false
  const options=name=>({storage:path.join(root,name),downloads,name,host:'127.0.0.1',discovery:false,changed:()=>{},confirmPair:async()=>true,confirmReceive:async()=>accept?downloads:false})
  const a=lan.createLanService(options('a')),b=lan.createLanService(options('b'));t.after(async()=>{await a.dispose();await b.dispose()})
  await a.enable(true);await b.enable(true);const peer=await a.connect('127.0.0.1',b.snapshot().port)
  await sendAndWait(a,peer.id,[source]);assert.equal(a.snapshot().tasks[0].status,'failed');assert.match(a.snapshot().tasks[0].error,/拒绝/)
  accept=true;await resumeAndWait(a,a.snapshot().tasks[0].id);assert.equal(a.snapshot().tasks[0].status,'failed')
  assert.equal(await fs.readFile(source,'utf8'),'original');assert.equal(await fs.readFile(downloads,'utf8'),'occupied')
  assert.equal(b.snapshot().tasks.length,1);assert.equal(b.snapshot().tasks[0].status,'failed')
})

test('canceling while the receiver is confirming cannot create a late receive folder', {timeout:30000},async t=>{
  const {lan,root}=await toolboxModules(t),source=path.join(root,'source.txt'),downloads=path.join(root,'received')
  await fs.writeFile(source,'keep')
  let notify,accept
  const confirmed=new Promise(resolve=>notify=resolve),decision=new Promise(resolve=>accept=resolve)
  const options=name=>({storage:path.join(root,name),downloads,name,host:'127.0.0.1',discovery:false,changed:()=>{},confirmPair:async()=>true,confirmReceive:async()=>{notify();return decision}})
  const a=lan.createLanService(options('a')),b=lan.createLanService(options('b'));t.after(async()=>{accept(false);await a.dispose();await b.dispose()})
  await a.enable(true);await b.enable(true);const peer=await a.connect('127.0.0.1',b.snapshot().port)
  const sending=a.send(peer.id,[source]);await confirmed;await a.control(a.snapshot().tasks[0].id,'cancel');await sending
  await new Promise(resolve=>setTimeout(resolve,30));accept(downloads);await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(a.snapshot().tasks[0].status,'canceled');assert.equal(b.snapshot().tasks.length,0)
  await assert.rejects(fs.stat(downloads),/ENOENT/);assert.equal(await fs.readFile(source,'utf8'),'keep')
})

test('disk-full image export removes partial files and allows a later retry',async t=>{
  const {assets,root}=await toolboxModules(t)
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABoIJXOQAAAABJRU5ErkJggg==','base64')
  let full=true
  const manager=assets.createToolAssets({...fs,writeFile:async(target,bytes,options)=>{if(full&&path.basename(target).startsWith('.part-')){await fs.writeFile(target,'partial',options);throw Object.assign(Error('ENOSPC: disk full'),{code:'ENOSPC'})}return fs.writeFile(target,bytes,options)}})
  const batch=await manager.beginBatch(path.join(root,'result.png'),1)
  await assert.rejects(manager.exportImage(batch.id,'result.png',png),{code:'ENOSPC'})
  const staging=(await fs.readdir(root)).find(name=>name.startsWith('.dustdesk-images-'))
  assert.deepEqual(await fs.readdir(path.join(root,staging)),[])
  full=false;const result=await manager.exportImage(batch.id,'result.png',png)
  assert.deepEqual(await fs.readFile(result),png)
  const output=await manager.endBatch(batch.id)
  assert.deepEqual(await fs.readFile(output.path),png)
  assert.equal((await fs.readdir(root)).some(name=>name.startsWith('.dustdesk-images-')),false)
})

test('single image saves directly, detects original format and avoids replacing the source or existing output', async t => {
  const { assets, root } = await toolboxModules(t), manager = assets.createToolAssets()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABoIJXOQAAAABJRU5ErkJggg==', 'base64')
  const source = path.join(root, '原图.jpeg'); await fs.writeFile(source, png)
  const [asset] = await manager.registerPaths([source], 'image')
  assert.deepEqual(await manager.imageExportName([asset.id], 'original'), { name: '原图-处理后.png', extension: 'png' })
  await assert.rejects(manager.imageExportName([], 'png'), /参数无效/)
  await assert.rejects(manager.imageExportName(['missing'], 'png'), /授权/)
  const batch = await manager.beginBatch(source, 1)
  await manager.exportImage(batch.id, 'result.png', png)
  const output = await manager.endBatch(batch.id)
  assert.equal(output.path, path.join(root, '原图-1.jpeg'))
  assert.equal(output.count, 1)
  assert.deepEqual(await fs.readFile(source), png)
  assert.deepEqual(await fs.readFile(output.path), png)
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.dustdesk-images-')), false)
})

test('partial multi-image export stays a ZIP, empty canceled export leaves nothing, and publication failure removes staging', async t => {
  const { assets, root } = await toolboxModules(t), manager = assets.createToolAssets()
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABoIJXOQAAAABJRU5ErkJggg==', 'base64')
  const target = path.join(root, 'images.zip')
  await fs.writeFile(target, 'existing output')
  const batch = await manager.beginBatch(target, 3)
  await manager.exportImage(batch.id, '../中文.png', png)
  const output = await manager.endBatch(batch.id)
  assert.equal(output.path, path.join(root, 'images-1.zip'))
  assert.deepEqual([...await readZip(output.path)], [['中文.png', png]])
  assert.equal(await fs.readFile(target, 'utf8'), 'existing output')
  const empty = await manager.beginBatch(path.join(root, 'empty.zip'), 2)
  assert.deepEqual(await manager.endBatch(empty.id), { count: 0 })
  await assert.rejects(fs.stat(path.join(root, 'empty.zip')), { code: 'ENOENT' })
  const brokenTarget = path.join(root, 'failed.zip')
  const broken = assets.createToolAssets({ ...fs, link: async (source, target) => { if (target === brokenTarget) throw Object.assign(Error('disk full'), { code: 'ENOSPC' }); return fs.link(source, target) } })
  const failed = await broken.beginBatch(brokenTarget, 2)
  await broken.exportImage(failed.id, 'result.png', png)
  await assert.rejects(broken.endBatch(failed.id), { code: 'ENOSPC' })
  await assert.rejects(fs.stat(brokenTarget), { code: 'ENOENT' })
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.dustdesk-images-')), false)
})

test('finishing an image export waits for pending writes and rejects late writes', async t => {
  const { assets, root } = await toolboxModules(t)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABoIJXOQAAAABJRU5ErkJggg==', 'base64')
  let started, release
  const pending = new Promise(resolve => { started = resolve }), gate = new Promise(resolve => { release = resolve })
  const manager = assets.createToolAssets({ ...fs, writeFile: async (...args) => { started(); await gate; return fs.writeFile(...args) } })
  const batch = await manager.beginBatch(path.join(root, 'pending.png'), 1)
  const writing = manager.exportImage(batch.id, 'pending.png', png)
  await pending
  const finishing = manager.endBatch(batch.id)
  await assert.rejects(manager.exportImage(batch.id, 'late.png', png), /结束/)
  release(); await writing
  const output = await finishing
  assert.deepEqual(await fs.readFile(output.path), png)
  assert.equal((await fs.readdir(root)).some(name => name.startsWith('.dustdesk-images-')), false)
})
