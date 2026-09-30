import type { WorkspaceState } from '../../../shared/types'
import { tagColor } from './colors'

export const withTagPreset = (state: WorkspaceState, tag: string) => {
  const normalized = tag.trim()
  if (!normalized || state.TagPresets.some(item => item.Name.toLowerCase() === normalized.toLowerCase())) return state
  return { ...state, TagPresets: [...state.TagPresets, { Name: normalized, ColorArgb: tagColor(normalized) }] }
}
