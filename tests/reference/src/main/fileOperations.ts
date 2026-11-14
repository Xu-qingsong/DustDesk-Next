import { promises as fs } from 'node:fs'
import path from 'node:path'

export function safeName(value: string) {
  const cleaned = value.replace(/[<>:"/\\|?*]/g, '_').trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return '未命名'
  return cleaned.replace(/^\.+$/, '未命名')
}

export function isWithinDirectory(root: string, target: string) {
  const relative = path.relative(path.resolve(root), path.resolve(target))
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}

export async function assertPathWithinRoot(root: string, target: string, allowMissing = false) {
  if (!isWithinDirectory(root, target)) throw new Error('Path is outside the managed root')
  const realRoot = await fs.realpath(root)
  let current = path.resolve(root)
  for (const part of path.relative(current, path.resolve(target)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    try {
      const info = await fs.lstat(current)
      if (info.isSymbolicLink() || !isWithinDirectory(realRoot, await fs.realpath(current))) {
        throw new Error('Symbolic links and redirected directories are not allowed')
      }
    } catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export async function moveFileSafely(source: string, target: string, fileSystem = fs) {
  const exists = async (value: string) => {
    try { await fileSystem.lstat(value); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
  }
  if (!await exists(source)) throw new Error('Source does not exist')
  if (await exists(target)) throw new Error('Target already exists')
  await fileSystem.mkdir(path.dirname(target), { recursive: true })
  try { await fileSystem.rename(source, target) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    const staging = await fileSystem.mkdtemp(path.join(path.dirname(target), '.dustdesk-move-'))
    try {
      const copy = path.join(staging, 'payload')
      await fileSystem.cp(source, copy, { recursive: true, errorOnExist: true, force: false })
      if (await exists(target)) throw new Error('Target already exists')
      await fileSystem.rename(copy, target)
      // Recursive removal may partially succeed. The complete copy must survive failure.
      try {
        await fileSystem.rm(source, { recursive: true, force: true })
        if (await exists(source)) throw new Error('Source still exists')
      } catch (cause) {
        throw new Error(`Source cleanup failed; complete copy retained at: ${target}`, { cause })
      }
    } finally { await fileSystem.rm(staging, { recursive: true, force: true }).catch(() => undefined) }
  }
  if (!await exists(target)) throw new Error('Move verification failed')
  return target
}
