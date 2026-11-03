import { promises as fs, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { ZipFile } from 'yazl'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { inspectToolImage } from '../shared/imageTools'
import { maxTextBytes } from '../shared/textTools'
import { assertPathWithinRoot, safeName } from './fileOperations'
import type { ImageOptions, ImageExportResult, ToolAsset } from '../shared/toolbox'

interface ImageBatch {
  directory: string; target: string; count: number; files: string[]
  pending: Set<Promise<string>>; finishing?: Promise<ImageExportResult>
}

export function createToolAssets(fileSystem = fs) {
  const assets = new Map<string, { asset: ToolAsset; path?: string; bytes?: Uint8Array; kind: 'image' | 'transfer' }>()
  const batches = new Map<string, ImageBatch>()
  async function registerPaths(paths: string[], kind: 'image' | 'transfer') {
    if (!Array.isArray(paths) || paths.length > 10000 || !['image','transfer'].includes(kind)) throw Error('导入参数无效')
    const result: ToolAsset[] = []
    const staged: [string, { asset: ToolAsset; path: string; kind: 'image' | 'transfer' }][] = []
    for (const target of paths) {
      if (typeof target !== 'string' || !path.isAbsolute(target)) throw Error('文件路径无效')
      const stat = await fileSystem.lstat(target)
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Error('不支持符号链接或特殊文件')
      if (kind === 'image') { if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw Error('单张图片最多 100 MiB'); inspectToolImage(new Uint8Array(await fileSystem.readFile(target))) }
      const asset = { id: randomUUID(), name: path.basename(target), size: stat.isDirectory() ? 0 : stat.size }
      staged.push([asset.id, { asset, path: target, kind }]); result.push(asset)
    }
    staged.forEach(([id, value]) => assets.set(id, value)); return result
  }
  async function readAsset(id: string) {
    const item = assets.get(id)
    if (!item || item.kind !== 'image') throw Error('图片授权已失效，请重新导入')
    if (item.bytes) return new Uint8Array(item.bytes)
    const info = await fileSystem.lstat(item.path!)
    if (info.isSymbolicLink() || !info.isFile() || info.size > 100 * 1024 * 1024) throw Error('图片文件已变化或超过限制')
    const bytes = new Uint8Array(await fileSystem.readFile(item.path!)); inspectToolImage(bytes); return bytes
  }
  async function importImage(bytes: Uint8Array, name: string) {
    inspectToolImage(bytes); const asset = { id: randomUUID(), name: safeName(name || '剪贴板.png'), size: bytes.length }
    assets.set(asset.id, { asset, bytes: new Uint8Array(bytes), kind: 'image' }); return asset
  }
  async function imageExportName(ids: string[], format: ImageOptions['format']) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 10000 || !['original', 'png', 'jpeg', 'webp'].includes(format)) throw Error('图片导出参数无效')
    for (const id of ids) if (assets.get(id)?.kind !== 'image') throw Error('图片授权已失效，请重新导入')
    if (ids.length > 1) return { name: 'DustDesk-图片.zip', extension: 'zip' }
    const actual = format === 'original' ? inspectToolImage(await readAsset(ids[0]!)).format : format
    const extension = actual === 'jpeg' ? 'jpg' : actual
    const stem = path.parse(assets.get(ids[0]!)!.asset.name).name
    return { name: `${safeName(stem)}-处理后.${extension}`, extension }
  }
  async function beginBatch(target: string, count: number) {
    if (!path.isAbsolute(target) || !Number.isInteger(count) || count < 1 || count > 10000) throw Error('图片导出参数无效')
    await assertPathWithinRoot(path.dirname(target), target, true)
    const directory = await fileSystem.mkdtemp(path.join(path.dirname(target), '.dustdesk-images-'))
    const id = randomUUID()
    batches.set(id, { directory, target, count, files: [], pending: new Set() })
    return { id }
  }
  async function writeImage(batch: ImageBatch, name: string, bytes: Uint8Array) {
    const { directory } = batch
    inspectToolImage(bytes)
    const base = safeName(path.basename(name)), ext = path.extname(base), stem = path.basename(base, ext)
    for (let index = 0; index < 10000; index++) {
      const target = path.join(directory, `${stem}${index ? '-' + index : ''}${ext}`)
      await assertPathWithinRoot(directory, target, true)
      const temporary = path.join(directory, '.part-' + randomUUID())
      try {
        await fileSystem.writeFile(temporary, bytes, { flag: 'wx' })
        // A hard link publishes the complete file without overwriting a competing name.
        await fileSystem.link(temporary, target)
        batch.files.push(target)
        return target
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      finally { await fileSystem.rm(temporary, { force: true }) }
    }
    throw Error('同名文件过多')
  }
  function exportImage(id: string, name: string, bytes: Uint8Array) {
    const batch = batches.get(id)
    if (!batch || batch.finishing) return Promise.reject(Error('导出批次已结束'))
    if (batch.files.length + batch.pending.size >= batch.count) return Promise.reject(Error('导出图片数量超过本次选择'))
    const writing = writeImage(batch, name, bytes)
    batch.pending.add(writing)
    void writing.then(() => batch.pending.delete(writing), () => batch.pending.delete(writing))
    return writing
  }
  async function publish(source: string, target: string) {
    const directory = path.dirname(target), ext = path.extname(target), stem = path.basename(target, ext)
    for (let index = 0; index < 10000; index++) {
      const destination = path.join(directory, `${stem}${index ? '-' + index : ''}${ext}`)
      await assertPathWithinRoot(directory, destination, true)
      try { await fileSystem.link(source, destination); return destination }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
    }
    throw Error('同名文件过多')
  }
  async function finishBatch(batch: ImageBatch): Promise<ImageExportResult> {
    try {
      await Promise.allSettled([...batch.pending])
      if (!batch.files.length) return { count: 0 }
      let source = batch.files[0]!
      if (batch.count > 1) {
        source = path.join(batch.directory, 'output.zip')
        const zip = new ZipFile()
        zip.on('error', error => zip.outputStream.emit('error', error))
        const writing = pipeline(zip.outputStream, createWriteStream(source, { flags: 'wx' }))
        try {
          // Image formats are already compressed; store them without recompressing.
          for (const file of batch.files) zip.addFile(file, path.basename(file), { compress: false })
          zip.end()
          await writing
        } catch (e) { zip.outputStream.emit('error', e); await writing.catch(() => {}); throw e }
      }
      const output = await publish(source, batch.target)
      return { path: output, directory: path.dirname(output), count: batch.files.length }
    } finally { await fileSystem.rm(batch.directory, { recursive: true, force: true }) }
  }
  function endBatch(id: string): Promise<ImageExportResult> {
    const batch = batches.get(id)
    if (!batch) return Promise.resolve({ count: 0 })
    return batch.finishing ??= finishBatch(batch).finally(() => batches.delete(id))
  }
  return { registerPaths, readAsset, importImage, imageExportName, beginBatch, exportImage, endBatch,
    releaseAssets(ids: string[]) { for (const id of ids) assets.delete(id) },
    transferPaths(ids: string[]) { return ids.map(id => { const item = assets.get(id); if (!item?.path || item.kind !== 'transfer') throw Error('发送文件授权已失效'); return item.path }) },
    validateText(text: string) { if (typeof text !== 'string' || Buffer.byteLength(text) > maxTextBytes * 4) throw Error('导出文本最多 40 MiB') },
    async dispose() { await Promise.all([...batches.keys()].map(endBatch)); assets.clear() }
  }
}
