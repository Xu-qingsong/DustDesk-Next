import { FocusPage, RecycleBinPage, ResourceHealthPage } from '../pages/ProductivityPages'
import { useEffect, useMemo, useRef, useState } from 'react'
import type React from 'react'
import { Sparkles } from 'lucide-react'
import { Toaster } from 'sonner'
import type { NoteRecord, WorkspaceState } from '../../../shared/types'
import '../styles.css'
import { ClipboardPage } from '../pages/Clipboard'
import { Library } from '../pages/Library'
import { MonitorPage } from '../pages/Monitor'
import { Notes } from '../pages/Notes'
import { Organizer } from '../pages/Organizer'
import { Overview } from '../pages/Overview'
import { Projects } from '../pages/Projects'
import { ScreenshotPage } from '../pages/Screenshot'
import { Settings } from '../pages/Settings'
import { StatsPage } from '../pages/Stats'
import { Tasks } from '../pages/Tasks'
import { HotkeyEditor, WidgetPicker } from '../widgets/WidgetPicker'
import { Sidebar } from '../components/Sidebar'
import { Topbar } from '../components/Topbar'
import { useClipboardSubscription } from '../hooks/useClipboardSubscription'
import { useFileSearch } from '../hooks/useFileSearch'
import { useWorkspace } from '../hooks/useWorkspace'
import { nav, pageDescriptions, type Page } from './navigation'
import { now, uid } from '../utils/ids'
import type { SearchNavigation, SearchResult, SearchTarget } from './searchNavigation'

export function App() {
  const { state, loaded, dataPath, persist } = useWorkspace()
  const [page, setPage] = useState<Page>('overview'); const [query, setQuery] = useState(''); const [screenshotImage, setScreenshotImage] = useState<{ dataUrl: string } | null>(null)
  const theme = state.Settings.Theme === 'dark' ? 'dark' : 'light'
  const setTheme = (next: 'light' | 'dark') => { void persist({ ...state, Settings: { ...state.Settings, Theme: next } }, '主题已保存') }
  useClipboardSubscription(state, persist)
  const [searchNavigation, setSearchNavigation] = useState<SearchNavigation>()
  const searchSequence = useRef(0)
  const navigatePage = (next: Page) => { setSearchNavigation(undefined); setPage(next) }
  const navigateTarget = (target: SearchTarget) => { setSearchNavigation({ target, requestId: ++searchSequence.current }); setPage(target.page) }
  const fileResults = useFileSearch(query)
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => window.dustdesk.onScreenshotCaptured(dataUrl => { setScreenshotImage({ dataUrl }); navigatePage('screenshot') }), [])
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
    if (event.key !== 'Enter') return
    const match = /^(todo|task|note|clip|open)(?:\s+(.*))?$/i.exec(query.trim())
    if (!match?.[1]) return
    const command = match[1].toLowerCase(); const argument = (match[2] ?? '').trim()
    if (command === 'clip') { navigatePage('clipboard'); setQuery(''); return }
    if (command === 'open' && argument) { void window.dustdesk.openPath(argument); setQuery(''); return }
    if (command === 'todo' || command === 'task') {
      if (argument) {
        const id = uid()
        persistUpdate('Todos', [...state.Todos, { Id: id, Title: argument, Tag: '', Note: '', IsCompleted: false, CreatedAt: now(), ReminderRepeat: 'None' }], '任务已创建')
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
  return <><div className="app-shell"><Sidebar state={state} page={page} setPage={navigatePage} nav={nav} /><main className="main-area"><Topbar title={pageTitle} description={pageDescriptions[page]} query={query} setQuery={setQuery} onKeyDown={handleSearchKey} results={searchResults} onSelect={selectSearchResult} theme={theme} setTheme={setTheme} /><section className="content"><div className="content-inner">{page === 'focus' && <FocusPage state={state} />}{page === 'recycle' && <RecycleBinPage state={state} />}{page === 'health' && <ResourceHealthPage />}{page === 'overview' && <Overview state={state} persist={persist} onNavigate={navigatePage} onAdd={title => persistUpdate('Todos', [...state.Todos, { Id: uid(), Title: title, Tag: '', Note: '', IsCompleted: false, CreatedAt: now(), ReminderRepeat: 'None' }], '任务已创建')} />}{page === 'tasks' && <Tasks state={state} persist={persist} navigation={searchNavigation} />}{page === 'notes' && <Notes state={state} persist={persist} navigation={searchNavigation} />}{page === 'projects' && <Projects state={state} persist={persist} navigation={searchNavigation} />}{page === 'library' && <Library state={state} persist={persist} navigation={searchNavigation} />}{page === 'clipboard' && <ClipboardPage state={state} persist={persist} />}{page === 'organizer' && <Organizer state={state} persist={persist} navigation={searchNavigation} />}<div hidden={page !== 'screenshot'}><ScreenshotPage initialImage={screenshotImage} /></div>{page === 'monitor' && <MonitorPage state={state} persist={persist} />}{page === 'stats' && <StatsPage state={state} />}{page === 'settings' && <Settings state={state} persist={persist} path={dataPath} theme={theme} setTheme={setTheme} />}</div></section></main><Toaster position="bottom-right" duration={2200} /></div><HotkeyEditor /><WidgetPicker /></>
}
