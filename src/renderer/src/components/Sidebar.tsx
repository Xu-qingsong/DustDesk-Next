import { Settings2 } from 'lucide-react'
import appIcon from '../../../../Assets/DustDeskIcon-128.png'
import { normalizeSidebarPreferences } from '../../../shared/sidebar'
import type { Page } from '../app/navigation'
import type { WorkspaceState } from '../../../shared/types'

export function Sidebar({ state, page, setPage, nav }: { state: WorkspaceState; page: Page; setPage: (page: Page) => void; nav: typeof import('../app/navigation').nav }) {
  const preferences = normalizeSidebarPreferences(state.Settings)
  const items = preferences.order.flatMap(id => nav.filter(item => item.id === id && !preferences.hidden.includes(id)))
  return <aside className="sidebar"><div className="brand"><img className="brand-mark" src={appIcon} alt="" width={32} height={32} draggable={false} /><div><strong>DustDesk</strong><span>v{__APP_VERSION__}</span></div></div><nav className="nav-list">{items.map(item => <button key={item.id} className={`nav-item ${page === item.id ? 'active' : ''}`} onClick={() => setPage(item.id)}><item.icon size={17} strokeWidth={1.8} /><span>{item.label}</span>{item.id === 'tasks' && state.Todos.filter(todo => !todo.IsCompleted).length > 0 ? <em>{state.Todos.filter(todo => !todo.IsCompleted).length}</em> : null}</button>)}</nav><div className="sidebar-bottom"><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 size={17} strokeWidth={1.8} /><span>设置</span></button></div></aside>
}

