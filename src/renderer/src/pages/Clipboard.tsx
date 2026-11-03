import { useEffect, useState } from 'react'
import { Clipboard, Eye, Search, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ClipboardRecord, NoteRecord, WorkspaceState } from '../../../shared/types'
import { Empty, PageHeader, Panel } from '../components/common'
import { now, uid } from '../utils/ids'
import { ClipboardImage } from '../components/ClipboardImage'
import { useDialogFocus } from '../hooks/useDialogFocus'

export function ClipboardPage({ state, persist, onOpenSettings }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; onOpenSettings: () => void }) {
  const [search, setSearch] = useState('')
  const [previewId, setPreviewId] = useState('')
  const [previewReloads, setPreviewReloads] = useState<Record<string, number>>({})
  const preview = state.ClipboardHistory.find(item => item.Id === previewId)
  const closePreview = () => {
    if (preview?.Kind === 'Image') setPreviewReloads(current => ({ ...current, [preview.Id]: (current[preview.Id] ?? 0) + 1 }))
    setPreviewId('')
  }
  useDialogFocus(Boolean(preview), '.clipboard-preview-dialog', closePreview)
  useEffect(() => { if (previewId && !preview) setPreviewId('') }, [previewId, preview])
  const items = state.ClipboardHistory.filter(item => `${item.Text} ${item.ImageFileName}`.toLowerCase().includes(search.toLowerCase()))
  const copy = (item: ClipboardRecord) => { void window.dustdesk.writeClipboard({ recordId: item.Id }).then(() => toast.success('已复制到系统剪贴板')).catch(() => toast.error('复制失败，图片可能已丢失或记录已删除')) }
  const convert = (item: ClipboardRecord, target: 'task' | 'note') => {
    if (target === 'task') {
      void persist({ ...state, Todos: [{ Id: uid(), Title: item.Text || item.ImageFileName || '剪贴板内容', Tag: '剪贴板', Note: '', IsCompleted: false, CreatedAt: now(), CompletedAt: null, ReminderRepeat: 'None' }, ...state.Todos] }, '已转为任务')
      return
    }
    const text = item.Text || item.ImageFileName || '剪贴板内容'
    const note: NoteRecord = { Id: uid(), Title: '剪贴板记录', Text: text, ColorArgb: -411768, FontColorArgb: -1385444, FontSize: 14, FontBold: false, BackgroundImageFileName: '', ImageOnly: false, CreatedAt: now(), UpdatedAt: now() }
    void persist({ ...state, Notes: [note, ...state.Notes] }, '已转为便签')
  }
  return <>
    <PageHeader eyebrow="Clipboard" title="剪贴板" description="查看文字摘要与图片缩略图，点击内容复制，点击预览查看详情。" action={<button className="secondary-button" onClick={onOpenSettings}><Clipboard size={16} />监听设置</button>} />
    <Panel><div className="small-search full"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索剪贴板历史" /></div>
      <div className="clipboard-list">{items.map(item => {
        const name = item.ImageFileName || item.Text.split(/\r?\n/, 1)[0]?.slice(0, 40) || '剪贴板内容'
        return <div className="clipboard-row" key={item.Id} data-clipboard-id={item.Id}>
          <button className="clipboard-preview-trigger" aria-label={`查看${item.Kind === 'Image' ? '图片' : '文字'}：${name}`} title="预览内容" onClick={() => setPreviewId(item.Id)}>
            {item.Kind === 'Image' ? <ClipboardImage key={previewReloads[item.Id] ?? 0} item={item} /> : <span className="clipboard-text-tile" aria-hidden="true">TXT</span>}
          </button>
          <div className="clipboard-row-main"><button className="clip-content" title="复制到系统剪贴板" onClick={() => copy(item)}><span className="clip-summary">{item.Text.slice(0, 500) || item.ImageFileName || '图片内容'}</span></button><small>{item.Kind === 'Image' ? '图片' : '文字'} · {new Date(item.CreatedAt).toLocaleString('zh-CN')}</small></div>
          <div className="clipboard-row-actions">
            <button className="mini-button" aria-label={`预览内容：${name}`} onClick={() => setPreviewId(item.Id)}><Eye size={13} />预览</button>
            <button className={`mini-button ${item.IsPinned ? 'selected' : ''}`} onClick={() => void persist({ ...state, ClipboardHistory: state.ClipboardHistory.map(value => value.Id === item.Id ? { ...value, IsPinned: !value.IsPinned } : value) }, item.IsPinned ? '已取消固定' : '已固定')}>固定</button>
            <button className={`mini-button ${item.IsLocked ? 'selected' : ''}`} onClick={() => void persist({ ...state, ClipboardHistory: state.ClipboardHistory.map(value => value.Id === item.Id ? { ...value, IsLocked: !value.IsLocked } : value) }, item.IsLocked ? '已解锁' : '已锁定')}>锁定</button>
            <button className="mini-button" onClick={() => convert(item, 'task')}>转任务</button><button className="mini-button" onClick={() => convert(item, 'note')}>转便签</button>
            <button className="icon-button danger" disabled={item.IsLocked} title="删除记录" onClick={() => void persist({ ...state, ClipboardHistory: state.ClipboardHistory.filter(value => value.Id !== item.Id) }, '记录已删除')}><Trash2 size={14} /></button>
          </div>
        </div>
      })}{!items.length && <Empty icon={Clipboard} title={search.trim() ? '没有匹配的记录' : '剪贴板还是空的'} description={search.trim() ? '试试其他关键词，或清空搜索查看全部记录。' : '复制文字或图片后，它们会出现在这里。'} />}</div>
    </Panel>
    {preview && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) closePreview() }}>
      <div className="library-modal clipboard-preview-dialog" role="dialog" aria-modal="true" aria-labelledby="clipboard-preview-title">
        <div className="modal-header"><div><h3 id="clipboard-preview-title">{preview.Kind === 'Image' ? '图片预览' : '文字预览'}</h3><p>{preview.Kind === 'Image' ? preview.ImageFileName || '剪贴板图片' : `${preview.Text.length.toLocaleString()} 个字符`}</p></div><button className="icon-button subtle" aria-label="关闭预览" onClick={closePreview}><X size={16} /></button></div>
        <div className="clipboard-preview-body">{preview.Kind === 'Image' ? <ClipboardImage key={preview.Id} item={preview} thumbnail={false} /> : <pre tabIndex={0} className="clipboard-text-preview">{preview.Text}</pre>}</div>
        <div className="modal-actions"><button className="secondary-button" onClick={closePreview}>关闭</button><button className="primary-button" onClick={() => copy(preview)}><Clipboard size={15} />复制{preview.Kind === 'Image' ? '图片' : '文字'}</button></div>
      </div>
    </div>}
  </>
}
