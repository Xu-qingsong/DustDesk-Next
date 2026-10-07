import { useEffect, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, ChevronRight, FolderInput, FolderOpen, LayoutGrid, Plus, RefreshCw, RotateCcw, SlidersHorizontal, Undo2, WandSparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import type { DesktopCategoryRecord, OrganizerEntry, OrganizerPlanItem, WorkspaceState } from '../../../shared/types'
import { OrganizerRules, useOperation } from '../components/Productivity'
import { Empty, PageHeader, Panel } from '../components/common'
import { PathIcon } from '../components/PathIcon'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { organizerWidgetKey, useWidgetVisibility } from '../hooks/useWidgetVisibility'
import { uid } from '../utils/ids'
import { searchTargetId, useSearchReveal, type SearchNavigation } from '../app/searchNavigation'

export function Organizer({ state, persist, navigation }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; navigation?: SearchNavigation }) {
  const [entries, setEntries] = useState<OrganizerEntry[]>([])
  const [plan, setPlan] = useState<OrganizerPlanItem[]>([])
  const [modal, setModal] = useState<'rules' | 'categories' | null>(null)
  const [newCategory, setNewCategory] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState(state.DesktopCategories[0]?.Id ?? '')
  const [mergeTargetId, setMergeTargetId] = useState('')
  const [dragCategoryId, setDragCategoryId] = useState('')
  const { busy, run } = useOperation()
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

  return <>
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
      <div className="panel-heading"><div><h3>桌面项目</h3><p className="organizer-caption">选择分类收纳，或将项目拖入下方分类。</p></div><div className="studio-actions"><span className="muted">{entries.length} 个项目</span><button className="secondary-button" onClick={() => void run(refresh)} disabled={busy}><RefreshCw size={15} />扫描</button></div></div>
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
        {entries.map(entry => <article className="organizer-entry" key={entry.Path} draggable={!busy} onDragStart={event => { event.dataTransfer.setData('text/plain', entry.Path); event.dataTransfer.effectAllowed = 'move' }} onContextMenu={event => { event.preventDefault(); void window.dustdesk.showPathContextMenu(entry.Path).catch(() => toast.error('无法打开文件菜单')) }}>
          <button className="organizer-entry-open" title={entry.Path} aria-label={`打开 ${entry.Name}`} onClick={() => void open(entry)}><PathIcon path={entry.Path} isDirectory={entry.IsDirectory} /><strong>{entry.Name}</strong><small>{entry.IsDirectory ? '文件夹' : /\.lnk$/i.test(entry.Name) ? '快捷方式' : /\.(exe|msi)$/i.test(entry.Name) ? '应用程序' : '文件'}</small></button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild><button className="organizer-entry-menu-trigger" title="收纳到分类" aria-label={`收纳 ${entry.Name} 到分类`} disabled={busy} onDragStart={event => event.preventDefault()}><FolderInput size={16} /></button></DropdownMenu.Trigger>
            <DropdownMenu.Portal><DropdownMenu.Content className="organizer-entry-menu" side="bottom" align="end" sideOffset={6} collisionPadding={12}>
              <DropdownMenu.Label className="organizer-entry-menu-label">收纳到分类</DropdownMenu.Label>
              {state.DesktopCategories.map(category => <DropdownMenu.Item className="organizer-entry-menu-item" key={category.Id} disabled={busy} onSelect={() => void run(() => move(entry, category))}><FolderOpen size={15} /><span>{category.Name}</span><small>{category.ItemPaths.length}</small></DropdownMenu.Item>)}
              {!state.DesktopCategories.length && <DropdownMenu.Item className="organizer-entry-menu-item" onSelect={() => setModal('categories')}><Plus size={15} /><span>新增分类</span></DropdownMenu.Item>}
            </DropdownMenu.Content></DropdownMenu.Portal>
          </DropdownMenu.Root>
        </article>)}
        {!entries.length && <Empty icon={FolderOpen} title={busy ? '正在扫描桌面' : '桌面很整洁'} description={busy ? '正在读取桌面项目。' : '没有找到可收纳的文件或目录。'} />}
      </div>
    </Panel>
    <div className="organizer-section-heading"><h3>已收纳分类</h3><span className="muted">{state.DesktopCategories.length} 个分类</span></div>
    <div className="category-grid organizer-categories">
      {state.DesktopCategories.map(category => <Panel key={category.Id} className={`category-card ${dragCategoryId === category.Id ? 'drop-active' : ''}`}>
        <div onDragOver={event => { if (busy) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setDragCategoryId(category.Id) }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragCategoryId('') }} onDrop={event => { event.preventDefault(); setDragCategoryId(''); if (busy) return; const source = event.dataTransfer.getData('text/plain'); const entry = entries.find(item => item.Path === source); if (entry) void run(() => move(entry, category)) }}>
          <button id={searchTargetId('category', category.Id)} data-search-target className="category-title category-select" title={`管理 ${category.Name}`} onClick={() => { setSelectedCategoryId(category.Id); setModal('categories') }}><FolderOpen size={18} /><strong>{category.Name}</strong><span>{category.ItemPaths.length}</span></button>
          <div className="category-drop"><span>{dragCategoryId === category.Id ? '松开即可收纳' : '拖入此分类收纳'}</span>{category.ItemPaths.slice(-3).map(item => <small key={item} title={item}>{item.split(/[\\/]/).pop()}</small>)}{!category.ItemPaths.length && <small>暂无项目</small>}</div>
        </div>
      </Panel>)}
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
              <label>当前分类<select aria-label="当前分类" value={selectedCategoryId} onChange={event => setSelectedCategoryId(event.target.value)}>{state.DesktopCategories.map(category => <option key={category.Id} value={category.Id}>{category.Name}</option>)}</select></label>
              <div className="studio-actions organizer-category-order"><button className="secondary-button" onClick={() => void run(() => moveCategory(-1))} disabled={busy || selectedIndex === 0}>上移</button><button className="secondary-button" onClick={() => void run(() => moveCategory(1))} disabled={busy || selectedIndex === state.DesktopCategories.length - 1}>下移</button><button className="secondary-button" aria-pressed={Boolean(widgets.visibility[groupWidgetKey])} onClick={() => void widgets.toggle(groupWidgetKey, '收纳组合已固定', '收纳组合已取消固定')} disabled={busy || widgets.busy[groupWidgetKey] || !selectedCategoryId}>{widgets.visibility[groupWidgetKey] ? '取消固定组合' : '固定组合'}</button></div>
              <label>合并到<select aria-label="合并目标分类" value={mergeTargetId} onChange={event => setMergeTargetId(event.target.value)}><option value="">选择目标分类</option>{state.DesktopCategories.filter(item => item.Id !== selectedCategoryId).map(category => <option key={category.Id} value={category.Id}>{category.Name}</option>)}</select></label>
              <button className="secondary-button" onClick={() => void run(mergeCategory)} disabled={busy || !mergeTargetId}>合并分类</button>
              <div className="organizer-category-delete"><p>删除分类时，其中的文件会恢复到桌面。</p><button className="secondary-button danger" onClick={() => void run(deleteCategory)} disabled={busy}>删除并恢复</button></div>
            </div> : <p className="muted">暂无分类，请先新增一个分类。</p>}
          </>}
        </div><div className="modal-actions"><button className="secondary-button" onClick={closeModal}>完成</button></div></div>
      </div>
    </div>}
  </>
}
