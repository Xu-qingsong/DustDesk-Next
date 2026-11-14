import { useEffect, useRef, useState } from 'react'
import type { WorkspaceState } from '../../../shared/types'
import { Checkbox } from '../components/ui/FormControls'
import { isComposingKey } from '../utils/keyboard'
import { runAction } from '../utils/runAction'
import { TaskDraftStore } from './taskDrafts'

export function TaskWidget({ state }: { state: WorkspaceState }) {
  const [title, setTitle] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const [store] = useState(() => new TaskDraftStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) }))
  const [ready, setReady] = useState(false)
  const [storageError, setStorageError] = useState('')
  const lock = useRef(false)
  const read = () => {
    try { const draft = store.load(state); setTitle(draft.title); setReady(true); setStorageError('') }
    catch { setStorageError('任务草稿读取或清理失败，原草稿未删除；请重试。'); setTitle(store.current.title); setReady(store.ready) }
  }
  useEffect(() => { read(); return window.dustdesk.onBeforeQuit(async () => { store.flush() }) }, [store])
  useEffect(() => window.dustdesk.onMainWindowReleaseCheck(() => ready && !store.pending && !title && !document.querySelector<HTMLInputElement>('[aria-label="桌面新增任务"]')?.value && !lock.current && !busy && !error && !storageError), [store, ready, title, busy, error, storageError])
  const change = (next: string) => {
    setTitle(next)
    try { store.change(next); setStorageError('') } catch { setStorageError('任务草稿暂未写入磁盘，内容仍保留在当前窗口；请重试。') }
  }
  const retry = () => {
    if (!store.ready) { read(); return }
    try { store.flush(); setStorageError('') } catch { setStorageError('任务草稿暂未写入磁盘，内容仍保留在当前窗口；请重试。') }
  }
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { lock.current = false; setBusy(false) }
  }
  const add = () => run(async () => {
    await runAction({ type: 'capture', kind: 'task', ...store.current, text: '' }); setTitle('')
    try { store.clear(); setStorageError('') } catch { setStorageError('任务已保存，但本地草稿清理失败；不会重复提交，请重试。') }
  })
  const todos = state.Todos.filter(item => !item.IsCompleted)
  return <div className="editable-widget"><div className="widget-task-add"><input aria-label="桌面新增任务" placeholder="新增任务，Enter 保存" maxLength={300} value={title} disabled={busy || !ready} onChange={event => change(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !isComposingKey(event.nativeEvent) && title.trim()) void add() }} /><button className="mini-button" disabled={busy || !ready || !title.trim()} onClick={() => void add()}>添加</button></div>{storageError && <p role="alert" className="inline-error">{storageError}<button className="mini-button" disabled={busy} onClick={retry}>重试任务草稿</button></p>}{error && <p role="alert" className="inline-error">{error}</p>}<div className="widget-todos">{todos.map(todo => <label className="widget-todo widget-task-row" key={todo.Id}><Checkbox checked={false} disabled={busy} aria-label={`完成 ${todo.Title}`} onChange={() => void run(() => runAction({ type: 'task-complete', id: todo.Id, completed: true }))} /><span>{todo.Title}</span></label>)}{!todos.length && <p className="widget-empty">今天没有未完成任务</p>}</div></div>
}
