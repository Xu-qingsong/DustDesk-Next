import { ipcMain, dialog, BrowserWindow, app, clipboard } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createToolAssets } from './toolAssets'
import { createLanService } from './lanTransfer'
import type { ImageOptions } from '../shared/toolbox'

export function createToolboxRuntime(window: () => BrowserWindow | null) {
  const assets = createToolAssets(), downloads = path.join(app.getPath('downloads'), 'DustDesk')
  let confirmationQueue: Promise<unknown> = Promise.resolve()
  function queued<T>(operation: () => Promise<T>): Promise<T> { const result = confirmationQueue.catch(() => {}).then(operation); confirmationQueue = result; return result }
  const lan = createLanService({
    storage: path.join(app.getPath('userData'), 'LanTransfers'), downloads, name: os.hostname(),
    changed: snapshot => { const target = window(); if (target && !target.isDestroyed()) target.webContents.send('toolbox:lan-changed', snapshot) },
    confirmPair: (device, code) => queued(async () => {
      const result = await dialog.showMessageBox({ type: 'question', title: '局域网设备配对', message: `与 ${device.name} 配对`, detail: `请核对两台电脑显示的配对码一致：\n\n${code}\n\n设备地址：${device.address}:${device.port}\n确认身份后，每次接收仍需单独同意。`, buttons: ['取消', '配对码一致，继续'], defaultId: 0, cancelId: 0, noLink: true })
      return result.response === 1
    }),
    confirmReceive: (device, offer) => queued(async () => {
      const detail = offer.text !== undefined ? `文本预览：\n${offer.text.slice(0, 2000)}${offer.text.length > 2000 ? '\n…' : ''}\n\n接收后可自行复制或保存。` : `${offer.count} 个文件 · ${(offer.total / 1024 / 1024).toFixed(2)} MiB\n${offer.resume ? '继续上次传输，沿用原接收目录。' : '默认目录：' + downloads}`
      const result = await dialog.showMessageBox({ type: 'question', title: '接收局域网内容', message: `${device.name} 请求${offer.resume ? '继续' : ''}发送：${offer.name}`, detail, buttons: offer.text !== undefined || offer.resume ? ['拒绝', '接收'] : ['拒绝', '接收到默认目录', '选择接收目录'], defaultId: 0, cancelId: 0, noLink: true })
      if (!result.response) return false
      if (result.response === 2) { const selected = await dialog.showOpenDialog({ title: '选择接收目录', properties: ['openDirectory', 'createDirectory'] }); return selected.canceled ? false : selected.filePaths[0] ?? false }
      return downloads
    })
  })
  function register() {
    const handle = (name: string, callback: (...args: any[]) => unknown) => ipcMain.handle('toolbox:' + name, (event, ...args) => {
      const current = window()
      if (!current || current.isDestroyed() || event.sender !== current.webContents) throw Error('此窗口无工具箱访问权限')
      return callback(...args)
    })
    handle('pick', async (kind: 'image' | 'files' | 'folder') => {
      if (!['image','files','folder'].includes(kind)) throw Error('选择类型无效')
      const result = await dialog.showOpenDialog({ title: kind === 'image' ? '导入图片' : '选择发送内容', properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'], ...(kind === 'image' ? { filters: [{ name: '静态图片', extensions: ['png','jpg','jpeg','webp'] }] } : {}) })
      return result.canceled ? [] : assets.registerPaths(result.filePaths, kind === 'image' ? 'image' : 'transfer')
    })
    handle('register-paths', assets.registerPaths)
    handle('import-image', assets.importImage)
    handle('read-asset', assets.readAsset)
    handle('release-assets', assets.releaseAssets)
    handle('copy-text', (text: string) => { assets.validateText(text); clipboard.writeText(text) })
    handle('export-text', async (text: string) => {
      assets.validateText(text)
      const result = await dialog.showSaveDialog({ title: '导出 UTF-8 文本', defaultPath: 'DustDesk-文本.txt', filters: [{ name: '文本', extensions: ['txt','json'] }] })
      if (result.canceled || !result.filePath) return { canceled: true }
      const temporary = path.join(path.dirname(result.filePath), '.dustdesk-text-' + randomUUID())
      try { await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, result.filePath) }
      finally { await fs.rm(temporary, { force: true }) }
      return { path: result.filePath }
    })
    handle('begin-image-export', async (ids: string[], format: ImageOptions['format']) => {
      const { name, extension } = await assets.imageExportName(ids, format)
      const result = await dialog.showSaveDialog({ title: ids.length === 1 ? '保存图片' : '保存图片压缩包', defaultPath: name, filters: [{ name: extension === 'zip' ? 'ZIP 压缩包' : '图片', extensions: extension === 'jpg' ? ['jpg', 'jpeg'] : [extension] }] })
      if (result.canceled || !result.filePath) return {}
      const validExtensions = extension === 'jpg' ? ['.jpg', '.jpeg'] : ['.' + extension]
      const target = validExtensions.includes(path.extname(result.filePath).toLowerCase()) ? result.filePath : result.filePath + '.' + extension
      return assets.beginBatch(target, ids.length)
    })
    handle('export-image', assets.exportImage); handle('end-image-export', assets.endBatch)
    handle('lan-snapshot', lan.snapshot); handle('lan-enable', lan.enable); handle('lan-connect', lan.connect)
    handle('lan-send', (device: string, ids: string[], text?: string) => lan.send(device, assets.transferPaths(ids), text))
    handle('lan-control', lan.control)
  }
  return { register, restore: () => lan.restore(), async dispose() { await lan.dispose(); await assets.dispose() } }
}
