// Native-only Electron reverse-import persistence. Browser snapshots must be
// read by the controlled native page; none of these methods is renderer IPC.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateDraftEntry, verifyDraftArchive, prepareDraftImport, draftMigrationReceiptsKey, draftMigrationJournalKey, type NativeDraftDecision } from '../shared/draftMigration'
import { verifyDraftProvenance } from './draftLineage'
import type { WorkspaceOwnership } from './workspaceOwnership'

export const electronDraftTransactionFile = 'ElectronMigrationTransaction.json'
const maximumRecordBytes = 16 * 1024 * 1024, maximumJournalBytes = 64 * 1024 * 1024
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hash = /^[a-f0-9]{64}$/
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
type Decision = 'pending' | 'commit' | 'abort'
type RecordFile = {
  version: 1; format: string; root: WorkspaceOwnership['identity']; transactionId: string; requestId: string
  workspaceId: string; archiveId: string; archiveSha256: string; workspaceFingerprint: string; journalSha256: string
  browserBinding: string; payloadSha256: string; writes: { key: string; sha256: string }[]; completed: boolean; decision: Decision
}
export type DraftBrowserSnapshot = { journal: string | null; receipts: string | null; values: Record<string, string | null> }
type ReadRecord = { record: RecordFile; bytes: Buffer }
const invalid = (): never => { throw Error('原生 Electron 草稿事务无效，已保留数据并禁止继续编辑或迁移') }
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field))) return invalid()
  return result
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) invalid()
}
async function checkPath(location: string) {
  for (let current = location; ; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('草稿事务路径包含链接或重解析点') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) return
  }
}
async function readBounded(location: string, maximum: number): Promise<Buffer | undefined> {
  await checkPath(location)
  const handle = await fs.open(location, 'r').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (!handle) return undefined
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximum)) return invalid()
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < buffer.length) { const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length); if (!bytesRead) break; length += bytesRead }
    const after = await handle.stat({ bigint: true }); await checkPath(location)
    const current = await fs.lstat(location, { bigint: true })
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) return invalid()
    return buffer.subarray(0, length)
  } catch (error) { throw Error('读取原生草稿文件失败（' + location + '）：' + String(error)) }
  finally { await handle.close() }
}
function parseRecord(bytes: Buffer, ownership: WorkspaceOwnership, format: string): RecordFile {
  const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), ['version','format','root','transactionId','requestId','workspaceId','archiveId','archiveSha256','workspaceFingerprint','journalSha256','browserBinding','payloadSha256','writes','completed','decision'])
  const root = object(value.root, ['volume','file'])
  if (value.version !== 1 || value.format !== format || root.volume !== ownership.identity.volume || root.file !== ownership.identity.file) return invalid()
  for (const key of ['transactionId','requestId','workspaceId','archiveId']) if (typeof value[key] !== 'string' || !uuid.test(value[key])) return invalid()
  for (const key of ['archiveSha256','workspaceFingerprint','journalSha256','browserBinding','payloadSha256']) if (typeof value[key] !== 'string' || !hash.test(value[key])) return invalid()
  if (typeof value.completed !== 'boolean' || !['pending','commit','abort'].includes(String(value.decision)) || (value.completed && value.decision === 'pending') || !Array.isArray(value.writes) || value.writes.length > 5000) return invalid()
  const writes = value.writes.map(item => { const entry = object(item, ['key','sha256']); if (typeof entry.key !== 'string' || !entry.key.length || entry.key.length > 2048 || typeof entry.sha256 !== 'string' || !hash.test(entry.sha256)) return invalid(); return { key: entry.key, sha256: entry.sha256 } })
  if (new Set(writes.map(entry => entry.key)).size !== writes.length) return invalid()
  return { ...value, root: { ...ownership.identity }, writes } as RecordFile
}
function browserReceipts(raw: string | null): { id: string; sha256: string }[] {
  if (raw === null) return []
  if (Buffer.byteLength(raw) > maximumJournalBytes) return invalid()
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length > 4096) return invalid()
  const entries = parsed.map(item => { const entry = object(item, ['id','sha256']); identifier(entry.id); if (typeof entry.sha256 !== 'string' || !hash.test(entry.sha256)) return invalid(); return { id: entry.id, sha256: entry.sha256 } })
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) return invalid()
  return entries
}
function checkJournal(raw: string, archiveId: string, payloadSha256: string) {
  if (Buffer.byteLength(raw) > maximumJournalBytes) return invalid()
  const journal = object(JSON.parse(raw), ['id','sha256','writes'])
  if (journal.id !== archiveId || journal.sha256 !== payloadSha256 || !Array.isArray(journal.writes) || journal.writes.length > 5000) return invalid()
  const entries = journal.writes.map(validateDraftEntry)
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) return invalid()
  return entries
}

