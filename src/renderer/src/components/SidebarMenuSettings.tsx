import { Switch } from './ui/FormControls'
import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react'
import { nav } from '../app/navigation'
import { normalizeSidebarPreferences, sidebarPageIds, sidebarDefaultHidden } from '../../../shared/sidebar'
import type { SidebarPage } from '../../../shared/sidebar'
import type { PageProps } from './common'

export function SidebarMenuSettings({ state, persist }: PageProps) {
  const preferences = normalizeSidebarPreferences(state.Settings)
  const [dragging, setDragging] = useState<SidebarPage | null>(null), [target, setTarget] = useState<SidebarPage | null>(null)
  const saving = useRef(false), [busy, setBusy] = useState(false)
  const save = async (order: SidebarPage[], hidden = preferences.hidden) => {
    if (saving.current) return
    saving.current = true; setBusy(true)
    try { await persist({ ...state, Settings: { ...state.Settings, SidebarOrder: order, SidebarHidden: hidden } }, '菜单设置已保存') }
    finally { saving.current = false; setBusy(false) }
  }
  const move = (from: SidebarPage, to: SidebarPage) => {
    const order = [...preferences.order], index = order.indexOf(from), destination = order.indexOf(to)
    if (index < 0 || destination < 0 || index === destination || busy) return
    order.splice(index, 1); order.splice(destination, 0, from); void save(order)
  }
  return <div className="settings-section stacked sidebar-menu-settings"><div className="sidebar-menu-heading"><div><h3>侧栏菜单</h3><p>拖动手柄或使用上下按钮排序。隐藏只影响菜单入口，设置入口始终保留。</p></div><button className="secondary-button" disabled={busy} onClick={() => void save([...sidebarPageIds], [...sidebarDefaultHidden])}><RotateCcw size={14} />恢复默认</button></div>
    <div className="sidebar-menu-list" aria-label="侧栏菜单排序与显示">{preferences.order.map((id, index) => {
      const item = nav.find(item => item.id === id)!, hidden = preferences.hidden.includes(id)
      return <div key={id} data-menu-id={id} className={`sidebar-menu-row ${hidden ? 'is-hidden' : ''} ${dragging === id ? 'is-dragging' : ''} ${target === id ? 'is-drop-target' : ''}`} onDragOver={event => { if (!dragging || busy) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTarget(id) }} onDrop={event => { event.preventDefault(); if (dragging) move(dragging, id); setDragging(null); setTarget(null) }}>
        <button type="button" className="icon-button sidebar-menu-grip" draggable={!busy} disabled={busy} aria-label={`拖动排序：${item.label}`} title="拖动排序" onDragStart={event => { setDragging(id); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', id) }} onDragEnd={() => { setDragging(null); setTarget(null) }}><GripVertical size={16} /></button>
        <item.icon size={16} /><span className="sidebar-menu-label">{item.label}</span><span className="sidebar-menu-position">{index + 1}</span>
        <button type="button" className="icon-button" aria-label={`上移：${item.label}`} disabled={busy || index === 0} onClick={() => move(id, preferences.order[index - 1]!)}><ArrowUp size={14} /></button>
        <button type="button" className="icon-button" aria-label={`下移：${item.label}`} disabled={busy || index === preferences.order.length - 1} onClick={() => move(id, preferences.order[index + 1]!)}><ArrowDown size={14} /></button>
        <Switch aria-label={`显示菜单：${item.label}`} checked={!hidden} disabled={busy} onCheckedChange={checked => void save(preferences.order, checked ? preferences.hidden.filter(value => value !== id) : [...preferences.hidden, id])} />
      </div>
    })}</div>
  </div>
}
