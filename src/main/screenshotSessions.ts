import { randomUUID } from 'node:crypto'
import { newScreenshotDocument, validScreenshotDocument } from '../shared/screenshotDocument'
import type { ScreenshotDocument, ScreenshotFinishRequest, ScreenshotPayload, ScreenshotRect } from '../shared/screenshotDocument'

export function createScreenshotSessions(dependencies: {
  decode: (bytes: Uint8Array) => { png: Uint8Array; width: number; height: number }
  output: (request: ScreenshotFinishRequest, png: Uint8Array) => Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string; pinId?: string; warning?: string }>
}) {
  const assets = new Map<string, Uint8Array>()
  const documents = new Map<string, ScreenshotDocument>()
  const requests = new Map<string, Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string; pinId?: string; warning?: string }>>()
  const locks = new Set<string>()
  const editablePins = new Map<string, string>()
  const editors = new Set<string>()
  function create(bytes: Uint8Array, region?: { width: number; height: number; rect: ScreenshotRect }): ScreenshotPayload {
    if (!(bytes instanceof Uint8Array) || bytes.length > 32 * 1024 * 1024 || !bytes.length) throw Error('图片无效或过大（最大 32 MB）')
    const decoded = dependencies.decode(bytes)
    if (decoded.png.length > 32 * 1024 * 1024) throw Error('解码后的图片过大（最大 32 MB）')
    if (decoded.width * decoded.height > 40_000_000 || !decoded.width || !decoded.height) throw Error('图片尺寸过大（最大 4000 万像素）')
    // Bound session memory. Never evict the assets retained by a pinned image.
    let total = [...assets.values()].reduce((sum, asset) => sum + asset.byteLength, 0)
    for (const [id, document] of documents) {
      if (documents.size < 64 && total + decoded.png.length < 256 * 1024 * 1024) break
      if ([...editablePins.values()].includes(id) || locks.has(id) || editors.has(id)) continue
      documents.delete(id)
      if (![...documents.values()].some(other => other.sourceAssetId === document.sourceAssetId)) { total -= assets.get(document.sourceAssetId)?.length || 0; assets.delete(document.sourceAssetId) }
    }
    if (total + decoded.png.length > 256 * 1024 * 1024) throw Error('贴图占用较多内存，请关闭部分贴图后重试')
    const assetId = randomUUID(); const document = newScreenshotDocument(randomUUID(), assetId, region?.width ?? decoded.width, region?.height ?? decoded.height)
    if (region) { document.crop = region.rect; document.sourceRect = region.rect }
    if (!validScreenshotDocument(document) || region && (region.rect.width !== decoded.width || region.rect.height !== decoded.height)) throw Error('选区像素尺寸不一致')
    assets.set(assetId, decoded.png); documents.set(document.id, document)
    return { document: structuredClone(document), png: new Uint8Array(decoded.png) }
  }
  function read(id: string): ScreenshotPayload {
    const document = documents.get(id); const png = document && assets.get(document.sourceAssetId)
    if (!document || !png) throw Error('截图会话已结束，请重新打开图片')
    return { document: structuredClone(document), png: new Uint8Array(png) }
  }
  async function finish(request: ScreenshotFinishRequest) {
    if (!request || typeof request.requestId !== 'string' || request.requestId.length > 128 || !validScreenshotDocument(request.document) || !['copy', 'save', 'saveAs', 'pin', 'openEditor', 'updatePin'].includes(request.action)) return { ok: false, error: '编辑数据无效' }
    const previous = documents.get(request.document.id)
    if (!previous || previous.sourceAssetId !== request.document.sourceAssetId || previous.width !== request.document.width || previous.height !== request.document.height || JSON.stringify(previous.sourceRect) !== JSON.stringify(request.document.sourceRect) || request.document.revision < previous.revision || request.document.targetPinId !== previous.targetPinId) return { ok: false, error: '截图已更改或会话已结束，请重新载入' }
    const key = `${request.document.id}:${request.requestId}`
    const shared = requests.get(key)
    if (shared) return shared
    if (locks.has(request.document.id)) return { ok: false, error: '正在处理上一项操作' }
    locks.add(request.document.id)
    const result = Promise.resolve().then(async () => {
      try {
        const decoded = request.action === 'openEditor' ? undefined : dependencies.decode(new Uint8Array(request.png || []))
        if (decoded && (decoded.png.length > 32 * 1024 * 1024 || decoded.width !== request.document.crop.width || decoded.height !== request.document.crop.height)) throw Error('导出图片与选区尺寸不一致')
        const png = decoded?.png || assets.get(previous.sourceAssetId)!
        // The output transaction owns disk/clipboard/window effects. Commit only on success.
        const output = await dependencies.output(request, png)
        if (output.ok) documents.set(previous.id, structuredClone(request.document))
        else requests.delete(key)
        return output
      } catch (error) { requests.delete(key); return { ok: false, error: error instanceof Error ? error.message : '截图处理失败' } }
      finally { locks.delete(previous.id) }
    })
    requests.set(key, result)
    if (requests.size > 128) requests.delete(requests.keys().next().value!)
    return result
  }
  function retainPin(pinId: string, documentId: string) { editablePins.set(pinId, documentId) }
  function releasePin(pinId: string) { editablePins.delete(pinId) }
  function snapshot(document: ScreenshotDocument): ScreenshotDocument {
    if (!validScreenshotDocument(document) || !assets.has(document.sourceAssetId)) throw Error('截图会话已结束')
    const copy = structuredClone(document); copy.id = randomUUID(); copy.targetPinId = undefined; copy.revision = 0
    // Editors and pins retain the region asset in its own pixel coordinates.
    // The live selector's screen-sized coordinate space contains no other pixels.
    if (copy.sourceRect) {
      const source = copy.sourceRect
      copy.width = source.width; copy.height = source.height
      copy.crop = { ...copy.crop, x: copy.crop.x - source.x, y: copy.crop.y - source.y }
      copy.annotations = copy.annotations.map(annotation => ({ ...annotation, points: annotation.points.map(point => ({ x: point.x - source.x, y: point.y - source.y })) }))
      delete copy.sourceRect
      if (!validScreenshotDocument(copy)) throw Error('请先重新捕获调整后的选区')
    }
    documents.set(copy.id, copy)
    return structuredClone(copy)
  }
  function editPin(pinId: string): ScreenshotPayload {
    const original = read(editablePins.get(pinId) || '')
    original.document.id = randomUUID(); original.document.targetPinId = pinId; original.document.revision = 0
    documents.set(original.document.id, structuredClone(original.document))
    return original
  }
  function remove(id: string) {
    if ([...editablePins.values()].includes(id) || locks.has(id) || editors.has(id)) return
    const document = documents.get(id); documents.delete(id)
    if (document && ![...documents.values()].some(other => other.sourceAssetId === document.sourceAssetId)) assets.delete(document.sourceAssetId)
  }
  return { create, read, finish, retainPin, releasePin, snapshot, editPin, remove, retainEditor: (id: string) => editors.add(id), releaseEditor: (id: string) => editors.delete(id), clear: () => { assets.clear(); documents.clear(); requests.clear(); editablePins.clear(); editors.clear() } }
}
