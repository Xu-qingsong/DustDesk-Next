import { BrowserWindow, ipcMain } from 'electron'
import type { IpcMainEvent, Session } from 'electron'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { draftMigrationJournalKey, draftMigrationReceiptsKey, maxDraftArchiveBytes, type NativeDraftDecision } from '../shared/draftMigration'
import type { DraftBrowserSnapshot } from './draftTransaction'
import type { DraftCollectionContext } from './draftMaintenance'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const draftKey = (key: string) => key.startsWith('widget-note:') || ['widget-notes:selected', 'widget-task-draft:v1:todo', 'quick-capture-draft'].includes(key)
async function checkPath(location: string) {
  for (let current = location; ; current = path.dirname(current)) {
    if ((await fs.lstat(current)).isSymbolicLink()) throw Error('浏览器配置路径包含链接或重解析点')
    if (path.dirname(current) === current) return
  }
}

// The caller supplies the configured native entry and actual Electron Session,
// never a renderer-selected URL/path/binding. All same-origin editors must be
// held behind the caller's native maintenance/startup gate for this lifetime.
export async function openDraftBrowser(session: Session, location: string, context: DraftCollectionContext) {
  context.assertActive()
  const entry = new URL(location)
  if (entry.protocol !== 'file:' || entry.search || entry.hash || entry.href !== location) throw Error('草稿写入仅允许精确的当前应用 file URL')
  fileURLToPath(entry)
  const profile = session.storagePath
  if (!profile || !path.isAbsolute(profile)) throw Error('Electron 浏览器没有可持久化的实际配置目录')
  if (session.protocol.isProtocolHandled('file')) throw Error('文件协议已有处理器，不能接管受控草稿页')
  await checkPath(profile)
  const directory = await fs.open(profile, 'r')
  let window: BrowserWindow | undefined, installed = false, closed = false, served = false, navigations = 0
  let tail: Promise<unknown> = Promise.resolve()
  let interrupted: Error | undefined
  let rejectCurrent: ((error: Error) => void) | undefined
  const token = randomUUID()
  const identity = async (handle: FileHandle) => {
    await checkPath(profile)
    const [held, current] = await Promise.all([handle.stat({ bigint: true }), fs.lstat(profile, { bigint: true })])
    if (!held.isDirectory() || !current.isDirectory() || held.ino === 0n || held.ino !== current.ino || held.dev !== current.dev || current.isSymbolicLink() || session.storagePath !== profile) throw Error('实际 Electron 浏览器配置身份已改变')
    return { volume: held.dev.toString(16).padStart(16, '0'), file: held.ino.toString(16).padStart(16, '0') }
  }
  const assertActive = () => {
    context.assertActive()
    if (closed || interrupted || !window || window.isDestroyed() || window.webContents.isDestroyed() || window.webContents.session !== session || window.webContents.getURL() !== location) throw interrupted ?? Error('受控草稿页面已失效')
  }
  const lost = (reason: unknown) => {
    interrupted ??= reason instanceof Error ? reason : Error(String(reason))
    rejectCurrent?.(interrupted)
  }
  const currentFrame = (event: IpcMainEvent) => {
    if (closed || !window || window.isDestroyed() || event.sender !== window.webContents || !served || event.sender.getURL() !== location) return false
    const frame = event.senderFrame, main = window.webContents.mainFrame
    return !!frame && frame.processId === main.processId && frame.routingId === main.routingId && frame.url === location
  }
  const onAbort = () => { lost('受控草稿维护已取消'); if (window && !window.isDestroyed()) window.destroy() }
  const close = async () => {
    if (closed) return
    closed = true
    lost('受控草稿页已关闭，原生事务记录保持原状')
    context.signal.removeEventListener('abort', onAbort)
    ipcMain.removeListener('draft-control:ready', ready)
    ipcMain.removeListener('draft-control:result', receive)
    if (window && !window.isDestroyed()) window.destroy()
    if (installed) { session.protocol.unhandle('file'); installed = false }
    await directory.close()
  }
  let onReady!: () => void
  const ready = (event: IpcMainEvent, request: string) => { if (request === token && currentFrame(event)) onReady() }
  let onResult: ((event: IpcMainEvent, request: string, id: string, error: unknown) => void) | undefined
  const receive = (event: IpcMainEvent, request: string, id: string, error: unknown) => onResult?.(event, request, id, error)
  const queue = <T,>(operation: () => Promise<T>) => {
    const result = tail.catch(() => {}).then(operation)
    tail = result
    return result
  }
  try {
    const physicalProfile = await identity(directory)
    const binding = digest(JSON.stringify({ version: 1, runtime: 'electron', entry: location, profile: physicalProfile }))
    const check = async () => {
      assertActive()
      if (JSON.stringify(await identity(directory)) !== JSON.stringify(physicalProfile)) throw Error('实际 Electron 浏览器配置已更换')
      assertActive()
    }
    context.signal.addEventListener('abort', onAbort, { once: true })
    if (context.signal.aborted) throw Error('受控草稿维护已取消')
    session.protocol.handle('file', request => {
      if (request.url !== location || request.method !== 'GET' || served || closed) return new Response(null, { status: 403 })
      context.assertActive(); served = true
      return new Response('<!doctype html><html><head><meta charset="utf-8"><title>DustDesk 草稿受控恢复</title></head><body></body></html>', { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
      } })
    })
    installed = true
    window = new BrowserWindow({ show: false, width: 160, height: 100, webPreferences: {
      session, preload: fileURLToPath(new URL('../preload/index.js', import.meta.url)),
      additionalArguments: ['--dustdesk-controlled-drafts', '--dustdesk-draft-token=' + token],
      sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
      webSecurity: true, allowRunningInsecureContent: false, backgroundThrottling: false
    } })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.webContents.on('will-frame-navigate', event => event.preventDefault())
    window.webContents.on('will-redirect', event => event.preventDefault())
    window.webContents.on('will-attach-webview', event => event.preventDefault())
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace && ++navigations > 1) lost('受控草稿页发生重新导航') })
    window.webContents.on('destroyed', () => lost('受控草稿窗口已销毁'))
    window.webContents.on('render-process-gone', () => lost('受控草稿进程已退出'))
    window.webContents.on('preload-error', (_event, _path, error) => lost(error))
    ipcMain.on('draft-control:ready', ready); ipcMain.on('draft-control:result', receive)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => lost('受控草稿页启动超时'), 10000)
      rejectCurrent = error => { clearTimeout(timer); reject(error) }
      onReady = () => { clearTimeout(timer); rejectCurrent = undefined; resolve() }
      void window!.loadURL(location).catch(error => { clearTimeout(timer); lost(error) })
    })
    await check()
    const rpc = async (request: object) => {
      await check()
      const id = randomUUID()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(() => lost('受控草稿操作超时，须保留原生决定并恢复'), 15000)
          rejectCurrent = error => { clearTimeout(timer); reject(error) }
          onResult = (event, requestToken, responseId, error) => {
            if (requestToken !== token || responseId !== id || !currentFrame(event)) return
            clearTimeout(timer)
            if (error !== null) reject(Error(typeof error === 'string' ? error : '受控草稿响应无效'))
            else resolve()
          }
          window!.webContents.send('draft-control:execute', { ...request, token, id })
        })
        await check()
      } catch (error) { lost(error); throw error }
      finally { clearTimeout(timer); onResult = undefined; rejectCurrent = undefined }
    }
    return Object.freeze({
      binding,
      snapshot: (additionalKeys: string[] = []) => {
        const keys = [...additionalKeys]
        if (keys.length > 5000 || keys.some(key => typeof key !== 'string' || key.length > 2048 || !draftKey(key))) return Promise.reject(Error('原生草稿观察键无效'))
        return queue(async (): Promise<DraftBrowserSnapshot> => {
          await check()
          const script = `(() => {
            const keys = new Set(${JSON.stringify(keys)}), length = localStorage.length;
            const original = Array.from({length}, (_, index) => localStorage.key(index));
            for (const key of original) {
              if (key === null) throw Error('草稿存储已改变');
              if (key.startsWith('widget-note:') || ['widget-notes:selected','widget-task-draft:v1:todo','quick-capture-draft'].includes(key)) keys.add(key);
            }
            if (keys.size > 5000) throw Error('草稿观察超出上限');
            const values = Object.fromEntries([...keys].map(key => [key, localStorage.getItem(key)]));
            const result = {journal:localStorage.getItem(${JSON.stringify(draftMigrationJournalKey)}),receipts:localStorage.getItem(${JSON.stringify(draftMigrationReceiptsKey)}),values};
            if (localStorage.length !== length || original.some((key,index) => localStorage.key(index) !== key) || [...keys].some(key => localStorage.getItem(key) !== values[key])) throw Error('草稿存储在观察时已改变');
            return JSON.stringify(result);
          })()`
          const raw: unknown = await window!.webContents.executeJavaScript(script)
          if (typeof raw !== 'string' || Buffer.byteLength(raw) > maxDraftArchiveBytes * 4) throw Error('实际浏览器草稿观察无效或过大')
          const result: DraftBrowserSnapshot = JSON.parse(raw)
          for (const value of [result.journal, result.receipts]) if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > maxDraftArchiveBytes)) throw Error('实际浏览器草稿日志无效或过大')
          let total = 0
          for (const value of Object.values(result.values)) if (value !== null) { if (typeof value !== 'string') throw Error('实际浏览器草稿值无效'); total += Buffer.byteLength(value) }
          if (total > maxDraftArchiveBytes) throw Error('实际浏览器草稿超过 64 MiB')
          await check()
          return result
        })
      },
      stage: (serialized: string, fingerprint: string) => queue(() => rpc({ operation: 'stage', serialized, fingerprint })),
      recover: (decision: NativeDraftDecision) => { const observed = structuredClone(decision); return queue(() => rpc({ operation: 'recover', decision: observed })) },
      flush: () => queue(async () => { await check(); session.flushStorageData(); await check() }),
      close
    })
  } catch (error) { await close(); throw error }
}
