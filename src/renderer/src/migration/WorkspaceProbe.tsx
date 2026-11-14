import { useEffect, useRef, useState } from 'react'
import { Database, RefreshCw, Save } from 'lucide-react'
import { starterState } from '../app/workspace'
import { newerSnapshot, previewWorkspace, type WorkspaceSnapshot } from './workspace'

export function WorkspaceProbe({ initialize = false }: { initialize?: boolean }) {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dirty = useRef(false)
  const latest = useRef<WorkspaceSnapshot | undefined>(undefined)
  const baseline = useRef<WorkspaceSnapshot | undefined>(undefined)
  const apply = (next: WorkspaceSnapshot) => {
    const accepted = newerSnapshot(latest.current, next)
    latest.current = accepted
    setSnapshot(accepted)
    if (!dirty.current) {
      baseline.current = accepted
      setDraft(accepted.state.QuickNote)
    }
  }
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void previewWorkspace.subscribe(next => { if (!disposed) apply(next) }).then(stop => {
      if (disposed) { stop(); return }
      unsubscribe = stop
      return previewWorkspace.load().then(next => { if (!disposed) apply(next) })
    }).catch(reason => { if (!disposed) setError(String(reason)) })
    return () => { disposed = true; unsubscribe?.() }
  }, [])
  const run = async (operation: () => Promise<WorkspaceSnapshot>) => {
    setBusy(true); setError('')
    try { apply(await operation()) } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const save = async () => {
    const editing = baseline.current
    if (!editing) return
    setBusy(true); setError('')
    try {
      const next = await previewWorkspace.save({ ...editing.state, QuickNote: draft }, editing.state)
      dirty.current = false; apply(next)
    } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  return <section data-testid="workspace-probe"><h2><Database size={20} aria-hidden /> Rust 工作区存储验证</h2><p>仅使用预览数据目录，已接通旧格式规范化与剪贴板图片外置存储；生产数据迁移和退出草稿协议尚未接入，验证草稿请先保存再退出。</p><div className="probe-actions">{initialize && <button disabled={busy || Boolean(snapshot)} onClick={() => void run(() => previewWorkspace.initialize(starterState()))}>初始化隔离工作区</button>}<button disabled={busy} onClick={() => void run(previewWorkspace.load)}><RefreshCw size={16} aria-hidden />重新读取</button></div>{snapshot && <><p>修订 {snapshot.revision} · {snapshot.path}</p><label>共享快速笔记<textarea aria-label="共享快速笔记" disabled={busy} value={draft} onChange={event => { dirty.current = true; setDraft(event.target.value) }} /></label><button disabled={busy} onClick={() => void save()}><Save size={16} aria-hidden />保存验证笔记</button></>}{error && <p role="alert">{error}</p>}</section>
}
