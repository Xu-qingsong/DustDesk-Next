import type { NoteRecord } from '../../../shared/types'

export type NoteDraft = { title: string; text: string; previousTitle: string; previousText: string }
export const isDirtyDraft = (draft: NoteDraft) => draft.title !== draft.previousTitle || draft.text !== draft.previousText
export const savedNoteDraft = (note: NoteRecord): NoteDraft => ({ title: note.Title, text: note.Text, previousTitle: note.Title, previousText: note.Text })
export const noteDraftKey = (widgetKey: string, noteId: string) => `widget-note:v2:${encodeURIComponent(widgetKey)}:${encodeURIComponent(noteId)}`
const serializeDraft = (draft: NoteDraft) => JSON.stringify(isDirtyDraft(draft) ? draft : { saved: true })

function parseDraft(value: string | null): NoteDraft | undefined {
  try {
    const saved = JSON.parse(value ?? 'null')
    if (saved && ['title', 'text', 'previousTitle', 'previousText'].every(key => typeof saved[key] === 'string')) return saved
  } catch { /* An unreadable legacy value must not prevent opening a saved note. */ }
  return undefined
}

// Each renderer keeps failed writes in memory until they can be persisted. The
// quit callback outlives the editor, so switching or collapsing cannot lose them.
export class NoteDraftStore {
  private drafts = new Map<string, NoteDraft>()
  private pending = new Set<string>()
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'>) {}

  read(widgetKey: string, note: NoteRecord): NoteDraft {
    const key = noteDraftKey(widgetKey, note.Id)
    let draft = this.drafts.get(key)
    if (!draft) {
      const scoped = this.storage.getItem(key)
      draft = parseDraft(scoped)
      // Keep the legacy original as a recovery copy. A scoped clean checkpoint
      // prevents an old legacy draft from reappearing after a successful save.
      if (scoped === null) draft = parseDraft(this.storage.getItem(`widget-note:${note.Id}`))
    }
    return draft && isDirtyDraft(draft) ? draft : savedNoteDraft(note)
  }

  write(widgetKey: string, noteId: string, draft: NoteDraft) {
    const key = noteDraftKey(widgetKey, noteId)
    this.drafts.set(key, draft)
    this.pending.add(key)
    this.storage.setItem(key, serializeDraft(draft))
    this.pending.delete(key)
  }

  flush() {
    for (const key of this.pending) {
      this.storage.setItem(key, serializeDraft(this.drafts.get(key)!))
      this.pending.delete(key)
    }
  }
}
