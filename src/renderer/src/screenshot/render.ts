import { annotationBounds } from '../../../shared/screenshotDocument'
import type { ScreenshotAnnotation, ScreenshotDocument } from '../../../shared/screenshotDocument'
type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

function redact(context: Context, annotation: ScreenshotAnnotation) {
  const canvas = context.canvas
  const bounds = annotationBounds(annotation)
  const brush = annotation.style.mode === 'brush'
  const rectangles = brush ? annotation.points.map(p => ({ x: p.x - annotation.style.width / 2, y: p.y - annotation.style.width / 2, width: annotation.style.width, height: annotation.style.width })) : [bounds]
  // Snapshot only the affected area, including neighboring pixels for blur.
  const padding = annotation.kind === 'blur' ? annotation.style.strength * 3 : 0
  const left = Math.max(0, Math.floor(bounds.x - padding)); const top = Math.max(0, Math.floor(bounds.y - padding))
  const width = Math.min(canvas.width - left, Math.ceil(bounds.width + padding * 2)); const height = Math.min(canvas.height - top, Math.ceil(bounds.height + padding * 2))
  if (width <= 0 || height <= 0) return
  const original = new OffscreenCanvas(width, height)
  original.getContext('2d')!.drawImage(canvas, left, top, width, height, 0, 0, width, height)
  context.save(); context.beginPath()
  for (const rect of rectangles) context.rect(rect.x, rect.y, rect.width, rect.height)
  context.clip()
  if (annotation.kind === 'cover') { context.fillStyle = annotation.style.color; context.fillRect(left, top, width, height) }
  else if (annotation.kind === 'blur') { context.filter = `blur(${annotation.style.strength}px)`; context.drawImage(original, left, top) }
  else {
      const small = new OffscreenCanvas(Math.max(1, Math.ceil(width / annotation.style.strength)), Math.max(1, Math.ceil(height / annotation.style.strength)))
      small.getContext('2d')!.drawImage(original, 0, 0, small.width, small.height)
      context.imageSmoothingEnabled = false; context.drawImage(small, left, top, width, height)
  }
  context.restore()
}

export function paintAnnotation(context: Context, annotation: ScreenshotAnnotation) {
  const first = annotation.points[0]!; const last = annotation.points.at(-1)!
  context.save(); context.strokeStyle = annotation.style.color; context.fillStyle = annotation.style.color; context.lineWidth = annotation.style.width; context.lineCap = 'round'; context.lineJoin = 'round'
  const rect = annotationBounds(annotation)
  if (['mosaic', 'blur', 'cover'].includes(annotation.kind)) redact(context, annotation)
  else if (annotation.kind === 'text') {
    context.font = `600 ${annotation.style.fontSize}px "Segoe UI", "Microsoft YaHei", sans-serif`; context.textBaseline = 'top'
    for (const [index, line] of (annotation.text || '').split('\n').entries()) context.fillText(line, first.x, first.y + index * annotation.style.fontSize * 1.3)
  } else if (annotation.kind === 'number') {
    const radius = annotation.style.fontSize * .75
    context.beginPath(); context.arc(first.x, first.y, radius, 0, Math.PI * 2); context.fill()
    context.fillStyle = '#ffffff'; context.textBaseline = 'middle'; context.textAlign = 'center'; context.font = `bold ${annotation.style.fontSize}px "Segoe UI", sans-serif`; context.fillText(String(annotation.number), first.x, first.y)
  } else if (annotation.kind === 'arrow') {
    const dx = last.x - first.x, dy = last.y - first.y, length = Math.hypot(dx, dy)
    context.translate(first.x, first.y); context.rotate(Math.atan2(dy, dx))
    context.beginPath()
    if (length < .01) context.arc(0, 0, annotation.style.width / 2, 0, Math.PI * 2)
    else {
      const head = Math.min(length, Math.max(12, annotation.style.width * 3)), neck = length - head
      const shaft = annotation.style.width / 2, wing = Math.max(annotation.style.width, head / 2)
      // One filled outline joins the shaft to the head. No round line cap can
      // protrude past the tip, even for thick, short or diagonal arrows.
      context.moveTo(0, -shaft); context.lineTo(neck, -shaft); context.lineTo(neck, -wing)
      context.lineTo(length, 0); context.lineTo(neck, wing); context.lineTo(neck, shaft); context.lineTo(0, shaft); context.closePath()
    }
    context.fill()
  } else {
    context.beginPath()
    if (annotation.kind === 'rectangle') context.rect(rect.x, rect.y, rect.width, rect.height)
    else if (annotation.kind === 'ellipse') context.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2)
    else {
      if (annotation.kind === 'highlighter') { context.globalAlpha = .35; context.lineWidth = annotation.style.width * 3 }
      context.moveTo(first.x, first.y)
      for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y)
      if (annotation.points.length === 1) { context.lineTo(first.x + .01, first.y + .01) }
    }
    if (annotation.style.filled && ['rectangle', 'ellipse'].includes(annotation.kind)) context.fill()
    else context.stroke()
  }
  context.restore()
}

export function renderScreenshot(source: ImageBitmap, document: ScreenshotDocument, cropped: boolean) {
  // Effects use native pixels so zoom cannot change the exported strength or brush size.
  const canvas = new OffscreenCanvas(document.width, document.height)
  const context = canvas.getContext('2d')!
  context.drawImage(source, document.sourceRect?.x ?? 0, document.sourceRect?.y ?? 0)
  for (const annotation of document.annotations) paintAnnotation(context, annotation)
  if (!cropped) return canvas
  const output = new OffscreenCanvas(document.crop.width, document.crop.height)
  output.getContext('2d')!.drawImage(canvas, document.crop.x, document.crop.y, document.crop.width, document.crop.height, 0, 0, output.width, output.height)
  return output
}
