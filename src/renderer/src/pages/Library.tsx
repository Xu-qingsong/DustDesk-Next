import { useEffect, useState } from 'react'
import { ExternalLink, FolderOpen, Link2, Pencil, Plus, Terminal, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { LinkGroupRecord, LinkRecord, WorkspaceState } from '../../../shared/types'
import { isHttpUrl } from '../../../shared/urls'
import { Empty, PageHeader, Panel } from '../components/common'
import { now, uid } from '../utils/ids'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { searchTargetId, useSearchReveal, type SearchNavigation } from '../app/searchNavigation'

export function Library({ state, persist, navigation }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; navigation?: SearchNavigation }) {
  type ResourceKind = 'link' | 'launcher'
  type ModalKind = ResourceKind | 'category' | null
  const [tab, setTab] = useState<ResourceKind>('link')
  const [selectedGroupId, setSelectedGroupId] = useState(state.LinkGroups[0]?.Id ?? '')
  const [modal, setModal] = useState<ModalKind>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [categoryName, setCategoryName] = useState('')
  const [draft, setDraft] = useState({ name: '', target: '', note: '', groupId: state.LinkGroups[0]?.Id ?? '' })
  const group = state.LinkGroups.find(item => item.Id === selectedGroupId) ?? state.LinkGroups[0]
  const visibleLaunchers = state.Launchers.filter(item => item.GroupId === group?.Id || (!item.GroupId && group?.Id === state.LinkGroups[0]?.Id))
  const target = navigation?.target.page === 'library' ? navigation.target : undefined
  useEffect(() => {
    if (!target) return
    setTab(target.kind)
    setSelectedGroupId(target.groupId)
  }, [navigation?.requestId, target])
  useSearchReveal(navigation, Boolean(target && tab === target.kind && group?.Id === target.groupId))

  useEffect(() => { if (!state.LinkGroups.some(item => item.Id === selectedGroupId)) setSelectedGroupId(state.LinkGroups[0]?.Id ?? '') }, [selectedGroupId, state.LinkGroups])
  const closeModal = () => { setModal(null); setEditingId(null); setCategoryName('') }
  useDialogFocus(Boolean(modal), '.library-modal', closeModal)
  const openCreate = (kind: ResourceKind) => { setEditingId(null); setDraft({ name: '', target: '', note: '', groupId: group?.Id ?? state.LinkGroups[0]?.Id ?? '' }); setModal(kind) }
  const openEditLink = (item: LinkRecord) => { setEditingId(item.Id); setDraft({ name: item.Name, target: item.Url, note: item.Note, groupId: group?.Id ?? state.LinkGroups[0]?.Id ?? '' }); setModal('link') }
  const openEditLauncher = (item: WorkspaceState['Launchers'][number]) => { setEditingId(item.Id); setDraft({ name: item.Name, target: item.Path, note: '', groupId: item.GroupId ?? group?.Id ?? state.LinkGroups[0]?.Id ?? '' }); setModal('launcher') }
  const saveResource = async () => {
    const name = draft.name.trim(); const target = draft.target.trim(); const targetGroup = state.LinkGroups.find(item => item.Id === draft.groupId) ?? state.LinkGroups[0]
    if (!name || !target || !targetGroup) return toast.error('名称、地址和分类不能为空')
    if (modal === 'link') {
      if (!isHttpUrl(target)) return toast.error('请输入有效的 HTTP/HTTPS 地址')
      const existing = editingId ? state.LinkGroups.flatMap(item => item.Links).find(item => item.Id === editingId) : null
      const link: LinkRecord = existing ? { ...existing, Name: name, Url: target, Note: draft.note.trim(), UpdatedAt: now() } : { Id: uid(), Name: name, Url: target, Note: draft.note.trim(), CreatedAt: now(), UpdatedAt: now() }
      const groups = state.LinkGroups.map(item => ({ ...item, Links: item.Links.filter(value => value.Id !== editingId) })); const destination = groups.find(item => item.Id === targetGroup.Id); if (destination) destination.Links = [...destination.Links, link]
      await persist({ ...state, LinkGroups: groups }, editingId ? '链接已更新' : '链接已添加')
    } else if (modal === 'launcher') {
      const launchers = editingId ? state.Launchers.map(item => item.Id === editingId ? { ...item, Name: name, Path: target, GroupId: targetGroup.Id } : item) : [...state.Launchers, { Id: uid(), Name: name, Path: target, GroupId: targetGroup.Id }]
      await persist({ ...state, Launchers: launchers }, editingId ? '启动器已更新' : '启动器已添加')
    }
    closeModal()
  }
  const saveCategory = async () => { const name = categoryName.trim(); if (!name) return toast.error('分类名称不能为空'); if (state.LinkGroups.some(item => item.Name.toLowerCase() === name.toLowerCase())) return toast.error('分类名称已存在'); const category: LinkGroupRecord = { Id: uid(), Name: name, Links: [] }; await persist({ ...state, LinkGroups: [...state.LinkGroups, category] }, '分类已新增'); setSelectedGroupId(category.Id); closeModal() }
  const deleteLink = async (id: string) => { if (!group || !window.confirm('确定删除这个链接吗？')) return; await persist({ ...state, LinkGroups: state.LinkGroups.map(item => item.Id === group.Id ? { ...item, Links: item.Links.filter(value => value.Id !== id) } : item) }, '链接已删除') }
  const deleteLauncher = async (id: string) => { if (!window.confirm('确定删除这个启动器吗？')) return; await persist({ ...state, Launchers: state.Launchers.filter(item => item.Id !== id) }, '启动器已删除') }
  useEffect(() => { if (tab !== 'launcher') return; const rows = [...document.querySelectorAll<HTMLElement>('.resource-list .resource-row')]; const cleanups: (() => void)[] = []; rows.forEach((row, index) => { const item = visibleLaunchers[index]; if (!item) return; const handler = (event: MouseEvent) => { event.preventDefault(); void window.dustdesk.showPathContextMenu(item.Path) }; row.addEventListener('contextmenu', handler); cleanups.push(() => row.removeEventListener('contextmenu', handler)) }); return () => cleanups.forEach(cleanup => cleanup()) }, [tab, visibleLaunchers])
  return <><PageHeader eyebrow="Library" title="资源库" description="按分类整理常用链接、应用和文件入口。" action={<div className="page-actions"><div className="segmented"><button className={tab === 'link' ? 'selected' : ''} onClick={() => setTab('link')}>链接</button><button className={tab === 'launcher' ? 'selected' : ''} onClick={() => setTab('launcher')}>启动器</button></div><button className="primary-button" onClick={() => openCreate(tab)}><Plus size={16} />{tab === 'link' ? '新建链接' : '新建启动器'}</button></div>} /><Panel><div className="library-toolbar"><div><span className="section-kicker">Categories</span><div className="library-categories">{state.LinkGroups.map(item => { const count = item.Links.length + state.Launchers.filter(launcher => launcher.GroupId === item.Id || (!launcher.GroupId && item.Id === state.LinkGroups[0]?.Id)).length; return <button type="button" className={`category-chip ${group?.Id === item.Id ? 'selected' : ''}`} key={item.Id} onClick={() => setSelectedGroupId(item.Id)}><span>{item.Name}</span><small>{count}</small></button> })}</div></div><button className="secondary-button" onClick={() => { setCategoryName(''); setModal('category') }}><Plus size={15} />新建分类</button></div>{tab === 'link' ? <div className="resource-list">{group?.Links.map(link => <div className="resource-row" key={link.Id} id={searchTargetId('link', link.Id)} data-search-target tabIndex={-1}><Link2 size={17} /><span><strong>{link.Name}</strong><small>{link.Url}{link.Note ? ` · ${link.Note}` : ''}</small></span><button className="icon-button" title="打开链接" onClick={() => void window.dustdesk.openUrl(link.Url)}><ExternalLink size={15} /></button><button className="icon-button" title="编辑链接" onClick={() => openEditLink(link)}><Pencil size={15} /></button><button className="icon-button danger" title="删除链接" onClick={() => void deleteLink(link.Id)}><Trash2 size={15} /></button></div>)}{!group?.Links.length && <Empty icon={Link2} title="这个分类还没有链接" description="使用右上角的新建链接添加一个入口。" />}</div> : <div className="resource-list">{visibleLaunchers.map(item => <div className="resource-row" key={item.Id} id={searchTargetId('launcher', item.Id)} data-search-target tabIndex={-1}><Terminal size={17} /><span><strong>{item.Name}</strong><small>{item.Path}</small></span><button className="icon-button" title="打开路径" onClick={() => void window.dustdesk.openPath(item.Path)}><ExternalLink size={15} /></button><button className="icon-button" title="编辑启动器" onClick={() => openEditLauncher(item)}><Pencil size={15} /></button><button className="icon-button danger" title="删除启动器" onClick={() => void deleteLauncher(item.Id)}><Trash2 size={15} /></button></div>)}{!visibleLaunchers.length && <Empty icon={Terminal} title="这个分类还没有启动器" description="使用右上角的新建启动器添加一个入口。" />}</div>}</Panel>{modal && <div className="modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closeModal() }}><div className="library-modal" role="dialog" aria-modal="true" aria-labelledby="library-modal-title"><div className="modal-header"><div><span className="section-kicker">Library</span><h3 id="library-modal-title">{modal === 'category' ? '新建分类' : editingId ? `编辑${modal === 'link' ? '链接' : '启动器'}` : `新建${modal === 'link' ? '链接' : '启动器'}`}</h3></div><button className="icon-button subtle" title="关闭" onClick={closeModal}><X size={16} /></button></div>{modal === 'category' ? <div className="modal-form"><div className="modal-body"><label>分类名称<input autoFocus value={categoryName} onChange={event => setCategoryName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveCategory() }} placeholder="例如：工作、学习、工具" /></label></div><div className="modal-actions"><button className="secondary-button" onClick={closeModal}>取消</button><button className="primary-button" onClick={() => void saveCategory()}>创建分类</button></div></div> : <div className="modal-form"><div className="modal-body"><label>{modal === 'link' ? '链接名称' : '名称'}<input autoFocus value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} placeholder={modal === 'link' ? '例如：公司文档' : '例如：Visual Studio Code'} /></label><label>{modal === 'link' ? '链接地址' : '文件或应用路径'}<div className="modal-input-action"><input value={draft.target} onChange={event => setDraft({ ...draft, target: event.target.value })} placeholder={modal === 'link' ? 'https://example.com' : '选择一个应用、文件或目录'} />{modal === 'launcher' && <button className="icon-button" title="选择路径" onClick={() => void window.dustdesk.pickPath('选择启动器路径').then(result => { if (result.ok && result.path) setDraft(current => ({ ...current, target: result.path! })) })}><FolderOpen size={16} /></button>}</div></label>{modal === 'link' && <label>备注<textarea value={draft.note} onChange={event => setDraft({ ...draft, note: event.target.value })} placeholder="可选备注" rows={3} /></label>}<label>分类<select value={draft.groupId} onChange={event => setDraft({ ...draft, groupId: event.target.value })}>{state.LinkGroups.map(item => <option key={item.Id} value={item.Id}>{item.Name}</option>)}</select></label></div><div className="modal-actions"><button className="secondary-button" onClick={closeModal}>取消</button><button className="primary-button" onClick={() => void saveResource()}>{editingId ? '保存修改' : '添加到资源库'}</button></div></div>}</div></div>}</>
}
