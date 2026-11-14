import { invoke } from '@tauri-apps/api/core'
import { listenPrototype } from './events'
import type { WorkspaceState } from '../../../shared/types'

export interface WorkspaceSnapshot { state: WorkspaceState; revision: number; path: string }

export function newerSnapshot(current: WorkspaceSnapshot | undefined, next: WorkspaceSnapshot): WorkspaceSnapshot {
  return !current || next.revision >= current.revision ? next : current
}

export const previewWorkspace = {
  initialize: (state: WorkspaceState) => invoke<WorkspaceSnapshot>('prototype_workspace_initialize', { state }),
  load: () => invoke<WorkspaceSnapshot>('prototype_workspace_load'),
  save: (state: WorkspaceState, baseline?: WorkspaceState) => invoke<WorkspaceSnapshot>('prototype_workspace_save', { state, baseline }),
  subscribe: (callback: (snapshot: WorkspaceSnapshot) => void) => listenPrototype('prototype:workspace-changed', callback)
}
