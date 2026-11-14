import { open, lstat, mkdir } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { createServer } from 'node:net'
import type { Server } from 'node:net'
import path from 'node:path'

export type WorkspaceOwnership = {
  root: string
  identity: { volume: string; file: string }
  assertHeld: () => Promise<void>
  release: () => Promise<void>
}

async function checkPath(directory: string) {
  let current = directory
  for (;;) {
    try {
      if ((await lstat(current)).isSymbolicLink()) throw Error('工作区路径含符号链接或重解析点，操作已拒绝')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = path.dirname(current)
    if (parent === current) return
    current = parent
  }
}

export async function acquireWorkspaceOwnership(directory: string, options: { existingOnly?: boolean } = {}): Promise<WorkspaceOwnership> {
  if (process.platform !== 'win32') throw Error('跨运行时工作区锁尚不支持此平台')
  if (!path.isAbsolute(directory)) throw Error('工作区目录必须为绝对路径')
  directory = path.resolve(directory)
  await checkPath(directory)
  if (!options.existingOnly) await mkdir(directory, { recursive: true })
  await checkPath(directory)
  let handle: FileHandle | undefined
  let server: Server | undefined
  try {
    handle = await open(directory, 'r')
    const metadata = await handle.stat({ bigint: true })
    if (!metadata.isDirectory() || metadata.ino === 0n) throw Error('无法确认工作区目录身份')
    const name = '\\\\.\\pipe\\dustdesk-workspace-v1-' + metadata.dev.toString(16).padStart(16, '0') + '-' + metadata.ino.toString(16).padStart(16, '0')
    server = createServer(socket => socket.destroy())
    const listening = server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { listening.removeListener('listening', ready); reject(error) }
      const ready = () => { listening.removeListener('error', failed); resolve() }
      listening.once('error', failed)
      listening.once('listening', ready)
      listening.listen(name)
    })
    await checkPath(directory)
    const current = await lstat(directory, { bigint: true })
    if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw Error('工作区目录在加锁时发生变化')
    let released = false
    return {
      root: directory,
      identity: { volume: metadata.dev.toString(16).padStart(16, '0'), file: metadata.ino.toString(16).padStart(16, '0') },
      async assertHeld() {
        if (released || !listening.listening) throw Error('工作区独占权限已失效')
        await checkPath(directory)
        const current = await lstat(directory, { bigint: true })
        if (current.dev !== metadata.dev || current.ino !== metadata.ino) throw Error('工作区目录身份已变化')
      },
      async release() {
        if (released) return
        released = true
        await new Promise<void>((resolve, reject) => listening.close(error => error ? reject(error) : resolve()))
        await handle?.close()
      }
    }
  } catch (error) {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()))
    await handle?.close()
    if (['EADDRINUSE', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw Error('工作区正由另一个进程使用或锁访问被拒绝，未打开。请先退出另一个版本。')
    throw error
  }
}
