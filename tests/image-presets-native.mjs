import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { chooseSelect } from './ui-controls.mjs'
const running=await launchDustDesk({ showToolMenus: true })
try{
 const page=running.window,errors=[];page.on('pageerror',e=>errors.push(e.message))
 await page.route(/^https?:\/\//,route=>route.abort())
 await page.locator('.sidebar').getByText('图片工具箱',{exact:true}).click()
 const bytes=await page.evaluate(async()=>{const c=new OffscreenCanvas(240,120),ctx=c.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,120,120);ctx.fillStyle='#0000ff';ctx.fillRect(120,0,120,120);return [...new Uint8Array(await (await c.convertToBlob()).arrayBuffer())]})
 const sources=[path.join(running.tempRoot,'左.png'),path.join(running.tempRoot,'右.png')];for(const source of sources)await fs.writeFile(source,Buffer.from(bytes))
 await running.electronApp.evaluate(({dialog},sources)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:sources});dialog.showSaveDialog=async opts=>({canceled:false,filePath:process.getBuiltinModule('node:path').join(process.env.DUSTDESK_TEST_USER_DATA_DIR,'output.'+(opts.filters[0].extensions[0]))})},sources)
 await page.getByRole('button',{name:'导入图片',exact:true}).click()
 const rows=page.locator('.image-tool-row'),preview=page.getByAltText('输出预览')
 const ready=async()=>{await preview.waitFor();await page.waitForFunction(()=>!document.querySelector('.image-tool-preview figcaption:last-of-type')?.textContent?.includes('更新中')&&!document.querySelectorAll('.image-tool-preview figcaption')[1]?.textContent?.includes('更新中'))}
 await ready();assert.equal(await rows.count(),2)
 await page.getByRole('tab',{name:'头像裁剪',exact:true}).click();await ready()
 assert.equal(await page.getByLabel('头像尺寸',{exact:true}).innerText(),'512×512 px')
 const inspect=()=>preview.evaluate(async image=>{await image.decode();const c=new OffscreenCanvas(image.naturalWidth,image.naturalHeight),ctx=c.getContext('2d');ctx.drawImage(image,0,0);return {width:c.width,height:c.height,corner:[...ctx.getImageData(0,0,1,1).data],center:[...ctx.getImageData(Math.floor(c.width/2),Math.floor(c.height/2),1,1).data]}})
 assert.equal((await inspect()).width,512)
 await chooseSelect(page.getByLabel('头像形状',{exact:true}),'circle');await ready();assert.equal((await inspect()).corner[3],0)
 assert.equal(await page.getByLabel('格式',{exact:true}).isDisabled(),true)
 await chooseSelect(page.getByLabel('头像形状',{exact:true}),'square')
 await chooseSelect(page.getByLabel('头像尺寸',{exact:true}),'128');await ready()
 const canvas=page.getByRole('img',{name:'拖动调整裁剪，方向键移动，加减键缩放',exact:true})
 await canvas.focus();for(let i=0;i<20;i++)await page.keyboard.press('ArrowRight');await ready()
 const leftPixel=(await inspect()).center;assert.ok(leftPixel[0]>200&&leftPixel[2]<20)
 await rows.last().locator('.image-tool-name').click();await ready();assert.ok((await inspect()).center[2]>200)
 await rows.first().locator('.image-tool-name').click();await ready();assert.ok((await inspect()).center[0]>200)
 await page.getByRole('button',{name:'重置构图',exact:true}).click();await ready()
 await page.getByRole('tab',{name:'证件照尺寸',exact:true}).click();await ready();let image=await inspect();assert.deepEqual([image.width,image.height],[295,413])
 for(const [id,width,height] of [['small-one',260,378],['one',295,413],['small-two',390,567],['two',413,579]]){await chooseSelect(page.getByLabel('证件照规格',{exact:true}),id);await ready();image=await inspect();assert.deepEqual([image.width,image.height],[width,height])}
 await rows.last().getByRole('button',{name:/^移除 /}).click()
 await page.getByRole('button',{name:'导出全部',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.image-tool-name')?.disabled);assert.match(await page.locator('.image-tool-layout > .panel').nth(1).locator('.toolbox-heading').first().innerText(),/导出完成：1 成功/,await page.locator('.image-tool-list').innerText())
 const output=await fs.readFile(await page.locator('.toolbox-path').innerText());const jfif=output.indexOf(Buffer.from('JFIF\0'));assert.ok(jfif>0);assert.equal(output[jfif+7],1);assert.equal(output.readUInt16BE(jfif+8),300)
 await chooseSelect(page.getByLabel('格式',{exact:true}),'png');await ready()
 await page.getByRole('button',{name:'导出全部',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.image-tool-name')?.disabled);assert.match(await page.locator('.image-tool-layout > .panel').nth(1).locator('.toolbox-heading').first().innerText(),/导出完成：1 成功/,await page.locator('.image-tool-list').innerText())
 const pngOutput=await fs.readFile(await page.locator('.toolbox-path').innerText()),density=pngOutput.indexOf(Buffer.from('pHYs'));assert.ok(density>0);assert.equal(pngOutput.readUInt32BE(density+4),11811)
 await fs.mkdir('test-artifacts',{recursive:true});await page.screenshot({path:'test-artifacts/image-presets-portrait.png'})
 await page.getByRole('tab',{name:'头像裁剪',exact:true}).click();await ready();assert.equal(await page.getByLabel('头像尺寸',{exact:true}).innerText(),'128×128 px')
 await chooseSelect(page.getByLabel('头像尺寸',{exact:true}),'256');await chooseSelect(page.getByLabel('头像尺寸',{exact:true}),'1024');await ready();assert.equal((await inspect()).width,1024)
 assert.deepEqual(await fs.readFile(sources[0]),Buffer.from(bytes));assert.deepEqual(errors,[])
 console.log('PASS: automatic preview, shapes, per-image crops, keyboard controls, all ID sizes, DPI export, category drafts, latest result and source preservation')
}finally{await closeDustDesk(running)}
