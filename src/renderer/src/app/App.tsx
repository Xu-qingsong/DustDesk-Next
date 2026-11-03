import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Sparkles } from 'lucide-react'
import { Toaster, toast } from 'sonner'
import type { NoteRecord, WorkspaceState } from '../../../shared/types'
import '../styles.css'
import '../toolbox/toolbox.css'
import { normalizeSidebarPreferences } from '../../../shared/sidebar'
import { Overview } from '../pages/Overview'
import { Sidebar } from '../components/Sidebar'
import { Topbar } from '../components/Topbar'
import { useClipboardSubscription } from '../hooks/useClipboardSubscription'
import { useFileSearch } from '../hooks/useFileSearch'
import { useWorkspace } from '../hooks/useWorkspace'
import { WidgetVisibilityProvider } from '../hooks/useWidgetVisibility'
import { nav, pageDescriptions, type Page } from './navigation'
import { now, uid } from '../utils/ids'
import { isComposingKey } from '../utils/keyboard'
import type { SearchNavigation, SearchResult, SearchTarget } from './searchNavigation'
import type { ScreenshotPayload } from '../../../shared/screenshotDocument'
import type { SettingsAnchor } from '../pages/Settings'

const TextToolbox = lazy(() => import('../pages/TextToolbox').then(module => ({ default: module.TextToolbox })))
const ImageToolbox = lazy(() => import('../pages/ImageToolbox').then(module => ({ default: module.ImageToolbox })))
const LanTransfer = lazy(() => import('../pages/LanTransfer').then(module => ({ default: module.LanTransfer })))
const ClipboardPage = lazy(() => import('../pages/Clipboard').then(module => ({ default: module.ClipboardPage })))
const Library = lazy(() => import('../pages/Library').then(module => ({ default: module.Library })))
const MonitorPage = lazy(() => import('../pages/Monitor').then(module => ({ default: module.MonitorPage })))
const Notes = lazy(() => import('../pages/Notes').then(module => ({ default: module.Notes })))
const Organizer = lazy(() => import('../pages/Organizer').then(module => ({ default: module.Organizer })))
const Projects = lazy(() => import('../pages/Projects').then(module => ({ default: module.Projects })))
const ScreenshotPage = lazy(() => import('../pages/Screenshot').then(module => ({ default: module.ScreenshotPage })))
const Settings = lazy(() => import('../pages/Settings').then(module => ({ default: module.Settings })))
const StatsPage = lazy(() => import('../pages/Stats').then(module => ({ default: module.StatsPage })))
const Tasks = lazy(() => import('../pages/Tasks').then(module => ({ default: module.Tasks })))
const FocusPage = lazy(() => import('../pages/ProductivityPages').then(module => ({ default: module.FocusPage })))
const RecycleBinPage = lazy(() => import('../pages/ProductivityPages').then(module => ({ default: module.RecycleBinPage })))
const ResourceHealthPage = lazy(() => import('../pages/ProductivityPages').then(module => ({ default: module.ResourceHealthPage })))
const HotkeyEditor = lazy(() => import('../widgets/WidgetPicker').then(module => ({ default: module.HotkeyEditor })))
const WidgetPicker = lazy(() => import('../widgets/WidgetPicker').then(module => ({ default: module.WidgetPicker })))

