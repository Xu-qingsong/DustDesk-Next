import type { ImageOptions } from '../../../shared/toolbox'
import { JobWorker } from './jobWorker'

export interface ImageResult { bytes: Uint8Array; width: number; height: number; originalWidth: number; originalHeight: number; originalFormat: 'png' | 'jpeg' | 'webp'; format: 'png' | 'jpeg' | 'webp'; retainedOriginal: boolean }
type Source = { id: string; bytes: Uint8Array; url: string }

// Bound memory to one selected source and one watermark. Exports use fresh reads.
export class ImagePreviewSession {
  private worker = new JobWorker(() => new Worker(new URL('./image.worker.ts', import.meta.url), { type: 'module' }), true)
  private source?: { id: string; loading: Promise<Source> }
  private mark?: { id: string; loading: Promise<Uint8Array> }
  private workerSource?: string
  private workerMark?: string
  private revision = 0
  async render(id: string, options: ImageOptions) {
    const revision = ++this.revision
    if (this.source?.id !== id) {
      this.releaseSource()
      const loading = window.dustdesk.toolbox.readAsset(id).then(bytes => ({ id, bytes, url: URL.createObjectURL(new Blob([new Uint8Array(bytes)])) }))
      this.source = { id, loading }
    }
    const loading = this.source
    let source: Source
    try { source = await loading.loading } catch (error) { if (this.source === loading) this.source = undefined; throw error }
    if (revision !== this.revision) throw Error('任务已取消')
    const watermarkId = options.watermark === 'image' ? options.watermarkAsset : undefined
    if (this.mark?.id !== watermarkId) this.mark = watermarkId ? { id: watermarkId, loading: window.dustdesk.toolbox.readAsset(watermarkId) } : undefined
    let mark: Uint8Array | undefined
    const marking = this.mark
    try { mark = await marking?.loading } catch (error) { if (this.mark === marking) this.mark = undefined; throw error }
    if (revision !== this.revision) throw Error('任务已取消')
    // A new run terminates unfinished work. Only an idle worker can reuse decoded assets.
    const reuse = this.worker.reusable
    const bytes = reuse && this.workerSource === id ? undefined : new Uint8Array(source.bytes)
    const watermark = reuse && this.workerMark === watermarkId ? undefined : mark ? new Uint8Array(mark) : undefined
    this.workerSource = id; this.workerMark = watermarkId
    const result = await this.worker.run<ImageResult>({ assetId: id, bytes, options, watermarkId, watermark }, 60000, [...(bytes ? [bytes.buffer] : []), ...(watermark ? [watermark.buffer] : [])])
    return { result, original: source.url }
  }
  private releaseSource() {
    void this.source?.loading.then(source => URL.revokeObjectURL(source.url), () => {})
    this.source = undefined
  }
  invalidate() { ++this.revision }
  cancel() { this.invalidate(); this.worker.cancel() }
  dispose() { this.cancel(); this.releaseSource(); this.mark = undefined }
}
