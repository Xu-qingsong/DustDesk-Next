import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { WorkspaceState } from '../../../shared/types'
import { starterState } from '../app/workspace'
import type { PersistWorkspace } from '../components/common'

type PendingSave = { next: WorkspaceState; baseline: WorkspaceState; message: string }

export function useWorkspace() {
  const [state, setState] = useState<WorkspaceState>(starterState)
  const [loaded, setLoaded] = useState(false)
  const [dataPath, setDataPath] = useState('')
  const pending = useRef<PendingSave[]>([])
  const activeSave = useRef<Promise<void> | null>(null)
  const readable = useRef(false)
  useEffect(() => {
    void Promise.all([window.dustdesk.loadWorkspace(), window.dustdesk.getDataLocation()]).then(([next, path]) => {
      setState(next); setDataPath(path); readable.current = true; setLoaded(true)
    }).catch(() => { setLoaded(true); toast.error('无法读取完整工作区，原文件已保留，请从备份恢复') })
  }, [])
  useEffect(() => window.dustdesk.onWorkspaceChanged(next => {
    if (pending.current.length) return
    readable.current = true
    setState(next)
  }), [])

  const flush = useCallback((): Promise<void> => {
    if (activeSave.current) return activeSave.current
    const operation = (async () => {
      while (pending.current.length) {
        const item = pending.current[0]!
        await window.dustdesk.saveWorkspace(item.next, item.baseline)
        pending.current.shift()
        if (item.message && !pending.current.length) toast.success(item.message)
      }
      const saved = await window.dustdesk.loadWorkspace()
      // Input can arrive while the final read is pending. Never replace those edits.
      if (!pending.current.length) setState(saved)
    })()
    activeSave.current = operation
    void operation.then(() => { activeSave.current = null }, () => { activeSave.current = null })
    return operation
  }, [])
  useEffect(() => window.dustdesk.onBeforeQuit(async () => {
    if (!pending.current.length && !activeSave.current) return
    do { await flush() } while (pending.current.length)
  }), [flush])

  const persist = useCallback<PersistWorkspace>(async (next, message = '已保存') => {
    if (!readable.current) { toast.error('工作区尚未完整读取，未覆盖原文件'); return }
    pending.current.push({ next, baseline: state, message })
    setState(next)
    try { do { await flush() } while (pending.current.length) }
    catch { toast.error('保存失败，修改仍保留在界面中；下次保存或退出时会重试') }
  }, [state, flush])
  return { state, setState, loaded, dataPath, persist }
}
