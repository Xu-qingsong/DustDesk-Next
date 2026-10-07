import { TaskWidget, NotesWidget } from './EditableWidgets'
import { useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, EyeOff, Lock, Magnet, Pin, TimerReset, X } from 'lucide-react'
import { toast } from 'sonner'
import type { WidgetPlacement, WorkspaceState } from '../../../shared/types'
import { argbCss } from '../utils/colors'
import { WidgetResizeGrip } from './WidgetResizeGrip'
import { SearchWidget } from './SearchWidget'
import { OrganizerGroupWidget } from './OrganizerGroupWidget'
import { OrganizerContent } from './OrganizerContent'
import { MonitorWidget } from './MonitorWidget'
import { CountdownWidget } from './CountdownWidget'
import { LinksWidget } from './LinksWidget'
import { useWidgetDrag } from './useWidgetDrag'
import { useFileSearch } from '../hooks/useFileSearch'

const widgetKey = new URLSearchParams(window.location.search).get('widget') ?? 'todo'

export function WidgetHost() {
  const drag = useWidgetDrag(widgetKey)
  const [state, setState] = useState<WorkspaceState | null>(null)
  const [search, setSearch] = useState('')
  const files = useFileSearch(widgetKey === 'search' ? search : '', 200)
  const [appearance, setAppearance] = useState({ color: -1, alpha: 245 / 255 })
  const [collapsed, setCollapsed] = useState(false)
  useEffect(() => { document.documentElement.classList.add('widget-window'); document.body.classList.add('widget-window'); return () => { document.documentElement.classList.remove('widget-window'); document.body.classList.remove('widget-window') } }, [])
  useEffect(() => { void window.dustdesk.loadWorkspace().then(next => { setState(next); setAppearance({ color: next.Settings.WidgetBackgroundColorArgb ?? -1, alpha: 245 / 255 }) }); const unsubscribe = window.dustdesk.onWorkspaceChanged(next => { setState(next); setAppearance(current => ({ color: next.Settings.WidgetBackgroundColorArgb ?? current.color, alpha: current.alpha })) }); const stopAppearance = window.dustdesk.onWidgetAppearance(setAppearance); return () => { unsubscribe(); stopAppearance() } }, [])
  useEffect(() => { const current = state?.Settings.WidgetPlacements?.[widgetKey]; if (current) setAppearance(value => ({ ...value, alpha: current.TransparentBackground ? 72 / 255 : 245 / 255 })) }, [state])
  const placement = (state?.Settings.WidgetPlacements?.[widgetKey] ?? {}) as WidgetPlacement
  useEffect(() => { setCollapsed(Boolean(placement.IsCollapsed)); if (!placement.AutoCollapseEnabled) return; const timer = window.setTimeout(() => { setCollapsed(true); void window.dustdesk.setWidgetOptions(widgetKey, { collapsed: true }) }, 10_000); return () => window.clearTimeout(timer) }, [placement.AutoCollapseEnabled, placement.IsCollapsed])
  if (!state) return <div className="widget-shell">正在加载工作区...</div>
  if (widgetKey.startsWith('organizer-group:')) return <OrganizerGroupWidget state={state} groupKey={widgetKey.slice('organizer-group:'.length)} />
  if (widgetKey === 'search') return <SearchWidget placement={placement} appearance={appearance} query={search} setQuery={setSearch} files={files} />
  const noteId = widgetKey.startsWith('note:') ? widgetKey.slice(5) : ''
  const projectId = widgetKey.startsWith('project:') ? widgetKey.slice(8) : ''
  const snapToEdges = placement.SnapToEdges ?? (widgetKey === 'launcher' && state.Settings.LauncherWidgetSnapToEdges)
  const setOption = async (option: Parameters<typeof window.dustdesk.setWidgetOptions>[1]) => { const result = await window.dustdesk.setWidgetOptions(widgetKey, option); if (!result.ok) toast.error(result.error ?? '小组件设置失败'); else void window.dustdesk.loadWorkspace().then(setState) }
  const title = noteId ? '便签' : projectId ? '项目' : ({ todo: '今天的任务', notes: '最近便签', projects: '项目进度', launcher: '快捷启动', links: '常用链接', clipboard: '剪贴板', organizer: '桌面收纳', monitor: '系统检测', countdown: '下班倒计时' } as Record<string, string>)[widgetKey] ?? 'DustDesk'
  const body = widgetKey === 'notes' || noteId ? <NotesWidget state={state} noteId={noteId} /> : widgetKey === 'projects' || projectId ? <div className="widget-todos">{state.Projects.filter(project => !projectId || project.Id === projectId).map(project => <div className="widget-todo" key={project.Id}><span>{project.Name}</span><small>{project.Phases.filter(phase => phase.Status === 'Done').length}/{project.Phases.length} 阶段</small></div>)}</div> : widgetKey === 'launcher' ? <div className="widget-todos">{state.Launchers.map(item => <button className="widget-todo widget-link" key={item.Id} onClick={() => void window.dustdesk.openPath(item.Path)}><span className="widget-launcher-icon" style={{ width: state.Settings.LauncherWidgetIconSize, height: state.Settings.LauncherWidgetIconSize }}>{item.Name.slice(0, 1).toUpperCase()}</span><span>{state.Settings.LauncherWidgetShowNames ? item.Name : item.Path}</span>{state.Settings.LauncherWidgetShowNames && <small>{item.Path}</small>}</button>)}</div> : widgetKey === 'links' ? <LinksWidget groups={state.LinkGroups} /> : widgetKey === 'clipboard' ? <div className="widget-todos">{state.ClipboardHistory.map(item => <button className="widget-todo widget-link" key={item.Id} onClick={() => void window.dustdesk.writeClipboard({ recordId: item.Id }).catch(() => toast.error('复制失败，记录或图片不可用'))}><span>{item.Text || item.ImageFileName || '图片内容'}</span></button>)}</div> : widgetKey === 'organizer' ? <OrganizerContent categories={state.DesktopCategories} iconSize={state.Settings.OrganizerWidgetIconSize} /> : widgetKey === 'monitor' ? <MonitorWidget settings={state.Settings} /> : widgetKey === 'countdown' ? <CountdownWidget settings={state.Settings} /> : <TaskWidget state={state} />
  return <div className={`widget-shell ${collapsed ? 'widget-collapsed' : ''}`} style={{ background: argbCss(appearance.color, appearance.alpha) }}><div className="widget-head" {...drag}><div className="widget-title-drag" data-widget-drag-handle><h2>{title}</h2></div><div className="widget-controls"><button className={`mini-button ${placement.Locked ? 'selected' : ''}`} title="锁定大小" onClick={() => void setOption({ locked: !placement.Locked })}><Lock size={13} /></button><button className={`mini-button ${placement.TopMost ? 'selected' : ''}`} title="置顶" onClick={() => void setOption({ topMost: !placement.TopMost })}><Pin size={13} /></button><button className={`mini-button ${placement.TransparentBackground ? 'selected' : ''}`} title="透明背景" onClick={() => void setOption({ transparentBackground: !placement.TransparentBackground })}><EyeOff size={13} /></button><button className={`mini-button ${placement.AutoCollapseEnabled ? 'selected' : ''}`} title="10 秒后自动折叠" onClick={() => void setOption({ autoCollapse: !placement.AutoCollapseEnabled })}><TimerReset size={13} /></button><button className={`mini-button ${snapToEdges ? 'selected' : ''}`} title="吸附屏幕边缘" aria-pressed={Boolean(snapToEdges)} onClick={() => void setOption({ snapToEdges: !snapToEdges })}><Magnet size={13} /></button><button className="mini-button widget-collapse-toggle" title={collapsed ? '展开' : '折叠'} aria-expanded={!collapsed} onClick={() => { const next = !collapsed; setCollapsed(next); void setOption({ collapsed: next }) }}>{collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</button><button className="mini-button" title="隐藏小组件" onClick={() => void window.dustdesk.hideWidget(widgetKey).then(result => { if (!result.ok) toast.error(result.error || "隐藏失败") }).catch(() => toast.error("隐藏失败"))}><X size={13} /></button></div></div>{!collapsed && <div className="widget-content">{body}</div>}{!collapsed && <WidgetResizeGrip widgetKey={widgetKey} locked={placement.Locked} />}</div>
}
