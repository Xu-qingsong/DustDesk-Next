export type ScreenshotPoint = { x: number; y: number }
export type ScreenshotRect = ScreenshotPoint & { width: number; height: number }
export type ScreenshotTool = 'select' | 'crop' | 'pen' | 'highlighter' | 'line' | 'arrow' | 'rectangle' | 'ellipse' | 'text' | 'number' | 'mosaic' | 'blur' | 'cover' | 'eraser'
export type AnnotationStyle = { color: string; width: number; fontSize: number; filled: boolean; strength: number; mode: 'rectangle' | 'brush' }
export type ScreenshotAnnotation = { id: string; kind: Exclude<ScreenshotTool, 'select' | 'crop' | 'eraser'>; points: ScreenshotPoint[]; style: AnnotationStyle; text?: string; number?: number }
export type ScreenshotDocument = { id: string; sourceAssetId: string; width: number; height: number; crop: ScreenshotRect; annotations: ScreenshotAnnotation[]; revision: number; nextNumber: number; targetPinId?: string; sourceRect?: ScreenshotRect }
export type ScreenshotAction = 'copy' | 'save' | 'saveAs' | 'pin' | 'openEditor' | 'updatePin'
export type ScreenshotPayload = { document: ScreenshotDocument; png: Uint8Array; placement?: ScreenshotRect; initialAction?: 'copy' | 'save' | 'pin'; initialTool?: ScreenshotTool }
export type ScreenshotFinishRequest = { requestId: string; document: ScreenshotDocument; action: ScreenshotAction; png?: Uint8Array; jpeg?: Uint8Array; format?: 'png' | 'jpg' }
export const defaultAnnotationStyle: AnnotationStyle = { color: '#ff4d57', width: 4, fontSize: 24, filled: false, strength: 12, mode: 'rectangle' }
export const screenshotColors = ['#ff4d57', '#ffb020', '#ffdf4f', '#20b87c', '#1689ff', '#9c65ef', '#ffffff', '#172333']
export function newScreenshotDocument(id: string, sourceAssetId: string, width: number, height: number): ScreenshotDocument {
  return { id, sourceAssetId, width, height, crop: { x: 0, y: 0, width, height }, annotations: [], revision: 0, nextNumber: 1 }
}
export function rectFromPoints(a: ScreenshotPoint, b: ScreenshotPoint): ScreenshotRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) }
}
export function clampRect(rect: ScreenshotRect, width: number, height: number): ScreenshotRect {
  const x = Math.round(Math.max(0, Math.min(width - 1, rect.x))); const y = Math.round(Math.max(0, Math.min(height - 1, rect.y)))
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(rect.width))), height: Math.max(1, Math.min(height - y, Math.round(rect.height))) }
}
export function annotationBounds(annotation: ScreenshotAnnotation): ScreenshotRect {
  const xs = annotation.points.map(point => point.x); const ys = annotation.points.map(point => point.y)
  const x = Math.min(...xs); const y = Math.min(...ys)
  if (annotation.kind === 'text') {
    const lines = (annotation.text || '').split('\n')
    return { x, y, width: Math.max(20, ...lines.map(line => [...line].reduce((sum, char) => sum + annotation.style.fontSize * (char.charCodeAt(0) > 255 ? 1 : .62), 0))), height: lines.length * annotation.style.fontSize * 1.3 }
  }
  if (annotation.kind === 'number') { const radius = annotation.style.fontSize * .75; return { x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 } }
  const brush = ['pen', 'highlighter'].includes(annotation.kind) || (['mosaic', 'blur', 'cover'].includes(annotation.kind) && annotation.style.mode === 'brush')
  const pad = brush ? annotation.style.width / 2 : 0
  return { x: x - pad, y: y - pad, width: Math.max(1, Math.max(...xs) - x + pad * 2), height: Math.max(1, Math.max(...ys) - y + pad * 2) }
}
export function transformAnnotation(annotation: ScreenshotAnnotation, from: ScreenshotRect, to: ScreenshotRect): ScreenshotAnnotation {
  const sx = to.width / Math.max(1, from.width); const sy = to.height / Math.max(1, from.height)
  return { ...annotation, points: annotation.points.map(point => ({ x: to.x + (point.x - from.x) * sx, y: to.y + (point.y - from.y) * sy })), style: { ...annotation.style, fontSize: Math.min(200, Math.max(8, annotation.style.fontSize * Math.min(sx, sy))) } }
}
export function constrainedPoint(start: ScreenshotPoint, end: ScreenshotPoint, tool: ScreenshotTool, shift: boolean): ScreenshotPoint {
  if (!shift) return end
  const dx = end.x - start.x; const dy = end.y - start.y
  if (tool === 'line' || tool === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4; const length = Math.hypot(dx, dy)
    return { x: start.x + Math.cos(angle) * length, y: start.y + Math.sin(angle) * length }
  }
  const size = Math.max(Math.abs(dx), Math.abs(dy))
  return { x: start.x + Math.sign(dx || 1) * size, y: start.y + Math.sign(dy || 1) * size }
}
export function hitAnnotation(annotation: ScreenshotAnnotation, point: ScreenshotPoint, tolerance: number) {
  const bounds = annotationBounds(annotation)
  if (point.x < bounds.x - tolerance || point.x > bounds.x + bounds.width + tolerance || point.y < bounds.y - tolerance || point.y > bounds.y + bounds.height + tolerance) return false
  if (['text', 'number', 'mosaic', 'blur', 'cover'].includes(annotation.kind) || annotation.style.filled) return true
  if (annotation.kind === 'rectangle') return Math.min(Math.abs(point.x - bounds.x), Math.abs(point.x - bounds.x - bounds.width), Math.abs(point.y - bounds.y), Math.abs(point.y - bounds.y - bounds.height)) <= tolerance + annotation.style.width
  if (annotation.kind === 'ellipse') return Math.abs(Math.hypot((point.x - bounds.x - bounds.width / 2) / (bounds.width / 2), (point.y - bounds.y - bounds.height / 2) / (bounds.height / 2)) - 1) <= (tolerance + annotation.style.width) / Math.max(1, Math.min(bounds.width, bounds.height) / 2)
  return annotation.points.some((b, i, points) => {
    const a = points[Math.max(0, i - 1)]!; const dx = b.x - a.x; const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy) <= tolerance + annotation.style.width / 2
  })
}
type Edit = { beforeCrop: ScreenshotRect; afterCrop: ScreenshotRect; beforeNumber: number; afterNumber: number; changes: { id: string; index: number; before?: ScreenshotAnnotation; after?: ScreenshotAnnotation }[] }
export function documentEdit(before: ScreenshotDocument, after: ScreenshotDocument): Edit {
  const changes: Edit['changes'] = []
  for (const [index, annotation] of before.annotations.entries()) { const next = after.annotations.find(item => item.id === annotation.id); if (next !== annotation) changes.push({ id: annotation.id, index, before: annotation, after: next }) }
  for (const [index, annotation] of after.annotations.entries()) if (!before.annotations.some(item => item.id === annotation.id)) changes.push({ id: annotation.id, index, after: annotation })
  return { beforeCrop: before.crop, afterCrop: after.crop, beforeNumber: before.nextNumber, afterNumber: after.nextNumber, changes }
}
export function applyDocumentEdit(document: ScreenshotDocument, edit: Edit, undo: boolean): ScreenshotDocument {
  const annotations = [...document.annotations]
  for (const change of edit.changes) {
    const index = annotations.findIndex(item => item.id === change.id); const value = undo ? change.before : change.after
    if (index >= 0) annotations.splice(index, 1)
    if (value) annotations.splice(Math.min(change.index, annotations.length), 0, value)
  }
  return { ...document, annotations, crop: undo ? edit.beforeCrop : edit.afterCrop, nextNumber: undo ? edit.beforeNumber : edit.afterNumber, revision: document.revision + 1 }
}
export function validScreenshotDocument(value: unknown): value is ScreenshotDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as ScreenshotDocument
  const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n)
  const point = (p: ScreenshotPoint) => p && finite(p.x) && finite(p.y) && Math.abs(p.x) <= 32768 && Math.abs(p.y) <= 32768
  const sourceRect = doc.sourceRect
  if (sourceRect && (!point(sourceRect) || !Number.isInteger(sourceRect.width) || !Number.isInteger(sourceRect.height) || sourceRect.x < 0 || sourceRect.y < 0 || sourceRect.width < 1 || sourceRect.height < 1 || sourceRect.x + sourceRect.width > doc.width || sourceRect.y + sourceRect.height > doc.height)) return false
  return typeof doc.id === 'string' && typeof doc.sourceAssetId === 'string' && Number.isInteger(doc.revision) && doc.revision >= 0 && Number.isInteger(doc.nextNumber) && doc.nextNumber > 0 && Number.isInteger(doc.width) && Number.isInteger(doc.height) && doc.width > 0 && doc.height > 0 && doc.width * doc.height <= 40_000_000 && !!doc.crop && point(doc.crop) && finite(doc.crop.width) && finite(doc.crop.height) && doc.crop.width >= 1 && doc.crop.height >= 1 && doc.crop.x >= 0 && doc.crop.y >= 0 && doc.crop.x + doc.crop.width <= doc.width && doc.crop.y + doc.crop.height <= doc.height && Array.isArray(doc.annotations) && doc.annotations.length <= 1000 && new Set(doc.annotations.map(a => a?.id)).size === doc.annotations.length && doc.annotations.every(a => a && typeof a.id === 'string' && ['pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse', 'text', 'number', 'mosaic', 'blur', 'cover'].includes(a.kind) && Array.isArray(a.points) && a.points.length > 0 && a.points.length <= 20000 && a.points.every(point) && !!a.style && /^#[\da-f]{6}$/i.test(a.style.color) && finite(a.style.width) && a.style.width >= 1 && a.style.width <= 200 && finite(a.style.fontSize) && a.style.fontSize >= 8 && a.style.fontSize <= 200 && finite(a.style.strength) && a.style.strength >= 1 && a.style.strength <= 80 && typeof a.style.filled === 'boolean' && ['rectangle', 'brush'].includes(a.style.mode) && (a.text === undefined || typeof a.text === 'string' && a.text.length <= 5000) && (a.number === undefined || Number.isInteger(a.number) && a.number > 0))
}
