import type { ClipboardRecord } from '../../../shared/types'

export function retainClipboardHistory(records: ClipboardRecord[], limit = 200) {
  const protectedCount = records.filter(item => item.IsLocked || item.IsPinned).length
  let remaining = Math.max(0, limit - protectedCount)
  return records.filter(item => item.IsLocked || item.IsPinned || remaining-- > 0)
}