export function createElectronDraftTransactions(ownership: WorkspaceOwnership) {
  const location = path.join(ownership.root, electronDraftTransactionFile)
  let tail: Promise<unknown> = Promise.resolve(), verifiedGeneration: string | undefined
  const queue = <T,>(operation: () => Promise<T>) => { const result = tail.catch(() => {}).then(operation); tail = result; return result }
  const queueSnapshot = <T,>(snapshot: DraftBrowserSnapshot, operation: (observed: DraftBrowserSnapshot) => Promise<T>) => {
    const observed = structuredClone(snapshot)
    return queue(() => operation(observed))
  }
  async function read(): Promise<ReadRecord | undefined> {
    await ownership.assertHeld()
    const bytes = await readBounded(location, maximumRecordBytes)
    await ownership.assertHeld()
    return bytes ? { bytes, record: parseRecord(bytes, ownership, 'dustdesk-electron-draft-transaction') } : undefined
  }
  async function requirePeerCompleted() {
    await ownership.assertHeld()
    const bytes = await readBounded(path.join(ownership.root, 'MigrationTransaction.json'), maximumRecordBytes)
    if (bytes && !parseRecord(bytes, ownership, 'dustdesk-draft-transaction').completed) throw Error('存在尚未完成的 Tauri 草稿事务，请先回到 Tauri 受控恢复；未打开 Electron 编辑器')
    await ownership.assertHeld()
  }
  async function fingerprint() {
    const bytes = await readBounded(path.join(ownership.root, 'workspace.json'), maximumJournalBytes)
    if (!bytes) throw Error('原生工作区检查点文件缺失，未使用备份或创建默认数据')
    return digest(bytes)
  }
  async function atomic(target: string, bytes: Buffer, previous: Buffer | undefined, active: () => void | Promise<void>) {
    const maximum = target === location ? maximumRecordBytes : maximumJournalBytes
    if (bytes.length > maximum) return invalid()
    await ownership.assertHeld(); await active(); await checkPath(target)
    const directory = path.dirname(target); await fs.mkdir(directory, { recursive: true }); await checkPath(directory)
    const temporary = path.join(directory, '.electron-draft-' + randomUUID() + '.tmp')
    try {
      const handle = await fs.open(temporary, 'wx')
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      await ownership.assertHeld(); await checkPath(target)
      const current = await readBounded(target, maximum)
      if (current?.toString('hex') !== previous?.toString('hex')) throw Error('原生草稿记录在写入前发生变化，未覆盖')
      await active()
      if (previous) await fs.rename(temporary, target)
      else { await fs.link(temporary, target); await fs.unlink(temporary) }
    } catch (error) { throw Error('持久化原生草稿文件失败（' + target + '）：' + String(error)) }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  }
  const journalPath = (record: RecordFile) => path.join(ownership.root, 'ElectronMigrationJournals', record.transactionId + '.json')
  async function journal(record: RecordFile) {
    const bytes = await readBounded(journalPath(record), maximumJournalBytes)
    if (!bytes || digest(bytes) !== record.journalSha256) throw Error('原生持久草稿副本缺失或摘要不匹配')
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    const entries = checkJournal(raw, record.archiveId, record.payloadSha256)
    if (JSON.stringify(entries.map(entry => ({ key: entry.key, sha256: digest(entry.value) }))) !== JSON.stringify(record.writes)) return invalid()
    return raw
  }
  function checkBinding(record: RecordFile, binding: string) {
    if (record.browserBinding !== binding || !hash.test(binding)) throw Error('实际 Electron 浏览器配置与原生草稿事务不匹配')
  }
  const generation = (record: RecordFile) => digest(JSON.stringify(record))
  const publish = (record: RecordFile, previous: ReadRecord | undefined, active: () => void | Promise<void>) => atomic(location, Buffer.from(JSON.stringify(record)), previous?.bytes, active)
  return {
    read: async () => (await read())?.record,
    requirePeerCompleted,
    begin: (requestId: string, serialized: string, nativeFingerprint: string, binding: string, snapshot: DraftBrowserSnapshot, assertActive: () => void) => queueSnapshot(snapshot, async snapshot => {
      assertActive(); await requirePeerCompleted()
      if (!uuid.test(requestId) || !hash.test(nativeFingerprint) || !hash.test(binding) || snapshot.journal !== null) return invalid()
      const previous = await read()
      if (previous && (!previous.record.completed || verifiedGeneration !== generation(previous.record))) throw Error('前次 Electron 草稿事务尚未由实际浏览器完成恢复')
      if (await fingerprint() !== nativeFingerprint) throw Error('工作区已偏离原生维护检查点，未暂存原生决定')
      const provenance = await verifyDraftProvenance(ownership, serialized, nativeFingerprint)
      const { archive, payload } = await verifyDraftArchive(serialized)
      browserReceipts(snapshot.receipts)
      // Plan on an isolated native shadow of the observed target. Persist the
      // write-ahead record BEFORE the real browser is allowed to stage anything.
      const values = new Map<string, string>()
      for (const [key, value] of Object.entries(snapshot.values)) if (value !== null) { validateDraftEntry({ key, value }); values.set(key, value) }
      if (snapshot.receipts !== null) values.set(draftMigrationReceiptsKey, snapshot.receipts)
      const shadow = { get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
      const prepared = await prepareDraftImport(serialized, nativeFingerprint)
      const staged = prepared.stage(shadow, () => { assertActive(); return true })
      if (staged.result.alreadyImported) { staged.commit(); return { result: staged.result, record: undefined } }
      const raw = values.get(draftMigrationJournalKey); if (raw === undefined) return invalid()
      const entries = checkJournal(raw, payload.id, archive.sha256)
      const journalDirectory = path.join(ownership.root, 'ElectronMigrationJournals')
      await checkPath(journalDirectory)
      let count = 0
      const directory = await fs.opendir(journalDirectory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
      if (directory) for await (const _entry of directory) { if (++count >= 4096) throw Error('原生草稿副本历史已满，未删除历史或继续导入') }
      const record: RecordFile = { version: 1, format: 'dustdesk-electron-draft-transaction', root: { ...ownership.identity }, transactionId: randomUUID(), requestId, workspaceId: provenance.workspaceId, archiveId: payload.id, archiveSha256: digest(serialized), workspaceFingerprint: nativeFingerprint, journalSha256: digest(raw), browserBinding: binding, payloadSha256: archive.sha256, writes: entries.map(entry => ({ key: entry.key, sha256: digest(entry.value) })), completed: false, decision: 'pending' }
      await atomic(journalPath(record), Buffer.from(raw), undefined, assertActive)
      await publish(record, previous, async () => { assertActive(); if (await fingerprint() !== nativeFingerprint) throw Error('工作区在持久化前变化，未发布草稿事务'); assertActive() })
      verifiedGeneration = undefined
      return { result: staged.result, record: structuredClone(record) }
    }),
    decide: (requestId: string, transactionId: string, commit: boolean, binding: string, snapshot: DraftBrowserSnapshot, assertActive: () => void) => queueSnapshot(snapshot, async snapshot => {
      await requirePeerCompleted()
      const previous = await read(); if (!previous) return invalid()
      const record = previous.record
      if (record.requestId !== requestId || record.transactionId !== transactionId) throw Error('草稿决定不属于当前原生维护请求')
      checkBinding(record, binding)
      if (record.decision !== 'pending') return structuredClone(record)
      let active = true; try { assertActive() } catch { active = false }
      const next = { ...record, decision: 'abort' as Decision }
      if (commit && active) {
        await journal(record)
        if (snapshot.journal === null || digest(snapshot.journal) !== record.journalSha256 || browserReceipts(snapshot.receipts).some(entry => entry.id === record.archiveId) || record.writes.some(entry => typeof snapshot.values[entry.key] !== 'string' || digest(snapshot.values[entry.key]!) !== entry.sha256)) throw Error('实际浏览器尚未暂存完整的原生草稿计划，未提交')
        if (await fingerprint() !== record.workspaceFingerprint) throw Error('提交前原生工作区已变化，保留 pending 决定')
        next.decision = 'commit'
      }
      await publish(next, previous, async () => { if (next.decision === 'commit') { assertActive(); if (await fingerprint() !== record.workspaceFingerprint) throw Error('提交前原生工作区已变化'); assertActive() } })
      return structuredClone(next)
    }),
    recover: (binding: string, before: DraftBrowserSnapshot) => queueSnapshot(before, async before => {
      await requirePeerCompleted()
      let previous = await read()
      if (!previous) { if (before.journal !== null) throw Error('存在没有原生决定的浏览器草稿日志，未打开编辑器'); return undefined }
      checkBinding(previous.record, binding)
      const receipt = browserReceipts(before.receipts).find(entry => entry.id === previous!.record.archiveId)
      if (receipt && receipt.sha256 !== previous.record.payloadSha256) return invalid()
      const raw = await journal(previous.record)
      if (before.journal !== null && digest(before.journal) !== previous.record.journalSha256) throw Error('实际浏览器草稿日志与原生副本不匹配')
      if (previous.record.decision === 'pending') {
        if (receipt) throw Error('浏览器完成回执与原生 pending 决定冲突')
        const next = { ...previous.record, decision: 'abort' as const }
        await publish(next, previous, () => {})
        previous = { record: next, bytes: Buffer.from(JSON.stringify(next)) }
      }
      const record = previous.record
      if (record.writes.some(entry => !Object.hasOwn(before.values, entry.key) || (before.values[entry.key] !== null && typeof before.values[entry.key] !== 'string'))) throw Error('未观察全部原生计划键的真实浏览器值')
      if (record.decision === 'abort' && receipt) throw Error('浏览器完成回执与原生中止决定冲突')
      const consumed = record.completed && before.journal === null && (record.decision === 'abort' || receipt !== undefined)
      if (!consumed && record.decision === 'commit' && record.writes.some(entry => Object.hasOwn(before.values, entry.key) && before.values[entry.key] !== null && digest(before.values[entry.key]!) !== entry.sha256)) throw Error('原生提交对应的浏览器草稿已改变，保留数据等待恢复')
      const decision: NativeDraftDecision = { archiveId: record.archiveId, payloadSha256: record.payloadSha256, journalSha256: record.journalSha256, recoveryJournal: raw, completed: record.completed, decision: record.decision }
      return Object.freeze({
        decision: Object.freeze(decision),
        complete: (after: DraftBrowserSnapshot) => queueSnapshot(after, async after => {
          checkBinding(record, binding)
          const current = await read()
          if (!current || (!current.bytes.equals(previous!.bytes) && generation(current.record) !== generation({ ...record, completed: true }))) throw Error('原生草稿决定在结果复核时变化')
          if (after.journal !== null) throw Error('浏览器草稿恢复日志尚未清理')
          const saved = browserReceipts(after.receipts).find(entry => entry.id === record.archiveId)
          if (record.decision === 'commit') {
            if (saved?.sha256 !== record.payloadSha256) throw Error('实际浏览器缺少匹配的完成回执')
            if (!consumed && record.writes.some(entry => typeof after.values[entry.key] !== 'string' || digest(after.values[entry.key]!) !== entry.sha256)) throw Error('实际浏览器尚未保留原生提交的草稿')
          } else if (saved || (!consumed && record.writes.some(entry => !Object.hasOwn(after.values, entry.key) || (typeof after.values[entry.key] === 'string' && digest(after.values[entry.key]!) === entry.sha256)))) throw Error('原生中止尚未完成实际浏览器回滚')
          const completed = { ...record, completed: true }
          if (!current.record.completed) await publish(completed, current, () => {})
          verifiedGeneration = generation(completed)
          return structuredClone(completed)
        })
      })
    })
  }
}
