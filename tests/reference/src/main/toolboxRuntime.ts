import { ipcMain, dialog, BrowserWindow, app, clipboard } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { createToolAssets } from './toolAssets'
import type { ImageOptions } from '../shared/toolbox'
import { assertOriginalLanReleased } from './originalLanPreview'
import { assertRuntimeHandbackReleased } from './runtimeHandback'

export function createToolboxRuntime(window: () => BrowserWindow | null, requireInteractive: () => void) {
  const assets = createToolAssets(), downloads = path.join(app.getPath('downloads'), 'DustDesk')
  let confirmationQueue: Promise<unknown> = Promise.resolve()
  let approvals = new AbortController()
  function queued<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = approvals.signal
    const result = confirmationQueue.catch(() => {}).then(async () => { signal.throwIfAborted(); requireInteractive(); const result = await operation(signal); signal.throwIfAborted(); requireInteractive(); return result })
    confirmationQueue = result
    return result
  }
  const lanOptions: Parameters<typeof import('./lanTransfer').createLanService>[0] = {
    storage: path.join(app.getPath('userData'), 'LanTransfers'), downloads, name: os.hostname(),
    changed: snapshot => { const target = window(); if (target && !target.isDestroyed()) target.webContents.send('toolbox:lan-changed', snapshot) },
    confirmPair: (device, code) => queued(async signal => {
      const result = await dialog.showMessageBox({ type: 'question', title: '局域网设备配对', message: `与 ${device.name} 配对`, detail: `请核对两台电脑显示的配对码一致：\n\n${code}\n\n设备地址：${device.address}:${device.port}\n确认身份后，每次接收仍需单独同意。`, buttons: ['取消', '配对码一致，继续'], defaultId: 0, cancelId: 0, noLink: true, signal })
      return result.response === 1
    }),
    confirmReceive: (device, offer) => queued(async signal => {
      const detail = offer.text !== undefined ? `文本预览：\n${offer.text.slice(0, 2000)}${offer.text.length > 2000 ? '\n…' : ''}\n\n接收后可自行复制或保存。` : `${offer.count} 个文件 · ${(offer.total / 1024 / 1024).toFixed(2)} MiB\n${offer.resume ? '继续上次传输，沿用原接收目录。' : '默认目录：' + downloads}`
      const result = await dialog.showMessageBox({ type: 'question', title: '接收局域网内容', message: `${device.name} 请求${offer.resume ? '继续' : ''}发送：${offer.name}`, detail, buttons: offer.text !== undefined || offer.resume ? ['拒绝', '接收'] : ['拒绝', '接收到默认目录', '选择接收目录'], defaultId: 0, cancelId: 0, noLink: true, signal })
      signal.throwIfAborted(); requireInteractive()
      if (!result.response) return false
      if (result.response === 2) { const selected = await dialog.showOpenDialog({ title: '选择接收目录', properties: ['openDirectory', 'createDirectory'] }); return selected.canceled ? false : selected.filePaths[0] ?? false }
      return downloads
    })
  }
  let lanPromise: Promise<ReturnType<typeof import('./lanTransfer').createLanService>> | undefined
  let lanSuspension: symbol | undefined, stopping = false
  function getLan() {
    if (stopping || lanSuspension) throw Error('局域网服务正在维护或停止，不能启动新的操作')
    if (approvals.signal.aborted) approvals = new AbortController()
    return lanPromise ??= assertRuntimeHandbackReleased(app.getPath('userData')).then(() => assertOriginalLanReleased(app.getPath('userData'))).then(() => import('./lanTransfer')).then(async ({ createLanService }) => {
      const lan = createLanService(lanOptions)
      await lan.restore()
      return lan
    }).catch(error => { lanPromise = undefined; throw error })
  }
  async function withInteractiveLan<Result>(operation: (lan: Awaited<ReturnType<typeof getLan>>) => Result | Promise<Result>): Promise<Result> {
    requireInteractive()
    const lan = await getLan()
    requireInteractive()
    return operation(lan)
  }
  function register() {
    const handle = (name: string, callback: (...args: any[]) => unknown) => ipcMain.handle('toolbox:' + name, (event, ...args) => {
      requireInteractive()
      const current = window()
      if (!current || current.isDestroyed() || event.sender !== current.webContents) throw Error('此窗口无工具箱访问权限')
      return callback(...args)
    })
    handle('pick', async (kind: 'image' | 'files' | 'folder') => {
      if (!['image','files','folder'].includes(kind)) throw Error('选择类型无效')
      const result = await dialog.showOpenDialog({ title: kind === 'image' ? '导入图片' : '选择发送内容', properties: kind === 'folder' ? ['openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'], ...(kind === 'image' ? { filters: [{ name: '静态图片', extensions: ['png','jpg','jpeg','webp'] }] } : {}) })
      requireInteractive()
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
      requireInteractive()
      if (result.canceled || !result.filePath) return { canceled: true }
      const temporary = path.join(path.dirname(result.filePath), '.dustdesk-text-' + randomUUID())
      try { await fs.writeFile(temporary, text, { encoding: 'utf8', flag: 'wx' }); await fs.rename(temporary, result.filePath) }
      finally { await fs.rm(temporary, { force: true }) }
      return { path: result.filePath }
    })
    handle('begin-image-export', async (ids: string[], format: ImageOptions['format']) => {
      const { name, extension } = await assets.imageExportName(ids, format)
      requireInteractive()
      const result = await dialog.showSaveDialog({ title: ids.length === 1 ? '保存图片' : '保存图片压缩包', defaultPath: name, filters: [{ name: extension === 'zip' ? 'ZIP 压缩包' : '图片', extensions: extension === 'jpg' ? ['jpg', 'jpeg'] : [extension] }] })
      requireInteractive()
      if (result.canceled || !result.filePath) return {}
      const validExtensions = extension === 'jpg' ? ['.jpg', '.jpeg'] : ['.' + extension]
      const target = validExtensions.includes(path.extname(result.filePath).toLowerCase()) ? result.filePath : result.filePath + '.' + extension
      return assets.beginBatch(target, ids.length)
    })
    handle('export-image', assets.exportImage); handle('end-image-export', assets.endBatch)
    handle('lan-snapshot', () => withInteractiveLan(lan => lan.snapshot()))
    handle('lan-enable', (value: boolean) => withInteractiveLan(lan => lan.enable(value)))
    handle('lan-connect', (address: string, port: number) => withInteractiveLan(lan => lan.connect(address, port)))
    handle('lan-send', (device: string, ids: string[], text?: string) => withInteractiveLan(lan => lan.send(device, assets.transferPaths(ids), text)))
    handle('lan-control', (id: string, action: Parameters<Awaited<ReturnType<typeof getLan>>['control']>[1]) => withInteractiveLan(lan => lan.control(id, action)))
  }
  async function restoreLan() {
    await assertRuntimeHandbackReleased(app.getPath('userData'))
    await assertOriginalLanReleased(app.getPath('userData'))
    try {
      const state = JSON.parse(await fs.readFile(path.join(lanOptions.storage, 'state.json'), 'utf8'))
      if (state.enabled === true) { requireInteractive(); await getLan() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  return {
    register,
    async suspendLan() {
      if (stopping || lanSuspension) throw Error('局域网服务已在维护或停止')
      const token = Symbol('source-snapshot')
      lanSuspension = token
      approvals.abort()
      const active = lanPromise
      try {
        if (active) { await (await active).dispose(); if (lanPromise === active) lanPromise = undefined }
      } catch (error) { if (lanSuspension === token) lanSuspension = undefined; throw error }
      let resumed = false
      return async (restore = true) => {
        if (resumed) return
        if (lanSuspension !== token) throw Error('局域网维护租约已失效')
        resumed = true; lanSuspension = undefined
        // The persistent fence still blocks every restart, but the in-memory
        // maintenance token must not outlive its finished operation. Explicit
        // native recovery can then restore after it has verified the handback.
        if (!stopping && restore) { requireInteractive(); if (active) await getLan(); else await restoreLan() }
      }
    },
    restore: restoreLan,
    async dispose() {
      stopping = true
      approvals.abort()
      const active = lanPromise
      if (active) { await (await active).dispose(); if (lanPromise === active) lanPromise = undefined }
      await assets.dispose()
    }
  }
}
