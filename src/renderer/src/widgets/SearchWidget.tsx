import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import type { SearchFileResult, WidgetPlacement } from '../../../shared/types'
import { argbCss } from '../utils/colors'
import { useWidgetDrag } from './useWidgetDrag'

export function SearchWidget({ placement, appearance, query, setQuery, files }: { placement: WidgetPlacement; appearance: { color: number; alpha: number }; query: string; setQuery: (value: string) => void; files: SearchFileResult[] }) {
  const [expanded, setExpanded] = useState(false); const hasQuery = query.trim().length >= 2; const hasResults = hasQuery && files.length > 0
  const drag = useWidgetDrag('search')
  useEffect(() => { void window.dustdesk.setWidgetOptions('search', { height: hasResults ? 360 : 52 }) }, [hasResults])
  const sideDocked = placement.DockEdge === 'Left' || placement.DockEdge === 'Right'
  return <div className={`widget-shell widget-search-shell ${sideDocked ? `widget-docked-${placement.DockEdge?.toLowerCase()}` : ''}`} style={{ background: argbCss(appearance.color, appearance.alpha) }}><div className="widget-search-row" {...drag}><button className="widget-search-toggle" title={expanded || hasQuery ? '收起搜索' : '展开搜索'} onClick={() => setExpanded(value => !value)}><Search size={15} /></button>{(!sideDocked || expanded || hasQuery) && <input autoFocus value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索桌面文件" />}</div>{hasResults && <div className="widget-search-results" data-widget-no-drag>{files.map(file => <button className="widget-todo widget-link" key={file.Path} onClick={() => void window.dustdesk.openPath(file.Path)}><span>{file.Name}</span></button>)}</div>}</div>
}
