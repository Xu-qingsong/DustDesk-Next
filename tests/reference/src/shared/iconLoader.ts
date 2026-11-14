export type PathIconResult = { dataUrl?: string; isDirectory?: boolean }

/** A bounded async queue shared by tiles; an abandoned tile never starts queued work. */
export function createIconLoader(load: (path: string) => Promise<PathIconResult>, options: {
  concurrency?: number; timeoutMs?: number; successTtlMs?: number; failureTtlMs?: number; capacity?: number
} = {}) {
  const { concurrency = 8, timeoutMs = 15_000, successTtlMs = 30_000, failureTtlMs = 3_000, capacity = 256 } = options
  type Request = { path: string; key: string; users: number; promise: Promise<PathIconResult>; resolve: (value: PathIconResult) => void }
  const cache = new Map<string, { value: PathIconResult; expires: number }>()
  const requests = new Map<string, Request>()
  const queue: Request[] = []
  let active = 0
  const keyFor = (path: string) => path.replace(/\\/g, '/').toLowerCase()

  async function execute(request: Request) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let value: PathIconResult = {}
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => load(request.path)),
        new Promise<PathIconResult>(resolve => { timer = setTimeout(() => resolve({}), timeoutMs) })
      ])
      // A malformed provider response must release the slot just like a rejected request.
      value = {
        ...(typeof result?.dataUrl === 'string' ? { dataUrl: result.dataUrl } : {}),
        ...(typeof result?.isDirectory === 'boolean' ? { isDirectory: result.isDirectory } : {})
      }
    } catch { /* An unavailable native provider must not break the file grid. */ }
    finally { clearTimeout(timer) }
    cache.set(request.key, { value, expires: Date.now() + (value.dataUrl ? successTtlMs : failureTtlMs) })
    if (cache.size > capacity) cache.delete(cache.keys().next().value!)
    requests.delete(request.key)
    request.resolve(value)
    active--
    drain()
  }

  function drain() {
    while (active < concurrency && queue.length) {
      const request = queue.shift()!
      if (!request.users) { requests.delete(request.key); request.resolve({}); continue }
      active++
      void execute(request)
    }
  }

  function read(path: string, signal?: AbortSignal): Promise<PathIconResult> {
    if (signal?.aborted) return Promise.reject(new DOMException('Icon request cancelled', 'AbortError'))
    const key = keyFor(path)
    const cached = cache.get(key)
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.value)
    cache.delete(key)
    let request = requests.get(key)
    if (!request) {
      let resolve!: Request['resolve']
      const promise = new Promise<PathIconResult>(done => { resolve = done })
      request = { path, key, users: 0, promise, resolve }
      requests.set(key, request)
      queue.push(request)
    }
    const subscribed = request
    subscribed.users++
    const result = new Promise<PathIconResult>((resolve, reject) => {
      const finish = () => { subscribed.users--; signal?.removeEventListener('abort', abort) }
      const abort = () => { finish(); reject(new DOMException('Icon request cancelled', 'AbortError')) }
      signal?.addEventListener('abort', abort, { once: true })
      subscribed.promise.then(value => { if (!signal?.aborted) { finish(); resolve(value) } })
    })
    queueMicrotask(drain)
    return result
  }

  return { read, invalidate: (path: string) => cache.delete(keyFor(path)) }
}
