import { useEffect, useRef, useState } from 'react'
import { Toaster, toast } from 'sonner'
import { runAction } from '../components/Productivity'

type Draft = { kind: 'task' | 'note'; title: string; text: string; requestId: string }
const empty = (kind: Draft['kind'] = 'task'): Draft => ({ kind, title: '', text: '', requestId: crypto.randomUUID() })
function loadDraft(): Draft {
  try { const draft = JSON.parse(localStorage.getItem('quick-capture-draft') ?? 'null'); return draft && ['task', 'note'].includes(draft.kind) && typeof draft.title === 'string' && typeof draft.text === 'string' ? { ...draft, requestId: typeof draft.requestId === 'string' && draft.requestId ? draft.requestId : crypto.randomUUID() } : empty() } catch { return empty() }
}

export function QuickCapture() {
  const [draft, setDraft] = useState(loadDraft)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [storageError, setStorageError] = useState('')
  const latest = useRef(draft)
  const lock = useRef(false)
  const title = useRef<HTMLInputElement>(null)
  useEffect(() => {
    document.documentElement.classList.add('capture-window'); document.body.classList.add('capture-window')
    return () => { document.documentElement.classList.remove('capture-window'); document.body.classList.remove('capture-window') }
  }, [])
  const retain = (next: Draft) => {
    try { localStorage.setItem('quick-capture-draft', JSON.stringify(next)); setStorageError(''); return true }
    catch { setStorageError(next.title || next.text ? '草稿暂未写入磁盘，内容仍保留在当前窗口；请重试或直接保存。' : '记录已保存，但本地草稿清理失败；不会重复提交，请重试清理。'); return false }
  }
  const set = (next: Draft) => { latest.current = next; setDraft(next); retain(next) }
  useEffect(() => {
    let cancelled = false
    // A failed cleanup may leave an older version of an already-committed draft
    // on disk. Reconcile before allowing edits, keeping one id for its lifetime.
    void window.dustdesk.loadWorkspace().then(state => {
      if (cancelled) return
      const id = latest.current.requestId
      const committed = state.Todos.some(item => item.Id === id) || state.Notes.some(item => item.Id === id) || state.RecycleBin.some(item => (item.kind === 'task' || item.kind === 'note') && item.value.Id === id)
      if (committed) { const cleared = empty(latest.current.kind); latest.current = cleared; setDraft(cleared) }
      retain(latest.current); setReady(true)
    }).catch(() => { if (!cancelled) { setStorageError('无法核对已保存记录，请重试读取工作区；原草稿未删除。') } })
    const unsubscribe = window.dustdesk.onBeforeQuit(async () => { localStorage.setItem('quick-capture-draft', JSON.stringify(latest.current)) })
    return () => { cancelled = true; unsubscribe() }
  }, [loadAttempt])
  useEffect(() => { const focus = () => title.current?.focus(); window.addEventListener('focus', focus); focus(); return () => window.removeEventListener('focus', focus) }, [])
  const save = async () => {
    if (!ready || lock.current || !draft.title.trim()) return
    lock.current = true; setBusy(true)
    try {
      await runAction({ type: 'capture', ...latest.current })
      const cleared = empty(draft.kind)
      latest.current = cleared; setDraft(cleared)
      if (retain(cleared)) await window.dustdesk.hideQuickCapture()
      else toast.success('记录已保存，请重试清理本地草稿')
    }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { lock.current = false; setBusy(false) }
  }
  return <main className="quick-capture" onKeyDown={event => { if (event.key === 'Escape' && !busy) void window.dustdesk.hideQuickCapture(); if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void save() } }}><div className="panel-heading"><h1>快速记录</h1><div className="segmented"><button disabled={busy || !ready} className={draft.kind === 'task' ? 'selected' : ''} onClick={() => set({ ...draft, kind: 'task' })}>任务</button><button disabled={busy || !ready} className={draft.kind === 'note' ? 'selected' : ''} onClick={() => set({ ...draft, kind: 'note' })}>便签</button></div></div><label>标题<input ref={title} aria-label="记录标题" maxLength={300} disabled={busy || !ready} value={draft.title} onChange={event => set({ ...draft, title: event.target.value })} placeholder="记下现在想到的事" /></label><label className="capture-body-label">{draft.kind === 'task' ? '备注' : '正文'}<textarea aria-label="记录正文" maxLength={200000} disabled={busy || !ready} value={draft.text} onChange={event => set({ ...draft, text: event.target.value })} placeholder="补充内容（可选）" /></label>{storageError && <div role="alert" className="inline-error">{storageError}<button className="mini-button" disabled={busy} onClick={() => { if (!ready) { setLoadAttempt(value => value + 1); return }; if (retain(latest.current) && !latest.current.title && !latest.current.text) void window.dustdesk.hideQuickCapture() }}>{ready ? '重试保存草稿' : '重试读取工作区'}</button></div>}<footer><small className="muted">Ctrl+Enter 保存 · Esc 隐藏并保留草稿</small><button className="primary-button" disabled={busy || !ready || !draft.title.trim()} onClick={() => void save()}>{busy ? '保存中…' : '保存并收起'}</button></footer><Toaster position="bottom-right" /></main>
}
