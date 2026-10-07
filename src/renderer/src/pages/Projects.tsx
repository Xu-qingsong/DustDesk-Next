import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, Download, ExternalLink, FolderKanban, FolderOpen, Pin, Plus, Sparkles, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import type { ProjectRecord, ProjectStatus, WorkspaceState } from '../../../shared/types'
import { Empty, PageHeader, Panel } from '../components/common'
import { ProjectGantt } from '../components/ProjectGantt'
import { now, uid } from '../utils/ids'

import { localDateInputValue, localDateIsoValue } from '../utils/dates'
import { searchTargetId, useSearchReveal, type SearchNavigation } from '../app/searchNavigation'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { useWidgetVisibility } from '../hooks/useWidgetVisibility'

type PhaseDraft = { projectId: string; phaseId?: string; title: string; status: ProjectStatus; progress: number; start: string; end: string; path: string }


export function Projects({ state, persist, navigation }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; navigation?: SearchNavigation }) {
  const [selected, setSelected] = useState<ProjectRecord | null>(state.Projects[0] ?? null); const [subtaskDrafts, setSubtaskDrafts] = useState<Record<string, string>>({}); const add = () => { const project: ProjectRecord = { Id: uid(), Name: '新项目', ProjectPath: '', Phases: [] }; void persist({ ...state, Projects: [project, ...state.Projects] }, '项目已创建'); setSelected(project) }
  const widgets = useWidgetVisibility()
  const pinnedKey = selected ? `project:${selected.Id}` : ""
  const [phaseDraft, setPhaseDraft] = useState<PhaseDraft | null>(null), [savingPhase, setSavingPhase] = useState(false)
  const [expandedPhaseId, setExpandedPhaseId] = useState<string | null>(selected?.Phases[0]?.Id ?? null)
  const phaseSaveLock = useRef(false)
  const closePhaseDialog = () => { if (!phaseSaveLock.current) setPhaseDraft(null) }
  useDialogFocus(Boolean(phaseDraft), '.project-phase-dialog', closePhaseDialog)
  useEffect(() => { setSelected(current => current ? state.Projects.find(item => item.Id === current.Id) ?? state.Projects[0] ?? null : state.Projects[0] ?? null) }, [state.Projects])
  const target = navigation?.target.page === 'projects' ? navigation.target : undefined
  useEffect(() => { if (target) setSelected(state.Projects.find(item => item.Id === target.projectId) ?? null) }, [navigation?.requestId, target])
  useEffect(() => {
    const phase = target?.kind === 'subtask' && target.projectId === selected?.Id ? selected?.Phases.find(phase => phase.Subtasks.some(task => task.Id === target.id)) : undefined
    setExpandedPhaseId(phase?.Id ?? selected?.Phases[0]?.Id ?? null)
  }, [selected?.Id, navigation?.requestId])
  useSearchReveal(navigation, Boolean(target && selected?.Id === target.projectId && (target.kind !== 'subtask' || selected?.Phases.find(phase => phase.Id === expandedPhaseId)?.Subtasks.some(task => task.Id === target.id))))
  const updateSelected = (next: ProjectRecord) => { setSelected(next); void persist({ ...state, Projects: state.Projects.map(item => item.Id === next.Id ? next : item) }, '项目已保存') }
  const addPhase = () => { if (selected) setPhaseDraft({ projectId: selected.Id, title: '', status: 'Todo', progress: 0, start: '', end: '', path: '' }) }
  const editPhase = (phase: ProjectRecord['Phases'][number]) => { if (selected) setPhaseDraft({ projectId: selected.Id, phaseId: phase.Id, title: phase.Title, status: phase.Status, progress: Math.max(0, Math.min(100, phase.ProgressPercent || 0)), start: localDateInputValue(phase.StartDate), end: localDateInputValue(phase.EndDate), path: phase.ProjectPath }) }
  const savePhase = async () => {
    if (!phaseDraft || phaseSaveLock.current) return
    const title = phaseDraft.title.trim(), project = state.Projects.find(item => item.Id === phaseDraft.projectId)
    if (!title) { toast.error('请输入阶段名称'); return }
    if (!project) { toast.error('项目已不存在'); return }
    if (phaseDraft.start && phaseDraft.end && phaseDraft.end < phaseDraft.start) { toast.error('结束日期不能早于开始日期'); return }
    const original = phaseDraft.phaseId ? project.Phases.find(phase => phase.Id === phaseDraft.phaseId) : undefined
    if (phaseDraft.phaseId && !original) { toast.error('阶段已不存在'); return }
    const phase: ProjectRecord['Phases'][number] = { Id: original?.Id ?? uid(), Title: title, Status: phaseDraft.status, ProgressPercent: phaseDraft.progress, StartDate: localDateIsoValue(phaseDraft.start), EndDate: localDateIsoValue(phaseDraft.end), ProjectPath: phaseDraft.path.trim(), Subtasks: original?.Subtasks ?? [] }
    const next = { ...project, Phases: original ? project.Phases.map(item => item.Id === original.Id ? phase : item) : [...project.Phases, phase] }
    phaseSaveLock.current = true; setSavingPhase(true)
    try {
      await persist({ ...state, Projects: state.Projects.map(item => item.Id === project.Id ? next : item) }, original ? '阶段已保存' : '阶段已添加')
      setSelected(next); setExpandedPhaseId(phase.Id); setPhaseDraft(null)
    } catch (error) { toast.error(error instanceof Error ? error.message : '保存失败，请重试') }
    finally { phaseSaveLock.current = false; setSavingPhase(false) }
  }
  const chooseDraftPath = async () => {
    if (!phaseDraft) return
    const draft = phaseDraft
    const result = await window.dustdesk.pickFolder('选择阶段路径')
    if (result.ok && result.path) setPhaseDraft(current => current && current.projectId === draft.projectId ? { ...current, path: result.path! } : current)
  }
  const updatePhase = (phaseId: string, changes: Partial<ProjectRecord['Phases'][number]>) => { if (!selected) return; updateSelected({ ...selected, Phases: selected.Phases.map(phase => phase.Id === phaseId ? { ...phase, ...changes } : phase) }) }
  const addSubtask = (phaseId: string) => { if (!selected) return; const title = (subtaskDrafts[phaseId] ?? '').trim(); const phase = selected.Phases.find(item => item.Id === phaseId); if (!title || !phase) return; updatePhase(phaseId, { Subtasks: [...phase.Subtasks, { Id: uid(), Title: title, IsCompleted: false, FilePath: '' }] }); setSubtaskDrafts(current => ({ ...current, [phaseId]: '' })) }
  const updateSubtask = (phaseId: string, subtaskId: string, changes: Partial<ProjectRecord['Phases'][number]['Subtasks'][number]>) => { const phase = selected?.Phases.find(item => item.Id === phaseId); if (!phase) return; updatePhase(phaseId, { Subtasks: phase.Subtasks.map(item => item.Id === subtaskId ? { ...item, ...changes } : item) }) }
  const removeSubtask = (phaseId: string, subtaskId: string) => { const phase = selected?.Phases.find(item => item.Id === phaseId); if (!phase) return; updatePhase(phaseId, { Subtasks: phase.Subtasks.filter(item => item.Id !== subtaskId) }) }
  const chooseProjectPath = async () => { if (!selected) return; const result = await window.dustdesk.pickFolder('选择项目路径'); if (result.ok && result.path) updateSelected({ ...selected, ProjectPath: result.path }) }
  const chooseSubtaskPath = async (phaseId: string, subtaskId: string) => { const result = await window.dustdesk.pickPath('选择子事项关联路径'); if (result.ok && result.path) updateSubtask(phaseId, subtaskId, { FilePath: result.path }) }
  const openPath = (target?: string | null) => { if (target?.trim()) void window.dustdesk.openPath(target) }
  const createTask = (text: string) => { const title = text.trim(); if (!title) return; void persist({ ...state, Todos: [{ Id: uid(), Title: title.slice(0, 80), Tag: '项目', Note: title, IsCompleted: false, CreatedAt: now(), ReminderRepeat: 'None' }, ...state.Todos] }, '已创建任务') }
  const pinProject = () => widgets.toggle(pinnedKey, "项目已固定到桌面", "项目已取消固定")
  const deleteProject = async () => { if (!selected || !window.confirm('确定删除这个项目吗？')) return; const key = `project:${selected.Id}`; await window.dustdesk.hideWidget(key); const placements = { ...(state.Settings.WidgetPlacements ?? {}) }; delete placements[key]; const nextProjects = state.Projects.filter(item => item.Id !== selected.Id); setSelected(nextProjects[0] ?? null); await persist({ ...state, Projects: nextProjects, Settings: { ...state.Settings, WidgetPlacements: placements } }, '项目已删除') }
  const deletePhase = (phaseId: string) => { if (!selected || !window.confirm('确定删除这个阶段吗？')) return; updateSelected({ ...selected, Phases: selected.Phases.filter(item => item.Id !== phaseId) }); setPhaseDraft(null); if (expandedPhaseId === phaseId) setExpandedPhaseId(null) }
  const phaseDialog = phaseDraft && <div className="modal-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) closePhaseDialog() }}>
    <div className="library-modal project-phase-dialog" role="dialog" aria-modal="true" aria-labelledby="project-phase-dialog-title" aria-busy={savingPhase}>
      <div className="modal-header"><div><span className="section-kicker">{state.Projects.find(item => item.Id === phaseDraft.projectId)?.Name}</span><h3 id="project-phase-dialog-title">{phaseDraft.phaseId ? '编辑阶段' : '添加阶段'}</h3></div><button type="button" className="icon-button subtle" aria-label="关闭弹窗" disabled={savingPhase} onClick={closePhaseDialog}><X size={16} /></button></div>
      <form className="modal-form" onSubmit={event => { event.preventDefault(); void savePhase() }} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault() }}>
        <div className="modal-body">
          <label>阶段名称<input autoFocus required disabled={savingPhase} value={phaseDraft.title} onChange={event => setPhaseDraft({ ...phaseDraft, title: event.target.value })} placeholder="例如：需求梳理、开发、验收" /></label>
          <div className="phase-dialog-fields">
            <label>状态<select aria-label="状态" disabled={savingPhase} value={phaseDraft.status} onChange={event => setPhaseDraft({ ...phaseDraft, status: event.target.value as ProjectStatus })}><option value="Todo">待开始</option><option value="Doing">进行中</option><option value="Done">已完成</option></select></label>
            <label>进度（%）<input disabled={savingPhase} type="number" min={0} max={100} value={phaseDraft.progress} onChange={event => setPhaseDraft({ ...phaseDraft, progress: Math.max(0, Math.min(100, Number(event.target.value) || 0)) })} /></label>
            <label>开始日期<input disabled={savingPhase} type="date" value={phaseDraft.start} onChange={event => setPhaseDraft({ ...phaseDraft, start: event.target.value })} /></label>
            <label>结束日期<input disabled={savingPhase} type="date" min={phaseDraft.start || undefined} value={phaseDraft.end} onChange={event => setPhaseDraft({ ...phaseDraft, end: event.target.value })} /></label>
          </div>
          <label>阶段路径<div className="modal-input-action"><input disabled={savingPhase} value={phaseDraft.path} onChange={event => setPhaseDraft({ ...phaseDraft, path: event.target.value })} placeholder="可选，关联阶段文件夹" /><button type="button" className="icon-button" aria-label="选择阶段路径" disabled={savingPhase} onClick={() => void chooseDraftPath()}><FolderOpen size={16} /></button></div></label>
          {phaseDraft.phaseId && <div className="phase-dialog-tools"><button type="button" className="secondary-button" disabled={savingPhase || !phaseDraft.path.trim()} onClick={() => openPath(phaseDraft.path)}><ExternalLink size={14} />打开路径</button><button type="button" className="text-button" disabled={savingPhase} onClick={() => createTask(phaseDraft.title)}>转任务</button><button type="button" className="icon-button danger" title="删除阶段" disabled={savingPhase} onClick={() => deletePhase(phaseDraft.phaseId!)}><Trash2 size={15} /></button></div>}
        </div>
        <div className="modal-actions"><button type="button" className="secondary-button" disabled={savingPhase} onClick={closePhaseDialog}>取消</button><button type="submit" className="primary-button" disabled={savingPhase || !phaseDraft.title.trim()}>{savingPhase ? '保存中…' : phaseDraft.phaseId ? '保存阶段' : '添加阶段'}</button></div>
      </form>
    </div>
  </div>
  const exportData = async () => { const result = await window.dustdesk.exportProjects(); if (result.ok) toast.success(`项目已导出：${result.path}`); else if (!result.canceled) toast.error(result.error ?? '导出失败') }
  return <><PageHeader eyebrow="Projects" title="项目" description="把阶段、进度和下一步行动放在同一张地图上。" action={<div className="page-actions"><button className="secondary-button" onClick={() => void exportData()} disabled={!state.Projects.length}><Download size={16} />导出</button><button className="primary-button" onClick={add}><Plus size={16} />新建项目</button></div>} /><div className="project-grid"><Panel><div className="panel-heading"><h3>全部项目</h3><span className="muted">{state.Projects.length} 个</span></div>{state.Projects.map(project => <button key={project.Id} className={`project-row ${selected?.Id === project.Id ? 'selected' : ''}`} onClick={() => setSelected(project)}><span className="project-icon"><FolderKanban size={17} /></span><span><strong>{project.Name}</strong><small>{project.Phases.length} 个阶段 · {project.Phases.reduce((sum, phase) => sum + phase.Subtasks.length, 0)} 个子事项</small></span><ChevronRight size={15} /></button>)}{state.Projects.length === 0 && <Empty icon={FolderKanban} title="还没有项目" description="新建一个项目，把阶段和子事项组织起来。" action={<button className="text-button" onClick={add}>创建项目 <Plus size={14} /></button>} />}</Panel><Panel>{selected ? <><div className="editor-toolbar"><span className="section-kicker">项目详情</span><div><button className="secondary-button" aria-pressed={Boolean(widgets.visibility[pinnedKey])} disabled={widgets.busy[pinnedKey]} onClick={() => void pinProject()}><Pin size={14} />{widgets.visibility[pinnedKey] ? '取消固定' : '固定'}</button><button className="secondary-button" onClick={() => void chooseProjectPath()}><FolderOpen size={14} />选择路径</button><button className="secondary-button" onClick={() => openPath(selected.ProjectPath)}><ExternalLink size={14} />打开</button><button className="secondary-button" onClick={addPhase}><Plus size={14} />添加阶段</button><button className="icon-button danger" title="删除项目" onClick={() => void deleteProject()}><Trash2 size={16} /></button></div></div><input id={searchTargetId('project', selected.Id)} data-search-target aria-label="项目名称" className="note-title compact-title" value={selected.Name} onChange={event => updateSelected({ ...selected, Name: event.target.value })} /><small className="muted">{selected.ProjectPath || '尚未选择项目路径'}</small>{selected.Phases.length ? <ProjectGantt key={selected.Id} phases={selected.Phases} expandedPhaseId={expandedPhaseId} onExpand={id => setExpandedPhaseId(current => current === id ? null : id)} onEdit={editPhase}>
  {selected.Phases.filter(phase => phase.Id === expandedPhaseId).map(phase => <div className="gantt-subtasks" key={phase.Id}>
    <div className="gantt-subtasks-heading"><strong>{phase.Title} · 子事项</strong><button className="text-button" onClick={() => editPhase(phase)}>编辑阶段</button></div>
    <div className="subtask-list">{phase.Subtasks.map(subtask => <div className="subtask-row" key={subtask.Id} id={searchTargetId('subtask', subtask.Id)} data-search-target tabIndex={-1}><button className={`todo-check ${subtask.IsCompleted ? 'checked' : ''}`} onClick={() => updateSubtask(phase.Id, subtask.Id, { IsCompleted: !subtask.IsCompleted })}>{subtask.IsCompleted && <Check size={12} />}</button><span className={subtask.IsCompleted ? 'completed-text' : ''}>{subtask.Title}<small>{subtask.FilePath}</small></span><button className="mini-button" onClick={() => void chooseSubtaskPath(phase.Id, subtask.Id)}>关联</button><button className="mini-button" onClick={() => openPath(subtask.FilePath)}>打开</button><button className="text-button" onClick={() => createTask(subtask.Title)}>任务</button><button className="text-button" onClick={() => { if (window.confirm('确定删除这个子事项吗？')) removeSubtask(phase.Id, subtask.Id) }}><Trash2 size={13} /></button></div>)}<div className="subtask-add"><input value={subtaskDrafts[phase.Id] ?? ''} onChange={event => setSubtaskDrafts(current => ({ ...current, [phase.Id]: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter') addSubtask(phase.Id) }} placeholder="添加子事项" /><button className="icon-button subtle" title="添加子事项" onClick={() => addSubtask(phase.Id)}><Plus size={15} /></button></div></div>
  </div>)}
</ProjectGantt> : <div className="project-empty"><Sparkles size={18} /><strong>从一个阶段开始</strong><span>添加阶段日期，在甘特图中安排进度。</span></div>}</> : <Empty icon={FolderKanban} title="选择一个项目" description="项目详情会显示在这里。" />}</Panel></div>{phaseDialog}</>
}
