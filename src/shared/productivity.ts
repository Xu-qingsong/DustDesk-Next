import type { TodoRecord, NoteRecord, ProjectRecord, LauncherRecord, LinkRecord, LinkGroupRecord } from './types'

export type RecycledPayload =
  | { kind: 'task'; value: TodoRecord }
  | { kind: 'note'; value: NoteRecord }
  | { kind: 'project'; value: ProjectRecord }
  | { kind: 'launcher'; value: LauncherRecord }
  | { kind: 'group'; value: LinkGroupRecord }
  | { kind: 'link'; value: LinkRecord; parent: { Id: string; Name: string } }
export type RecycleEntry = RecycledPayload & { Id: string; DeletedAt: string; ExpiresAt: string }
export interface OrganizerRule { Id: string; Enabled: boolean; Match: 'extension' | 'name'; Pattern: string; CategoryId: string }
export interface FocusSession { Id: string; TaskId: string; TaskTitle: string; ProjectId: string; ProjectName: string; StartedAt: string; EndedAt: string; Seconds: number; Completed: boolean }
export interface ActiveFocus extends Omit<FocusSession, 'EndedAt' | 'Seconds' | 'Completed'> { PlannedSeconds: number; ElapsedSeconds: number; RunningSince: string | null; CheckpointAt: string }
export interface ProductivityState { RecycleBin: RecycleEntry[]; OrganizerRules: OrganizerRule[]; FocusSessions: FocusSession[]; ActiveFocus: ActiveFocus | null }
export type ProductivityAction =
  | { type: 'capture'; kind: 'task' | 'note'; title: string; text: string; requestId?: string; sourceNoteId?: string }
  | { type: 'task-complete'; id: string; completed: boolean }
  | { type: 'note-edit'; id: string; title: string; text: string; previousText: string; previousTitle: string }
  | { type: 'recycle-restore'; id: string }
  | { type: 'recycle-empty'; ids: string[] }
  | { type: 'focus-start'; taskId: string; projectId: string; minutes: number }
  | { type: 'focus-pause' | 'focus-resume' | 'focus-finish' | 'focus-cancel' }
  | { type: 'rules-save'; rules: OrganizerRule[] }
  | { type: 'resource-relink'; resource: ResourceHealth; replacement: string }
export interface ActionResult { ok: boolean; error?: string; code?: 'NOTE_CONFLICT' | 'NOTE_DELETED' }
export interface BackupPreview { path: string; modifiedAt: string; tasks: number; notes: number; projects: number; links: number; focusSessions: number; recycleEntries: number; fingerprint: string; warnings: string[] }
export interface ResourceHealth { kind: 'launcher' | 'project' | 'phase' | 'subtask' | 'organizer' | 'link'; id: string; parentId?: string; name: string; target: string; status: 'ok' | 'missing' | 'warning'; detail: string }
export interface ResourceScanRequest { requestId: string; resource?: ResourceHealth }
export interface ResourceScanProgress { requestId: string; completed: number; total: number; item?: ResourceHealth }
export function focusPlannedSeconds(minutes: number) {
  return Number.isFinite(minutes) && minutes >= 1 && minutes <= 180 ? Math.round(minutes * 60) : null
}
export const productivityDefaults = (): ProductivityState => ({ RecycleBin: [], OrganizerRules: [], FocusSessions: [], ActiveFocus: null })
export const productivitySettings = { AutomaticBackupEnabled: true, BackupRetentionDays: 30, QuickCaptureHotKey: 'Ctrl+Shift+Space' }
export function focusElapsed(active: ActiveFocus, now = Date.now()) {
  return Math.min(active.PlannedSeconds, Math.max(0, active.ElapsedSeconds + (active.RunningSince ? Math.max(0, (now - Date.parse(active.RunningSince)) / 1000) : 0)))
}
