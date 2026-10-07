import { useId, useState, type CSSProperties } from 'react'
import { FolderOpen } from 'lucide-react'
import { toast } from 'sonner'
import type { DesktopCategoryRecord } from '../../../shared/types'
import { PathIcon } from '../components/PathIcon'

function OrganizerFile({ path, size }: { path: string; size: number }) {
  const name = path.split(/[\\/]/).filter(Boolean).pop() || path
  const open = async () => {
    try {
      const result = await window.dustdesk.openPath(path)
      if (!result.ok) toast.error(result.error || '无法打开文件，文件可能已移动或删除')
    } catch { toast.error('无法打开文件，请重试') }
  }
  return <button className="organizer-file" title={path} aria-label={name} onClick={() => void open()} onContextMenu={event => {
    event.preventDefault()
    void window.dustdesk.showPathContextMenu(path).catch(() => toast.error('无法打开文件菜单'))
  }}>
    <PathIcon path={path} size={size} className="path-icon organizer-file-icon" />
    <span className="organizer-file-name">{name}</span>
  </button>
}

export function OrganizerContent({ categories, iconSize }: { categories: DesktopCategoryRecord[]; iconSize: number }) {
  const [selectedId, setSelectedId] = useState(() => (categories.find(category => category.ItemPaths.length) ?? categories[0])?.Id)
  const selected = categories.find(category => category.Id === selectedId) ?? categories.find(category => category.ItemPaths.length) ?? categories[0]
  const id = useId()
  const size = Number.isFinite(iconSize) ? Math.max(24, Math.min(96, iconSize)) : 48
  if (!selected) return <div className="widget-empty"><FolderOpen size={24} />暂无收纳分类</div>
  return <div className="organizer-widget" style={{ '--organizer-cell-width': `${Math.max(88, size + 24)}px` } as CSSProperties}>
    <div className="organizer-tabs" role="tablist" aria-label="收纳分类">
      {categories.map((category, index) => <button key={category.Id} id={`${id}-tab-${category.Id}`} className="organizer-tab" role="tab" aria-selected={selected.Id === category.Id} aria-controls={`${id}-panel`} tabIndex={selected.Id === category.Id ? 0 : -1} title={`${category.Name} · ${category.ItemPaths.length} 项`} onClick={() => setSelectedId(category.Id)} onKeyDown={event => {
        const nextIndex = event.key === 'ArrowRight' ? (index + 1) % categories.length : event.key === 'ArrowLeft' ? (index - 1 + categories.length) % categories.length : event.key === 'Home' ? 0 : event.key === 'End' ? categories.length - 1 : -1
        if (nextIndex < 0) return
        event.preventDefault()
        const next = categories[nextIndex]!
        setSelectedId(next.Id)
        document.getElementById(`${id}-tab-${next.Id}`)?.focus()
      }}><span>{category.Name}</span><small>{category.ItemPaths.length}</small></button>)}
    </div>
    <div className="organizer-panel" id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${selected.Id}`} tabIndex={0} key={selected.Id}>
      {selected.ItemPaths.length ? <div className="organizer-files">{selected.ItemPaths.map(path => <OrganizerFile key={path} path={path} size={size} />)}</div> : <div className="widget-empty"><FolderOpen size={24} />此分类暂无文件</div>}
    </div>
  </div>
}
