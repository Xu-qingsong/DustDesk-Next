const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(record)

// Normalization can supply optional defaults, but must not turn lost collections into empty ones.
export function isCompleteWorkspace(value: unknown): boolean {
  if (!record(value) || !record(value.Settings)) return false
  if (value.SchemaVersion !== undefined && (!Number.isInteger(value.SchemaVersion) || Number(value.SchemaVersion) < 1 || Number(value.SchemaVersion) > 3)) return false
  for (const key of ['Todos', 'Notes', 'Projects', 'Launchers', 'LinkGroups', 'ClipboardHistory', 'DesktopCategories', 'TagPresets']) {
    if (!records(value[key])) return false
  }
  // Legacy records may lack IDs, but content fields must survive migration intact.
  const identity = (item: Record<string, unknown>) => (item.Id === undefined && Number(value.SchemaVersion ?? 1) < 2) || (typeof item.Id === 'string' && item.Id.trim().length > 0)
  const strings = (item: Record<string, unknown>, ...keys: string[]) => keys.every(key => typeof item[key] === 'string')
  const collection = (items: unknown, valid: (item: Record<string, unknown>) => boolean): boolean => {
    if (!records(items) || !items.every(item => identity(item) && valid(item))) return false
    const ids = items.flatMap(item => typeof item.Id === 'string' ? [item.Id] : [])
    return new Set(ids).size === ids.length
  }
  const project = (item: Record<string, unknown>): boolean => strings(item, 'Name') && collection(item.Phases, phase => strings(phase, 'Title') && collection(phase.Subtasks, task => strings(task, 'Title')))
  const link = (item: Record<string, unknown>) => strings(item, 'Name', 'Url')
  const group = (item: Record<string, unknown>) => strings(item, 'Name') && collection(item.Links, link)
  const clipboard = (item: Record<string, unknown>) => {
    if (!strings(item, 'Text') || (item.Kind !== 'Text' && item.Kind !== 'Image')) return false
    return item.Kind === 'Text'
      || (typeof item.ImagePngBase64 === 'string' && item.ImagePngBase64.length > 0)
      || (typeof item.ImageAssetName === 'string' && /^[a-f0-9]{64}\.png$/.test(item.ImageAssetName))
  }
  if (!collection(value.Todos, item => strings(item, 'Title'))
    || !collection(value.Notes, item => strings(item, 'Title', 'Text'))
    || !collection(value.Projects, project)
    || !collection(value.Launchers, item => strings(item, 'Name', 'Path'))
    || !collection(value.LinkGroups, group)
    || !collection(value.ClipboardHistory, clipboard)
    || !collection(value.DesktopCategories, item => strings(item, 'Name') && Array.isArray(item.ItemPaths) && item.ItemPaths.every(path => typeof path === 'string'))
    || !(value.TagPresets as Record<string, unknown>[]).every(item => strings(item, 'Name'))) return false
  // Link operations identify links across groups, while recovery/history actions
  // identify entries across the entire collection. Ambiguous IDs would drop data.
  if (!collection((value.LinkGroups as Record<string, unknown>[]).flatMap(group => group.Links as Record<string, unknown>[]), link)) return false
  for (const key of ['RecycleBin', 'OrganizerRules', 'FocusSessions']) if (value[key] !== undefined && !collection(value[key], () => true)) return false
  if (Array.isArray(value.RecycleBin) && !value.RecycleBin.every(item => {
    if (!record(item) || typeof item.Id !== 'string' || !record(item.value) || typeof item.value.Id !== 'string' || !Number.isFinite(Date.parse(String(item.ExpiresAt)))) return false
    const payload = item.value
    switch (item.kind) {
      case 'task': case 'note': return typeof payload.Title === 'string' && (item.kind !== 'note' || typeof payload.Text === 'string')
      case 'launcher': return typeof payload.Name === 'string' && typeof payload.Path === 'string'
      case 'link': return typeof payload.Name === 'string' && typeof payload.Url === 'string' && record(item.parent) && typeof item.parent.Id === 'string' && typeof item.parent.Name === 'string'
      case 'group': return group(payload)
      case 'project': return project(payload)
      default: return false
    }
  })) return false
  if (Array.isArray(value.OrganizerRules) && !value.OrganizerRules.every(rule => typeof rule.Id === 'string' && typeof rule.Enabled === 'boolean' && ['extension', 'name'].includes(rule.Match) && typeof rule.Pattern === 'string' && typeof rule.CategoryId === 'string')) return false
  if (Array.isArray(value.FocusSessions) && !value.FocusSessions.every(item => typeof item.Id === 'string' && typeof item.TaskTitle === 'string' && typeof item.ProjectName === 'string' && Number.isFinite(item.Seconds) && item.Seconds >= 0)) return false
  if (value.ActiveFocus !== undefined && value.ActiveFocus !== null) {
    const active = value.ActiveFocus
    if (!record(active) || typeof active.Id !== 'string' || typeof active.TaskTitle !== 'string' || typeof active.ProjectName !== 'string' || typeof active.ElapsedSeconds !== 'number' || !Number.isFinite(active.ElapsedSeconds) || active.ElapsedSeconds < 0 || typeof active.PlannedSeconds !== 'number' || !Number.isFinite(active.PlannedSeconds) || active.PlannedSeconds <= 0 || !Number.isFinite(Date.parse(String(active.CheckpointAt))) || (active.RunningSince !== null && !Number.isFinite(Date.parse(String(active.RunningSince))))) return false
  }
  return true
}
