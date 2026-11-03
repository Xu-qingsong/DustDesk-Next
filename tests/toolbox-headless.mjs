import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync, promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { chromium } from 'playwright'
import ts from 'typescript'
import { deflateSync } from 'node:zlib'
import { mainFixture } from './main-headless-harness.mjs'

const browserPath = [process.env.DUSTDESK_HEADLESS_BROWSER, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(value => value && existsSync(value))
test('toolbox pages use real IPC and Workers, preserve drafts and export a single image directly', { timeout: 60000, skip: !browserPath }, async t => {
  const fixture = await mainFixture(t), root = path.resolve('out/renderer')
  const initial = await fixture.load()
  await fixture.invoke('workspace:save', { ...initial, Settings: { ...initial.Settings, SidebarHidden: [] } }, initial)
  const server = createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname
      const file = path.resolve(root, '.' + (name === '/' ? '/index.html' : name))
      if (path.relative(root, file).startsWith('..')) throw Error('outside root')
      const bytes=await fs.readFile(file);res.writeHead(200, { 'Content-Type': ({ '.html':'text/html','.js':'text/javascript','.css':'text/css' })[path.extname(file)] ?? 'application/octet-stream' });res.end(bytes)
    } catch { res.writeHead(404);res.end() }
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
  const origin=`http://127.0.0.1:${server.address().port}`
  const browser=await chromium.launch({executablePath:browserPath,headless:true,args:['--disable-gpu']});t.after(()=>browser.close())
  const context=await browser.newContext({viewport:{width:1400,height:900}}), page=await context.newPage(), errors=[]
  const sourceReads = []
  page.on('pageerror',e=>errors.push(e.message))
  const invoke=fixture.client((channel,...args)=>{void page.evaluate(({channel,args})=>window.__receive?.(channel,...args),{channel,args}).catch(()=>{})},true)
  await page.exposeFunction('__invoke',async(channel,args)=>{
    if (channel === 'toolbox:read-asset') sourceReads.push(args[0])
    if (['toolbox:import-image','toolbox:export-image'].includes(channel)) {const i=channel==='toolbox:import-image'?0:2;args[i]=new Uint8Array(Object.values(args[i]))}
    const result=await invoke(channel,...args);return channel==='toolbox:read-asset'?Array.from(result):result
  })
  const preload=ts.transpileModule(await fs.readFile('src/preload/index.ts','utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace(/import\s+\{[^}]+\}\s+from\s+['"]electron['"];?/,'')
  await page.addInitScript({content:`(()=>{
    const NativeWorker=Worker;window.__imageWorkers=[];window.Worker=class extends NativeWorker{constructor(...args){super(...args);window.__imageWorkers.push(String(args[0]))}};
    const process={platform:'win32'},listeners=new Map(),webUtils={getPathForFile:()=>''};
    const contextBridge={exposeInMainWorld:(name,value)=>window[name]=value};
    const ipcRenderer={invoke:(channel,...args)=>window.__invoke(channel,args).then(value=>channel==='toolbox:read-asset'?new Uint8Array(value):value),on:(name,cb)=>{const list=listeners.get(name)||new Set();list.add(cb);listeners.set(name,list)},removeListener:(name,cb)=>listeners.get(name)?.delete(cb),send:()=>{}};
    window.__receive=(name,...args)=>{for(const cb of listeners.get(name)||[])cb({},...args)};
    ${preload}
  })();`})
  await page.goto(origin);await page.locator('h1').waitFor()
  const navigate=name=>page.locator('.sidebar').getByText(name,{exact:true}).click()
  await navigate('文本工具箱');await page.getByLabel('文本输入',{exact:true}).fill('{"中文":"😀","n":2}')
  await page.waitForFunction(()=>document.querySelector('[aria-label="文本结果"]')?.value.includes('\n  "中文"'))
  const value=await page.getByLabel('文本结果',{exact:true}).inputValue();assert.equal(JSON.parse(value).中文,'😀')
  await navigate('任务');await navigate('文本工具箱');assert.match(await page.getByLabel('文本输入',{exact:true}).inputValue(),/中文/)
  await page.getByRole('button',{name:'文本对比',exact:true}).click()
  await page.getByLabel('对比文本',{exact:true}).fill('保留对比草稿')
  await page.getByLabel('文本输入',{exact:true}).fill('')
  await page.getByRole('button',{name:'JSON 格式化',exact:true}).click()
  await page.waitForTimeout(400)
  assert.equal(await page.getByLabel('文本结果',{exact:true}).inputValue(),'')
  assert.equal(await page.locator('.toolbox-error:visible').count(),0,'Inactive diff input must not cause an empty JSON error')
  await page.getByRole('button',{name:'文本对比',exact:true}).click()
  assert.equal(await page.getByLabel('对比文本',{exact:true}).inputValue(),'保留对比草稿')
  await page.getByRole('button',{name:'正则测试',exact:true}).click();await page.getByPlaceholder('例如 (\\d+)').fill('(a+)+$');await page.getByLabel('文本输入',{exact:true}).fill('a'.repeat(40)+'!')
  await page.getByRole('alert').filter({hasText:'处理超时'}).waitFor()
  await page.getByRole('button',{name:'转大写',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).fill('current 中文')
  await page.waitForFunction(()=>document.querySelector('[aria-label="文本结果"]')?.value==='CURRENT 中文')
  await page.getByLabel('文本输入',{exact:true}).dispatchEvent('compositionstart')
  await page.getByLabel('文本输入',{exact:true}).fill('中文输入 abc')
  await page.waitForTimeout(400)
  assert.equal(await page.getByLabel('文本结果',{exact:true}).inputValue(),'')
  await page.getByLabel('文本输入',{exact:true}).dispatchEvent('compositionend')
  await page.waitForFunction(()=>document.querySelector('[aria-label="文本结果"]')?.value==='中文输入 ABC')
  await page.getByRole('button',{name:'正则测试',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).fill('a'.repeat(40)+'!')
  await page.getByText('处理中…',{exact:true}).waitFor()
  await page.getByRole('button',{name:'转大写',exact:true}).click();await page.getByLabel('文本输入',{exact:true}).fill('current 中文')
  await page.waitForFunction(()=>document.querySelector('[aria-label="文本结果"]')?.value==='CURRENT 中文')
  await page.waitForTimeout(1100);assert.equal(await page.locator('.toolbox-error:visible').count(),0)
  fixture.electron.dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(fixture.root,'text.txt')})
  await page.getByRole('button',{name:'导出文本',exact:true}).click();await page.getByText('文本已导出',{exact:true}).waitFor();assert.equal(await fs.readFile(path.join(fixture.root,'text.txt'),'utf8'),'CURRENT 中文')
  const png=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=2;const ctx=canvas.getContext('2d');ctx.fillStyle='rgba(255,0,0,.5)';ctx.fillRect(0,0,2,2);ctx.fillStyle='#0000ff';ctx.fillRect(2,0,2,2);return [...new Uint8Array(await (await new Promise(resolve=>canvas.toBlob(resolve))).arrayBuffer())]})
  const imagePath=path.join(fixture.root,'透明.png');await fs.writeFile(imagePath,Buffer.from(png))
  fixture.electron.dialog.showSaveDialog=async()=>({canceled:false,filePath:path.join(fixture.root,'透明-处理后.png')})
  fixture.electron.dialog.showOpenDialog=async options=>({canceled:false,filePaths:options.title==='导入图片'?[imagePath]:[fixture.root]})
  await navigate('图片工具箱');await page.getByRole('button',{name:'导入图片',exact:true}).click()
  await page.locator('.image-tool-thumb').waitFor()
  assert.equal(await page.getByLabel('有损质量',{exact:true}).count(),0)
  assert.equal(await page.getByRole('button',{name:'JPG 背景',exact:true}).count(),0)
  await page.getByRole('button',{name:'批量预览',exact:true}).click();await page.getByAltText('输出预览').waitFor()
  assert.match(await page.locator('.image-tool-row').innerText(),/保留原图/)
  const image=await page.evaluate(async()=>{const value=document.querySelector('[alt="输出预览"]');await value.decode();const canvas=document.createElement('canvas');canvas.width=value.naturalWidth;canvas.height=value.naturalHeight;const ctx=canvas.getContext('2d');ctx.drawImage(value,0,0);return {width:canvas.width,height:canvas.height,pixel:[...ctx.getImageData(0,0,1,1).data]}})
  assert.equal(image.width,4);assert.equal(image.height,2);assert.ok(image.pixel[3]>=127&&image.pixel[3]<=129)
  await page.getByRole('button',{name:'导出全部',exact:true}).click();await page.getByText('导出完成：1 成功',{exact:true}).waitFor()
  const exported=await fs.readFile(path.join(fixture.root,'透明-处理后.png'));assert.deepEqual(exported,Buffer.from(png));assert.deepEqual(await fs.readFile(imagePath),Buffer.from(png))
  assert.equal((await fs.readdir(fixture.root)).some(name=>name.startsWith('.dustdesk-images-')),false)
  const cropImages = await page.evaluate(async () => {
    const make = async (width, color) => { const canvas = new OffscreenCanvas(width, width / 2), ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, canvas.width, canvas.height); return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())] }
    return [await make(32, '#ff0000'), await make(64, '#00ff00')]
  })
  const cropPaths = [path.join(fixture.root, 'red.png'), path.join(fixture.root, 'green.png')]
  await Promise.all(cropPaths.map((file, index) => fs.writeFile(file, Buffer.from(cropImages[index]))))
  fixture.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: cropPaths })
  await page.getByRole('button', { name: '导入图片', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[alt="原图预览"]')?.naturalWidth === 32)
  await page.getByRole('tab', { name: '头像裁剪', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[alt="输出预览"]')?.naturalWidth === 512 && !document.querySelectorAll('.image-tool-preview figcaption')[1]?.textContent.includes('更新中'))
  const sourceUrl = await page.getByAltText('原图预览').getAttribute('src'), beforeReads = sourceReads.length
  const beforeWorkers = await page.evaluate(() => window.__imageWorkers.length)
  await page.locator('.image-crop-canvas').focus(); await page.keyboard.press('+')
  await page.waitForFunction(() => !document.querySelectorAll('.image-tool-preview figcaption')[1]?.textContent.includes('更新中'))
  assert.equal(sourceReads.length, beforeReads, 'Crop changes must reuse original bytes')
  assert.equal(await page.evaluate(() => window.__imageWorkers.length), beforeWorkers, 'Completed preview Worker must be reused')
  assert.equal(await page.getByAltText('原图预览').getAttribute('src'), sourceUrl, 'Crop canvas should keep its decoded source')
  const switched = await page.evaluate(async () => {
    [...document.querySelectorAll('.image-tool-name')].find(button => button.textContent.includes('green.png')).click()
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    return { source: document.querySelector('[alt="原图预览"]')?.src, crop: !!document.querySelector('.image-crop-canvas') }
  })
  assert.notEqual(switched.source, sourceUrl, 'New selection must never display the previous image')
  assert.equal(switched.crop, false, 'Crop controls wait for the selected image')
  await page.waitForFunction(() => document.querySelector('[alt="原图预览"]')?.naturalWidth === 64)
  const changedSource = await page.evaluate(async () => { const canvas = new OffscreenCanvas(128, 64); canvas.getContext('2d').fillRect(0, 0, 128, 64); return [...new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())] })
  await fs.writeFile(cropPaths[1], Buffer.from(changedSource))
  await page.getByRole('button', { name: '批量预览', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[alt="原图预览"]')?.naturalWidth === 128 && !document.querySelector('.image-tool-name')?.disabled)
  await page.waitForFunction(() => !document.querySelectorAll('.image-tool-preview figcaption')[1]?.textContent.includes('更新中'))
  assert.equal(await page.getByAltText('原图预览').evaluate(image => image.naturalWidth), 128, 'Explicit processing and later automatic previews must discard stale source bytes')
  await navigate('局域网传输');await page.getByRole('button',{name:'文本',exact:true}).click();await page.getByLabel('发送文本').fill('local draft');await navigate('文本工具箱');await navigate('局域网传输');assert.equal(await page.getByLabel('发送文本').inputValue(),'local draft')
  for (const viewport of [{width:1400,height:900},{width:960,height:720}]) {await page.setViewportSize(viewport);for(const name of ['文本工具箱','图片工具箱','局域网传输']){await navigate(name);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}}
  await page.evaluate(()=>document.documentElement.dataset.theme='dark');await page.screenshot({path:'test-artifacts/toolbox-dark.png'})
  assert.deepEqual(errors,[])
})

test('image Worker flattens transparency, applies watermarks, resizes and rejects animations', {timeout:30000,skip:!browserPath},async t=>{
  // A valid grayscale PNG is smaller than Canvas's RGBA encoding of the same pixel.
  const chunk=(type,data)=>{
    const body=Buffer.concat([Buffer.from(type),data]),result=Buffer.alloc(body.length+8)
    let crc=0xffffffff
    for(const byte of body){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0)}
    result.writeUInt32BE(data.length);body.copy(result,4);result.writeUInt32BE((crc^0xffffffff)>>>0,result.length-4)
    return result
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8
  const optimizedBase64=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,0]),{level:9})),chunk('IEND',Buffer.alloc(0))]).toString('base64')
  const assets=path.resolve('out/renderer/assets'), files=await fs.readdir(assets),worker=files.find(n=>n.startsWith('image.worker-'))
  const server=createServer(async(req,res)=>{res.writeHead(200,{'Content-Type':'text/javascript'});res.end(await fs.readFile(path.join(assets,worker)))})
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve)}))
  const browser=await chromium.launch({executablePath:browserPath,headless:true});t.after(()=>browser.close());const page=await browser.newPage()
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  const result=await page.evaluate(async optimizedBase64=>{
    const make=async(color,width=4,height=2)=>{const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,width,height);return new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer())}
    const options={format:'png',quality:100,resize:'none',percent:100,width:2,height:2,fit:'contain',upscale:false,background:'#ffffff',watermark:'none',text:'X',position:8,margin:0,watermarkSize:1,opacity:100,color:'#00ff00'}
    const run=(bytes,overrides={},watermark)=>new Promise(resolve=>{const worker=new Worker(location.href,{type:'module'});worker.onmessage=e=>{worker.terminate();resolve(e.data)};worker.postMessage({bytes,options:{...options,...overrides},watermark})})
    const inspect=async(result)=>{if(result.error)return result;const image=await createImageBitmap(new Blob([result.result.bytes])),canvas=new OffscreenCanvas(image.width,image.height),ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return {width:image.width,height:image.height,pixel:[...ctx.getImageData(0,0,1,1).data],last:[...ctx.getImageData(image.width-1,image.height-1,1,1).data],type:result.result.format}}
    const png=await make('rgba(255,0,0,.5)'),mark=await make('#00ff00',1,1)
    const jpg=await inspect(await run(png,{format:'jpeg'})),webp=await inspect(await run(png,{format:'webp'})),resize=await inspect(await run(png,{resize:'dimensions'})),watermark=await inspect(await run(png,{watermark:'image'},mark))
    const canvas=new OffscreenCanvas(4,2);canvas.getContext('2d').fillRect(0,0,4,2)
    const jpeg=new Uint8Array(await (await canvas.convertToBlob({type:'image/jpeg'})).arrayBuffer())
    const exif=new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0])
    const rotated=new Uint8Array(jpeg.length+exif.length);rotated.set(jpeg.subarray(0,2));rotated.set(exif,2);rotated.set(jpeg.subarray(2),2+exif.length)
    const orientation=await inspect(await run(rotated))
    const optimized=Uint8Array.from(atob(optimizedBase64),c=>c.charCodeAt(0))
    const same=await run(optimized,{format:'original',quality:1}),explicitPng=await run(optimized,{format:'png'}),sameDimensions=await run(optimized,{resize:'dimensions',width:1,height:1})
    const changed=await run(optimized,{watermark:'image'},mark),converted=await run(optimized,{format:'jpeg'})
    const resized=await run(optimized,{resize:'percent',percent:200,upscale:true})
    const sameJpeg=await run(jpeg,{format:'original',quality:100}),sameWebp=await run((await run(png,{format:'webp'})).result.bytes,{format:'original',quality:100})
    const noisy=new OffscreenCanvas(64,64),ctx=noisy.getContext('2d'),pixels=ctx.createImageData(64,64)
    for(let i=0;i<pixels.data.length;i+=4){pixels.data[i]=(i*13)%256;pixels.data[i+1]=(i*31)%256;pixels.data[i+2]=(i*7)%256;pixels.data[i+3]=255}
    ctx.putImageData(pixels,0,0)
    const highQuality=new Uint8Array(await (await noisy.convertToBlob({type:'image/jpeg',quality:1})).arrayBuffer())
    const compressed=await run(highQuality,{format:'original',quality:10})
    const persistent = new Worker(location.href, { type: 'module' })
    const cachedRun = request => new Promise(resolve => { persistent.onmessage = event => resolve(event.data); persistent.postMessage({ options, ...request }) })
    const cachedFirst = await cachedRun({ assetId: 'one', bytes: optimized })
    const cachedSecond = await cachedRun({ assetId: 'one' })
    const cachedWatermark = await cachedRun({ assetId: 'one', watermarkId: 'mark', watermark: mark, options: { ...options, watermark: 'image' } })
    const cachedWatermarkAgain = await cachedRun({ assetId: 'one', watermarkId: 'mark', options: { ...options, watermark: 'image' } })
    persistent.terminate()
    return {jpg,webp,resize,watermark,orientation,broken:await run(new Uint8Array([1,2,3])),optimized:[...optimized],same,explicitPng,sameDimensions,changed,changedImage:await inspect(changed),converted,resized,sameJpeg,sameWebp,compressedSize:compressed.result.bytes.length,originalSize:highQuality.length,compressedRetained:compressed.result.retainedOriginal,cachedFirst,cachedSecond,cachedWatermark,cachedWatermarkAgain}
  },optimizedBase64)
  assert.equal(result.jpg.pixel[3],255);assert.ok(result.jpg.pixel[0]>240&&result.jpg.pixel[1]>110&&result.jpg.pixel[1]<145)
  assert.equal(result.webp.pixel[3],128);assert.equal(result.resize.width,2);assert.equal(result.resize.height,1)
  assert.deepEqual(result.watermark.last,[0,255,0,255]);assert.match(result.broken.error,/静态/)
  assert.equal(result.orientation.width,2);assert.equal(result.orientation.height,4)
  for(const value of [result.same,result.explicitPng,result.sameDimensions]) {
    assert.equal(value.result.retainedOriginal,true)
    assert.deepEqual([...value.result.bytes],result.optimized)
  }
  assert.equal(result.changed.result.retainedOriginal,false)
  assert.deepEqual(result.changedImage.pixel,[0,255,0,255])
  assert.equal(result.converted.result.retainedOriginal,false);assert.equal(result.converted.result.format,'jpeg')
  assert.equal(result.resized.result.retainedOriginal,false);assert.equal(result.resized.result.width,2)
  assert.equal(result.sameJpeg.result.originalFormat,'jpeg');assert.equal(result.sameWebp.result.originalFormat,'webp')
  assert.ok(result.compressedSize<result.originalSize);assert.equal(result.compressedRetained,false)
  assert.deepEqual([...result.cachedFirst.result.bytes], result.optimized)
  assert.deepEqual([...result.cachedSecond.result.bytes], result.optimized, 'Original retention must not detach the cached source')
  assert.deepEqual([...result.cachedWatermark.result.bytes], [...result.cachedWatermarkAgain.result.bytes], 'Watermarks must remain available without another decode')
})
