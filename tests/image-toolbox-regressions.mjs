import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { launchDustDesk, closeDustDesk } from './electron-harness.mjs'
import { chooseSelect } from './ui-controls.mjs'
import { readZip } from './zip-files.mjs'

const running = await launchDustDesk({ showToolMenus: true })
try {
  const page = running.window, errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.locator('.sidebar').getByText('图片工具箱', { exact: true }).click()
  await page.evaluate(() => {
    const revoke = URL.revokeObjectURL.bind(URL)
    window.__revokedImageUrls = []
    URL.revokeObjectURL = url => { window.__revokedImageUrls.push(url); revoke(url) }
  })
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 12; canvas.height = 8
    canvas.getContext('2d').fillRect(0, 0, 12, 8)
    return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve))).arrayBuffer())]
  })
  await running.electronApp.evaluate(({ clipboard, nativeImage }, bytes) => {
    clipboard.readText = () => ''
    clipboard.readImage = () => nativeImage.createFromBuffer(Buffer.from(bytes))
  }, png)
  const button = name => page.getByRole('button', { name, exact: true })
  const rows = page.locator('.image-tool-row')
  const heading = page.locator('.image-tool-layout > .panel').nth(1).locator('.toolbox-heading').first()
  const settled = () => page.waitForFunction(() => !document.querySelector('.image-tool-name')?.disabled)
  const waitMainFlag = async name => {
    const deadline = Date.now() + 10000
    while (!await running.electronApp.evaluate((_electron, name) => globalThis[name], name)) {
      assert.ok(Date.now() < deadline, `${name} did not become ready`)
      await page.waitForTimeout(20)
    }
  }
  const source = path.join(running.tempRoot, '源图.png'), outputRoot = path.join(running.tempRoot, 'exports')
  await fs.writeFile(source, Buffer.from(png)); await fs.mkdir(outputRoot)

  // Both clipboard entrypoints must produce thumbnails and reject overlapping imports.
  await button('粘贴图片').click(); await settled()
  assert.equal(await page.locator('.image-tool-thumb').count(), 1)
  await page.evaluate(bytes => {
    const dispatch = () => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([new Uint8Array(bytes)], '快捷粘贴.png', { type: 'image/png' }))
      document.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    }
    dispatch(); dispatch()
  }, png)
  await settled()
  assert.equal(await rows.count(), 2)
  assert.equal(await page.locator('.image-tool-thumb').count(), 2)

  await running.electronApp.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
  }, source)
  await button('导入图片').click(); await settled()
  assert.equal(await page.locator('.image-tool-thumb').count(), 3)

  // Stale result dimensions, errors and preview URLs must disappear together.
  await rows.last().locator('.image-tool-name').click(); await button('批量预览').click(); await settled()
  assert.match(await rows.last().innerText(), /12×8 → 12×8/)
  assert.equal(await page.getByRole('slider', { name: '有损质量', exact: true }).count(), 0)
  await chooseSelect(page.getByLabel('格式', { exact: true }), 'png')
  assert.doesNotMatch(await rows.last().innerText(), /→/)
  assert.equal(await page.getByAltText('输出预览', { exact: true }).count(), 1)
  await fs.rm(source)
  await rows.last().locator('.image-tool-name').click(); await button('批量预览').click(); await settled()
  await page.waitForTimeout(500)
  assert.match(await rows.last().innerText(), /失败/)
  await fs.writeFile(source, Buffer.from(png))
  await rows.last().locator('.image-tool-name').click(); await button('批量预览').click(); await settled()
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.equal(await rows.last().locator('em').count(), 0)

  // Cancel while the save picker is unresolved, then confirm it late.
  await running.electronApp.evaluate(({ dialog }, root) => {
    dialog.showSaveDialog = () => new Promise(resolve => {
      globalThis.__imageDialogResolve = () => resolve({ canceled: false, filePath: process.getBuiltinModule('node:path').join(root, '图片.zip') })
    })
  }, outputRoot)
  await button('导出全部').click()
  await button('取消处理').click()
  assert.equal(await button('粘贴图片').isDisabled(), true)
  await running.electronApp.evaluate(() => globalThis.__imageDialogResolve())
  await settled()
  assert.match(await heading.innerText(), /已取消/)
  assert.deepEqual(await fs.readdir(outputRoot), [])

  // Cancel a delayed asset read: no new Worker may start after it resolves.
  await page.evaluate(() => {
    const NativeWorker = window.Worker
    window.__imageWorkerJobs = 0
    window.Worker = class extends NativeWorker {
      postMessage(...args) { window.__imageWorkerJobs++; super.postMessage(...args) }
    }
  })
  await running.electronApp.evaluate(async (_electron, source) => {
    const { promises: fs } = process.getBuiltinModule('node:module').createRequire(process.execPath)('node:fs'), readFile = fs.readFile
    fs.readFile = async (...args) => {
      if (args[0] === source) {
        globalThis.__imageReadPending = true
        await new Promise(resolve => { globalThis.__imageReadResolve = resolve })
      }
      return readFile(...args)
    }
    globalThis.__restoreImageRead = () => { fs.readFile = readFile }
  }, source)
  await button('批量预览').click()
  await waitMainFlag('__imageReadPending')
  await button('取消处理').click()
  const jobsBeforeReadResolved = await page.evaluate(() => window.__imageWorkerJobs)
  await running.electronApp.evaluate(() => { globalThis.__restoreImageRead(); globalThis.__imageReadResolve() })
  await settled()
  assert.equal(await page.evaluate(() => window.__imageWorkerJobs), jobsBeforeReadResolved)
  assert.ok(await page.getByAltText('输出预览', { exact: true }).count() <= 1)
  assert.equal(await page.getByRole('alert').count(), 0)

  // Cancel an active Worker before its processing request completes.
  await page.evaluate(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      postMessage(...args) {
        window.__imageWorkerPending = true
        window.__imageWorkerResolve = () => super.postMessage(...args)
      }
    }
    window.__restoreImageWorker = () => { window.Worker = NativeWorker }
  })
  await button('批量预览').click()
  await page.waitForFunction(() => window.__imageWorkerPending)
  await button('取消处理').click(); await settled()
  await page.evaluate(() => { window.__restoreImageWorker(); window.__imageWorkerResolve() })
  assert.ok(await page.getByAltText('输出预览', { exact: true }).count() <= 1)
  assert.match(await rows.last().innerText(), /待处理/)

  // If one write is already in main-process IPC, preserve it but stop the batch.
  await running.electronApp.evaluate(async ({ dialog }, root) => {
    const { promises: fs } = process.getBuiltinModule('node:module').createRequire(process.execPath)('node:fs'), writeFile = fs.writeFile
    dialog.showSaveDialog = async options => ({ canceled: false, filePath: process.getBuiltinModule('node:path').join(root, options.defaultPath) })
    fs.writeFile = async (...args) => {
      if (String(args[0]).includes('.part-')) {
        globalThis.__imageWritePending = true
        await new Promise(resolve => { globalThis.__imageWriteResolve = resolve })
      }
      return writeFile(...args)
    }
    globalThis.__restoreImageWrite = () => { fs.writeFile = writeFile }
  }, outputRoot)
  await button('导出全部').click()
  await waitMainFlag('__imageWritePending')
  await button('取消处理').click()
  assert.equal(await button('粘贴图片').isDisabled(), true)
  await running.electronApp.evaluate(() => { globalThis.__restoreImageWrite(); globalThis.__imageWriteResolve() })
  await settled()
  assert.match(await heading.innerText(), /已取消/)
  assert.deepEqual(await fs.readdir(outputRoot), ['DustDesk-图片.zip'])
  const canceledZip = await readZip(path.join(outputRoot, 'DustDesk-图片.zip'))
  assert.equal(canceledZip.size, 1)
  assert.ok([...canceledZip.keys()][0].endsWith('.png'))
  assert.ok(await page.getByAltText('输出预览', { exact: true }).count() <= 1)

  // Failed-only retry must export just that item, then clear its old error.
  await fs.rm(source)
  await button('导出全部').click(); await settled()
  await page.waitForTimeout(500)
  assert.match(await heading.innerText(), /2 成功，1 失败/)
  assert.match(await rows.last().innerText(), /失败/, 'Automatic preview cannot clear an export failure before retry')
  assert.equal((await readZip(await page.locator('.toolbox-path').innerText())).size, 2)
  await fs.writeFile(source, Buffer.from(png))
  await button('重试失败项').click(); await settled()
  assert.match(await heading.innerText(), /导出完成：1 成功/)
  const retriedImage = await page.locator('.toolbox-path').innerText()
  assert.equal(path.extname(retriedImage), '.png')
  assert.equal((await fs.readFile(retriedImage)).subarray(1, 4).toString(), 'PNG')
  assert.equal(await rows.last().locator('em').count(), 0)
  await rows.last().locator('.image-tool-name').click(); await settled()
  assert.match(await rows.last().innerText(), /已导出/)

  // A ZIP publication failure must be visible, clean staging, and make all staged images retryable.
  await running.electronApp.evaluate((_, root) => {
    const { promises: fs } = process.getBuiltinModule('node:fs'), link = fs.link, path = process.getBuiltinModule('node:path')
    fs.link = async (source, target) => {
      if (path.dirname(target) === root && path.extname(target) === '.zip') throw Object.assign(Error('ENOSPC: disk full'), { code: 'ENOSPC' })
      return link(source, target)
    }
    globalThis.__restoreImageLink = () => { fs.link = link }
  }, outputRoot)
  await button('导出全部').click(); await settled()
  assert.match(await heading.innerText(), /导出失败/)
  assert.match(await page.getByRole('alert').innerText(), /磁盘空间不足/)
  assert.equal(await rows.filter({ has: page.locator('em') }).count(), 3)
  assert.equal((await fs.readdir(outputRoot)).some(name => name.startsWith('.dustdesk-images-')), false)
  await running.electronApp.evaluate(() => globalThis.__restoreImageLink())
  await button('重试失败项').click(); await settled()
  assert.match(await heading.innerText(), /导出完成：3 成功/)
  assert.equal((await readZip(await page.locator('.toolbox-path').innerText())).size, 3)

  // Shared watermark bytes must survive transfer to each Worker in the batch.
  await chooseSelect(page.getByLabel('类型', { exact: true }), 'image')
  await running.electronApp.evaluate(({ dialog }, source) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [source] })
  }, source)
  await button('选择水印图片').click(); await settled()
  // A missing watermark fails before image processing; it must not report a completed export.
  const beforeWatermarkFailure = await fs.readdir(outputRoot)
  await fs.rm(source)
  await button('导出全部').click(); await settled()
  assert.equal(await page.getByRole('alert').count(), 1)
  assert.doesNotMatch(await heading.innerText(), /导出完成/)
  assert.deepEqual(await fs.readdir(outputRoot), beforeWatermarkFailure)
  await fs.writeFile(source, Buffer.from(png))
  await button('批量预览').click(); await settled()
  assert.match(await heading.innerText(), /处理完成：3 成功/)
  const removedUrls = await page.evaluate(() => [
    document.querySelector('.image-tool-row:last-child .image-tool-thumb').src,
    ...[...document.querySelectorAll('.image-tool-preview img')].map(image => image.src)
  ])
  assert.equal(removedUrls.length, 3)
  await button('移除 源图.png').click()
  assert.ok(await page.getByAltText('输出预览', { exact: true }).count() <= 1)
  const revoked = await page.evaluate(() => window.__revokedImageUrls)
  assert.ok(removedUrls.every(url => revoked.includes(url)))
  assert.deepEqual(await fs.readFile(source), Buffer.from(png))

  // One remaining image saves as the actual selected format, with a matching save filter.
  await rows.first().getByRole('button', { name: /^移除 / }).click()
  await chooseSelect(page.getByLabel('类型', { exact: true }), 'none')
  await running.electronApp.evaluate(({ dialog }, root) => {
    globalThis.__imageSaveOptions = []
    dialog.showSaveDialog = async options => {
      globalThis.__imageSaveOptions.push(options)
      return { canceled: false, filePath: process.getBuiltinModule('node:path').join(root, options.defaultPath) }
    }
  }, outputRoot)
  for (const format of ['png', 'jpeg', 'webp']) {
    await chooseSelect(page.getByLabel('格式', { exact: true }), format)
    await button('导出全部').click(); await settled()
    const output = await page.locator('.toolbox-path').innerText(), bytes = await fs.readFile(output)
    assert.equal(path.extname(output), format === 'jpeg' ? '.jpg' : '.' + format)
    if (format === 'png') assert.equal(bytes.subarray(1, 4).toString(), 'PNG')
    if (format === 'jpeg') assert.equal(bytes.readUInt16BE(0), 0xffd8)
    if (format === 'webp') assert.equal(bytes.subarray(8, 12).toString(), 'WEBP')
  }
  const saveOptions = await running.electronApp.evaluate(() => globalThis.__imageSaveOptions)
  assert.ok(saveOptions.every(options => options.title === '保存图片'))
  assert.deepEqual(saveOptions.map(options => options.filters[0].extensions), [['png'], ['jpg', 'jpeg'], ['webp']])
  assert.equal((await fs.readdir(outputRoot)).some(name => name.startsWith('.dustdesk-images-')), false)
  // Batch selection is independent of preview and deleting never touches source/export files.
  await button('导入图片').click(); await settled()
  assert.equal(await rows.count(), 2)
  await rows.last().getByRole('checkbox').check()
  await button('删除选中').click()
  const confirmation = page.getByRole('alertdialog')
  await confirmation.waitFor()
  assert.equal(await confirmation.getByRole('button', { name: '取消', exact: true }).evaluate(node => node === document.activeElement), true)
  await confirmation.getByRole('button', { name: '取消', exact: true }).click()
  assert.equal(await rows.count(), 2)
  await button('删除选中').click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  assert.equal(await rows.count(), 1)
  await page.getByRole('checkbox', { name: '全选图片', exact: true }).check()
  await button('删除选中').click()
  await page.getByRole('alertdialog').getByRole('button', { name: '删除', exact: true }).click()
  await page.getByText('拖入图片开始', { exact: true }).waitFor()
  assert.equal(await rows.count(), 0)
  assert.ok(await page.getByAltText('输出预览', { exact: true }).count() <= 1)
  assert.deepEqual(await fs.readFile(source), Buffer.from(png))
  assert.ok((await fs.readdir(outputRoot)).length > 0)
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ clipboardThumbnails: true, importLock: true, resultInvalidation: true, failedPreviewRecovery: true, saveDialogCancel: true, readCancel: true, workerCancel: true, writeCancel: true, failedOnlyRetry: true, zipContents: true, zipPublicationRetry: true, singleImageFormats: true, watermarkBatch: true, urlCleanup: true, sourcePreserved: true }))
} finally { await closeDustDesk(running) }
