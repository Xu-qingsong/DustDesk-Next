import type { WorkspaceState } from '../shared/types'
import type { ProductivityAction, RecycledPayload, RecycleEntry } from '../shared/productivity'
import { focusElapsed, focusPlannedSeconds, productivityDefaults } from '../shared/productivity'

const DAY = 86_400_000
export function collectDeleted(previous: WorkspaceState, next: WorkspaceState, now = Date.now()) {
  const removed: RecycledPayload[] = []
  for (const [key, kind] of [['Todos', 'task'], ['Notes', 'note'], ['Projects', 'project'], ['Launchers', 'launcher'], ['LinkGroups', 'group']] as const) {
    const remaining = new Set(next[key].map(item => item.Id))
    for (const value of previous[key]) if (!remaining.has(value.Id)) removed.push({ kind, value } as RecycledPayload)
  }
  const remainingLinks = new Set(next.LinkGroups.flatMap(group => group.Links.map(link => link.Id)))
  for (const group of previous.LinkGroups) if (next.LinkGroups.some(item => item.Id === group.Id)) {
    for (const value of group.Links) if (!remainingLinks.has(value.Id)) removed.push({ kind: 'link', value, parent: { Id: group.Id, Name: group.Name } })
  }
  next.RecycleBin = [...previous.RecycleBin.filter(item => Date.parse(item.ExpiresAt) > now), ...removed.map(item => ({ ...structuredClone(item), Id: crypto.randomUUID(), DeletedAt: new Date(now).toISOString(), ExpiresAt: new Date(now + 30 * DAY).toISOString() }))]
  // These collections are changed only by atomic main-process commands.
  next.FocusSessions = previous.FocusSessions
  next.ActiveFocus = previous.ActiveFocus
  next.OrganizerRules = previous.OrganizerRules.filter(rule => next.DesktopCategories.some(category => category.Id === rule.CategoryId))
  return next
}

export function restoreRecycled(state: WorkspaceState, id: string) {
  const entry = state.RecycleBin.find(item => item.Id === id)
  if (!entry || Date.parse(entry.ExpiresAt) <= Date.now()) throw new Error('该项目不存在或已过期')
  const append = <T extends { Id: string }>(items: T[], value: T) => {
    if (items.some(item => item.Id === value.Id)) throw new Error('同一项目已存在，未覆盖现有内容')
    items.push(structuredClone(value))
  }
  switch (entry.kind) {
    case 'task': append(state.Todos, entry.value); break
    case 'note': append(state.Notes, entry.value); break
    case 'project': append(state.Projects, entry.value); break
    case 'launcher': append(state.Launchers, entry.value); break
    case 'group': {
      const ids = new Set(state.LinkGroups.flatMap(group => group.Links.map(link => link.Id)))
      append(state.LinkGroups, { ...entry.value, Links: entry.value.Links.filter(link => !ids.has(link.Id)) }); break
    }
    case 'link': {
      if (state.LinkGroups.some(group => group.Links.some(link => link.Id === entry.value.Id))) throw new Error('链接已存在')
      let group = state.LinkGroups.find(item => item.Id === entry.parent.Id)
      if (!group) { group = { ...entry.parent, Links: [] }; state.LinkGroups.push(group) }
      append(group.Links, entry.value); break
    }
  }
  state.RecycleBin = state.RecycleBin.filter(item => item.Id !== id)
}

function checkedText(value: unknown, maximum: number, required = false) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) throw new Error('输入为空或超过长度限制')
  return value
}

export function finishFocus(state: WorkspaceState, now = Date.now()) {
  const active = state.ActiveFocus
  if (!active) return
  const seconds = Math.floor(focusElapsed(active, now))
  if (seconds > 0) state.FocusSessions.push({ Id: active.Id, TaskId: active.TaskId, TaskTitle: active.TaskTitle, ProjectId: active.ProjectId, ProjectName: active.ProjectName, StartedAt: active.StartedAt, EndedAt: new Date(now).toISOString(), Seconds: seconds, Completed: seconds >= active.PlannedSeconds })
  state.ActiveFocus = null
}

