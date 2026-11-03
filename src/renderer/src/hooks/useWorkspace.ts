import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { WorkspaceState } from '../../../shared/types'
import { starterState } from '../app/workspace'
import type { PersistWorkspace } from '../components/common'

type PendingSave = { next: WorkspaceState; baseline: WorkspaceState; message: string; readyAt: number; waiters: { resolve(): void; reject(error: unknown): void }[] }

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState>(starterState)
  const [loaded, setLoaded] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const pending = useRef<PendingSave[]>([])
  const activeSave = useRef<Promise<void> | null>(null)
  const saving = useRef<PendingSave | null>(null), forceFlush = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const schedule = useRef<() => void>(() => {})
  const readable = useRef(false)
  const broadcastRevision = useRef(0)
  useEffect(() => {
    const revision = broadcastRevision.current
    void Promise.all([window.dustdesk.loadWorkspace(), window.dustdesk.getDataLocation()]).then(([next, path]) => {
      if (revision === broadcastRevision.current) setState(next)
      setDataPath(path); readable.current = true; setLoaded(true)
    }).catch(() => { setLoaded(true); toast.error('无法读取完整工作区，原文件已保留，请从备份恢复') })
  }, [])
  useEffect(() => window.dustdesk.onWorkspaceChanged(next => {
    ++broadcastRevision.current
    if (pending.current.length) return
    readable.current = true
    setState(next)
  }), [])

  const flush = useCallback((force = true): Promise<void> => {
    if (force) { clearTimeout(timer.current); forceFlush.current = true }
    if (activeSave.current) return activeSave.current
    if (!pending.current.length) { forceFlush.current = false; return Promise.resolve() }
    const operation = (async () => {
      try {
        while (pending.current.length) {
          const item = pending.current[0]!
          if (!forceFlush.current && item.readyAt > Date.now()) break
          saving.current = item
          await window.dustdesk.saveWorkspace(item.next, item.baseline)
          pending.current.shift(); saving.current = null
          item.waiters.forEach(waiter => waiter.resolve())
          if (item.message && !pending.current.length) toast.success(item.message)
        }
        if (pending.current.length) return
        const revision = broadcastRevision.current
        const saved = await window.dustdesk.loadWorkspace()
        // Input or a newer broadcast can arrive while this snapshot is in transit.
        if (!pending.current.length && revision === broadcastRevision.current) setState(saved)
      } catch (error) {
        for (const item of pending.current) { item.waiters.splice(0).forEach(waiter => waiter.reject(error)) }
        throw error
      }
    })()
    activeSave.current = operation
    void operation.then(() => { activeSave.current = null; forceFlush.current = false; schedule.current() }, () => { activeSave.current = null; saving.current = null; forceFlush.current = false })
    return operation
  }, [])
  schedule.current = () => {
    clearTimeout(timer.current)
    const item = pending.current[0]
    if (!item || activeSave.current) return
    timer.current = setTimeout(() => { void flush(false).catch(() => {}) }, Math.max(0, item.readyAt - Date.now()))
  }
  useEffect(() => window.dustdesk.onBeforeQuit(async () => {
    if (!pending.current.length && !activeSave.current) return
    do { await flush() } while (pending.current.length)
  }), [flush])
  useEffect(() => () => { clearTimeout(timer.current); void flush().catch(() => {}) }, [flush])

  const persist = useCallback<PersistWorkspace>(async (next, message = '已保存', delayMs = 0) => {
    if (!readable.current) { toast.error('工作区尚未完整读取，未覆盖原文件'); return }
    const completion = new Promise<void>((resolve, reject) => {
      const tail = pending.current.at(-1)
      if (delayMs > 0 && tail && tail !== saving.current && tail.readyAt > 0) {
        // Keep the first editing baseline so all coalesced fields reach the main-process merge.
        tail.next = next; tail.message = message; tail.readyAt = Date.now() + delayMs; tail.waiters.push({ resolve, reject })
      } else pending.current.push({ next, baseline: state, message, readyAt: delayMs > 0 ? Date.now() + delayMs : 0, waiters: [{ resolve, reject }] })
    })
    setState(next)
    if (delayMs > 0) schedule.current()
    else void flush().catch(() => {})
    try { await completion }
    catch { toast.error('保存失败，修改仍保留在界面中；下次保存或退出时会重试', { id: 'workspace-save-error' }) }
  }, [state, flush])
  return { state, setState, loaded, dataPath, persist }
}
