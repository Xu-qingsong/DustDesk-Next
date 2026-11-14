import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { maxDraftArchiveBytes } from '../shared/draftMigration'

export async function writeDraftExport(target: string, serialized: string, protectedRoots: string[], beforePublish?: () => Promise<void>) {
  if (!path.isAbsolute(target) || path.extname(target).toLowerCase() !== '.json') throw Error('请选择工作区以外的 JSON 草稿文件')
  if (Buffer.byteLength(serialized, 'utf8') > maxDraftArchiveBytes) throw Error('草稿迁移包超过 64 MiB，未导出')
  const parent = await fs.realpath(path.dirname(target))
  const destination = path.join(parent, path.basename(target))
  const within = (root: string, candidate: string) => {
    const normalize = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
    const relative = path.relative(normalize(root), normalize(candidate))
    return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))
  }
  for (const root of protectedRoots) {
    if (within(path.resolve(root), path.resolve(target)) || within(await fs.realpath(root), destination)) throw Error('不能将迁移草稿写入应用数据目录或覆盖工作区文件')
  }
  const existing = await fs.lstat(destination).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw Error('草稿目标必须为普通文件，不能覆盖链接或目录')
  const temporary = path.join(parent, '.dustdesk-drafts-' + randomUUID() + '.tmp')
  try {
    const handle = await fs.open(temporary, 'wx')
    try { await handle.writeFile(serialized, 'utf8'); await handle.sync() } finally { await handle.close() }
    await beforePublish?.()
    await fs.rename(temporary, destination)
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  return destination
}
