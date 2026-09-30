import { useEffect, useRef, useState } from 'react'
import type { NoteRecord } from '../../../shared/types'

export function NoteBackgroundControls({ note, backgroundUrl, backgroundError }: { note: NoteRecord; backgroundUrl: string; backgroundError: string }) {
  const [source, setSource] = useState(note.BackgroundImagePath || '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  useEffect(() => { setSource(note.BackgroundImagePath || ''); setError('') }, [note.Id, note.BackgroundImagePath])
  const run = async (operation: () => Promise<{ ok: boolean; canceled?: boolean; error?: string }>) => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const result = await operation()
      if (!result.ok && !result.canceled) setError(result.error || '背景修改失败，原图片已保留')
    } catch { setError('背景修改失败，请重试；原图片已保留') }
    finally { lock.current = false; setBusy(false) }
  }
  return <div className="note-background-controls">
    <div className="page-actions">
      <button className="mini-button" disabled={busy} onClick={() => void run(() => window.dustdesk.pickNoteBackground(note.Id, note.BackgroundImagePath || null))}>选择背景图</button>
      <button className="mini-button" disabled={busy || !note.BackgroundImagePath} onClick={() => void run(() => window.dustdesk.clearNoteBackground(note.Id, note.BackgroundImagePath || null))}>清除背景</button>
    </div>
    {backgroundUrl && <img className="note-background-preview" src={backgroundUrl} alt="便签背景预览" />}
    <label className="note-background-path">背景图片路径
      <div className="note-background-import"><input className="settings-input note-image-path" aria-label="背景图片路径" value={source} disabled={busy} onChange={event => { setSource(event.target.value); setError('') }} onKeyDown={event => { if (event.key === 'Enter' && source.trim()) { event.preventDefault(); void run(() => window.dustdesk.importNoteBackground(note.Id, source, note.BackgroundImagePath || null)) } }} placeholder="背景图片路径（可选）" />
        <button className="mini-button" disabled={busy || !source.trim()} onClick={() => void run(() => window.dustdesk.importNoteBackground(note.Id, source, note.BackgroundImagePath || null))}>{busy ? '处理中…' : '导入背景'}</button></div>
    </label>
    <small className="muted">导入后复制到应用数据目录，原文件不受影响。</small>
    {(error || backgroundError) && <p role="alert" className="inline-error">{error || backgroundError}</p>}
  </div>
}
