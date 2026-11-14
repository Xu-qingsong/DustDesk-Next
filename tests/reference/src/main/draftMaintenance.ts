import type { BrowserWindow, IpcMain, IpcMainEvent, WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { maxDraftArchiveBytes, validateDraftEntry, type DraftEntry } from '../shared/draftMigration'

type Session = { id: string; ready: boolean; cancelled: boolean }
type Checkpoint = { workspaceFingerprint: string; entries: DraftEntry[] }
export type DraftCollectionContext = { signal: AbortSignal; assertActive: () => void }
export type DraftMaintenanceContext = DraftCollectionContext & { holdForRecovery: () => void }
type Options = { signal?: AbortSignal; timeoutMilliseconds?: number }

function validateEntries(entries: unknown): DraftEntry[] {
  if (!Array.isArray(entries) || entries.length > 5000) throw Error('迁移草稿条目无效或超过上限')
  const checked = entries.map(validateDraftEntry)
  if (new Set(checked.map(entry => entry.key)).size !== checked.length) throw Error('迁移草稿包含重复键')
  let bytes = 0
  for (const entry of checked) bytes += new TextEncoder().encode(JSON.stringify(entry)).length
  if (bytes > maxDraftArchiveBytes) throw Error('迁移草稿超过 64 MiB，未截断或导出')
  return checked
}

export function createDraftMaintenance(ipc: Pick<IpcMain, 'on' | 'removeListener'>, timeoutMilliseconds = 35000, trustedLocation?: string, startupGuard?: () => void) {
  let current: Session | undefined
  const requireInteractive = () => { startupGuard?.(); if (current) throw Error('正在迁移维护，不能开始新的操作') }
  const requireWritable = () => { startupGuard?.(); if (current?.ready) throw Error('正在迁移维护，不能接受新保存') }
  async function collect(owner: BrowserWindow, windows: BrowserWindow[], seal: (ready: () => void) => Promise<string>, sourceReader?: (context: DraftMaintenanceContext) => Promise<DraftEntry[]>, options: Options = {}): Promise<Checkpoint> {
    requireInteractive()
    const timeout = options.timeoutMilliseconds ?? timeoutMilliseconds
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 600000) throw Error('迁移维护时限无效')
    if (options.signal?.aborted) throw Error('迁移维护已由用户取消')
    const participants = [...new Set(windows)]
    if (owner.isDestroyed() || !participants.includes(owner) || participants.some(window => window.isDestroyed())) throw Error('迁移参与窗口已关闭')
    const participantSenders = new Map(participants.map(window => [window, window.webContents]))
    const source = owner.webContents
    const location = new URL(source.getURL())
    if (trustedLocation) {
      const expected = new URL(trustedLocation)
      if (location.protocol !== expected.protocol || location.host !== expected.host || location.origin !== expected.origin || location.pathname !== expected.pathname) throw Error('主窗口存储来源不是应用入口，未导出')
    }
    for (const window of participants) {
      const target = new URL(window.webContents.getURL())
      if (window.webContents.session !== source.session || target.protocol !== location.protocol || target.host !== location.host || target.origin !== location.origin || target.pathname !== location.pathname) throw Error('迁移参与窗口的存储来源不一致，未导出')
    }
    const session: Session = { id: randomUUID(), ready: false, cancelled: false }
    current = session
    const controller = new AbortController()
    let sourceOperation: Promise<DraftEntry[]> | undefined
    let retained = false
    const assertActive = () => { if (current !== session || session.cancelled) throw Error('迁移维护请求已失效') }
    const holdForRecovery = () => { assertActive(); if (!session.ready) throw Error('迁移维护尚未封存'); retained = true }
    const pending = new Set(participants.map(window => window.webContents))
    let saved!: () => void; let collected!: (entries: DraftEntry[]) => void; let cancel!: (error: Error) => void
    const saving = new Promise<void>(resolve => { saved = resolve })
    const collection = new Promise<DraftEntry[]>(resolve => { collected = resolve })
    const cancelled = new Promise<never>((_resolve, reject) => { cancel = reject })
    const fail = (error: unknown) => { session.cancelled = true; controller.abort(); cancel(error instanceof Error ? error : Error(String(error))) }
    const aborted = () => fail('迁移维护已由用户取消')
    options.signal?.addEventListener('abort', aborted, { once: true })
    const acknowledged = new Set<WebContents>()
    const acknowledge = (event: IpcMainEvent, id: string, error?: unknown) => {
      if (current !== session || session.cancelled || session.ready || id !== session.id || !pending.has(event.sender)) return
      pending.delete(event.sender); acknowledged.add(event.sender)
      if (error !== undefined && error !== null) { fail(typeof error === 'string' ? error : '迁移保存响应无效'); return }
      if (!pending.size) saved()
    }
    let requested = false
    const receive = (event: IpcMainEvent, id: string, entries: unknown, error?: unknown) => {
      if (current !== session || session.cancelled || !session.ready || !requested || id !== session.id || event.sender !== source) return
      requested = false
      try {
        if (error !== undefined && error !== null) throw Error(typeof error === 'string' ? error : '迁移草稿响应无效')
        collected(validateEntries(entries))
      } catch (error) { fail(error) }
    }
    const lost = () => fail('迁移参与窗口已关闭或重载，未导出')
    const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) lost() }
    ipc.on('drafts:flushed', acknowledge); ipc.on('drafts:collected', receive)
    for (const window of participants) {
      window.webContents.on('destroyed', lost); window.webContents.on('render-process-gone', lost); window.webContents.on('did-start-navigation', navigated)
    }
    const timer = setTimeout(() => fail('等待所有窗口迁移保存超时，未导出'), timeout)
    timer.unref()
    try {
      const operation = async () => {
        for (const window of participants) { assertActive(); window.webContents.send('drafts:flush', session.id) }
        await saving; assertActive()
        const workspaceFingerprint = await seal(() => { assertActive(); if (pending.size || acknowledged.size !== participants.length) throw Error('迁移保存尚未完成'); session.ready = true })
        assertActive()
        if (!session.ready || !/^[a-f0-9]{64}$/.test(workspaceFingerprint)) throw Error('迁移工作区检查点无效')
        if (sourceReader) {
          sourceOperation = Promise.resolve().then(() => { assertActive(); return sourceReader({ signal: controller.signal, assertActive, holdForRecovery }) })
          const entries = validateEntries(await sourceOperation)
          assertActive()
          return { workspaceFingerprint, entries }
        }
        requested = true; source.send('drafts:collect', session.id)
        const entries = await collection; assertActive()
        return { workspaceFingerprint, entries }
      }
      return await Promise.race([operation(), cancelled])
    } finally {
      clearTimeout(timer)
      session.cancelled = true
      controller.abort()
      options.signal?.removeEventListener('abort', aborted)
      ipc.removeListener('drafts:flushed', acknowledge); ipc.removeListener('drafts:collected', receive)
      for (const window of participants) {
        const sender = participantSenders.get(window)!
        sender.removeListener('destroyed', lost); sender.removeListener('render-process-gone', lost); sender.removeListener('did-start-navigation', navigated)
      }
      await sourceOperation?.catch(() => {})
      if (!retained && current === session) current = undefined
      for (const window of participants) {
        const sender = participantSenders.get(window)!
        if (!retained && !window.isDestroyed() && !sender.isDestroyed()) { try { sender.send('drafts:resume', session.id) } catch {} }
      }
    }
  }
  async function run<T>(owner: BrowserWindow, windows: BrowserWindow[], seal: (ready: () => void) => Promise<string>, operation: (fingerprint: string, context: DraftMaintenanceContext) => Promise<T>, options: Options = {}): Promise<T> {
    let fingerprint!: string, result!: T
    await collect(owner, windows, async ready => { fingerprint = await seal(ready); return fingerprint }, async context => {
      result = await operation(fingerprint, context)
      return []
    }, options)
    return result
  }
  return { collect, run, requireInteractive, requireWritable, get busy() { return current !== undefined } }
}
