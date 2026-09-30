import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { WorkspaceState } from '../shared/types'
import { assertPathWithinRoot, isWithinDirectory } from './fileOperations'

const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' }
const maxImageBytes = 12 * 1024 * 1024
interface Dependencies {
  read(): Promise<WorkspaceState>
  write(state: WorkspaceState): Promise<string>
  enqueue<T>(operation: () => Promise<T>): Promise<T>
  directory(): string
  broadcast(state: WorkspaceState): void
}

export function createNoteBackgroundManager(deps: Dependencies) {
  const root = () => path.join(deps.directory(), 'NoteBackgrounds')
  const samePath = (left: string, right: string) => process.platform === 'win32' ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right)
  const checkedNote = (state: WorkspaceState, id: string, expectedPath?: string | null) => {
    const note = state.Notes.find(item => item.Id === id)
    if (!note) throw new Error('便签不存在，请重新选择')
    if (expectedPath !== undefined && (note.BackgroundImagePath || '') !== (expectedPath || '')) throw new Error('背景已在其他窗口修改，请重新操作')
    return note
  }
  // Metadata has committed. Never delete an external/shared image or report a
  // successful save as failed solely because unreferenced cleanup is delayed.
  async function cleanup(state: WorkspaceState, target?: string | null) {
    if (!target) return
    const notes = [...state.Notes, ...state.RecycleBin.flatMap(item => item.kind === 'note' ? [item.value] : [])]
    if (notes.some(note => note.BackgroundImagePath && samePath(note.BackgroundImagePath, target))) return
    const resolved = path.resolve(target)
    if (!isWithinDirectory(path.resolve(root()), resolved)) return
    try {
      await assertPathWithinRoot(deps.directory(), resolved, true)
      if ((await fs.lstat(resolved)).isSymbolicLink()) return
      await fs.rm(resolved, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('便签背景清理已延后', error)
    }
  }
  async function importBackground(id: string, source: string, expectedPath?: string | null) {
    return deps.enqueue(async () => {
      if (typeof source !== 'string' || !source.trim() || source.length > 4096) throw new Error('请输入有效的图片文件路径')
      const resolved = path.resolve(source.trim())
      const extension = path.extname(resolved).toLowerCase()
      const mime = imageTypes[extension]
      if (!mime) throw new Error('请选择 PNG、JPG、WebP、GIF 或 BMP 图片')
      const info = await fs.lstat(resolved)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('请选择普通图片文件，不支持目录或符号链接')
      if (!info.size || info.size > maxImageBytes) throw new Error('图片为空或超过 12 MB')
      const buffer = await fs.readFile(resolved)
      if (buffer.length > maxImageBytes) throw new Error('图片超过 12 MB')
      const state = await deps.read()
      const note = checkedNote(state, id, expectedPath)
      const previous = note.BackgroundImagePath
      const fileName = 'note-' + crypto.randomUUID() + extension
      const target = path.join(root(), fileName)
      await assertPathWithinRoot(deps.directory(), target, true)
      await fs.mkdir(root(), { recursive: true })
      await assertPathWithinRoot(deps.directory(), target, true)
      let created = false
      try {
        const file = await fs.open(target, 'wx')
        created = true
        try { await file.writeFile(buffer) } finally { await file.close() }
        note.BackgroundImagePath = target
        note.BackgroundImageFileName = fileName
        note.UpdatedAt = new Date().toISOString()
        await deps.write(state)
      } catch (error) {
        if (created) await fs.rm(target, { force: true }).catch(() => undefined)
        throw error
      }
      await cleanup(state, previous)
      deps.broadcast(state)
      return { ok: true, path: target, fileName, dataUrl: 'data:' + mime + ';base64,' + buffer.toString('base64') }
    })
  }
  async function clearBackground(id: string, expectedPath?: string | null) {
    return deps.enqueue(async () => {
      const state = await deps.read()
      const note = checkedNote(state, id, expectedPath)
      const previous = note.BackgroundImagePath
      note.BackgroundImagePath = null
      note.BackgroundImageFileName = ''
      note.ImageOnly = false
      note.UpdatedAt = new Date().toISOString()
      await deps.write(state)
      await cleanup(state, previous)
      deps.broadcast(state)
      return { ok: true }
    })
  }
  return { importBackground, clearBackground }
}
