import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

let app = await launchDustDesk()
const text = '本周工作安排\n整理桌面素材，完成项目验收。\n<script>这些字符应按原文显示</script>\n' + '完整文字内容，支持换行和选择复制。'.repeat(80)
async function waitForWrite(expected) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const last = await app.electronApp.evaluate(() => globalThis.clipboardPreviewWrites.at(-1))
    if (JSON.stringify(last) === JSON.stringify(expected)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  assert.deepEqual(await app.electronApp.evaluate(() => globalThis.clipboardPreviewWrites.at(-1)), expected)
}
try {
  const page = app.window
  const images = await page.evaluate(async () => {
    const create = async color => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360
      const context = canvas.getContext('2d')
      context.fillStyle = color; context.fillRect(0, 0, 640, 360)
      context.fillStyle = '#e5f3ee'; context.fillRect(32, 32, 576, 80)
      context.fillStyle = '#087f6c'; context.font = '32px sans-serif'; context.fillText('DustDesk preview', 54, 84)
      return [...new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve))).arrayBuffer())]
    }
    return [await create('#087f6c'), await create('#c4dfd6')]
  })
  const encoded = Buffer.from(images[0]).toString('base64')
  const missingBytes = Buffer.from(images[1])
  const missingName = `${createHash('sha256').update(missingBytes).digest('hex')}.png`
  await page.evaluate(async ({ encoded, missingName, text }) => {
    const state = await window.dustdesk.loadWorkspace()
    const base = { Text: '', ImagePngBase64: '', ImageFileName: '', ImageSha256: '', CreatedAt: new Date().toISOString(), IsLocked: false, IsPinned: false }
    await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, ClipboardMonitoringEnabled: false }, ClipboardHistory: [
      { ...base, Id: 'preview-image', Kind: 'Image', ImagePngBase64: encoded, ImageFileName: '桌面素材.png' },
      { ...base, Id: 'preview-text', Kind: 'Text', Text: text },
      { ...base, Id: 'preview-missing', Kind: 'Image', ImageAssetName: missingName, ImageFileName: '待恢复图片.png' }
    ] }, state)
  }, { encoded, missingName, text })
  await app.electronApp.evaluate(({ clipboard }) => {
    globalThis.clipboardPreviewWrites = []
    clipboard.writeText = value => globalThis.clipboardPreviewWrites.push({ text: value })
    clipboard.writeImage = image => globalThis.clipboardPreviewWrites.push({ pixels: process.getBuiltinModule('crypto').createHash('sha256').update(image.toBitmap()).digest('hex') })
  })
  const expectedPixels = await app.electronApp.evaluate(({ nativeImage }, encoded) => process.getBuiltinModule('crypto').createHash('sha256').update(nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')).toBitmap()).digest('hex'), encoded)
  await page.locator('.sidebar').getByText('剪贴板', { exact: true }).click()
  const thumbnail = page.getByAltText('缩略图：桌面素材.png', { exact: true })
  await thumbnail.waitFor()
  await thumbnail.evaluate(image => image.decode())
  assert.deepEqual(await thumbnail.evaluate(image => [image.naturalWidth, image.naturalHeight]), [160, 90])
  assert.deepEqual(await app.electronApp.evaluate(() => globalThis.clipboardPreviewWrites), [])
  await page.getByRole('button', { name: '查看图片：桌面素材.png', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '图片预览', exact: true })
  const full = dialog.getByAltText('桌面素材.png', { exact: true })
  await full.waitFor(); await full.evaluate(image => image.decode())
  assert.deepEqual(await full.evaluate(image => [image.naturalWidth, image.naturalHeight]), [640, 360])
  assert.deepEqual(await app.electronApp.evaluate(() => globalThis.clipboardPreviewWrites), [])
  await dialog.getByRole('button', { name: '复制图片', exact: true }).click()
  await page.getByText('已复制到系统剪贴板', { exact: true }).last().waitFor()
  await waitForWrite({ pixels: expectedPixels })
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' })
  assert.equal(await page.getByRole('button', { name: '查看图片：桌面素材.png', exact: true }).evaluate(element => element === document.activeElement), true)

  const textRow = page.locator('[data-clipboard-id="preview-text"]')
  await textRow.getByRole('button', { name: /^预览内容/ }).click()
  assert.equal(await page.locator('.clipboard-text-preview').textContent(), text)
  await page.getByRole('button', { name: '复制文字', exact: true }).click()
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click()
  await waitForWrite({ text })

  await page.getByRole('button', { name: '查看图片：待恢复图片.png', exact: true }).click()
  await page.getByRole('dialog').getByText('图片文件已丢失，无法预览', { exact: true }).waitFor()
  await fs.writeFile(path.join(app.tempRoot, 'data', 'ClipboardImages', missingName), missingBytes)
  await page.getByRole('button', { name: '重试预览', exact: true }).click()
  await page.getByRole('dialog').getByAltText('待恢复图片.png', { exact: true }).waitFor()
  await page.keyboard.press('Escape')
  await page.getByAltText('缩略图：待恢复图片.png', { exact: true }).waitFor()
  await page.getByPlaceholder('搜索剪贴板历史').fill('没有匹配项')
  await page.getByText('没有匹配的记录', { exact: true }).waitFor()
  await page.getByPlaceholder('搜索剪贴板历史').clear()
  await page.getByAltText('缩略图：待恢复图片.png', { exact: true }).waitFor()

  const created = app.electronApp.waitForEvent('window', { predicate: candidate => candidate !== page })
  await page.evaluate(() => window.dustdesk.setWidgetVisibility('clipboard', true))
  const widget = await created
  await widget.getByAltText('缩略图：桌面素材.png', { exact: true }).waitFor()
  const widgetSize = await widget.locator('.widget-clipboard-thumbnail').first().evaluate(element => [Math.round(element.getBoundingClientRect().width), Math.round(element.getBoundingClientRect().height)])
  assert.deepEqual(widgetSize, [52, 40])
  await textRow.getByRole('button', { name: /^预览内容/ }).click()
  await page.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    await window.dustdesk.saveWorkspace({ ...state, ClipboardHistory: state.ClipboardHistory.filter(item => item.Id !== 'preview-text') }, state)
  })
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  await widget.locator('.widget-todo').filter({ hasText: '本周工作安排' }).waitFor({ state: 'hidden' })

  const screenshotRoot = path.resolve('test-artifacts')
  await fs.mkdir(screenshotRoot, { recursive: true })
  for (const [theme, width] of [['light', 1400], ['dark', 960]]) {
    await page.evaluate(async theme => {
      const state = await window.dustdesk.loadWorkspace()
      await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, Theme: theme } }, state)
    }, theme)
    await app.electronApp.evaluate(({ BrowserWindow }, width) => BrowserWindow.getAllWindows().find(window => !window.webContents.getURL().includes('widget=')).setSize(width, 820), width)
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, theme)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
    await page.screenshot({ path: path.join(screenshotRoot, `clipboard-preview-${theme}.png`) })
  }
  // Persisted image references must still preview after a fresh process starts.
  await closeDustDesk({ ...app, preserveTempRoot: true })
  app = await launchDustDesk({ tempRoot: app.tempRoot })
  await app.window.locator('.sidebar').getByText('剪贴板', { exact: true }).click()
  await app.window.getByAltText('缩略图：桌面素材.png', { exact: true }).waitFor()
  console.log('Clipboard thumbnails, original image copy, text preview, missing-file retry, keyboard close, widget sync, themes and restart passed')
} finally { await closeDustDesk(app) }
