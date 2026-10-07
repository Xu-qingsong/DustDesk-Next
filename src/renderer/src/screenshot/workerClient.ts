import type { ScreenshotDocument, ScreenshotRect } from '../../../shared/screenshotDocument'
export function createScreenshotRenderer() {
  const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' })
  let sequence = 0; let disposed = false
  const pending = new Map<number, { resolve: (result: { bitmap?: ImageBitmap; bytes?: Uint8Array; rect?: ScreenshotRect }) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  function fail(message: string) { for (const request of pending.values()) { clearTimeout(request.timer); request.reject(Error(message)) } pending.clear() }
  worker.onmessage = event => {
    const request = pending.get(event.data.id)
    if (!request) { event.data.bitmap?.close(); return }
    pending.delete(event.data.id); clearTimeout(request.timer)
    event.data.error ? request.reject(Error(event.data.error)) : request.resolve(event.data)
  }
  worker.onerror = () => fail('图片处理失败，请重新载入图片')
  return {
    render(document: ScreenshotDocument, source?: Uint8Array, exporting = false, format: 'png' | 'jpg' = 'png', fullPreview = false): Promise<{ bitmap?: ImageBitmap; bytes?: Uint8Array; rect?: ScreenshotRect }> {
      if (disposed) return Promise.reject(Error('编辑已取消'))
      const id = ++sequence
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, timer: setTimeout(() => { pending.delete(id); reject(Error('图片处理超时，请缩小图片后重试')) }, 30_000) })
        const sourceCopy = source ? new Uint8Array(source) : undefined
        worker.postMessage({ id, sourceId: document.sourceAssetId, source: sourceCopy, document, export: exporting, format, fullPreview }, sourceCopy ? [sourceCopy.buffer] : [])
      })
    },
    dispose() { disposed = true; worker.terminate(); fail('编辑已取消') }
  }
}
