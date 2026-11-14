import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ClipboardRecord, WorkspaceState } from '../shared/types'
import { assertPathWithinRoot } from './fileOperations'

const maxBytes = 12 * 1024 * 1024
const validName = (name: string) => /^[a-f0-9]{64}\.png$/.test(name)

export function createClipboardAssets(directory: () => string) {
  const root = () => path.join(directory(), 'ClipboardImages')

  async function read(item: ClipboardRecord): Promise<string> {
    if (item.ImagePngBase64) return item.ImagePngBase64
    const name = item.ImageAssetName
    if (!name || !validName(name)) throw new Error('剪贴板图片引用无效')
    const target = path.join(root(), name)
    await assertPathWithinRoot(directory(), target)
    if ((await fs.stat(target)).size > maxBytes) throw new Error('剪贴板图片过大')
    const bytes = await fs.readFile(target)
    if (`${createHash('sha256').update(bytes).digest('hex')}.png` !== name) throw new Error('剪贴板图片已损坏')
    return bytes.toString('base64')
  }

  async function externalize(state: WorkspaceState) {
    for (const item of state.ClipboardHistory) {
      if (item.Kind !== 'Image' || !item.ImagePngBase64) continue
      const content = item.ImagePngBase64
      if (content.length > Math.ceil(maxBytes * 4 / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('剪贴板图片无效或过大')
      const bytes = Buffer.from(content, 'base64')
      if (!bytes.length || bytes.toString('base64') !== content) throw new Error('剪贴板图片编码无效')
      const name = `${createHash('sha256').update(bytes).digest('hex')}.png`
      await assertPathWithinRoot(directory(), root(), true)
      await fs.mkdir(root(), { recursive: true })
      const target = path.join(root(), name)
      await assertPathWithinRoot(directory(), target, true)
      // Commit the asset first: a failed metadata write must leave the old workspace usable.
      let existing: Buffer | undefined
      try { existing = await fs.readFile(target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!existing?.equals(bytes)) {
        const temporary = path.join(root(), `${randomUUID()}.tmp`)
        try {
          await fs.writeFile(temporary, bytes, { flag: 'wx' })
          await fs.rename(temporary, target)
        } finally { await fs.rm(temporary, { force: true }).catch(() => undefined) }
      }
      item.ImageAssetName = name
      item.ImagePngBase64 = ''
    }
  }

  async function forBackup(state: WorkspaceState, warnings?: string[]) {
    const history: ClipboardRecord[] = []
    for (const item of state.ClipboardHistory) {
      if (item.Kind !== 'Image') { history.push(item); continue }
      try { history.push({ ...item, ImagePngBase64: await read(item) }) }
      catch (error) {
        if (!warnings) throw error
        warnings.push(`剪贴板图片未能读取，已保留原引用：${item.ImageFileName}`)
        history.push(item)
      }
    }
    return { ...state, ClipboardHistory: history }
  }

  // Assets remain available to workspace.json.bak and recovery points after history deletion.
  return { read, externalize, forBackup }
}
