import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { NoteRecord, WorkspaceState } from '../../../shared/types'
import { runAction } from '../components/Productivity'
import { isDirtyDraft, NoteDraftStore, savedNoteDraft, type NoteDraft } from './noteDrafts'
import { useNoteAppearance } from '../hooks/useNoteAppearance'

export function TaskWidget({ state }: { state: WorkspaceState }) {
  const [title, setTitle] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const run = async (operation: () => Promise<void>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await operation() } catch (error) { setError(error instanceof Error ? error.message : String(error)) } finally { lock.current = false; setBusy(false) }
  }
  const add = () => run(async () => { await runAction({ type: 'capture', kind: 'task', title, text: '' }); setTitle('') })
  const todos = state.Todos.filter(item => !item.IsCompleted)
  return <div className="editable-widget"><div className="widget-task-add"><input aria-label="桌面新增任务" placeholder="新增任务，Enter 保存" maxLength={300} value={title} disabled={busy} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && title.trim()) void add() }} /><button className="mini-button" disabled={busy || !title.trim()} onClick={() => void add()}>添加</button></div>{error && <p role="alert" className="inline-error">{error}</p>}<div className="widget-todos">{todos.map(todo => <label className="widget-todo widget-task-row" key={todo.Id}><input type="checkbox" checked={false} disabled={busy} aria-label={`完成 ${todo.Title}`} onChange={() => void run(() => runAction({ type: 'task-complete', id: todo.Id, completed: true }))} /><span>{todo.Title}</span></label>)}{!todos.length && <p className="widget-empty">今天没有未完成任务</p>}</div></div>
}

const drafts = new NoteDraftStore(localStorage)
let protectsDraftsOnQuit = false
class NoteConflictError extends Error {}

