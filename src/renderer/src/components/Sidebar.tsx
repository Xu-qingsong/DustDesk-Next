import { ChevronRight, Settings2 } from 'lucide-react'
import type { Page } from '../app/navigation'
import type { WorkspaceState } from '../../../shared/types'

export function Sidebar({ state, page, setPage, nav }: { state: WorkspaceState; page: Page; setPage: (page: Page) => void; nav: typeof import('../app/navigation').nav }) {
  return <aside className="sidebar"><div className="brand"><div className="brand-mark">D</div><div><strong>DustDesk</strong><span>本地工作台</span></div></div><div className="workspace-chip"><span className="status-dot" /><span className="workspace-name">{state.Settings.MainWindowDisplayName || 'DustDesk'}</span><ChevronRight size={14} /></div><nav className="nav-list">{nav.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === 'tasks' && state.Todos.filter(todo => !todo.IsCompleted).length > 0 ? <em>{state.Todos.filter(todo => !todo.IsCompleted).length}</em> : null}</button>)}</nav><div className="sidebar-bottom"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 size={17} strokeWidth={1.8} /><span>设置</span></button><div className="sidebar-meta"><span>Electron 主线</span><span className="version">v{__APP_VERSION__}</span></div></div></aside>
}

