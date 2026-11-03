import https from 'node:https'
import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import { promises as fs, createReadStream, createWriteStream } from 'node:fs'
import { createHash, randomUUID, randomBytes, X509Certificate, timingSafeEqual } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import type { TLSSocket } from 'node:tls'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { generate } from 'selfsigned'
import { assertPathWithinRoot } from './fileOperations'
import type { LanDevice, LanSnapshot, TransferView } from '../shared/toolbox'
import { toolError } from '../shared/toolbox'

interface Entry { relative: string; size: number; mtime: number; hash: string; source?: string }
interface Manifest { id: string; name: string; entries: Entry[]; directories: string[]; text?: string }
interface Task { view: TransferView; peer: LanDevice; manifest: Manifest; sources?: string[]; prepared?: boolean; token?: string; staging?: string; files?: Record<string, string>; controller?: AbortController; running?: Promise<void> }
interface Identity { id: string; cert: string; key: string; fingerprint: string }
interface Options {
  storage: string; downloads: string; name: string; host?: string; discovery?: boolean
  confirmPair(device: LanDevice, code: string): Promise<boolean>
  confirmReceive(device: LanDevice, offer: { name: string; count: number; total: number; text?: string; resume: boolean }): Promise<string | false>
  changed(snapshot: LanSnapshot): void
}
const discoveryPort = 45892
const maxEntries = 10000
const maxJson = 64 * 1024 * 1024
const fingerprint = (raw: Buffer) => createHash('sha256').update(raw).digest('hex')
export const pairingCode = (a: string, b: string) => String(parseInt(createHash('sha256').update([a, b].sort().join(':')).digest('hex').slice(0, 12), 16) % 1000000).padStart(6, '0')
const errorText = toolError
function privateAddress(address: string) {
  return /^127\./.test(address) || /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address) || /^169\.254\./.test(address)
}
function validAddress(address: string) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) && address.split('.').every(p => +p <= 255) && privateAddress(address) }
export function validateManifest(value: Manifest) {
  if (!value || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id) || typeof value.name !== 'string' || value.name.length > 255 || !Array.isArray(value.entries) || !Array.isArray(value.directories) || value.entries.length + value.directories.length > maxEntries) throw Error('传输清单无效或超过 10000 项')
  const seen = new Set<string>()
  const validateName = (name: string) => {
    if (typeof name !== 'string' || name.length > 2048 || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..' || /[<>:"|?*\x00-\x1f]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw Error('传输路径无效')
    const key = name.toLowerCase(); if (seen.has(key)) throw Error('清单含重复路径'); seen.add(key)
  }
  for (const directory of value.directories) validateName(directory)
  for (const item of value.entries) {
    validateName(item.relative)
    if (!Number.isSafeInteger(item.size) || item.size < 0 || !Number.isFinite(item.mtime) || !/^[a-f0-9]{64}$/.test(item.hash)) throw Error('文件大小或校验值无效')
  }
  const fileNames = new Set(value.entries.map(e => e.relative.toLowerCase()))
  for (const name of seen) { const parts = name.split('/'); parts.pop(); while (parts.length) { if (fileNames.has(parts.join('/'))) throw Error('文件与目录冲突'); parts.pop() } }
  if (value.text !== undefined && (typeof value.text !== 'string' || Buffer.byteLength(value.text) > 10 * 1024 * 1024 || value.entries.length || value.directories.length)) throw Error('文本传输无效')
  if (!Number.isSafeInteger(value.entries.reduce((sum, e) => sum + e.size, 0))) throw Error('总大小超过安全范围')
}
async function hashFile(target: string, signal?: AbortSignal, end?: number) {
  const hash = createHash('sha256')
  if (end === 0) return hash.digest('hex')
  for await (const chunk of createReadStream(target, { signal, ...(end === undefined ? {} : { end: end - 1 }) })) hash.update(chunk)
  return hash.digest('hex')
}
async function jsonBody(request: IncomingMessage, limit = maxJson) {
  const chunks: Buffer[] = []; let length = 0
  for await (const chunk of request) { length += chunk.length; if (length > limit) throw Error('请求内容过大'); chunks.push(chunk) }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
function reply(response: ServerResponse, value: unknown, status = 200) { if (!response.destroyed && !response.writableEnded) { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)) } }
function publicManifest(manifest: Manifest): Manifest { return { ...manifest, entries: manifest.entries.map(({ source: _source, ...entry }) => entry) } }
function pairingDecision(operation: Promise<boolean>, signal: AbortSignal) {
  return new Promise<boolean>((resolve, reject) => {
    const aborted = () => { signal.removeEventListener('abort', aborted); reject(Error('配对已取消或局域网传输已关闭')) }
    void operation.then(value => { signal.removeEventListener('abort', aborted); resolve(value) }, error => { signal.removeEventListener('abort', aborted); reject(error) })
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

export function createLanService(options: Options) {
  let identity: Identity, enabled = false, port = 0, error: string | undefined
  let server: https.Server | undefined, socket: dgram.Socket | undefined, timer: NodeJS.Timeout | undefined
  let initialized: Promise<void> | undefined, writeQueue: Promise<void> = Promise.resolve(), changeTimer: NodeJS.Timeout | undefined
  let desired = false, lifecycle: Promise<void> = Promise.resolve()
  const devices = new Map<string, LanDevice>(), trusted = new Set<string>(), tasks = new Map<string, Task>()
  const pairedDevices = new Map<string, LanDevice>(), heartbeats = new Map<string, Promise<void>>()
  let heartbeatController = new AbortController()
  const receiving = new Set<string>(), offers = new Set<string>(), speeds = new Map<string, { time: number; bytes: number }>()
  function addresses() { return Object.values(os.networkInterfaces()).flat().filter(n => n && n.family === 'IPv4' && !n.internal && privateAddress(n.address)).map(n => n!.address) }
  function snapshot(): LanSnapshot { return { enabled, port, error, addresses: options.host ? [options.host] : addresses(), devices: [...devices.values()].filter(d => Date.now() - d.lastSeen < 20000), tasks: [...tasks.values()].map(t => ({ ...t.view })) } }
  function emit(immediate = false) {
    if (immediate) { clearTimeout(changeTimer); changeTimer = undefined; options.changed(snapshot()); return }
    if (!changeTimer) changeTimer = setTimeout(() => { changeTimer = undefined; options.changed(snapshot()) }, 150)
  }
  function save() {
    const state = JSON.stringify({ enabled: desired, trusted: [...trusted], tasks: [...tasks.values()].filter(t => t.manifest.text === undefined).map(({ controller: _c, running: _r, token: _token, ...task }) => task) })
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await fs.mkdir(options.storage, { recursive: true })
      const temporary = path.join(options.storage, 'state-' + randomUUID() + '.tmp')
      try { await fs.writeFile(temporary, state); await fs.rename(temporary, path.join(options.storage, 'state.json')) }
      finally { await fs.rm(temporary, { force: true }) }
    }); return writeQueue
  }
  function initialize() {
    return initialized ??= (async () => {
      await fs.mkdir(options.storage, { recursive: true })
      const target = path.join(options.storage, 'identity.json')
      try { identity = JSON.parse(await fs.readFile(target, 'utf8')); if (fingerprint(new X509Certificate(identity.cert).raw) !== identity.fingerprint || !identity.key) throw Error('设备身份文件损坏') }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        const certificate = await new Promise<{ cert: string; private: string }>((resolve, reject) => generate([{ name: 'commonName', value: 'DustDesk Local Transfer' }], { keySize: 2048, days: 3650, algorithm: 'sha256' }, (err, cert) => err ? reject(err) : resolve(cert)))
        identity = { id: randomUUID(), cert: certificate.cert, key: certificate.private, fingerprint: fingerprint(new X509Certificate(certificate.cert).raw) }
        await fs.writeFile(target, JSON.stringify(identity), { mode: 0o600, flag: 'wx' })
      }
      try {
        const state = JSON.parse(await fs.readFile(path.join(options.storage, 'state.json'), 'utf8'))
        desired = state.enabled === true
        for (const fp of state.trusted ?? []) if (/^[a-f0-9]{64}$/.test(fp)) trusted.add(fp)
        for (const task of state.tasks ?? []) {
          validateManifest(task.manifest)
          task.token = undefined; task.view.speed = 0
          if (!['completed','canceled'].includes(task.view.status)) task.view.status = 'paused'
          tasks.set(task.view.id, task)
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw Error('续传状态无法读取：' + errorText(e)) }
    })()
  }
  async function request(device: LanDevice, route: string, body?: unknown, stream?: NodeJS.ReadableStream, signal?: AbortSignal, unpaired = false, timeout = 120000): Promise<any> {
    if (!enabled) throw Error('请先开启局域网传输')
    return new Promise((resolve, reject) => {
      const outgoing = https.request({ hostname: device.address, port: device.port, path: route, method: body === undefined && !stream ? 'GET' : 'POST', cert: identity.cert, key: identity.key, rejectUnauthorized: false, agent: false, signal, headers: { 'Content-Type': stream ? 'application/octet-stream' : 'application/json' } }, async response => {
        try { const result = await jsonBody(response); if ((response.statusCode ?? 500) >= 400) throw Error(result.error || '传输请求失败'); resolve(result) } catch (e) { reject(e) }
      })
      outgoing.setTimeout(timeout, () => outgoing.destroy(Error('连接超时，请检查对方是否在线及防火墙设置')))
      outgoing.on('socket', value => (value as TLSSocket).once('secureConnect', () => {
        const peer = (value as TLSSocket).getPeerCertificate()
        const fp = peer.raw ? fingerprint(peer.raw) : ''
        if (!fp || (!unpaired && fp !== device.fingerprint)) outgoing.destroy(Error('设备身份已变化，请重新连接并核对配对码'))
        else if (unpaired) device.fingerprint = fp
      }))
      outgoing.on('error', reject)
      if (stream) { void pipeline(stream as ReturnType<typeof createReadStream>, outgoing).catch(reject) }
      else outgoing.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  async function connect(address: string, targetPort: number, taskSignal?: AbortSignal, expected?: Pick<LanDevice, 'id' | 'fingerprint'>) {
    await initialize()
    const signal = taskSignal ? AbortSignal.any([heartbeatController.signal, taskSignal]) : heartbeatController.signal
    signal.throwIfAborted()
    if (!validAddress(address) || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw Error('请输入局域网 IPv4 地址和有效端口')
    const peer: LanDevice = { id: '', name: '', address, port: targetPort, fingerprint: expected?.fingerprint ?? '', lastSeen: Date.now() }
    const hello = await request(peer, '/hello', undefined, undefined, signal, !expected)
    if (hello.protocol !== 1 || typeof hello.id !== 'string' || hello.id === identity.id || typeof hello.name !== 'string' || hello.name.length > 255) throw Error('对方不是兼容的 DustDesk 设备')
    Object.assign(peer, { id: hello.id, name: hello.name, lastSeen: Date.now() })
    if (expected && peer.id !== expected.id) throw Error('设备身份已变化，请重新连接并核对配对码')
    signal.throwIfAborted()
    if (!trusted.has(peer.fingerprint)) {
      const code = pairingCode(identity.fingerprint, peer.fingerprint)
      if (!await pairingDecision(options.confirmPair(peer, code), signal)) throw Error('配对已取消')
    }
    signal.throwIfAborted()
    await request(peer, '/pair', { id: identity.id, name: options.name, port }, undefined, signal)
    signal.throwIfAborted()
    trusted.add(peer.fingerprint); await save()
    devices.set(peer.id, peer); pairedDevices.set(peer.id, peer); emit(true); return peer
  }
  function refreshDevices() {
    for (const [id, peer] of devices) if (Date.now() - peer.lastSeen > 20000) devices.delete(id)
    for (const [id, peer] of pairedDevices) {
      if (heartbeats.has(id) || Date.now() - peer.lastSeen < 5000) continue
      const signal = heartbeatController.signal
      const operation = request(peer, '/hello', undefined, undefined, signal, false, 3000).then(hello => {
        if (!enabled || signal.aborted || pairedDevices.get(id) !== peer || hello.protocol !== 1 || hello.id !== id) return
        peer.lastSeen = Date.now(); devices.set(id, peer); emit()
      }).catch(() => { /* Keep probing paired devices, but hide them when their last successful contact expires. */ })
        .finally(() => { heartbeats.delete(id) })
      heartbeats.set(id, operation)
    }
    announce(); emit()
  }
  async function receiveOffer(peer: LanDevice, manifest: Manifest, alive: () => boolean) {
    validateManifest(manifest)
    const id = peer.fingerprint + '-' + manifest.id
    if (offers.has(id)) throw Error('此传输正在等待确认，请勿重复发送')
    const previous = tasks.get(id)
    if (previous && JSON.stringify(publicManifest(previous.manifest)) !== JSON.stringify(publicManifest(manifest))) throw Error('发送源已变化，请创建新的发送任务')
    if (previous?.view.status === 'canceled') throw Error('任务已取消，请重新发送')
    if (previous?.view.status === 'transferring') throw Error('任务正在传输')
    offers.add(id)
    try {
      const total = manifest.entries.reduce((sum, e) => sum + e.size, 0)
      const root = await options.confirmReceive(peer, { name: manifest.name, count: manifest.entries.length, total, text: manifest.text, resume: !!previous })
      if (!root) throw Error('对方拒绝接收')
      if (!enabled || !alive()) throw Error('发送已取消或局域网传输已关闭')
      const task: Task = previous ?? { peer, manifest: publicManifest(manifest), view: { id, direction: 'receive', device: peer.name, name: manifest.name, total, done: 0, speed: 0, status: 'waiting' }, files: {} }
      task.peer = peer; task.token = randomBytes(32).toString('hex'); task.controller = new AbortController()
      tasks.set(id, task)
      const operation = (async () => {
        if (manifest.text !== undefined) {
          task.view.text = manifest.text; task.view.status = 'completed'; tasks.set(id, task); emit(true); return { token: task.token, offsets: [] }
        }
        if (!task.view.directory) {
          await fs.mkdir(root, { recursive: true })
          task.view.directory = await fs.mkdtemp(path.join(root, 'DustDesk-接收-'))
          task.staging = path.join(task.view.directory, '.dustdesk-part-' + manifest.id)
          await fs.mkdir(task.staging)
        }
        if (task.view.status === 'completed') { await fs.mkdir(task.staging!, { recursive: true }) }
        await assertPathWithinRoot(task.view.directory!, task.staging!)
        for (const directory of manifest.directories) { task.controller!.signal.throwIfAborted(); const target = path.join(task.view.directory!, ...directory.split('/')); await assertPathWithinRoot(task.view.directory!, target, true); await fs.mkdir(target, { recursive: true }) }
        const offsets: { size: number; hash: string; complete: boolean }[] = []
        for (let index = 0; index < manifest.entries.length; index++) {
          task.controller!.signal.throwIfAborted()
          const item = manifest.entries[index]!, final = task.files?.[String(index)], temporary = path.join(task.staging!, index + '.part')
          let size = 0, complete = false, hash = createHash('sha256').digest('hex')
          if (final) {
            await assertPathWithinRoot(task.view.directory!, final)
            const info = await fs.stat(final); hash = await hashFile(final, task.controller!.signal)
            if (info.size !== item.size || hash !== item.hash) throw Error('已接收文件被修改，请重新发送到新目录')
            size = item.size; complete = true
          } else {
            await assertPathWithinRoot(task.view.directory!, temporary, true)
            try { size = (await fs.stat(temporary)).size; if (size > item.size) throw Error('临时文件大小异常'); hash = await hashFile(temporary, task.controller!.signal) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
          }
          offsets.push({ size, hash, complete })
        }
        task.controller!.signal.throwIfAborted()
        task.view.done = offsets.reduce((sum, o) => sum + o.size, 0); task.view.status = 'waiting'; tasks.set(id, task); await save(); emit(true)
        return { token: task.token, offsets }
      })()
      task.running = operation.then(() => {}, () => {})
      try { return await operation }
      catch (e) { if (!['paused', 'canceled'].includes(task.view.status)) { task.view.status = 'failed'; task.view.error = errorText(e) }; await save(); emit(true); throw e }
      finally { task.running = undefined }
    } finally { offers.delete(id) }
  }
  function authenticatedTask(peer: LanDevice, url: URL) {
    const task = tasks.get(peer.fingerprint + '-' + url.searchParams.get('id'))
    const token = url.searchParams.get('token') ?? ''
    if (!task?.token || !/^[a-f0-9]{64}$/.test(token) || !timingSafeEqual(Buffer.from(token), Buffer.from(task.token)) || task.peer.fingerprint !== peer.fingerprint) throw Error('传输授权无效')
    return task
  }
  async function handler(incoming: IncomingMessage, response: ServerResponse) {
    let currentTask: Task | undefined
    let ownsReceive = false
    try {
      const address = (incoming.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
      if (!validAddress(address)) throw Error('仅接受局域网 IPv4 连接')
      const cert = (incoming.socket as TLSSocket).getPeerCertificate()
      if (!cert.raw) throw Error('缺少设备证书')
      const fp = fingerprint(cert.raw), url = new URL(incoming.url ?? '/', 'https://dustdesk.local')
      if (url.pathname === '/hello' && incoming.method === 'GET') { reply(response, { protocol: 1, id: identity.id, name: options.name, port }); return }
      if (url.pathname === '/pair' && incoming.method === 'POST') {
        const signal = heartbeatController.signal
        const body = await jsonBody(incoming, 4096)
        if (typeof body.id !== 'string' || typeof body.name !== 'string' || body.name.length > 255 || !Number.isInteger(body.port) || body.port < 1 || body.port > 65535) throw Error('设备信息无效')
        const peer = { id: body.id, name: body.name, address, port: body.port, fingerprint: fp, lastSeen: Date.now() }
        signal.throwIfAborted()
        if (!trusted.has(fp) && !await pairingDecision(options.confirmPair(peer, pairingCode(identity.fingerprint, fp)), signal)) throw Error('配对已取消')
        if (!enabled || signal.aborted || response.destroyed) throw Error('配对已取消或局域网传输已关闭')
        trusted.add(fp); devices.set(peer.id, peer); pairedDevices.set(peer.id, peer); await save(); emit(true); reply(response, { ok: true }); return
      }
      if (!trusted.has(fp)) throw Error('请先配对设备')
      const peer = [...devices.values()].find(d => d.fingerprint === fp) ?? [...tasks.values()].find(t => t.peer.fingerprint === fp)?.peer
      if (!peer) throw Error('请重新连接设备')
      peer.address = address; peer.lastSeen = Date.now()
      if (url.pathname === '/offer' && incoming.method === 'POST') { reply(response, await receiveOffer(peer, await jsonBody(incoming), () => !response.destroyed)); return }
      const task = authenticatedTask(peer, url)
      currentTask = task
      if (url.pathname === '/pause' || url.pathname === '/cancel') {
        task.controller?.abort(); task.token = undefined; task.view.speed = 0; task.view.status = url.pathname === '/cancel' ? 'canceled' : 'paused'
        while (receiving.has(task.view.id)) await new Promise(resolve => setTimeout(resolve, 20))
        if (task.view.status === 'canceled') await cleanup(task)
        await save(); emit(true); reply(response, { ok: true }); return
      }
      if (url.pathname === '/file' && incoming.method === 'POST') {
        const index = Number(url.searchParams.get('index')), offset = Number(url.searchParams.get('offset')), entry = task.manifest.entries[index]
        if (!Number.isInteger(index) || !entry || !Number.isSafeInteger(offset) || offset < 0 || offset > entry.size || receiving.has(task.view.id) || !['waiting','transferring'].includes(task.view.status)) throw Error('文件传输状态无效')
        if (task.files?.[String(index)]) throw Error('文件已完成')
        receiving.add(task.view.id)
        ownsReceive = true
        task.controller ??= new AbortController(); task.view.status = 'transferring'; task.view.error = undefined
        const temporary = path.join(task.staging!, index + '.part'), before = task.view.done
        await assertPathWithinRoot(task.view.directory!, temporary, true)
        const handle = await fs.open(temporary, 'a')
        const actual = (await handle.stat()).size; await handle.close()
        if (actual !== offset) throw Error('续传偏移不一致，请重新恢复任务')
        let received = 0
        const count = (chunk: Buffer) => {
          received += chunk.length
          if (offset + received > entry.size) incoming.destroy(Error('文件超过声明大小'))
          task.view.done = before + received; updateSpeed(task); emit()
        }
        incoming.on('data', count)
        try {
          await pipeline(incoming, createWriteStream(temporary, { flags: 'a' }), { signal: task.controller.signal })
          if (offset + received !== entry.size) throw Error('文件未传输完整')
          if (await hashFile(temporary, task.controller.signal) !== entry.hash) { await fs.rm(temporary); task.view.done = before - offset; throw Error('文件校验失败，请重试') }
          const target = path.join(task.view.directory!, ...entry.relative.split('/'))
          await assertPathWithinRoot(task.view.directory!, target, true); await fs.mkdir(path.dirname(target), { recursive: true })
          const extension = path.extname(target), base = target.slice(0, target.length - extension.length)
          let final: string | undefined
          for (let n = 0; n < 10000; n++) {
            const candidate = n ? `${base}-${n}${extension}` : target
            await assertPathWithinRoot(task.view.directory!, candidate, true)
            try { await fs.link(temporary, candidate); final = candidate; break } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e }
          }
          if (!final) throw Error('同名文件过多')
          task.files ??= {}; task.files[String(index)] = final
          await save(); await fs.rm(temporary, { force: true }); reply(response, { ok: true })
        } finally { incoming.removeListener('data', count); receiving.delete(task.view.id) }
        return
      }
      if (url.pathname === '/complete' && incoming.method === 'POST') {
        if (Object.keys(task.files ?? {}).length !== task.manifest.entries.length || receiving.has(task.view.id)) throw Error('仍有文件未完成')
        task.view.status = 'completed'; task.view.done = task.view.total; task.view.speed = 0; await cleanup(task); await save(); emit(true); reply(response, { ok: true }); return
      }
      throw Error('未知传输操作')
    } catch (e) {
      const task = currentTask
      if (task && ownsReceive) receiving.delete(task.view.id)
      if (task && ownsReceive && task.view.status === 'transferring') { task.view.status = 'failed'; task.view.error = errorText(e); task.view.speed = 0; void save().catch(() => {}); emit(true) }
      reply(response, { error: errorText(e) }, 400)
    }
  }
  function updateSpeed(task: Task) {
    const last = speeds.get(task.view.id), time = Date.now()
    if (!last || time - last.time >= 500) { task.view.speed = last ? Math.max(0, (task.view.done - last.bytes) * 1000 / (time - last.time)) : 0; speeds.set(task.view.id, { time, bytes: task.view.done }) }
  }
  async function cleanup(task: Task) {
    if (task.staging && task.view.directory) { await assertPathWithinRoot(task.view.directory, task.staging, true); await fs.rm(task.staging, { recursive: true, force: true }) }
  }
  function announce() {
    if (!socket || !identity) return
    const message = Buffer.from(JSON.stringify({ protocol: 'dustdesk-1', id: identity.id, name: options.name, port, fingerprint: identity.fingerprint }))
    const targets = new Set(['255.255.255.255'])
    for (const adapter of Object.values(os.networkInterfaces()).flat()) if (adapter?.family === 'IPv4' && !adapter.internal && privateAddress(adapter.address)) {
      const ip = adapter.address.split('.').map(Number), mask = adapter.netmask.split('.').map(Number)
      targets.add(ip.map((v, i) => v | (~mask[i]! & 255)).join('.'))
    }
    for (const target of targets) socket.send(message, discoveryPort, target, e => { if (e) { error = '设备发现受阻：' + e.message + '，可手动连接'; emit() } })
  }
  async function start() {
    if (enabled) return
    await initialize(); error = undefined
    server = https.createServer({ key: identity.key, cert: identity.cert, requestCert: true, rejectUnauthorized: false, minVersion: 'TLSv1.2' }, (req, res) => { void handler(req, res) })
    server.requestTimeout = 0; server.headersTimeout = 15000
    server.setTimeout(120000, connection => connection.destroy())
    await new Promise<void>((resolve, reject) => { server!.once('error', reject); server!.listen(0, options.host ?? '0.0.0.0', () => { server!.removeListener('error', reject); resolve() }) })
    port = (server.address() as { port: number }).port; enabled = true; heartbeatController = new AbortController()
    server.on('error', e => { error = errorText(e); emit(true) })
    if (options.discovery !== false) {
      socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      socket.on('error', e => { error = '设备发现受阻：' + e.message + '，可手动连接'; emit() })
      socket.on('message', (bytes, remote) => {
        if (bytes.length > 2048 || !validAddress(remote.address)) return
        try {
          const packet = JSON.parse(bytes.toString())
          if (packet.protocol !== 'dustdesk-1' || typeof packet.id !== 'string' || packet.id.length > 80 || packet.id === identity.id || typeof packet.name !== 'string' || packet.name.length > 255 || !Number.isInteger(packet.port) || packet.port < 1 || packet.port > 65535 || !/^[a-f0-9]{64}$/.test(packet.fingerprint)) return
          const paired = pairedDevices.get(packet.id)
          if (paired && paired.fingerprint !== packet.fingerprint) return
          const peer = paired ?? { ...packet }
          Object.assign(peer, { name: packet.name, address: remote.address, port: packet.port, lastSeen: Date.now() })
          devices.set(packet.id, peer); emit()
        } catch { /* Ignore packets from unrelated services. */ }
      })
      socket.bind(discoveryPort, () => { socket?.setBroadcast(true); announce() })
    }
    timer = setInterval(refreshDevices, 5000)
    emit(true)
  }
  async function stop() {
    enabled = false; clearInterval(timer); timer = undefined; heartbeatController.abort()
    try { socket?.close() } catch { /* A blocked bind never opened a socket. */ }
    socket = undefined
    for (const task of tasks.values()) { task.controller?.abort(); task.token = undefined; if (['preparing','waiting','transferring'].includes(task.view.status)) { task.view.status = 'paused'; task.view.speed = 0 } }
    const running = [...tasks.values()].map(t => t.running).filter(Boolean)
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined; port = 0; await Promise.allSettled([...running, ...heartbeats.values()]); await save(); emit(true)
  }
  async function prepare(paths: string[], name: string, signal: AbortSignal): Promise<Manifest> {
    const entries: Entry[] = [], directories: string[] = [], names = new Set<string>()
    async function visit(source: string, relative: string, root: string) {
      signal.throwIfAborted(); await assertPathWithinRoot(root, source)
      const info = await fs.lstat(source)
      if (info.isSymbolicLink()) throw Error('不支持符号链接：' + relative)
      if (entries.length + directories.length >= maxEntries) throw Error('一次最多发送 10000 个文件和目录')
      if (info.isDirectory()) { directories.push(relative); for (const child of await fs.readdir(source)) await visit(path.join(source, child), relative + '/' + child, root) }
      else if (info.isFile()) {
        const hash = await hashFile(source, signal), after = await fs.stat(source)
        if (info.size !== after.size || info.mtimeMs !== after.mtimeMs) throw Error('发送源在准备期间发生变化：' + relative)
        entries.push({ relative, source, size: info.size, mtime: info.mtimeMs, hash })
      } else throw Error('不支持特殊文件：' + relative)
    }
    for (const source of paths) {
      if (!path.basename(source)) throw Error('请选择普通文件夹，不能发送整个盘符')
      let base = path.basename(source), suffix = 1
      while (names.has(base.toLowerCase())) base = `${path.basename(source)}-${suffix++}`
      names.add(base.toLowerCase()); await visit(source, base, path.dirname(source))
    }
    const manifest = { id: randomUUID(), name, entries, directories }; validateManifest(manifest); return manifest
  }
  async function run(task: Task) {
    if (!enabled) throw Error('请先开启局域网传输')
    if (task.running) throw Error('任务正在处理')
    task.controller = new AbortController(); const signal = task.controller.signal
    task.view.error = undefined; task.view.status = 'preparing'; emit(true)
    const operation = (async () => {
      try {
        if (!task.prepared && task.manifest.text === undefined) {
          const manifest = await prepare(task.sources ?? [], task.view.name, signal)
          task.manifest = { ...manifest, id: task.manifest.id }; task.prepared = true
          task.view.total = manifest.entries.reduce((sum, entry) => sum + entry.size, 0)
          await save()
        }
        const latest = devices.get(task.peer.id) ?? task.peer
        const peer = await connect(latest.address, latest.port, signal, task.peer); task.peer = peer
        for (const entry of task.manifest.entries) {
          signal.throwIfAborted(); await assertPathWithinRoot(path.dirname(entry.source!), entry.source!)
          const info = await fs.stat(entry.source!)
          if (info.size !== entry.size || info.mtimeMs !== entry.mtime || await hashFile(entry.source!, signal) !== entry.hash) throw Error('发送源已变化，请重新发送：' + entry.relative)
        }
        task.view.status = 'waiting'; emit(true)
        const offer = await request(peer, '/offer', publicManifest(task.manifest), undefined, signal)
        task.token = offer.token
        if (task.manifest.text !== undefined) { task.view.status = 'completed'; emit(true); return }
        if (!Array.isArray(offer.offsets) || offer.offsets.length !== task.manifest.entries.length) throw Error('续传信息无效')
        task.view.done = 0; task.view.status = 'transferring'; speeds.delete(task.view.id); emit(true)
        for (let index = 0; index < task.manifest.entries.length; index++) {
          signal.throwIfAborted()
          const entry = task.manifest.entries[index]!, offset = offer.offsets[index]
          if (!Number.isSafeInteger(offset.size) || offset.size < 0 || offset.size > entry.size || offset.hash !== await hashFile(entry.source!, signal, offset.size)) throw Error('续传临时文件校验失败，请取消并重新发送')
          task.view.done += offset.size
          if (offset.complete) continue
          const stream = entry.size === offset.size ? createReadStream(entry.source!, { start: entry.size }) : createReadStream(entry.source!, { start: offset.size, signal })
          stream.on('data', chunk => { task.view.done += chunk.length; updateSpeed(task); emit() })
          await request(peer, `/file?id=${task.manifest.id}&token=${task.token}&index=${index}&offset=${offset.size}`, undefined, stream, signal)
          await save()
        }
        await request(peer, `/complete?id=${task.manifest.id}&token=${task.token}`, {}, undefined, signal)
        task.view.status = 'completed'; task.view.done = task.view.total; task.view.speed = 0
      } catch (e) {
        if (!['paused','canceled'].includes(task.view.status)) { task.view.status = 'failed'; task.view.error = errorText(e) }
        task.view.speed = 0
      } finally { task.running = undefined; await save(); emit(true) }
    })()
    task.running = operation; await operation
  }
  function startTask(task: Task) {
    // run owns the transfer lifetime; IPC only waits for task submission.
    void run(task).catch(e => {
      if (!['paused', 'canceled'].includes(task.view.status)) { task.view.status = 'failed'; task.view.error = errorText(e) }
      emit(true)
    })
  }
  return {
    snapshot,
    async restore() { await initialize(); if (desired) await start() },
    async enable(value: boolean) {
      lifecycle = lifecycle.catch(() => {}).then(async () => { await initialize(); desired = value; if (value) { try { await start() } catch (e) { desired = false; error = errorText(e); await stop(); throw e } } else await stop(); await save() })
      await lifecycle; return snapshot()
    }, connect,
    async send(deviceId: string, paths: string[], text?: string) {
      if (!enabled) throw Error('请先开启局域网传输')
      const peer = devices.get(deviceId); if (!peer) throw Error('设备已离线，请重新连接')
      if (!paths.length && text === undefined) throw Error('请选择文件或输入文本')
      if (text !== undefined && (paths.length || Buffer.byteLength(text) > 10 * 1024 * 1024)) throw Error('文本传输参数无效或超过 10 MiB')
      const id = randomUUID(), name = text !== undefined ? '文本' : paths.length === 1 ? path.basename(paths[0]!) : `${paths.length} 个项目`
      const task: Task = { peer, manifest: { id, name, entries: [], directories: [], text }, sources: paths, prepared: text !== undefined, view: { id, direction: 'send', device: peer.name, name, total: 0, done: 0, speed: 0, status: 'preparing' }, controller: new AbortController() }
      tasks.set(id, task); emit(true)
      try { await save(); if (task.view.status === 'canceled' || task.view.status === 'paused') return; startTask(task) }
      catch (e) { if (!['canceled','paused'].includes(task.view.status)) { task.view.status = 'failed'; task.view.error = errorText(e) }; emit(true) }
    },
    async control(id: string, action: 'pause' | 'resume' | 'cancel' | 'clear') {
      const task = tasks.get(id); if (!task) throw Error('任务不存在')
      if (action === 'resume') {
        if (!['paused','failed'].includes(task.view.status)) throw Error('任务不能继续')
        if (task.view.direction === 'receive') throw Error('请在发送电脑点击继续，对方重新确认后续传')
        startTask(task); return
      }
      if (!['pause','cancel','clear'].includes(action)) throw Error('任务操作无效')
      if (action === 'pause' && ['completed','canceled'].includes(task.view.status)) return
      const token = task.token; task.view.status = action === 'pause' ? 'paused' : 'canceled'; task.view.speed = 0; task.controller?.abort(); task.token = undefined
      await task.running
      if (task.view.direction === 'send' && token && enabled) await request(task.peer, `/${action === 'pause' ? 'pause' : 'cancel'}?id=${task.manifest.id}&token=${token}`, {}).catch(() => {})
      while (receiving.has(id)) await new Promise(resolve => setTimeout(resolve, 20))
      if (action !== 'pause') await cleanup(task)
      if (action === 'clear') tasks.delete(id)
      await save(); emit(true)
    },
    async dispose() { await lifecycle.catch(() => {}); await stop(); clearTimeout(changeTimer) }
  }
}