function NoteEditor({ note, widgetKey, selector }: { note: NoteRecord; widgetKey: string; selector?: ReactNode }) {
  const { backgroundUrl, backgroundError, textStyle } = useNoteAppearance(note)
  const [editImageText, setEditImageText] = useState(false)
  const [notice, setNotice] = useState('')
  const copyRequest = useRef<{ requestId: string; title: string; text: string } | null>(null)
  const [initial] = useState(() => {
    try { return { draft: drafts.read(widgetKey, note), error: '' } }
    catch { return { draft: savedNoteDraft(note), error: '无法读取本地草稿，请检查可用磁盘空间后重新打开。' } }
  })
  const [draft, setDraft] = useState(initial.draft); const [error, setError] = useState(''); const [storageError, setStorageError] = useState(initial.error); const [busy, setBusy] = useState(false)
  const latest = useRef(draft); const pending = useRef<Promise<void> | null>(null)
  const dirty = isDirtyDraft(draft)
  const conflict = dirty && (note.Text !== draft.previousText || note.Title !== draft.previousTitle) && (note.Text !== draft.text || note.Title !== draft.title.trim())
  const retain = (next: NoteDraft) => {
    try { drafts.write(widgetKey, note.Id, next); setStorageError('') }
    catch { setStorageError('草稿暂未写入磁盘，请释放空间后重试。退出前会再次保存。') }
  }
  const set = (next: NoteDraft) => { latest.current = next; setDraft(next); retain(next) }
  useEffect(() => { if (!initial.error) retain(latest.current) }, [])
  useEffect(() => {
    const current = latest.current
    if (!isDirtyDraft(current) && (note.Text !== current.previousText || note.Title !== current.previousTitle)) set(savedNoteDraft(note))
  }, [note.Title, note.Text])
  const save = () => {
    if (pending.current) return pending.current
    const captured = { ...latest.current, title: latest.current.title.trim() }
    if (!isDirtyDraft(captured) || (captured.title === note.Title && captured.text === note.Text)) {
      if (isDirtyDraft(latest.current)) set({ ...captured, previousTitle: captured.title, previousText: captured.text })
      return Promise.resolve()
    }
    if (!captured.title) { setError('请输入便签标题，正文草稿已保留。'); return Promise.resolve() }
    setBusy(true); setError('')
    const operation = window.dustdesk.productivity({ type: 'note-edit', id: note.Id, ...captured }).then(result => {
      if (!result.ok) {
        const ErrorType = result.code === 'NOTE_CONFLICT' || result.code === 'NOTE_DELETED' ? NoteConflictError : Error
        throw new ErrorType(result.error ?? '便签保存失败')
      }
      set({ ...captured, previousTitle: captured.title, previousText: captured.text })
    }).catch(error => { setError(error instanceof Error ? error.message : String(error)); throw error }).finally(() => { pending.current = null; setBusy(false) })
    pending.current = operation
    return operation
  }
  const flush = useRef<() => Promise<void>>(async () => undefined)
  const saveAsNew = () => {
    if (pending.current) return pending.current
    const captured = { title: latest.current.title.trim(), text: latest.current.text }
    if (!captured.title) { setError('请输入便签标题，正文草稿已保留。'); return Promise.resolve() }
    if (!copyRequest.current || copyRequest.current.title !== captured.title || copyRequest.current.text !== captured.text) copyRequest.current = { ...captured, requestId: crypto.randomUUID() }
    setBusy(true); setError('')
    const operation = runAction({ type: 'capture', kind: 'note', sourceNoteId: note.Id, ...copyRequest.current }).then(() => {
      set(savedNoteDraft(note)); setNotice('草稿已另存为新便签，原便签未被覆盖。')
    }).catch(error => { setError(error instanceof Error ? error.message : String(error)); throw error }).finally(() => { pending.current = null; setBusy(false) })
    pending.current = operation
    return operation
  }
  flush.current = async () => {
    drafts.write(widgetKey, note.Id, latest.current)
    try { await save() }
    catch (error) { if (!(error instanceof NoteConflictError)) throw error }
    // A conflict remains a private draft; a failed draft write still blocks quit.
    drafts.write(widgetKey, note.Id, latest.current)
  }
  useEffect(() => window.dustdesk.onBeforeQuit(() => flush.current()), [note.Id, widgetKey])
  const message = storageError || error || (conflict ? '便签已在其他窗口修改；本窗口草稿已保留，退出后仍可恢复。' : '')
  return <div className="widget-note-editor">
    <div className="widget-note-toolbar">{selector}<input aria-label="便签标题" value={draft.title} maxLength={300} disabled={busy} onChange={event => set({ ...draft, title: event.target.value })} /></div>
    {note.ImageOnly && backgroundUrl && !editImageText ? <div className="widget-note-image" style={{ backgroundColor: textStyle.backgroundColor }}><img src={backgroundUrl} alt={note.Title || '便签图片'} /></div> : <textarea aria-label="便签正文" value={draft.text} maxLength={200000} disabled={busy} onChange={event => set({ ...draft, text: event.target.value })} onKeyDown={event => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); void save().catch(() => undefined) } }} placeholder="在桌面直接编辑便签…" style={textStyle} />}
    <div className="widget-note-actions">
      <small title="Ctrl+Enter 保存到工作区">{storageError ? '草稿待写入磁盘' : dirty ? '草稿已保留' : '已保存'}</small>
      {note.ImageOnly && backgroundUrl && <button className="mini-button" disabled={busy} onClick={() => setEditImageText(value => !value)}>{editImageText ? '显示图片' : '编辑文字'}</button>}
      <button className="mini-button" title="Ctrl+Enter 保存" disabled={busy || !dirty || !draft.title.trim()} onClick={() => void save().catch(() => undefined)}>保存</button>
    </div>
    {backgroundError && <p className="inline-error" role="alert">{backgroundError}</p>}
    {notice && <p className="widget-note-notice" role="status">{notice}</p>}
    {message && <div role="alert" className="inline-error">{message}
      {storageError && <button className="mini-button" disabled={busy} onClick={() => retain(latest.current)}>重试保存草稿</button>}
      {conflict && <div className="note-conflict-actions">
        <button className="mini-button" disabled={busy || !draft.title.trim()} onClick={() => void saveAsNew().catch(() => undefined)}>另存为新便签</button>
        <button className="mini-button" disabled={busy} onClick={() => { void navigator.clipboard.writeText(draft.title + '\n' + draft.text).then(() => { set(savedNoteDraft(note)); setError('') }).catch(() => setError('复制失败，请另存为新便签或手动复制草稿')) }}>复制草稿并重新载入</button>
      </div>}
    </div>}
    {conflict && <details className="note-conflict-versions"><summary>对比版本</summary><div><section><h3>已保存版本</h3><strong>{note.Title}</strong><pre>{note.Text || '（空正文）'}</pre></section><section><h3>本窗口草稿</h3><strong>{draft.title}</strong><pre>{draft.text || '（空正文）'}</pre></section></div></details>}
  </div>
}

export function NotesWidget({ state, noteId }: { state: WorkspaceState; noteId: string }) {
  const widgetKey = noteId ? `note:${noteId}` : 'notes'
  const [selected, setSelected] = useState(() => { try { return noteId || localStorage.getItem('widget-notes:selected') || state.Notes[0]?.Id || '' } catch { return noteId || state.Notes[0]?.Id || '' } })
  useEffect(() => {
    if (!protectsDraftsOnQuit) {
      protectsDraftsOnQuit = true
      window.dustdesk.onBeforeQuit(async () => drafts.flush())
    }
  }, [])
  const note = state.Notes.find(item => item.Id === (noteId || selected)) ?? (!noteId ? state.Notes[0] : undefined)
  const selector = !noteId && <select aria-label="选择桌面便签" value={note?.Id ?? ''} onChange={event => { setSelected(event.target.value); try { localStorage.setItem('widget-notes:selected', event.target.value) } catch { /* Draft retention does not depend on selection persistence. */ } }}>{state.Notes.map(item => <option key={item.Id} value={item.Id}>{item.Title}</option>)}</select>
  return <div className="editable-widget widget-note-panel">{note ? <NoteEditor key={note.Id} note={note} widgetKey={widgetKey} selector={selector} /> : <p className="widget-empty">便签不存在，可在快速记录中新增。</p>}</div>
}
