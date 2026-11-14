import type { ProductivityAction } from '../../../shared/productivity'

export async function runAction(action: ProductivityAction) {
  const result = await window.dustdesk.productivity(action)
  if (!result.ok) throw new Error(result.error ?? '操作失败')
}
