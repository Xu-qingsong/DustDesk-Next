import type { WorkspaceState } from '../../../shared/types'
import { taskDraftStorageKey } from '../../../shared/draftMigration'

export const taskDraftKey = taskDraftStorageKey
export type TaskDraft = { title: string; requestId: string }
const empty = (): TaskDraft => ({ title: '', requestId: crypto.randomUUID() })

export class TaskDraftStore {
  current = empty()
  ready = false
  pending = false
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>) {}

  load(state: Pick<WorkspaceState, 'Todos' | 'RecycleBin'>) {
    const raw = this.storage.getItem(taskDraftKey)
    let draft = empty()
    if (raw !== null) {
      const saved = JSON.parse(raw)
      if (!saved || typeof saved.title !== 'string' || saved.title.length > 300 || typeof saved.requestId !== 'string' || !saved.requestId || saved.requestId.length > 128) throw Error('任务草稿格式无效，原内容未覆盖')
      draft = { title: saved.title, requestId: saved.requestId }
    }
    const committed = state.Todos.some(item => item.Id === draft.requestId) || state.RecycleBin.some(item => item.kind === 'task' && item.value.Id === draft.requestId)
    this.current = committed ? empty() : draft
    this.ready = true
    if (committed) { this.pending = true; this.flush() }
    return this.current
  }

  change(title: string) {
    if (!this.ready) throw Error('任务草稿尚未读取')
    this.current = { ...this.current, title }
    this.pending = true
    this.flush()
  }

  clear() {
    this.current = empty()
    this.pending = true
    this.flush()
  }

  flush() {
    if (!this.ready) throw Error('任务草稿尚未读取，不能确认退出')
    if (!this.pending) return
    this.storage.setItem(taskDraftKey, JSON.stringify(this.current))
    this.pending = false
  }
}