export function App() {
  const [screenshotDocument, setScreenshotDocument] = useState<ScreenshotPayload | null>(null)
  const { state, loaded, dataPath, persist } = useWorkspace()
  const [visitedTools, setVisitedTools] = useState<Page[]>([])
  const [page, setPage] = useState<Page>('overview'); const [query, setQuery] = useState(''); const [screenshotImage, setScreenshotImage] = useState<{ dataUrl: string } | null>(null)
  const [settingsAnchor, setSettingsAnchor] = useState<SettingsAnchor>()
  const theme = state.Settings.Theme === 'dark' ? 'dark' : 'light'
  const setTheme = (next: 'light' | 'dark') => { void persist({ ...state, Settings: { ...state.Settings, Theme: next } }, '主题已保存') }
  useClipboardSubscription(state, persist)
  const [searchNavigation, setSearchNavigation] = useState<SearchNavigation>()
  const searchSequence = useRef(0)
  const navigatePage = (next: Page) => { setSearchNavigation(undefined); if (next !== 'settings') setSettingsAnchor(undefined); if (['textTools','imageTools','lan','screenshot'].includes(next)) setVisitedTools(current => current.includes(next) ? current : [...current, next]); setPage(next) }
  const navigateSettings = (anchor: SettingsAnchor) => { setSettingsAnchor(anchor); navigatePage('settings') }
  useEffect(() => {
    if (!loaded) return
    const preferences = normalizeSidebarPreferences(state.Settings)
    if (page === 'settings' || !preferences.hidden.includes(page as typeof preferences.hidden[number])) return
    navigatePage(preferences.order.find(id => !preferences.hidden.includes(id)) ?? 'settings')
  }, [loaded, page, state.Settings.SidebarHidden, state.Settings.SidebarOrder])
  const navigateTarget = (target: SearchTarget) => { setSearchNavigation({ target, requestId: ++searchSequence.current }); setPage(target.page) }
  const fileResults = useFileSearch(query)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => window.dustdesk.onScreenshotCaptured(dataUrl => { setScreenshotImage({ dataUrl }); navigatePage('screenshot') }), [])
  useEffect(() => window.dustdesk.onScreenshotDocument(payload => { setScreenshotDocument(payload); navigatePage('screenshot') }), [])
  useEffect(() => { const handler = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); document.getElementById('global-search')?.focus() } }; window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler) }, [])
  const persistUpdate = <K extends keyof WorkspaceState>(key: K, value: WorkspaceState[K], message?: string) => void persist({ ...state, [key]: value }, message)
  const searchResults = useMemo<SearchResult[]>(() => {
    const text = query.trim().toLowerCase()
    if (!text) return []
    const match = (...values: string[]) => values.some(value => value.toLowerCase().includes(text))
    const results: SearchResult[] = []
    const add = (title: string, meta: string, target: SearchTarget) => results.push({ key: target.kind + ':' + target.id, title, meta, target })
    for (const item of state.Todos) if (match(item.Title, item.Tag, item.Note)) add(item.Title, '任务 · ' + new Date(item.CreatedAt).toLocaleDateString('zh-CN'), { page: 'tasks', kind: 'task', id: item.Id })
    for (const item of state.Notes) if (match(item.Title, item.Text)) add(item.Title, '便签', { page: 'notes', kind: 'note', id: item.Id })
    for (const project of state.Projects) {
      if (match(project.Name, project.ProjectPath)) add(project.Name, '项目', { page: 'projects', kind: 'project', id: project.Id, projectId: project.Id })
      for (const phase of project.Phases) {
        if (match(phase.Title, phase.ProjectPath)) add(phase.Title, '阶段 · ' + project.Name, { page: 'projects', kind: 'phase', id: phase.Id, projectId: project.Id, phaseId: phase.Id })
        for (const subtask of phase.Subtasks) if (match(subtask.Title, subtask.FilePath)) add(subtask.Title, '子事项 · ' + project.Name + ' / ' + phase.Title, { page: 'projects', kind: 'subtask', id: subtask.Id, projectId: project.Id, phaseId: phase.Id })
      }
    }
    for (const group of state.LinkGroups) for (const link of group.Links) if (match(link.Name, link.Url, link.Note, group.Name)) add(link.Name, '链接 · ' + group.Name, { page: 'library', kind: 'link', id: link.Id, groupId: group.Id })
    for (const item of state.Launchers) {
      const group = state.LinkGroups.find(group => group.Id === item.GroupId) ?? state.LinkGroups[0]
      if (match(item.Name, item.Path, group?.Name ?? '')) add(item.Name, '启动器 · ' + (group?.Name ?? '未分类'), { page: 'library', kind: 'launcher', id: item.Id, groupId: group?.Id ?? '' })
    }
    for (const item of state.DesktopCategories) if (match(item.Name, ...item.ItemPaths)) add(item.Name, '桌面分类', { page: 'organizer', kind: 'category', id: item.Id })
    for (const item of fileResults) results.push({ key: 'file:' + item.Path, title: item.Name, meta: item.IsDirectory ? '文件夹' : '文件', path: item.Path })
    return results.slice(0, 12)
  }, [query, state, fileResults])
  const handleSearchKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || isComposingKey(event.nativeEvent)) return
    const match = /^(todo|task|note|clip|open)(?:\s+(.*))?$/i.exec(query.trim())
    if (!match?.[1]) return
    const command = match[1].toLowerCase(); const argument = (match[2] ?? '').trim()
    if (command === 'clip') { navigatePage('clipboard'); setQuery(''); return }
    if (command === 'open' && argument) { void window.dustdesk.openPath(argument); setQuery(''); return }
    if (command === 'todo' || command === 'task') {
      if (argument) {
        const id = uid()
        persistUpdate('Todos', [...state.Todos, { Id: id, Title: argument, Tag: '', Note: '', IsCompleted: false, CreatedAt: now(), CompletedAt: null, ReminderRepeat: 'None' }], '任务已创建')
        navigateTarget({ page: 'tasks', kind: 'task', id })
      } else navigatePage('tasks')
      setQuery('')
      return
    }
    if (command === 'note') {
      const note: NoteRecord = { Id: uid(), Title: argument || '新便签', Text: '', ColorArgb: -411768, FontColorArgb: -1385444, FontSize: 14, FontBold: false, BackgroundImageFileName: '', ImageOnly: false, CreatedAt: now(), UpdatedAt: now() }
      persistUpdate('Notes', [note, ...state.Notes], '便签已创建')
      navigateTarget({ page: 'notes', kind: 'note', id: note.Id })
      setQuery('')
    }
  }
  const selectSearchResult = (result: SearchResult) => { if (result.path) void window.dustdesk.openPath(result.path); else if (result.target) navigateTarget(result.target); setQuery('') }
  const pageTitle = page === 'overview' ? '概览' : page === 'library' ? '资源库' : nav.find(item => item.id === page)?.label ?? '设置'
  if (!loaded) return <div className="boot"><Sparkles size={22} /><span>正在打开 DustDesk</span></div>
  return <WidgetVisibilityProvider state={state}><div className="app-shell"><Sidebar state={state} page={page} setPage={navigatePage} nav={nav} /><main className="main-area"><Topbar title={pageTitle} description={pageDescriptions[page]} query={query} setQuery={setQuery} onKeyDown={handleSearchKey} results={searchResults} onSelect={selectSearchResult} theme={theme} setTheme={setTheme} /><section className="content"><div className="content-inner"><Suspense fallback={<div className="boot">正在打开页面…</div>}>{visitedTools.includes('textTools') && <div hidden={page !== 'textTools'}><TextToolbox active={page === 'textTools'} /></div>}{visitedTools.includes('imageTools') && <div hidden={page !== 'imageTools'}><ImageToolbox active={page === 'imageTools'} /></div>}{visitedTools.includes('lan') && <div hidden={page !== 'lan'}><LanTransfer active={page === 'lan'} /></div>}{page === 'focus' && <FocusPage state={state} />}{page === 'recycle' && <RecycleBinPage state={state} />}{page === 'health' && <ResourceHealthPage />}{page === 'overview' && <Overview state={state} persist={persist} onNavigate={navigatePage} onAdd={title => persistUpdate('Todos', [...state.Todos, { Id: uid(), Title: title, Tag: '', Note: '', IsCompleted: false, CreatedAt: now(), CompletedAt: null, ReminderRepeat: 'None' }], '任务已创建')} />}{page === 'tasks' && <Tasks state={state} persist={persist} navigation={searchNavigation} />}{page === 'notes' && <Notes state={state} persist={persist} navigation={searchNavigation} />}{page === 'projects' && <Projects state={state} persist={persist} navigation={searchNavigation} />}{page === 'library' && <Library state={state} persist={persist} navigation={searchNavigation} />}{page === 'clipboard' && <ClipboardPage state={state} persist={persist} onOpenSettings={() => navigateSettings('settings-general')} />}{page === 'organizer' && <Organizer state={state} persist={persist} navigation={searchNavigation} />}{visitedTools.includes('screenshot') && <div hidden={page !== 'screenshot'}><ScreenshotPage initialImage={screenshotImage} initialDocument={screenshotDocument} active={page === 'screenshot'} /></div>}{page === 'monitor' && <MonitorPage state={state} persist={persist} />}{page === 'stats' && <StatsPage state={state} />}{page === 'settings' && <Settings state={state} persist={persist} path={dataPath} theme={theme} setTheme={setTheme} initialAnchor={settingsAnchor} />}</Suspense></div></section></main><Toaster position="bottom-right" duration={2200} /></div><Suspense fallback={null}><HotkeyEditor /><WidgetPicker state={state} /></Suspense></WidgetVisibilityProvider>
}