export function applyProductivityAction(state: WorkspaceState, action: ProductivityAction, now = Date.now()) {
  const time = new Date(now).toISOString()
  switch (action.type) {
    case 'capture': {
      const title = checkedText(action.title, 300, true).trim(); const text = checkedText(action.text, 200_000)
      if (action.kind !== 'task' && action.kind !== 'note') throw new Error('记录类型无效')
      const id = action.requestId === undefined ? crypto.randomUUID() : checkedText(action.requestId, 100, true)
      // The draft's stable request id survives a lost reply or failed local cleanup.
      // Repeating that submission must not create another record, even after deletion.
      if (state.Todos.some(item => item.Id === id) || state.Notes.some(item => item.Id === id) || state.RecycleBin.some(item => (item.kind === 'task' || item.kind === 'note') && item.value.Id === id)) break
      if (action.kind === 'task') state.Todos.push({ Id: id, Title: title, Tag: '', Note: text, IsCompleted: false, CreatedAt: time, ReminderRepeat: 'None' })
      else if (action.kind === 'note') {
        const source = state.Notes.find(item => item.Id === action.sourceNoteId)
        state.Notes.unshift({ ...(source ?? { ColorArgb: -411768, FontColorArgb: -1385444, FontSize: 14, FontBold: false, BackgroundImageFileName: '', ImageOnly: false }), Id: id, Title: title, Text: text, CreatedAt: time, UpdatedAt: time })
      }
      else throw new Error('记录类型无效')
      break
    }
    case 'task-complete': {
      const item = state.Todos.find(item => item.Id === action.id)
      if (!item || typeof action.completed !== 'boolean') throw new Error('任务不存在或参数无效')
      item.IsCompleted = action.completed; break
    }
    case 'note-edit': {
      const item = state.Notes.find(item => item.Id === action.id)
      if (!item) throw Object.assign(new Error('便签已删除，请复制当前草稿后另存'), { code: 'NOTE_DELETED' })
      if (item.Text !== action.previousText || item.Title !== action.previousTitle) throw Object.assign(new Error('便签已在其他窗口修改，请复制草稿并重新载入后再编辑'), { code: 'NOTE_CONFLICT' })
      item.Title = checkedText(action.title, 300, true).trim(); item.Text = checkedText(action.text, 200_000); item.UpdatedAt = time; break
    }
    case 'recycle-restore': restoreRecycled(state, action.id); break
    case 'recycle-empty': {
      if (!Array.isArray(action.ids) || action.ids.some(id => typeof id !== 'string')) throw new Error('回收站项目无效')
      const ids = new Set(action.ids); state.RecycleBin = state.RecycleBin.filter(item => !ids.has(item.Id)); break
    }
    case 'rules-save': {
      if (!Array.isArray(action.rules) || action.rules.length > 100) throw new Error('最多支持 100 条规则')
      const ids = new Set<string>()
      for (const rule of action.rules) {
        if (!rule || typeof rule.Id !== 'string' || !rule.Id || ids.has(rule.Id) || typeof rule.Enabled !== 'boolean' || !['name', 'extension'].includes(rule.Match)) throw new Error('规则格式无效')
        checkedText(rule.Pattern, 100, true)
        if (!rule.Pattern.split(/[,，]/).some(value => value.trim().replace(/^\*?\./, ''))) throw new Error('请输入有效的匹配内容')
        ids.add(rule.Id)
        if (!state.DesktopCategories.some(category => category.Id === rule.CategoryId)) throw new Error('规则对应的分类已删除，请重新选择')
      }
      state.OrganizerRules = structuredClone(action.rules); break
    }
    case 'focus-start': {
      if (state.ActiveFocus) throw new Error('请先结束当前专注')
      const plannedSeconds = focusPlannedSeconds(action.minutes)
      if (plannedSeconds === null) throw new Error('专注时长应为 1–180 分钟')
      const task = state.Todos.find(item => item.Id === action.taskId); const project = state.Projects.find(item => item.Id === action.projectId)
      if ((action.taskId && !task) || (action.projectId && !project)) throw new Error('关联的任务或项目已删除')
      state.ActiveFocus = { Id: crypto.randomUUID(), TaskId: task?.Id ?? '', TaskTitle: task?.Title ?? '自由专注', ProjectId: project?.Id ?? '', ProjectName: project?.Name ?? '未关联项目', StartedAt: time, PlannedSeconds: plannedSeconds, ElapsedSeconds: 0, RunningSince: time, CheckpointAt: time }; break
    }
    case 'focus-pause': {
      const active = state.ActiveFocus; if (!active) throw new Error('没有进行中的专注')
      active.ElapsedSeconds = focusElapsed(active, now); active.RunningSince = null; active.CheckpointAt = time; break
    }
    case 'focus-resume': {
      const active = state.ActiveFocus; if (!active) throw new Error('没有进行中的专注')
      if (!active.RunningSince) { active.RunningSince = time; active.CheckpointAt = time }; break
    }
    case 'focus-finish': finishFocus(state, now); break
    case 'focus-cancel': state.ActiveFocus = null; break
    default: throw new Error('不支持的操作')
  }
}

export function matchOrganizerRule(name: string, state: WorkspaceState) {
  const lower = name.toLowerCase()
  return state.OrganizerRules.filter(rule => rule.Enabled).flatMap(rule => {
    const patterns = rule.Pattern.toLowerCase().split(/[,，]/).map(value => value.trim()).filter(Boolean)
    const match = rule.Match === 'name' ? patterns.some(value => lower.includes(value)) : patterns.some(value => lower.endsWith(`.${value.replace(/^\*?\./, '')}`))
    const category = state.DesktopCategories.find(item => item.Id === rule.CategoryId)
    return match && category ? [category] : []
  })[0]
}

export function normalizeProductivity(value: Record<string, unknown>) {
  const defaults = productivityDefaults()
  defaults.RecycleBin = Array.isArray(value.RecycleBin) ? (value.RecycleBin as RecycleEntry[]).filter(item => item && typeof item.Id === 'string' && item.value && ['task', 'note', 'project', 'launcher', 'group', 'link'].includes(item.kind) && (item.kind !== 'link' || item.parent) && Number.isFinite(Date.parse(item.ExpiresAt))) : []
  defaults.OrganizerRules = Array.isArray(value.OrganizerRules) ? value.OrganizerRules.filter(item => item && typeof item.Id === 'string' && typeof item.Pattern === 'string' && typeof item.CategoryId === 'string' && ['extension', 'name'].includes(item.Match)).map(item => ({ ...item, Enabled: item.Enabled === true })) : []
  defaults.FocusSessions = Array.isArray(value.FocusSessions) ? value.FocusSessions.filter(item => item && typeof item.Id === 'string' && Number.isFinite(item.Seconds) && item.Seconds >= 0 && typeof item.TaskTitle === 'string' && typeof item.ProjectName === 'string') : []
  const active = value.ActiveFocus as WorkspaceState['ActiveFocus']
  if (active && typeof active.Id === 'string' && typeof active.TaskTitle === 'string' && Number.isFinite(active.ElapsedSeconds) && active.ElapsedSeconds >= 0 && Number.isFinite(active.PlannedSeconds) && active.PlannedSeconds > 0 && Number.isFinite(Date.parse(active.CheckpointAt)) && (active.RunningSince === null || Number.isFinite(Date.parse(active.RunningSince)))) defaults.ActiveFocus = active
  return defaults
}
