import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import type { WorkspaceState } from '../../../shared/types'

export const generalWidgets = [['todo', '任务'], ['notes', '便签'], ['projects', '项目'], ['launcher', '启动器'], ['links', '链接'], ['clipboard', '剪贴板'], ['organizer', '收纳'], ['search', '搜索'], ['monitor', '监控'], ['countdown', '倒计时']] as const

export function organizerWidgetKey(state: WorkspaceState, categoryIds: string[]) {
  const suffix = [...new Set(categoryIds.filter(Boolean))].sort().join(',')
  return Object.keys(state.Settings.WidgetPlacements ?? {}).find(key => key.startsWith('organizer-group:') && [...new Set(key.slice(16).split(','))].sort().join(',') === suffix) ?? `organizer-group:${suffix}`
}

type Controls = {
  visibility: Record<string, boolean>; busy: Record<string, boolean>
  setVisible: (key: string, visible: boolean, message?: string) => Promise<void>
  toggle: (key: string, showMessage?: string, hideMessage?: string) => Promise<void>
  refresh: () => Promise<void>
}
const WidgetVisibilityContext = createContext<Controls | null>(null)

export function WidgetVisibilityProvider({ state, children }: { state: WorkspaceState; children: ReactNode }) {
  const keys = JSON.stringify([...new Set([...generalWidgets.map(([key]) => key), ...state.Projects.map(project => `project:${project.Id}`), ...state.Notes.map(note => `note:${note.Id}`), ...Object.keys(state.Settings.WidgetPlacements ?? {})])])
  const keysRef = useRef<string[]>([]); keysRef.current = JSON.parse(keys)
  const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const current = useRef<Record<string, boolean>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const locks = useRef(new Set<string>()), revisions = useRef(new Map<string, number>())
  const receive = useCallback((key: string, visible: boolean) => {
    revisions.current.set(key, (revisions.current.get(key) ?? 0) + 1)
    current.current = { ...current.current, [key]: visible }
    setVisibility(current.current)
  }, [])
  const refresh = useCallback(async () => {
    const before = new Map(revisions.current)
    const requests: Promise<Record<string, boolean>>[] = []
    for (let index = 0; index < keysRef.current.length; index += 100) requests.push(window.dustdesk.getWidgetVisibility(keysRef.current.slice(index, index + 100)))
    const result = Object.assign({}, ...await Promise.all(requests)) as Record<string, boolean>
    for (const [key, visible] of Object.entries(result)) {
      if (revisions.current.get(key) === before.get(key)) receive(key, visible)
    }
  }, [receive])
  useEffect(() => window.dustdesk.onWidgetVisibilityChanged(receive), [receive])
  useEffect(() => { void refresh().catch(() => toast.error('无法读取小组件状态，请重试')) }, [keys, refresh])
  const setVisible = useCallback(async (key: string, visible: boolean, message?: string) => {
    if (!key || locks.current.has(key)) return
    locks.current.add(key); setBusy(value => ({ ...value, [key]: true }))
    const revision = revisions.current.get(key)
    try {
      const result = await window.dustdesk.setWidgetVisibility(key, visible)
      if (!result.ok) throw Error(result.error || '小组件操作失败')
      if (revisions.current.get(key) === revision) receive(key, result.visible)
      if (message) toast.success(message)
    } catch (error) { toast.error(error instanceof Error ? error.message : '小组件操作失败，请重试') }
    finally { locks.current.delete(key); setBusy(value => ({ ...value, [key]: false })) }
  }, [receive])
  const toggle = useCallback((key: string, showMessage?: string, hideMessage?: string) => {
    const visible = !current.current[key]
    return setVisible(key, visible, visible ? showMessage : hideMessage)
  }, [setVisible])
  return <WidgetVisibilityContext.Provider value={{ visibility, busy, setVisible, toggle, refresh }}>{children}</WidgetVisibilityContext.Provider>
}

export function useWidgetVisibility() {
  const controls = useContext(WidgetVisibilityContext)
  if (!controls) throw Error('WidgetVisibilityProvider is required')
  return controls
}
