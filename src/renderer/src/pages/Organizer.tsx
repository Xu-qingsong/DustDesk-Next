import { Select } from '../components/ui/Select'
import { useEffect, useState, type ReactNode, type MouseEvent } from 'react'
import { DndContext, KeyboardSensor, PointerSensor, pointerWithin, rectIntersection, useDraggable, useDroppable, useSensor, useSensors, type KeyboardCoordinateGetter } from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, FolderInput, FolderOpen, GripVertical, LayoutGrid, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Undo2, WandSparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import type { DesktopCategoryRecord, OrganizerEntry, OrganizerPlanItem, WorkspaceState } from '../../../shared/types'
import { OrganizerRules, useOperation } from '../components/Productivity'
import { Empty, PageHeader, Panel } from '../components/common'
import { PathIcon } from '../components/PathIcon'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { organizerWidgetKey, useWidgetVisibility } from '../hooks/useWidgetVisibility'
import { uid } from '../utils/ids'
import { searchTargetId, useSearchReveal, type SearchNavigation } from '../app/searchNavigation'

const organizerKeyboardCoordinates: KeyboardCoordinateGetter = (event,{context}) => {
  if (!['ArrowDown','ArrowRight','ArrowUp','ArrowLeft'].includes(event.code)) return
  event.preventDefault()
  const categories=context.droppableContainers.getEnabled().filter(container=>container.data.current?.categoryId)
  if (!categories.length) return
  const direction=event.code==='ArrowDown'||event.code==='ArrowRight'?1:-1
  const index=categories.findIndex(category=>category.id===context.over?.id)
  const destination=categories[Math.max(0,Math.min(categories.length-1,index<0?(direction>0?0:categories.length-1):index+direction))]
  const bounds=destination&&context.droppableRects.get(destination.id)
  if (!bounds||!context.collisionRect) return
  return {x:bounds.left+(bounds.width-context.collisionRect.width)/2,y:bounds.top+(bounds.height-context.collisionRect.height)/2}
}
function DraggableEntry({ entry, busy, children, onContextMenu }: { entry: OrganizerEntry; busy: boolean; children: ReactNode; onContextMenu: (event: MouseEvent<HTMLElement>) => void }) {
  const {attributes,listeners,setNodeRef,setActivatorNodeRef,transform,isDragging}=useDraggable({id:'entry:'+entry.Path,data:{path:entry.Path},disabled:busy})
  return <article ref={setNodeRef} className="organizer-entry" style={{transform:CSS.Translate.toString(transform),zIndex:isDragging?10:undefined}} onContextMenu={onContextMenu}>
    <button ref={setActivatorNodeRef} type="button" className="icon-button organizer-entry-drag" {...attributes} {...listeners} disabled={busy} aria-label={'拖动收纳 '+entry.Name} title="拖动收纳"><GripVertical size={15}/></button>{children}
  </article>
}
function DroppableCategory({category,busy,children}:{category:DesktopCategoryRecord;busy:boolean;children:ReactNode}) {
  const {setNodeRef,isOver}=useDroppable({id:'category:'+category.Id,data:{categoryId:category.Id},disabled:busy})
  return <Panel className={'category-card '+(isOver?'drop-active':'')}><div ref={setNodeRef}>{children}</div></Panel>
}

