export interface FilesDropped {
  paths: string[]
  position: { x: number; y: number }
  error?: string
}
export function acceptsFileDrop(element: Element | null, hit: Element | null, position: FilesDropped['position']) {
  if (!element || !hit || !Number.isFinite(position.x) || !Number.isFinite(position.y) || position.x < 0 || position.y < 0) return false
  if (!element.contains(hit) || hit.closest('input, textarea, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"]')) return false
  const bounds = element.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0 && position.x >= bounds.left && position.x < bounds.right && position.y >= bounds.top && position.y < bounds.bottom
}
