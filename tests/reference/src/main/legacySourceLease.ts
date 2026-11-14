import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import type { DraftCollectionContext } from './draftMaintenance'
import type { WorkspaceOwnership } from './workspaceOwnership'
import { legacyInstallationEntry } from './legacyDraftReader'
import { clearOriginalLanFence, writeOriginalLanFence, type OriginalLanFence, type OriginalLanProof } from './originalLanPreview'
import { readRuntimeHandbackFence, writeRuntimeHandbackFence, verifyRuntimeHandbackReceipt, type RuntimeHandbackFence, type RuntimeHandbackReceipt } from './runtimeHandback'

type Identity = { volume: number; index: string }
type Binding = {
  format: string; version: number; scope: string; productionReady: boolean; migrationComplete: boolean
  dataIdentity: Identity; userDataIdentity: Identity; browserProfileIdentity: Identity
  lanStorageIdentity: Identity | null; workspaceSha256: string; browserEntry: string; browserBinding: string
}
type SnapshotReceipt = { id: string; manifestSha256: string; destinationIdentity: Identity; componentsSha256: string; data: { id: string; manifestSha256: string; destinationIdentity: Identity; sourceIdentity: Identity; workspaceSha256: string; files: number; directories: number; totalBytes: number } }
type RuntimeReceipt = { format: string; version: number; id: string; preparationId: string; snapshotReceiptSha256: string; inventorySha256: string; destinationIdentity: Identity; workspaceSha256: string; files: number; directories: number; totalBytes: number; productionReady: boolean; migrationComplete: boolean }
type RuntimeProfile = { ownershipId: string; path: string; identity: Identity; origin: string }
type OriginalLanReady = { enabled: boolean; port: number; deviceId?: string; fingerprint?: string }
type Message = { event: string; requestId: string; binding?: Binding; id?: string; receipt?: unknown; bytes?: number; preparationId?: string; scope?: string; productionReady?: boolean; migrationComplete?: boolean; profile?: RuntimeProfile; ownershipId?: string; businessServicesStarted?: boolean; proof?: OriginalLanProof; enabled?: boolean; port?: number; deviceId?: string; fingerprint?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hash = /^[0-9a-f]{64}$/

export async function runtimePreviewRoot(data: string, profile: string) {
  if (app.isPackaged) throw Error('隔离运行验证仅供开发构建使用')
  const root = await fs.realpath(path.dirname(data)), temporary = await fs.realpath(os.tmpdir())
  if (path.dirname(root).toLowerCase() !== temporary.toLowerCase() || !path.basename(root).startsWith('dustdesk-runtime-preview-')
    || path.dirname(profile).toLowerCase() !== path.dirname(data).toLowerCase()) throw Error('隔离运行验证仅允许专用 TEMP 根中的同级 Data 与 Electron profile')
  return root
}

async function openLegacySource(owner: BrowserWindow, installation: string, ownership: WorkspaceOwnership, fingerprint: string, context: DraftCollectionContext, mode: 'lease' | 'snapshot' | 'runtime') {
  context.assertActive(); await ownership.assertHeld()
  if (process.platform !== 'win32') throw Error('正式旧安装来源租约仅支持 Windows')
  const session = owner.webContents.session, browserProfile = session.storagePath, userData = app.getPath('userData')
  if (!browserProfile || !path.isAbsolute(browserProfile)) throw Error('实际 Electron Session 没有持久化配置目录')
  if (mode === 'runtime') { await runtimePreviewRoot(ownership.root, userData); if (browserProfile !== userData) throw Error('隔离运行验证必须使用当前完整 Electron Session') }
  const executable = app.isPackaged ? path.join(process.resourcesPath, 'migration', 'dustdesk-tauri.exe') : fileURLToPath(new URL('../../src-tauri/target/debug/dustdesk-tauri.exe', import.meta.url))
  const requestId = randomUUID(), expectedEntry = await legacyInstallationEntry(installation)
  const child = spawn(executable, [mode === 'runtime' ? '--legacy-runtime-preview-v1' : mode === 'snapshot' ? '--legacy-source-snapshot-v1' : '--legacy-source-lease-v1'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = Buffer.alloc(0), stderr = '', lost: Error | undefined, closed = false, closing: Promise<void> | undefined
  let runtimeLaunched = false
  let originalLanRequested = false, releaseRecovery = false
  let fence: OriginalLanFence | undefined, handback: Message | undefined
  let wholeFence: RuntimeHandbackFence | undefined, finalReading = false
  let signalFailure!: (error: Error) => void
  const failure = new Promise<Error>(resolve => { signalFailure = resolve })
  let pending: { event: string; resolve: (message: Message) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined
  const ended = new Promise<void>(resolve => child.once('close', () => { closed = true; if (pending) fail('原生来源租约未返回完整确认就已关闭：' + stderr.trim()); resolve() }))
  const fail = (reason: unknown) => {
    lost ??= reason instanceof Error ? reason : Error(String(reason))
    signalFailure(lost)
    const waiting = pending; pending = undefined
    if (waiting) { clearTimeout(waiting.timer); waiting.reject(lost) }
  }
  const aborted = () => { fail('旧安装来源维护已取消'); if (!originalLanRequested || !runtimeLaunched) child.kill() }
  context.signal.addEventListener('abort', aborted, { once: true })
  child.on('error', error => fail('无法启动原生来源租约；请先构建迁移预览或提供随应用分发的原生 helper：' + error.message))
  child.on('exit', (code, signal) => { if (!closing && !releaseRecovery) fail('原生来源租约提前退出（' + (signal ?? code) + '）：' + stderr.trim()) })
  child.stdin.on('error', fail)
  child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-8192) })
  child.stdout.on('data', chunk => {
    if (output.length + chunk.length > 65536) { fail('原生来源租约响应超限'); child.kill(); return }
    output = Buffer.concat([output, chunk])
    let newline: number
    while ((newline = output.indexOf(10)) !== -1) {
      const bytes = output.subarray(0, newline); output = output.subarray(newline + 1)
      try {
        const message = JSON.parse(bytes.toString('utf8')) as Message
        if (wholeFence && message?.requestId === requestId && message.event === 'runtimeHandbackReading') {
          if (finalReading || pending?.event !== 'runtimeHandbackSealed' || message.ownershipId !== wholeFence.ownershipId
            || message.businessServicesStarted !== false || message.productionReady !== false || message.migrationComplete !== false) throw Error('整体交还最终读取响应阶段或身份不匹配')
          finalReading = true; continue
        }
        if (originalLanRequested && message?.requestId === requestId && message.event === 'runtimeOriginalLanHandedBack') {
          if (handback || message.productionReady !== false || message.migrationComplete !== false || message.businessServicesStarted !== false
            || !message.proof || (fence && message.ownershipId !== fence.ownershipId) || (wholeFence && message.ownershipId !== wholeFence.ownershipId)) throw Error('原 LAN 交还响应不属于本次原生所有权')
          handback = message; continue
        }
        if (!pending || !message || message.requestId !== requestId || message.event !== pending.event) throw Error('原生来源租约响应阶段或身份不匹配')
        const waiting = pending; pending = undefined; clearTimeout(waiting.timer); waiting.resolve(message)
      } catch (error) { fail(error); child.kill() }
    }
  })
  const assertActive = () => {
    context.assertActive()
    if (lost || closed || child.exitCode !== null || child.signalCode !== null || owner.isDestroyed() || owner.webContents.isDestroyed() || owner.webContents.session !== session || session.storagePath !== browserProfile || app.getPath('userData') !== userData) throw lost ?? Error('实际旧安装来源租约或 Electron Session 已失效')
  }
  const rpc = (event: string, command: object, timeout = 15000) => new Promise<Message>((resolve, reject) => {
    if (pending) { reject(Error('原生来源租约不允许并发消息')); return }
    if (lost || closed) { reject(lost ?? Error('原生来源租约已关闭')); return }
    const timer = setTimeout(() => { fail('原生来源租约响应超时'); child.kill() }, timeout)
    timer.unref(); pending = { event, resolve, reject, timer }
    child.stdin.write(JSON.stringify({ ...command, requestId }) + '\n', error => { if (error) fail(error) })
  })
  const close = () => closing ??= (async () => {
    try {
      if (!runtimeLaunched && !closed && !lost && !context.signal.aborted && !pending) await rpc('closed', { action: 'close' })
    } finally {
      context.signal.removeEventListener('abort', aborted)
      child.stdin.end()
      if (runtimeLaunched && !closed && ((originalLanRequested || releaseRecovery) || (!lost && !context.signal.aborted))) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([ended, new Promise<void>(resolve => { timer = setTimeout(resolve, originalLanRequested || releaseRecovery ? 60000 : 5000) })]) }
        finally { clearTimeout(timer) }
      }
      if (!closed) child.kill()
      await ended
      if (fence) {
        if (!handback?.proof || child.exitCode !== 0 || child.signalCode !== null) throw Error('原生宿主未确认持久交还，原 LAN 保持暂停；请使用恢复原 LAN 交还入口。' + (stderr.trim() ? '\n' + stderr.trim() : ''))
        await clearOriginalLanFence(fence, handback.proof)
      }
    }
  })()
  const physical = async (directory: string, expected: Identity) => {
    const metadata = await fs.stat(directory, { bigint: true })
    if (!metadata.isDirectory() || !expected || BigInt(expected.volume) !== metadata.dev || expected.index !== metadata.ino.toString(16).padStart(16, '0')) throw Error('实际运行时目录与原生来源物理身份不匹配')
  }
  try {
    assertActive()
    const { binding } = await rpc('ready', { action: 'open', version: 1, locations: { installation, data: ownership.root, userData, browserProfile, workspaceSha256: fingerprint } })
    if (!binding || binding.format !== 'dustdesk-live-legacy-source-binding' || binding.version !== 1 || binding.scope !== 'prepared-electron-runtime' || binding.productionReady !== false || binding.migrationComplete !== false || binding.workspaceSha256 !== fingerprint || binding.browserEntry !== expectedEntry) throw Error('原生来源绑定不属于当前运行时和工作区')
    const browserBinding = createHash('sha256').update(JSON.stringify({ version: 1, runtime: 'electron', entry: binding.browserEntry, profile: { volume: binding.browserProfileIdentity.volume.toString(16).padStart(16, '0'), file: binding.browserProfileIdentity.index } })).digest('hex')
    if (binding.browserBinding !== browserBinding || binding.dataIdentity.volume.toString(16).padStart(16, '0') !== ownership.identity.volume || binding.dataIdentity.index !== ownership.identity.file) throw Error('原生来源的工作区所有权或浏览器绑定不匹配')
    const check = async () => {
      assertActive(); await ownership.assertHeld()
      await physical(ownership.root, binding.dataIdentity); await physical(userData, binding.userDataIdentity); await physical(browserProfile, binding.browserProfileIdentity)
      assertActive()
    }
    await check()
    let preparing = false
    const prepare = async (destination: string, serialized: string) => {
      if (mode === 'lease' || preparing || runtimeLaunched) throw Error('当前来源会话不能重复准备组合快照')
      preparing = true
      const bytes = Buffer.from(serialized, 'utf8')
      if (!bytes.length || bytes.length > 64 * 1024 * 1024 || !path.isAbsolute(destination)) throw Error('来源快照草稿或绝对目标路径无效')
      await check()
      await rpc('draftsStarted', { action: 'draftsBegin', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        assertActive()
        const chunk = bytes.subarray(offset, offset + 32768)
        const accepted = await rpc('draftsAccepted', { action: 'draftsChunk', data: chunk.toString('base64') })
        if (accepted.bytes !== offset + chunk.length) throw Error('来源快照草稿分块确认长度不匹配')
      }
      await check()
      const prepared = await rpc('prepared', { action: 'prepare', destination }, 300000)
      await check()
      const receipt = prepared.receipt as SnapshotReceipt | undefined
      if (!prepared.id || !uuid.test(prepared.id) || !receipt || !uuid.test(receipt.id) || !hash.test(receipt.manifestSha256) || !hash.test(receipt.componentsSha256)
        || !receipt.data || !uuid.test(receipt.data.id) || !hash.test(receipt.data.manifestSha256) || receipt.data.workspaceSha256 !== fingerprint
        || receipt.data.sourceIdentity?.volume !== binding.dataIdentity.volume || receipt.data.sourceIdentity?.index !== binding.dataIdentity.index
        || !Number.isSafeInteger(receipt.data.files) || receipt.data.files < 1 || !Number.isSafeInteger(receipt.data.directories) || receipt.data.directories < 0
        || !Number.isSafeInteger(receipt.data.totalBytes) || receipt.data.totalBytes < 0 || receipt.data.totalBytes > 1024 ** 4) throw Error('原生来源快照回执不属于当前准备会话')
      await physical(destination, receipt.destinationIdentity); await physical(path.join(destination, 'Data'), receipt.data.destinationIdentity)
      const verified = await rpc('verifiedPrepared', { action: 'verifyPrepared', id: prepared.id }, 300000)
      if (verified.id !== prepared.id || JSON.stringify(verified.receipt) !== JSON.stringify(receipt)) throw Error('持久来源快照决定与准备回执不匹配')
      await check()
      return { id: prepared.id, path: destination, receipt }
    }
    let runtime: { preparationId: string; id: string; path: string; receipt: RuntimeReceipt } | undefined
    const prepareRuntime = async (preparationId: string, destination: string) => {
      if (mode !== 'runtime' || runtime || runtimeLaunched || !uuid.test(preparationId)) throw Error('当前来源会话不能准备隔离运行 Data')
      await check()
      const prepared = await rpc('runtimePrepared', { action: 'prepareRuntime', id: preparationId, destination }, 300000)
      const receipt = prepared.receipt as RuntimeReceipt | undefined
      if (prepared.preparationId !== preparationId || prepared.scope !== 'runtime-data-only' || prepared.productionReady !== false || prepared.migrationComplete !== false
        || !prepared.id || !uuid.test(prepared.id) || !receipt || receipt.format !== 'dustdesk-runtime-data-prepared' || receipt.version !== 1
        || receipt.id !== prepared.id || receipt.preparationId !== preparationId || !hash.test(receipt.snapshotReceiptSha256) || !hash.test(receipt.inventorySha256)
        || receipt.workspaceSha256 !== fingerprint || receipt.productionReady !== false || receipt.migrationComplete !== false
        || !Number.isSafeInteger(receipt.files) || receipt.files < 1 || !Number.isSafeInteger(receipt.directories) || receipt.directories < 0
        || !Number.isSafeInteger(receipt.totalBytes) || receipt.totalBytes < 0 || receipt.totalBytes > 1024 ** 4) throw Error('原生运行 Data 回执不属于当前准备会话')
      await physical(destination, receipt.destinationIdentity)
      const verified = await rpc('runtimeVerified', { action: 'verifyRuntime', preparationId, id: prepared.id }, 300000)
      if (verified.id !== prepared.id || verified.preparationId !== preparationId || verified.scope !== prepared.scope || verified.productionReady !== false || verified.migrationComplete !== false
        || JSON.stringify(verified.receipt) !== JSON.stringify(receipt)) throw Error('原生运行 Data 决定与准备回执不匹配')
      await check()
      runtime = { preparationId, id: prepared.id, path: destination, receipt }
      return runtime
    }
    const runRuntime = async (ready: (profile: RuntimeProfile, signal: AbortSignal, lan?: OriginalLanReady) => Promise<void>, originalLan = false, retainForHandback?: () => void) => {
      if (mode !== 'runtime' || !runtime || runtimeLaunched) throw Error('当前会话没有可启动的隔离运行 Data')
      await check()
      runtimeLaunched = true
      originalLanRequested = originalLan
      const dialog = new AbortController()
      let operation: Promise<void> | undefined, checking = false
      const watch = setInterval(() => {
        if (checking || closing) return
        checking = true
        void check().catch(error => { fail(error); if (!originalLanRequested) child.kill() }).finally(() => { checking = false })
      }, 200)
      watch.unref()
      try {
        const started = await rpc('runtimeBrowserStarting', { action: 'launchRuntime', preparationId: runtime.preparationId, id: runtime.id, ...(originalLan ? { originalLan: true } : {}) }, 45000)
        const profile = started.profile
        if (started.productionReady !== false || started.migrationComplete !== false || started.businessServicesStarted !== false || !profile || !uuid.test(profile.ownershipId)
          || profile.origin !== 'http://tauri.localhost' || profile.path !== path.join(path.dirname(runtime.path), 'DustDesk-WebView2-' + profile.ownershipId)) throw Error('隔离运行浏览器没有匹配的原生绑定')
        await physical(profile.path, profile.identity); await check()
        if (retainForHandback) {
          const record: RuntimeHandbackFence = { format: 'dustdesk-runtime-handback-fence', version: 1, requestId, preparationId: runtime.preparationId, runtimeId: runtime.id,
            ownershipId: profile.ownershipId, installation, data: ownership.root, userData, workspaceSha256: fingerprint,
            runtimePath: runtime.path, runtimeIdentity: runtime.receipt.destinationIdentity, browser: profile }
          // Persist before any browser import or LAN admission. Even an abort
          // after this point must retain the original all-editor maintenance.
          await writeRuntimeHandbackFence(record); wholeFence = record
          retainForHandback()
        }
        const imported = await rpc('runtimeBrowserReady', { action: 'continueRuntime' }, 45000)
        if (imported.ownershipId !== profile.ownershipId || imported.productionReady !== false || imported.migrationComplete !== false || imported.businessServicesStarted !== false) throw Error('隔离运行导入完成回执不匹配')
        await check()
        let lan: OriginalLanReady | undefined
        if (originalLan) {
          const record: OriginalLanFence = { format: 'dustdesk-original-lan-preview-fence', version: 1, requestId, preparationId: runtime.preparationId, runtimeId: runtime.id, ownershipId: profile.ownershipId, installation, data: ownership.root, userData, workspaceSha256: fingerprint }
          if (!wholeFence) { await writeOriginalLanFence(record); fence = record }
          const startedLan = await rpc('runtimeOriginalLanReady', { action: 'startOriginalLan' }, 45000)
          if (startedLan.ownershipId !== profile.ownershipId || startedLan.productionReady !== false || startedLan.migrationComplete !== false
            || typeof startedLan.enabled !== 'boolean' || startedLan.businessServicesStarted !== startedLan.enabled || !Number.isInteger(startedLan.port)
            || (startedLan.enabled && (!startedLan.port || startedLan.port < 1 || startedLan.port > 65535 || !startedLan.deviceId || !hash.test(startedLan.fingerprint ?? '')))
            || (!startedLan.enabled && startedLan.port !== 0)) throw Error('原 LAN 服务没有匹配的原生启动确认')
          lan = { enabled: startedLan.enabled, port: startedLan.port!, deviceId: startedLan.deviceId, fingerprint: startedLan.fingerprint }
          await check()
        }
        operation = Promise.resolve().then(() => ready(profile, dialog.signal, lan))
        await Promise.race([operation, failure.then(error => { throw error })])
        await check()
        if (wholeFence) {
          const sealed = await rpc('runtimeHandbackSealed', { action: 'sealRuntime' }, 120000)
          if (!finalReading || sealed.productionReady !== false || sealed.migrationComplete !== false || sealed.businessServicesStarted !== false) throw Error('整体交还没有完成原生最终读取')
          const receipt = verifyRuntimeHandbackReceipt(wholeFence, sealed.receipt)
          await check()
          await close()
          if (child.exitCode !== 0 || child.signalCode !== null) throw Error('整体交还宿主未正常退出，保留启动屏障')
          return receipt
        }
      } finally {
        clearInterval(watch); dialog.abort()
        await close()
        await operation?.catch(() => {})
      }
    }
    const releaseOriginalLan = async (record: OriginalLanFence) => {
      if (mode !== 'runtime' || runtimeLaunched || record.data !== ownership.root || record.userData !== userData || record.installation !== installation || record.workspaceSha256 !== fingerprint) throw Error('原 LAN 恢复记录不属于当前实际来源')
      await check(); runtimeLaunched = true; releaseRecovery = true
      const released = await rpc('originalLanReleased', { action: 'releaseOriginalLan', preparationId: record.preparationId, runtimeId: record.runtimeId, ownershipId: record.ownershipId }, 120000)
      if (released.ownershipId !== record.ownershipId || released.productionReady !== false || released.migrationComplete !== false || released.businessServicesStarted !== false || !released.proof) throw Error('原 LAN 恢复缺少当前原生证明')
      await close()
      if (child.exitCode !== 0 || child.signalCode !== null) throw Error('原 LAN 恢复宿主没有正常退出，保留阻断记录')
      await clearOriginalLanFence(record, released.proof)
    }
    const recoverRuntimeHandback = async (record: RuntimeHandbackFence, expected?: RuntimeHandbackReceipt) => {
      if (mode !== 'runtime' || runtimeLaunched || record.data !== ownership.root || record.userData !== userData || record.installation !== installation || record.workspaceSha256 !== fingerprint) throw Error('整体交还记录不属于当前实际来源')
      await check()
      if (!isDeepStrictEqual(await readRuntimeHandbackFence(userData), record)) throw Error('整体交还屏障已改变')
      runtimeLaunched = true; releaseRecovery = true
      const recovered = await rpc('runtimeHandbackRecovered', { action: 'recoverRuntimeHandback', preparationId: record.preparationId, runtimeId: record.runtimeId, ownershipId: record.ownershipId }, 120000)
      if (recovered.productionReady !== false || recovered.migrationComplete !== false || recovered.businessServicesStarted !== false) throw Error('整体交还恢复错误地声明业务许可')
      const receipt = verifyRuntimeHandbackReceipt(record, recovered.receipt, expected)
      await check(); await physical(record.runtimePath, record.runtimeIdentity); await physical(record.browser.path, record.browser.identity)
      await close()
      if (child.exitCode !== 0 || child.signalCode !== null) throw Error('整体交还恢复宿主未正常退出，保留启动屏障')
      return receipt
    }
    return { entry: binding.browserEntry, binding, assertActive, confirm: async () => { if (runtimeLaunched) throw Error('运行所有权已转移，不能再发送来源确认'); await check(); await rpc('confirmed', { action: 'confirm' }); await check() }, close, prepare, prepareRuntime, runRuntime, releaseOriginalLan, recoverRuntimeHandback }
  } catch (error) { await close(); throw error }
}

export async function openLegacySourceLease(owner: BrowserWindow, installation: string, ownership: WorkspaceOwnership, fingerprint: string, context: DraftCollectionContext) {
  const source = await openLegacySource(owner, installation, ownership, fingerprint, context, 'lease')
  return { entry: source.entry, binding: source.binding, assertActive: source.assertActive, confirm: source.confirm, close: source.close }
}

export async function openLegacySourceSnapshot(owner: BrowserWindow, installation: string, ownership: WorkspaceOwnership, fingerprint: string, context: DraftCollectionContext) {
  return openLegacySource(owner, installation, ownership, fingerprint, context, 'snapshot')
}

export async function openLegacySourceRuntimePreview(owner: BrowserWindow, installation: string, ownership: WorkspaceOwnership, fingerprint: string, context: DraftCollectionContext) {
  return openLegacySource(owner, installation, ownership, fingerprint, context, 'runtime')
}