export function Organizer({ state, persist, navigation }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; navigation?: SearchNavigation }) {
  const [entries, setEntries] = useState<OrganizerEntry[]>([])
  const [plan, setPlan] = useState<OrganizerPlanItem[]>([])
  const [modal, setModal] = useState<'rules' | 'categories' | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState(state.DesktopCategories[0]?.Id ?? '')
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [dragCategoryId, setDragCategoryId] = useState('')
  const { busy, run } = useOperation()
  const sensors=useSensors(useSensor(PointerSensor,{activationConstraint:{distance:6}}),useSensor(KeyboardSensor,{coordinateGetter:organizerKeyboardCoordinates}))
  const selectedCategory = state.DesktopCategories.find(item => item.Id === selectedCategoryId)
  const selectedIndex = state.DesktopCategories.findIndex(item => item.Id === selectedCategoryId)
  const widgets = useWidgetVisibility()
  const groupWidgetKey = organizerWidgetKey(state, [selectedCategoryId, mergeTargetId])
  const entriesByPath = new Map(entries.map(entry => [entry.Path, entry]))
  const refresh = async () => { setEntries(await window.dustdesk.listDesktopEntries()) }
  const closeModal = () => setModal(null)
  useDialogFocus(Boolean(modal), '.organizer-dialog', closeModal)
  useEffect(() => { void run(refresh) }, [])
  const target = navigation?.target.page === 'organizer' ? navigation.target : undefined
  useEffect(() => { if (target) setSelectedCategoryId(target.id) }, [navigation?.requestId, target])
  useSearchReveal(navigation, Boolean(target && selectedCategoryId === target.id))
  useEffect(() => {
    if (!state.DesktopCategories.some(item => item.Id === selectedCategoryId)) setSelectedCategoryId(state.DesktopCategories[0]?.Id ?? '')
    if (mergeTargetId === selectedCategoryId || !state.DesktopCategories.some(item => item.Id === mergeTargetId)) setMergeTargetId('')
  }, [state.DesktopCategories, selectedCategoryId, mergeTargetId])

  const move = async (entry: OrganizerEntry, category: DesktopCategoryRecord) => {
    const result = await window.dustdesk.moveIntoCategory(category.Id, entry.Path)
    if (!result.ok) throw new Error(result.error ?? '收纳失败')
    setPlan([])
    toast.success('文件已收纳')
    await refresh()
  }
  const open = async (entry: OrganizerEntry) => {
    try {
      const result = await window.dustdesk.openPath(entry.Path)
      if (!result.ok) toast.error(result.error ?? '无法打开文件')
    } catch { toast.error('无法打开文件') }
  }
  const preview = async () => {
    const next = await window.dustdesk.planSmartOrganize()
    setPlan(next)
    if (!next.length) toast.info('没有可整理的项目')
  }
  const execute = async () => {
    const result = await window.dustdesk.executeSmartOrganize(plan)
    if (!result.ok) toast.error(result.error ?? '智能整理失败')
    else toast.success(`已整理 ${result.moved} 个项目`)
    setPlan([])
    await refresh()
  }
  const undo = async () => {
    const result = await window.dustdesk.undoOrganizerMove()
    if (!result.ok) throw new Error(result.error ?? '没有可撤销操作')
    setPlan([])
    toast.success('已撤销上一次收纳')
    await refresh()
  }
  const addCategory = async () => {
    const name = newCategory.trim()
    if (!name || state.DesktopCategories.some(item => item.Name.toLowerCase() === name.toLowerCase())) throw new Error('分类名称为空或已存在')
    const category = { Id: uid(), Name: name, IsCollapsed: false, ItemPaths: [] }
    await persist({ ...state, DesktopCategories: [...state.DesktopCategories, category] }, '分类已新增')
    setNewCategory('')
    setSelectedCategoryId(category.Id)
    setPlan([])
  }
  const restoreAll = async () => {
    let restored = 0
    let failed = 0
    for (const category of state.DesktopCategories) for (const item of category.ItemPaths) {
      const result = await window.dustdesk.restoreToDesktop(category.Id, item)
      result.ok ? restored++ : failed++
    }
    setPlan([])
    await refresh()
    if (failed) toast.error(`已恢复 ${restored} 个项目，${failed} 个项目恢复失败`)
    else toast.success(`已恢复 ${restored} 个项目`)
  }
  const deleteCategory = async () => {
    if (!selectedCategory) return
    let failed = false
    for (const item of selectedCategory.ItemPaths) {
      const result = await window.dustdesk.restoreToDesktop(selectedCategory.Id, item)
      if (!result.ok) failed = true
    }
    setPlan([])
    await refresh()
    if (failed) throw new Error('分类中仍有项目未能恢复，请重试')
    const latest = await window.dustdesk.loadWorkspace()
    await persist({ ...latest, DesktopCategories: latest.DesktopCategories.filter(item => item.Id !== selectedCategory.Id) }, '分类已删除')
  }
  const mergeCategory = async () => {
    const destination = state.DesktopCategories.find(item => item.Id === mergeTargetId)
    if (!selectedCategory || !destination || selectedCategory.Id === destination.Id) return
    let failed = false
    for (const item of selectedCategory.ItemPaths) {
      const result = await window.dustdesk.moveIntoCategory(destination.Id, item)
      if (!result.ok) failed = true
    }
    setPlan([])
    await refresh()
    if (failed) throw new Error('部分项目合并失败，未移动的项目仍保留在原分类')
    const latest = await window.dustdesk.loadWorkspace()
    await persist({ ...latest, DesktopCategories: latest.DesktopCategories.filter(item => item.Id !== selectedCategory.Id) }, '分类已合并')
    setSelectedCategoryId(destination.Id)
    setMergeTargetId('')
  }
  const moveCategory = async (offset: number) => {
    const targetIndex = selectedIndex + offset
    if (selectedIndex < 0 || targetIndex < 0 || targetIndex >= state.DesktopCategories.length) return
    const categories = [...state.DesktopCategories]
    ;[categories[selectedIndex], categories[targetIndex]] = [categories[targetIndex]!, categories[selectedIndex]!]
    await persist({ ...state, DesktopCategories: categories }, '分类顺序已更新')
  }

  return <DndContext sensors={sensors} collisionDetection={args=>{const collisions=pointerWithin(args);return collisions.length?collisions:rectIntersection(args)}} accessibility={{screenReaderInstructions:{draggable:'按空格开始收纳，使用方向键选择分类，再按空格放置，按 Escape 取消。'}}} onDragOver={({over})=>setDragCategoryId(over?.data.current?.categoryId??'')} onDragCancel={()=>setDragCategoryId('')} onDragEnd={({active,over})=>{setDragCategoryId('');if(busy)return;const entry=entries.find(item=>item.Path===active.data.current?.path);const category=state.DesktopCategories.find(item=>item.Id===over?.data.current?.categoryId);if(entry&&category)void run(()=>move(entry,category))}}>
    <PageHeader title="桌面收纳" action={<div className="organizer-page-actions">
      <div className="studio-actions">
        <button className="primary-button" onClick={() => void run(preview)} disabled={busy}><WandSparkles size={16} />智能预览</button>
        <button className="secondary-button" onClick={() => void run(undo)} disabled={busy}><Undo2 size={16} />撤销</button>
        <button className="secondary-button" onClick={() => void run(restoreAll)} disabled={busy || !state.DesktopCategories.some(item => item.ItemPaths.length)}><RotateCcw size={16} />恢复全部</button>
      </div>
      <div className="studio-actions">
        <button className="secondary-button" onClick={() => setModal('rules')}><SlidersHorizontal size={16} />收纳规则</button>
        <button className="secondary-button" onClick={() => setModal('categories')}><LayoutGrid size={16} />分类管理</button>
      </div>
    </div>} />
    <Panel className="organizer-desktop-panel">
      <div className="panel-heading"><div><h3>桌面项目</h3><p className="organizer-caption">选择分类或拖入下方收纳，恢复时自动放回原位。</p><p className="organizer-caption">Windows 开启“自动排列图标”时，位置由系统排列。</p></div><div className="studio-actions"><span className="muted">{entries.length} 个项目</span><button className="secondary-button" onClick={() => void run(refresh)} disabled={busy}><RefreshCw size={15} />扫描</button></div></div>
      {plan.length > 0 && <section className="organizer-plan" aria-label="整理预览">
        <div className="organizer-plan-heading">
          <div className="organizer-plan-title"><span className="organizer-plan-mark" aria-hidden="true"><FolderInput size={18} /></span><div><div className="organizer-plan-title-line"><h3>整理预览</h3><span className="organizer-plan-count">{plan.length} 个项目</span></div><p>确认文件与目标分类后执行整理。</p></div></div>
          <div className="studio-actions"><button className="secondary-button" disabled={busy} onClick={() => setPlan([])}>取消预览</button><button className="primary-button" disabled={busy} onClick={() => void run(execute)}><Check size={15} />执行计划</button></div>
        </div>
        <div className="organizer-plan-columns" aria-hidden="true"><span>桌面项目</span><span /><span>收纳到</span></div>
        <ul className="organizer-plan-list" aria-label="整理预览列表" tabIndex={0}>
          {plan.map(item => <li className="organizer-plan-row" key={item.SourcePath}>
            <div className="organizer-plan-file"><PathIcon path={item.SourcePath} isDirectory={entriesByPath.get(item.SourcePath)?.IsDirectory} size={28} /><span title={item.SourcePath}>{item.SourcePath.split(/[\\/]/).pop()}</span></div>
            <ChevronRight className="organizer-plan-arrow" size={14} aria-hidden="true" />
            <span className="organizer-plan-category" title={item.CategoryName}><FolderOpen size={13} aria-hidden="true" /><span>{item.CategoryName}</span></span>
          </li>)}
        </ul>
      </section>}
      <div className="organizer-entries" aria-label="桌面项目宫格" aria-busy={busy}>
        {entries.map(entry => <DraggableEntry key={entry.Path} entry={entry} busy={busy} onContextMenu={event => { event.preventDefault(); void window.dustdesk.showPathContextMenu(entry.Path).then(result => { if (!result.ok) toast.error(result.error || '无法打开文件菜单') }).catch(() => toast.error('无法打开文件菜单')) }}>
          <span className="organizer-entry-type">{entry.IsDirectory ? '文件夹' : /\.lnk$/i.test(entry.Name) ? '快捷方式' : /\.(exe|msi)$/i.test(entry.Name) ? '应用程序' : '文件'}</span>
          <button className="organizer-entry-open" title={entry.Path} aria-label={`打开 ${entry.Name}`} onClick={() => void open(entry)}><PathIcon path={entry.Path} isDirectory={entry.IsDirectory} size={40} /><strong>{entry.Name}</strong></button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild><button className="organizer-entry-menu-trigger" title="收纳到分类" aria-label={`收纳 ${entry.Name} 到分类`} disabled={busy}><FolderInput size={16} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="organizer-entry-menu" side="bottom" align="end" sideOffset={6} collisionPadding={12}>
              <DropdownMenu.Label className="organizer-entry-menu-label">收纳到分类</DropdownMenu.Label>
              {state.DesktopCategories.map(category => <DropdownMenu.Item className="organizer-entry-menu-item" key={category.Id} disabled={busy} onSelect={() => void run(() => move(entry, category))}><FolderOpen size={15} /><span>{category.Name}</span><small>{category.ItemPaths.length}</small></DropdownMenu.Item>)}
              {!state.DesktopCategories.length && <DropdownMenu.Item className="organizer-entry-menu-item" onSelect={() => setModal('categories')}><Plus size={15} /><span>新增分类</span></DropdownMenu.Item>}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
        </DraggableEntry>)}
        {!entries.length && <Empty icon={FolderOpen} title={busy ? '正在扫描桌面' : '桌面很整洁'} description={busy ? '正在读取桌面项目。' : '没有找到可收纳的文件或目录。'} />}
      </div>
    </Panel>
    <div className="organizer-section-heading"><h3>已收纳分类</h3><span className="muted">{state.DesktopCategories.length} 个分类</span></div>
    <div className="category-grid organizer-categories">
      {state.DesktopCategories.map(category => <DroppableCategory key={category.Id} category={category} busy={busy}>
          <button id={searchTargetId('category', category.Id)} data-search-target className="category-title category-select" title={`管理 ${category.Name}`} onClick={() => { setSelectedCategoryId(category.Id); setModal('categories') }}><FolderOpen size={18} /><strong>{category.Name}</strong><span>{category.ItemPaths.length}</span></button>
          <div className="category-drop"><span>{dragCategoryId === category.Id ? '松开即可收纳' : '拖入此分类收纳'}</span>{category.ItemPaths.slice(-3).map(item => <small key={item} title={item}>{item.split(/[\\/]/).pop()}</small>)}{!category.ItemPaths.length && <small>暂无项目</small>}</div>
      </DroppableCategory>)}
      {!state.DesktopCategories.length && <Empty icon={FolderOpen} title="还没有分类" description="创建分类后即可收纳桌面项目。" action={<button className="secondary-button" onClick={() => setModal('categories')}><Plus size={15} />新增分类</button>} />}
    </div>
    {modal && <div className="modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeModal() }}>
      <div className="library-modal organizer-dialog" role="dialog" aria-modal="true" aria-labelledby="organizer-dialog-title">
        <div className="modal-header"><div><span className="section-kicker">Organizer</span><h3 id="organizer-dialog-title">{modal === 'rules' ? '收纳规则' : '分类管理'}</h3></div><button className="icon-button subtle" title="关闭" aria-label="关闭弹窗" onClick={closeModal}><X size={16} /></button></div>
        <div className="modal-form"><div className="modal-body">
          {modal === 'rules' ? <OrganizerRules state={state} onChanged={() => setPlan([])} inDialog /> : <>
            <form className="organizer-category-add" onSubmit={event => { event.preventDefault(); void run(addCategory) }}><label>新增分类名称<input value={newCategory} onChange={event => setNewCategory(event.target.value)} placeholder="例如：工作、学习、工具" /></label><button type="submit" className="primary-button" disabled={busy || !newCategory.trim()}><Plus size={16} />新增分类</button></form>
            <div className="organizer-category-list" aria-label="分类列表">{state.DesktopCategories.map(category => <button className={`category-chip ${selectedCategoryId === category.Id ? 'selected' : ''}`} key={category.Id} onClick={() => setSelectedCategoryId(category.Id)}><FolderOpen size={14} /><span>{category.Name}</span><small>{category.ItemPaths.length}</small></button>)}</div>
            {selectedCategory ? <div className="category-manager-row">
              <label>当前分类<Select searchable aria-label="当前分类" value={selectedCategoryId} onValueChange={value => setSelectedCategoryId(value)}>{state.DesktopCategories.map(category => <option key={category.Id} value={category.Id}>{category.Name}</option>)}</Select></label>
              <div className="studio-actions organizer-category-order"><button className="secondary-button" onClick={() => void run(() => moveCategory(-1))} disabled={busy || selectedIndex === 0}>上移</button><button className="secondary-button" onClick={() => void run(() => moveCategory(1))} disabled={busy || selectedIndex === state.DesktopCategories.length - 1}>下移</button><button className="secondary-button" aria-pressed={Boolean(widgets.visibility[groupWidgetKey])} onClick={() => void widgets.toggle(groupWidgetKey, '收纳组合已固定', '收纳组合已取消固定')} disabled={busy || widgets.busy[groupWidgetKey] || !selectedCategoryId}>{widgets.visibility[groupWidgetKey] ? '取消固定组合' : '固定组合'}</button></div>
              <label>合并到<Select searchable aria-label="合并目标分类" value={mergeTargetId} onValueChange={value => setMergeTargetId(value)}><option value="">选择目标分类</option>{state.DesktopCategories.filter(item => item.Id !== selectedCategoryId).map(category => <option key={category.Id} value={category.Id}>{category.Name}</option>)}</Select></label>
              <button className="secondary-button" onClick={() => void run(mergeCategory)} disabled={busy || !mergeTargetId}>合并分类</button>
              <div className="organizer-category-delete"><p>删除分类时，其中的文件会恢复到桌面。</p><button className="secondary-button danger" onClick={() => void run(deleteCategory)} disabled={busy}>删除并恢复</button></div>
            </div> : <p className="muted">暂无分类，请先新增一个分类。</p>}
          </>}
        </div><div className="modal-actions"><button className="secondary-button" onClick={closeModal}>完成</button></div></div>
      </div>
    </div>}
  </DndContext>
}
