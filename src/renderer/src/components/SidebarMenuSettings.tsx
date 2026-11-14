import { Switch } from './ui/FormControls'
import { useRef, useState } from 'react'
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react'
import { nav } from '../app/navigation'
import { normalizeSidebarPreferences, sidebarPageIds, sidebarDefaultHidden } from '../../../shared/sidebar'
import type { SidebarPage } from '../../../shared/sidebar'
import type { PageProps } from './common'
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

function SortableMenuRow({ id, index, total, hidden, busy, target, onMove, onToggle }: { id: SidebarPage; index: number; total: number; hidden: boolean; busy: boolean; target: boolean; onMove: (direction: -1 | 1) => void; onToggle: (checked: boolean) => void }) {
  const item = nav.find(item => item.id === id)!
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({id,disabled:busy})
  return <div ref={setNodeRef} data-menu-id={id} style={{transform:CSS.Transform.toString(transform),transition,zIndex:isDragging?1:undefined}} className={'sidebar-menu-row '+(hidden?'is-hidden ':'')+(isDragging?'is-dragging ':'')+(target?'is-drop-target':'')}>
    <button ref={setActivatorNodeRef} type="button" className="icon-button sidebar-menu-grip" {...attributes} {...listeners} disabled={busy} aria-label={'拖动排序：'+item.label} title="拖动排序" style={{touchAction:'none'}}><GripVertical size={16}/></button>
    <item.icon size={16}/><span className="sidebar-menu-label">{item.label}</span><span className="sidebar-menu-position">{index+1}</span>
    <button type="button" className="icon-button" aria-label={'上移：'+item.label} disabled={busy||index===0} onClick={()=>onMove(-1)}><ArrowUp size={14}/></button>
    <button type="button" className="icon-button" aria-label={'下移：'+item.label} disabled={busy||index===total-1} onClick={()=>onMove(1)}><ArrowDown size={14}/></button>
    <Switch aria-label={'显示菜单：'+item.label} checked={!hidden} disabled={busy} onCheckedChange={onToggle}/>
  </div>
}

export function SidebarMenuSettings({ state, persist }: PageProps) {
  const preferences = normalizeSidebarPreferences(state.Settings)
  const [target, setTarget] = useState<SidebarPage | null>(null)
  const sensors = useSensors(useSensor(PointerSensor,{activationConstraint:{distance:6}}),useSensor(KeyboardSensor,{coordinateGetter:sortableKeyboardCoordinates}))
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
    <DndContext sensors={sensors} collisionDetection={closestCenter} accessibility={{screenReaderInstructions:{draggable:'按空格开始排序，使用上下方向键选择位置，再按空格放置，按 Escape 取消。'}}} onDragOver={({over})=>setTarget((over?.id as SidebarPage)??null)} onDragCancel={()=>setTarget(null)} onDragEnd={({active,over})=>{setTarget(null);if(over)move(active.id as SidebarPage,over.id as SidebarPage)}}>
      <SortableContext items={preferences.order} strategy={verticalListSortingStrategy}><div className="sidebar-menu-list" aria-label="侧栏菜单排序与显示">{preferences.order.map((id,index)=><SortableMenuRow key={id} id={id} index={index} total={preferences.order.length} hidden={preferences.hidden.includes(id)} busy={busy} target={target===id} onMove={direction=>move(id,preferences.order[index+direction]!)} onToggle={checked=>void save(preferences.order,checked?preferences.hidden.filter(value=>value!==id):[...preferences.hidden,id])}/>)}</div></SortableContext>
    </DndContext>
  </div>
}
