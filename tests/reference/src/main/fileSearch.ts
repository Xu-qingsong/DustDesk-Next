import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Dirent } from 'node:fs'
import type { SearchFileResult } from '../shared/types'

const canonical = (target: string) => process.platform === 'win32' ? path.resolve(target).toLowerCase() : path.resolve(target)

export function createFileSearch(readDirectory: (directory: string) => Promise<Dirent[]> = directory => fs.readdir(directory, { withFileTypes: true })) {
  const cache = new Map<string, { expires: number; items: SearchFileResult[] }>()
  return async (roots: string[], query: string, signal: AbortSignal): Promise<SearchFileResult[]> => {
    const uniqueRoots = [...new Map(roots.map(root => [canonical(root), path.resolve(root)])).values()].slice(0, 10)
    const needle = query.trim().toLowerCase()
    const key = JSON.stringify([uniqueRoots.map(canonical), needle])
    if (signal.aborted) return []
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return cached.items
    const items: SearchFileResult[] = []
    const seenDirectories = new Set<string>()
    const seenResults = new Set<string>()
    for (const root of uniqueRoots) {
      const pending = [root]
      let visited = 0
      for (let cursor = 0; cursor < pending.length && visited < 50_000 && items.length < 40; cursor++) {
        if (signal.aborted) return []
        const directory = pending[cursor]!
        const directoryKey = canonical(directory)
        if (seenDirectories.has(directoryKey)) continue
        seenDirectories.add(directoryKey)
        let entries: Dirent[]
        try { entries = await readDirectory(directory) } catch { continue }
        if (signal.aborted) return []
        for (const entry of entries) {
          if (++visited > 50_000 || items.length >= 40 || signal.aborted) break
          const target = path.join(directory, entry.name)
          const targetKey = canonical(target)
          if (entry.name.toLowerCase().includes(needle) && !seenResults.has(targetKey)) {
            items.push({ Name: entry.name, Path: target, IsDirectory: entry.isDirectory() })
            seenResults.add(targetKey)
          }
          if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(target)
        }
      }
      if (items.length >= 40) break
    }
    if (signal.aborted) return []
    cache.delete(key)
    cache.set(key, { expires: Date.now() + 2000, items })
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return items
  }
}
