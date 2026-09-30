const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const records = (value: unknown): value is Record<string, unknown>[] => Array.isArray(value) && value.every(record)

// Normalization can supply optional defaults, but must not turn lost collections into empty ones.
export function isCompleteWorkspace(value: unknown): boolean {
  if (!record(value) || !record(value.Settings)) return false
  if (value.SchemaVersion !== undefined && (!Number.isInteger(value.SchemaVersion) || Number(value.SchemaVersion) < 1 || Number(value.SchemaVersion) > 2)) return false
  for (const key of ['Todos', 'Notes', 'Projects', 'Launchers', 'LinkGroups', 'ClipboardHistory', 'DesktopCategories', 'TagPresets']) {
    if (!records(value[key])) return false
  }
  for (const key of ['RecycleBin', 'OrganizerRules', 'FocusSessions']) if (value[key] !== undefined && !records(value[key])) return false
  if (Array.isArray(value.RecycleBin) && !value.RecycleBin.every(item => {
    if (!record(item) || typeof item.Id !== 'string' || !record(item.value) || typeof item.value.Id !== 'string' || !Number.isFinite(Date.parse(String(item.ExpiresAt)))) return false
    const payload = item.value
    switch (item.kind) {
      case 'task': case 'note': return typeof payload.Title === 'string' && (item.kind !== 'note' || typeof payload.Text === 'string')
      case 'launcher': return typeof payload.Name === 'string' && typeof payload.Path === 'string'
      case 'link': return typeof payload.Name === 'string' && typeof payload.Url === 'string' && record(item.parent) && typeof item.parent.Id === 'string' && typeof item.parent.Name === 'string'
      case 'group': return typeof payload.Name === 'string' && records(payload.Links) && payload.Links.every(link => typeof link.Id === 'string' && typeof link.Name === 'string' && typeof link.Url === 'string')
      case 'project': return typeof payload.Name === 'string' && records(payload.Phases) && payload.Phases.every(phase => records(phase.Subtasks))
      default: return false
    }
  })) return false
  if (Array.isArray(value.OrganizerRules) && !value.OrganizerRules.every(rule => typeof rule.Id === 'string' && typeof rule.Enabled === 'boolean' && ['extension', 'name'].includes(rule.Match) && typeof rule.Pattern === 'string' && typeof rule.CategoryId === 'string')) return false
  if (Array.isArray(value.FocusSessions) && !value.FocusSessions.every(item => typeof item.Id === 'string' && typeof item.TaskTitle === 'string' && typeof item.ProjectName === 'string' && Number.isFinite(item.Seconds) && item.Seconds >= 0)) return false
  if (value.ActiveFocus !== undefined && value.ActiveFocus !== null) {
    const active = value.ActiveFocus
    if (!record(active) || typeof active.Id !== 'string' || typeof active.TaskTitle !== 'string' || typeof active.ProjectName !== 'string' || typeof active.ElapsedSeconds !== 'number' || !Number.isFinite(active.ElapsedSeconds) || active.ElapsedSeconds < 0 || typeof active.PlannedSeconds !== 'number' || !Number.isFinite(active.PlannedSeconds) || active.PlannedSeconds <= 0 || !Number.isFinite(Date.parse(String(active.CheckpointAt))) || (active.RunningSince !== null && !Number.isFinite(Date.parse(String(active.RunningSince))))) return false
  }
  return (value.Projects as Record<string, unknown>[]).every(project => records(project.Phases) && project.Phases.every(phase => records(phase.Subtasks)))
    && (value.LinkGroups as Record<string, unknown>[]).every(group => records(group.Links))
    && (value.DesktopCategories as Record<string, unknown>[]).every(category => Array.isArray(category.ItemPaths) && category.ItemPaths.every(item => typeof item === 'string'))
}
