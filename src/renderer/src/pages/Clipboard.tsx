import { useState } from 'react'
import { Clipboard, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { ClipboardRecord, NoteRecord, WorkspaceState } from '../../../shared/types'
import { Empty, PageHeader, Panel } from '../components/common'
import { now, uid } from '../utils/ids'

export function ClipboardPage({ state, persist }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void> }) {
  const [search, setSearch] = useState('')
  const items = state.ClipboardHistory.filter(item => `${item.Text} ${item.ImageFileName}`.toLowerCase().includes(search.toLowerCase()))
  const convert = (item: ClipboardRecord, target: 'task' | 'note') => {
    if (target === 'task') {
      void persist({ ...state, Todos: [{ Id: uid(), Title: item.Text || item.ImageFileName || '剪贴板内容', Tag: '剪贴板', Note: '', IsCompleted: false, CreatedAt: now(), ReminderRepeat: 'None' }, ...state.Todos] }, '已转为任务')
      return
    }
    const text = item.Text || item.ImageFileName || '剪贴板内容'
    const note: NoteRecord = { Id: uid(), Title: '剪贴板记录', Text: text, ColorArgb: -411768, FontColorArgb: -1385444, FontSize: 14, FontBold: false, BackgroundImageFileName: '', ImageOnly: false, CreatedAt: now(), UpdatedAt: now() }
    void persist({ ...state, Notes: [note, ...state.Notes] }, '已转为便签')
  }
  return <><PageHeader eyebrow="Clipboard" title="剪贴板" description="最近复制的文字和图片会在这里暂存。" action={<button className="secondary-button" onClick={() => toast.info('剪贴板监听由主进程实时运行')}><Clipboard size={16} />监听设置</button>} /><Panel><div className="small-search full"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索剪贴板历史" /></div><div className="clipboard-list">{items.map(item => <div className="clipboard-row" key={item.Id}><button className="clip-content" onClick={() => { void window.dustdesk.writeClipboard({ recordId: item.Id }).then(() => toast.success('已复制到系统剪贴板')).catch(() => toast.error('复制失败，图片可能已丢失或记录已删除')) }}><span className={`clip-type ${item.Kind === 'Image' ? 'image' : ''}`}>{item.Kind === 'Image' ? 'IMG' : 'TXT'}</span><span>{item.Text || item.ImageFileName || '图片内容'}</span></button><small>{new Date(item.CreatedAt).toLocaleString('zh-CN')}</small><button className={`mini-button ${item.IsPinned ? 'selected' : ''}`} onClick={() => void persist({ ...state, ClipboardHistory: state.ClipboardHistory.map(value => value.Id === item.Id ? { ...value, IsPinned: !value.IsPinned } : value) }, item.IsPinned ? '已取消固定' : '已固定')}>固定</button><button className={`mini-button ${item.IsLocked ? 'selected' : ''}`} onClick={() => void persist({ ...state, ClipboardHistory: state.ClipboardHistory.map(value => value.Id === item.Id ? { ...value, IsLocked: !value.IsLocked } : value) }, item.IsLocked ? '已解锁' : '已锁定')}>锁定</button><button className="mini-button" onClick={() => convert(item, 'task')}>转任务</button><button className="mini-button" onClick={() => convert(item, 'note')}>转便签</button><button className="icon-button danger" disabled={item.IsLocked} title="删除记录" onClick={() => void persist({ ...state, ClipboardHistory: state.ClipboardHistory.filter(value => value.Id !== item.Id) }, '记录已删除')}><Trash2 size={14} /></button></div>)}{!items.length && <Empty icon={Clipboard} title="剪贴板还是空的" description="复制文字或图片后，它们会出现在这里。" />}</div></Panel></>
}
