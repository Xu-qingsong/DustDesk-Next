import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent } from 'electron'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import type { DraftEntry } from '../shared/draftMigration'
import type { DraftCollectionContext } from './draftMaintenance'

export async function legacyInstallationEntry(directory: string): Promise<string> {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('请选择旧版 DustDesk 安装目录')
  const root = path.resolve(directory)
  if (!(await fs.stat(root)).isDirectory()) throw Error('旧安装路径不是目录')
  return pathToFileURL(path.join(root, 'resources', 'app.asar', 'out', 'renderer', 'index.html')).href
}

export async function readLegacyDrafts(owner: BrowserWindow, location: string, context: DraftCollectionContext): Promise<DraftEntry[]> {
  context.assertActive()
  if (new URL(location).protocol !== 'file:') throw Error('旧草稿仅允许受控的本地安装路径')
  const session = owner.webContents.session
  const protocol = session.protocol
  if (protocol.isProtocolHandled('file')) throw Error('文件协议已有处理器，不能安全接管旧草稿读取')
  const token = randomUUID()
  let window: BrowserWindow | undefined
  let installed = false
  let served = false
  let finished = false
  let resolve!: (entries: DraftEntry[]) => void
  let reject!: (error: Error) => void
  const result = new Promise<DraftEntry[]>((accept, fail) => { resolve = accept; reject = fail })
  const fail = (error: unknown) => { if (finished) return; finished = true; reject(error instanceof Error ? error : Error(String(error))) }
  const cleanup = () => {
    context.signal.removeEventListener('abort', aborted)
    ipcMain.removeListener('draft-reader:ready', ready); ipcMain.removeListener('draft-reader:result', receive)
    if (installed) { protocol.unhandle('file'); installed = false }
    if (window && !window.isDestroyed()) { window.webContents.removeListener('destroyed', lost); window.destroy() }
  }
  const aborted = () => { fail('旧草稿读取维护已取消'); cleanup() }
  const currentFrame = (event: IpcMainEvent) => {
    if (!window || window.isDestroyed() || event.sender !== window.webContents || !served || window.webContents.getURL() !== location) return false
    const frame = event.senderFrame; const main = window.webContents.mainFrame
    return !!frame && frame.processId === main.processId && frame.routingId === main.routingId && frame.url === location
  }
  const ready = (event: IpcMainEvent) => {
    if (finished || !currentFrame(event)) return
    try { context.assertActive(); window!.webContents.send('draft-reader:collect', token) } catch (error) { fail(error) }
  }
  const receive = (event: IpcMainEvent, request: string, entries: DraftEntry[], error?: unknown) => {
    if (finished || request !== token || !currentFrame(event)) return
    try {
      context.assertActive()
      if (error !== undefined && error !== null) throw Error(typeof error === 'string' ? error : '旧草稿读取响应无效')
      if (!Array.isArray(entries)) throw Error('旧草稿读取响应无效')
      finished = true; resolve(entries)
    } catch (reason) { fail(reason) }
  }
  const lost = () => fail('旧草稿读取窗口已关闭')
  const timer = setTimeout(() => fail('受控旧草稿读取超时，未导出'), 10000)
  timer.unref()
  try {
    context.signal.addEventListener('abort', aborted, { once: true })
    context.assertActive()
    protocol.handle('file', request => {
      if (request.url !== location) return session.fetch(request, { bypassCustomProtocolHandlers: true })
      context.assertActive()
      if (request.method !== 'GET') return new Response(null, { status: 405 })
      served = true
      return new Response('<!doctype html><html><head><meta charset="utf-8"><title>DustDesk 草稿受控读取</title></head><body></body></html>', { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
      } })
    })
    installed = true
    const preload = fileURLToPath(new URL('../preload/index.js', import.meta.url))
    window = new BrowserWindow({ show: false, width: 160, height: 100, webPreferences: { session, preload, additionalArguments: ['--dustdesk-read-only-drafts'], sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-frame-navigate', event => event.preventDefault())
    window.webContents.on('will-redirect', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('preload-error', (_event, _path, error) => fail(error))
    window.webContents.on('render-process-gone', lost)
    window.webContents.on('destroyed', lost)
    ipcMain.on('draft-reader:ready', ready); ipcMain.on('draft-reader:result', receive)
    void window.loadURL(location).catch(fail)
    const entries = await result
    context.assertActive()
    return entries
  } finally { clearTimeout(timer); cleanup() }
}
