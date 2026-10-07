import { paintAnnotation, renderScreenshot } from './render'
import { annotationBounds } from '../../../shared/screenshotDocument'
import type { ScreenshotAnnotation, ScreenshotDocument, ScreenshotRect } from '../../../shared/screenshotDocument'
let source: ImageBitmap | undefined
let sourceId = ''
let queue = Promise.resolve()
let prefix: OffscreenCanvas | undefined, preview: OffscreenCanvas | undefined
let prefixKeys: string[] = [], previousKeys: string[] = [], previousTail: ScreenshotAnnotation[] = []

// Cache the unchanged annotation prefix. A pointer preview repaints and transfers
// only the old/new tail's affected pixels; exports still render native pixels.
function renderPreview(document: ScreenshotDocument, fullPreview = false): { bitmap?: ImageBitmap; rect?: ScreenshotRect } {
  const keys = document.annotations.map(annotation => JSON.stringify(annotation))
  if (!fullPreview && preview && keys.length === previousKeys.length && keys.every((key, index) => key === previousKeys[index])) return {}
  let common = 0
  while (common < keys.length && keys[common] === previousKeys[common]) common++
  const rebuild = !prefix || common !== prefixKeys.length || keys.slice(0, common).some((key, i) => key !== prefixKeys[i])
  const tail = document.annotations.slice(common)
  let rect: ScreenshotRect = { x: 0, y: 0, width: document.width, height: document.height }
  if (rebuild) {
    prefix = renderScreenshot(source!, { ...document, annotations: document.annotations.slice(0, common) }, false)
    preview = new OffscreenCanvas(document.width, document.height)
    prefixKeys = keys.slice(0, common)
  } else {
    const bounds = [...previousTail, ...tail].map(annotation => {
      const r = annotationBounds(annotation), padding = Math.max(16, annotation.style.width * 3, annotation.style.strength * 3)
      return { left: r.x - padding, top: r.y - padding, right: r.x + r.width + padding, bottom: r.y + r.height + padding }
    })
    if (bounds.length) {
      const x = Math.max(0, Math.floor(Math.min(...bounds.map(r => r.left)))), y = Math.max(0, Math.floor(Math.min(...bounds.map(r => r.top))))
      rect = { x, y, width: Math.max(1, Math.min(document.width, Math.ceil(Math.max(...bounds.map(r => r.right)))) - x), height: Math.max(1, Math.min(document.height, Math.ceil(Math.max(...bounds.map(r => r.bottom)))) - y) }
    }
  }
  const context = preview!.getContext('2d')!
  context.save(); context.beginPath(); context.rect(rect.x, rect.y, rect.width, rect.height); context.clip()
  context.clearRect(rect.x, rect.y, rect.width, rect.height); context.drawImage(prefix!, 0, 0)
  for (const annotation of tail) paintAnnotation(context, annotation)
  context.restore()
  previousKeys = keys; previousTail = tail
  if (fullPreview) rect = { x: 0, y: 0, width: document.width, height: document.height }
  const output = new OffscreenCanvas(rect.width, rect.height)
  output.getContext('2d')!.drawImage(preview!, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height)
  return { bitmap: output.transferToImageBitmap(), rect }
}
self.onmessage = (event: MessageEvent<{ id: number; source?: Uint8Array; sourceId: string; document: ScreenshotDocument; export?: boolean; format?: 'png' | 'jpg'; fullPreview?: boolean }>) => {
  const request = event.data
  queue = queue.then(async () => {
  try {
    if (request.source) {
      const bitmap = await createImageBitmap(new Blob([new Uint8Array(request.source)], { type: 'image/png' }))
      source?.close(); source = bitmap; sourceId = request.sourceId
      prefix = undefined; preview = undefined; prefixKeys = []; previousKeys = []; previousTail = []
    }
    if (!source || sourceId !== request.sourceId) throw Error('图像尚未就绪')
    if (request.export) {
      const canvas = renderScreenshot(source, request.document, true)
      if (request.format === 'jpg') {
        const context = canvas.getContext('2d')!; context.globalCompositeOperation = 'destination-over'; context.fillStyle = '#ffffff'; context.fillRect(0, 0, canvas.width, canvas.height)
      }
      const blob = await canvas.convertToBlob({ type: request.format === 'jpg' ? 'image/jpeg' : 'image/png', quality: .92 }); const bytes = new Uint8Array(await blob.arrayBuffer())
      self.postMessage({ id: request.id, bytes }, { transfer: [bytes.buffer] })
    } else {
      const result = renderPreview(request.document, request.fullPreview)
      self.postMessage({ id: request.id, ...result }, { transfer: result.bitmap ? [result.bitmap] : [] })
    }
  } catch (error) { self.postMessage({ id: request.id, error: error instanceof Error ? error.message : '图像处理失败' }) }
  })
}
