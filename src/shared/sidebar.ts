export const sidebarPageIds = ['overview', 'tasks', 'notes', 'projects', 'library', 'clipboard', 'organizer', 'screenshot', 'monitor', 'focus', 'stats', 'health', 'recycle', 'textTools', 'imageTools', 'lan'] as const
export type SidebarPage = typeof sidebarPageIds[number]
export const sidebarDefaultHidden: readonly SidebarPage[] = ['textTools', 'imageTools', 'lan']

export function normalizeSidebarPreferences(settings: { SidebarOrder?: unknown; SidebarHidden?: unknown }) {
  const valid = (value: unknown): value is SidebarPage => typeof value === 'string' && (sidebarPageIds as readonly string[]).includes(value)
  const ids = (value: unknown) => [...new Set(Array.isArray(value) ? value.filter(valid) : [])]
  const saved = ids(settings.SidebarOrder)
  return { order: [...saved, ...sidebarPageIds.filter(id => !saved.includes(id))], hidden: ids(Array.isArray(settings.SidebarHidden) ? settings.SidebarHidden : sidebarDefaultHidden) }
}
