export const draftMigrationFormat = 'dustdesk-browser-drafts'
export const draftMigrationReceiptsKey = 'dustdesk:draft-migration:receipts:v1'
export const draftMigrationJournalKey = 'dustdesk:draft-migration:pending:v1'
export const taskDraftStorageKey = 'widget-task-draft:v1:todo'
export const quickCaptureDraftStorageKey = 'quick-capture-draft'
export const selectedNoteStorageKey = 'widget-notes:selected'
export const noteDraftStorageKey = (owner: string, noteId: string) => 'widget-note:v2:' + encodeURIComponent(owner) + ':' + encodeURIComponent(noteId)
export const maxDraftArchiveBytes = 64 * 1024 * 1024
const maxEntries = 5000
const maxReceipts = 4096
type Runtime = 'electron' | 'tauri'
type DraftStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>
export type DraftEntry = { key: string; value: string }
export type DraftSource = { runtime: Runtime; appVersion: string; workspaceFingerprint: string }
export type DraftPayload = { id: string; createdAt: string; source: DraftSource; entries: DraftEntry[] }
export type DraftArchive = { format: typeof draftMigrationFormat; version: 1; payload: string; sha256: string }
type Receipt = { id: string; sha256: string }
type Journal = { id: string; sha256: string; writes: DraftEntry[] }
export type DraftImportResult = { alreadyImported: boolean; importedKeys: string[]; existingKeys: string[] }
export type DraftImportTransaction = { result: DraftImportResult; commit: () => DraftImportResult; rollback: () => void }
export type PreparedDraftImport = Readonly<{ id: string; sha256: string; workspaceFingerprint: string; stage: (storage: DraftStorage, isActive: () => boolean) => DraftImportTransaction }>
const activeImports = new WeakMap<object, symbol>()
type Key = { kind: 'note'; noteId: string; owner: string } | { kind: 'capture' | 'task' | 'selection' }

const fail = (): never => { throw Error('草稿迁移数据无效，未继续写入') }
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, fields: string[]) {
  if (Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) fail()
}
function text(value: unknown, maximum: number, required = false): asserts value is string {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.length)) fail()
}
function identifier(value: unknown): asserts value is string {
  text(value, 256, true)
  if (/[\u0000-\u001f\u007f]/.test(value)) fail()
}
const hashPattern = /^[a-f0-9]{64}$/
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !hashPattern.test(value)) fail()
}
function size(value: string) {
  if (value.length > maxDraftArchiveBytes || new TextEncoder().encode(value).length > maxDraftArchiveBytes) throw Error('草稿迁移包超过 64 MiB，未截断或导入')
}
function classify(key: string): Key | undefined {
  if (key === taskDraftStorageKey) return { kind: 'task' }
  if (key === quickCaptureDraftStorageKey) return { kind: 'capture' }
  if (key === selectedNoteStorageKey) return { kind: 'selection' }
  if (key.startsWith('widget-note:v2:')) {
    const parts = key.slice('widget-note:v2:'.length).split(':')
    if (parts.length !== 2) return fail()
    let owner: string; let noteId: string
    try { owner = decodeURIComponent(parts[0]!); noteId = decodeURIComponent(parts[1]!) } catch { return fail() }
    identifier(noteId)
    if ((owner !== 'notes' && owner !== 'note:' + noteId) || encodeURIComponent(owner) !== parts[0] || encodeURIComponent(noteId) !== parts[1]) return fail()
    return { kind: 'note', owner, noteId }
  }
  if (key.startsWith('widget-note:')) {
    if (/^widget-note:v\d+:/.test(key)) return fail()
    const noteId = key.slice('widget-note:'.length); identifier(noteId)
    return { kind: 'note', owner: 'legacy', noteId }
  }
  return undefined
}

export function validateDraftEntry(entry: unknown): DraftEntry {
  const object = record(entry); exact(object, ['key', 'value']); text(object.key, 2048, true); text(object.value, maxDraftArchiveBytes)
  const kind = classify(object.key)
  if (!kind) return fail()
  if (kind.kind === 'selection') { if (object.value !== '') identifier(object.value); return { key: object.key, value: object.value } }
  const value = record(JSON.parse(object.value))
  if (kind.kind === 'note') {
    if (value.saved === true) exact(value, ['saved'])
    else {
      exact(value, ['title', 'text', 'previousTitle', 'previousText'])
      text(value.title, 300); text(value.previousTitle, 300); text(value.text, 200000); text(value.previousText, 200000)
    }
  } else if (kind.kind === 'task') {
    exact(value, ['title', 'requestId']); text(value.title, 300); text(value.requestId, 128, true)
  } else {
    exact(value, Object.hasOwn(value, 'requestId') ? ['kind', 'title', 'text', 'requestId'] : ['kind', 'title', 'text'])
    if (value.kind !== 'note' && value.kind !== 'task') return fail()
    text(value.title, 300); text(value.text, 200000)
    if (Object.hasOwn(value, 'requestId')) text(value.requestId, 128, true)
  }
  return { key: object.key, value: object.value }
}

function validatePayload(value: unknown): DraftPayload {
  const payload = record(value); exact(payload, ['id', 'createdAt', 'source', 'entries']); identifier(payload.id); text(payload.createdAt, 40, true)
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(payload.createdAt) || !Number.isFinite(Date.parse(payload.createdAt)) || new Date(payload.createdAt).toISOString() !== payload.createdAt) return fail()
  const source = record(payload.source); exact(source, ['runtime', 'appVersion', 'workspaceFingerprint'])
  if (source.runtime !== 'electron' && source.runtime !== 'tauri') return fail()
  text(source.appVersion, 80, true); hash(source.workspaceFingerprint)
  if (!Array.isArray(payload.entries) || payload.entries.length > maxEntries) return fail()
  let bytes = 0
  const entries = payload.entries.map(entry => {
    const validated = validateDraftEntry(entry)
    bytes += new TextEncoder().encode(JSON.stringify(validated)).length
    if (bytes > maxDraftArchiveBytes) throw Error('草稿迁移包超过 64 MiB，未截断或导入')
    return validated
  })
  if (new Set(entries.map(entry => entry.key)).size !== entries.length) return fail()
  return { id: payload.id, createdAt: payload.createdAt, source: { runtime: source.runtime, appVersion: source.appVersion, workspaceFingerprint: source.workspaceFingerprint }, entries }
}

export async function draftDigest(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, '0')).join('')
}

export function collectDrafts(storage: Pick<Storage, 'length' | 'key' | 'getItem'>): DraftEntry[] {
  const entries: DraftEntry[] = []
  let bytes = 0
  const length = storage.length
  const keys = Array.from({ length }, (_, index) => storage.key(index))
  for (const key of keys) {
    if (key === null) throw Error('草稿在导出时发生变化，请暂停编辑后重试')
    if (!classify(key)) continue
    const value = storage.getItem(key)
    if (value === null) throw Error('草稿在导出时发生变化，请暂停编辑后重试')
    const entry = validateDraftEntry({ key, value })
    bytes += new TextEncoder().encode(JSON.stringify(entry)).length
    if (bytes > maxDraftArchiveBytes) throw Error('草稿迁移包超过 64 MiB，未截断或导入')
    entries.push(entry)
    if (entries.length > maxEntries) return fail()
  }
  if (storage.length !== length || keys.some((key, index) => storage.key(index) !== key) || entries.some(entry => storage.getItem(entry.key) !== entry.value)) throw Error('草稿在导出时发生变化，请暂停编辑后重试')
  return entries.sort((first, second) => first.key < second.key ? -1 : first.key > second.key ? 1 : 0)
}

export async function createDraftArchive(entries: DraftEntry[], source: DraftSource): Promise<string> {
  const payload = JSON.stringify(validatePayload({ id: crypto.randomUUID(), createdAt: new Date().toISOString(), source, entries }))
  const archive: DraftArchive = { format: draftMigrationFormat, version: 1, payload, sha256: await draftDigest(payload) }
  const serialized = JSON.stringify(archive); size(serialized)
  return serialized
}

export async function verifyDraftArchive(serialized: string): Promise<{ archive: DraftArchive; payload: DraftPayload }> {
  size(serialized)
  const archive = record(JSON.parse(serialized)); exact(archive, ['format', 'version', 'payload', 'sha256'])
  if (archive.format !== draftMigrationFormat || archive.version !== 1) return fail()
  text(archive.payload, maxDraftArchiveBytes); hash(archive.sha256)
  if (await draftDigest(archive.payload) !== archive.sha256) throw Error('草稿迁移包摘要不匹配，未导入')
  return { archive: { format: draftMigrationFormat, version: 1, payload: archive.payload, sha256: archive.sha256 }, payload: validatePayload(JSON.parse(archive.payload)) }
}

function receipts(storage: Pick<Storage, 'getItem'>): Receipt[] {
  const raw = storage.getItem(draftMigrationReceiptsKey)
  if (raw === null) return []
  size(raw)
  const parsed: unknown = JSON.parse(raw)
  if (!Array.isArray(parsed) || parsed.length > maxReceipts) return fail()
  const result = parsed.map(item => { const receipt = record(item); exact(receipt, ['id', 'sha256']); identifier(receipt.id); hash(receipt.sha256); return { id: receipt.id, sha256: receipt.sha256 } })
  if (new Set(result.map(item => item.id)).size !== result.length) return fail()
  return result
}

export function recoverDraftImport(storage: Pick<Storage, 'getItem' | 'removeItem'>) {
  activeImports.delete(storage)
  const raw = storage.getItem(draftMigrationJournalKey)
  if (raw === null) return
  size(raw)
  const journal = record(JSON.parse(raw)); exact(journal, ['id', 'sha256', 'writes']); identifier(journal.id); hash(journal.sha256)
  if (!Array.isArray(journal.writes) || journal.writes.length > maxEntries) return fail()
  const writes = journal.writes.map(validateDraftEntry)
  if (new Set(writes.map(item => item.key)).size !== writes.length) return fail()
  const committed = receipts(storage).find(item => item.id === journal.id)
  if (committed && committed.sha256 !== journal.sha256) return fail()
  if (!committed) for (const entry of writes) {
    const current = storage.getItem(entry.key)
    if (current === entry.value) storage.removeItem(entry.key)
  }
  storage.removeItem(draftMigrationJournalKey)
}

function existingAlias(entry: DraftEntry, destination: DraftEntry[]): boolean {
  const incoming = classify(entry.key)!
  return destination.some(saved => {
    if (saved.key === entry.key) return true
    const existing = classify(saved.key)!
    return incoming.kind === 'note' && existing.kind === 'note' && incoming.noteId === existing.noteId && (incoming.owner === 'legacy' || existing.owner === 'legacy')
  })
}

export async function prepareDraftImport(serialized: string, expectedWorkspaceFingerprint: string): Promise<PreparedDraftImport> {
  hash(expectedWorkspaceFingerprint)
  const { archive, payload } = await verifyDraftArchive(serialized)
  if (payload.source.workspaceFingerprint !== expectedWorkspaceFingerprint) throw Error('草稿来源工作区不匹配，未导入')
  return Object.freeze({
    id: payload.id,
    sha256: archive.sha256,
    workspaceFingerprint: payload.source.workspaceFingerprint,
    stage: (storage: DraftStorage, isActive: () => boolean) => stageDraftImport(storage, archive, payload, isActive),
  })
}

function stageDraftImport(storage: DraftStorage, archive: DraftArchive, payload: DraftPayload, isActive: () => boolean): DraftImportTransaction {
  const requireActive = () => { if (isActive() !== true) throw Error('草稿导入维护屏障已失效，未继续提交') }
  requireActive()
  if (activeImports.has(storage)) throw Error('已有草稿导入等待提交，未开启另一事务')
  recoverDraftImport(storage)
  const previousReceipts = storage.getItem(draftMigrationReceiptsKey)
  const previous = receipts(storage); const receipt = previous.find(item => item.id === payload.id)
  if (storage.getItem(draftMigrationReceiptsKey) !== previousReceipts) throw Error('草稿导入回执在准备期间发生变化')
  if (receipt) {
    if (receipt.sha256 !== archive.sha256) throw Error('同一迁移编号的内容已改变，未导入')
    const result = { alreadyImported: true, importedKeys: [], existingKeys: [] }
    return { result, commit: () => {
      requireActive()
      if (storage.getItem(draftMigrationReceiptsKey) !== previousReceipts || storage.getItem(draftMigrationJournalKey) !== null) throw Error('已导入草稿的回执或恢复状态发生变化')
      return result
    }, rollback: () => {} }
  }
  if (previous.length >= maxReceipts) throw Error('迁移记录已满，未丢弃历史记录或继续导入')
  const destination = collectDrafts(storage)
  const existingKeys = payload.entries.filter(entry => existingAlias(entry, destination)).map(entry => entry.key)
  const writes = payload.entries.filter(entry => !existingKeys.includes(entry.key))
  const writeKeys = new Set(writes.map(entry => entry.key))
  const journal: Journal = { id: payload.id, sha256: archive.sha256, writes }
  const encodedJournal = JSON.stringify(journal); size(encodedJournal)
  const token = Symbol('draft-import')
  let published = false
  const release = () => { if (activeImports.get(storage) === token) activeImports.delete(storage) }
  const requireCurrent = () => {
    requireActive()
    if (activeImports.get(storage) !== token) throw Error('草稿导入事务或恢复日志已改变，未继续提交')
  }
  const requireOwned = () => {
    requireCurrent()
    if (storage.getItem(draftMigrationJournalKey) !== encodedJournal) throw Error('草稿导入事务或恢复日志已改变，未继续提交')
    if (storage.getItem(draftMigrationReceiptsKey) !== previousReceipts) throw Error('草稿导入回执在等待提交期间发生变化')
  }
  const rollback = () => {
    if (activeImports.get(storage) !== token) throw Error('草稿导入事务已失效，未改动其他事务')
    try {
      if (storage.getItem(draftMigrationJournalKey) !== encodedJournal) throw Error('草稿导入恢复日志已改变，未改动其他事务')
      recoverDraftImport(storage)
    } finally { release() }
  }
  requireActive()
  if (activeImports.has(storage) || storage.getItem(draftMigrationJournalKey) !== null || storage.getItem(draftMigrationReceiptsKey) !== previousReceipts) throw Error('草稿导入准备期间出现另一事务，未开始写入')
  activeImports.set(storage, token)
  try {
    storage.setItem(draftMigrationJournalKey, encodedJournal)
    published = true
    for (const entry of writes) {
      requireCurrent()
      if (storage.getItem(entry.key) !== null) throw Error('导入期间出现新草稿，已停止')
      storage.setItem(entry.key, entry.value)
    }
    requireOwned()
  } catch (error) {
    try {
      if (published || storage.getItem(draftMigrationJournalKey) !== null) rollback()
    } catch { throw Error('草稿导入失败且回滚未完成；禁止切换运行时，请保留现有数据与恢复日志') }
    finally { release() }
    throw error
  }
  const result = { alreadyImported: false, importedKeys: writes.map(entry => entry.key), existingKeys }
  return {
    result,
    rollback,
    commit: () => {
      try {
        requireOwned()
        const current = collectDrafts(storage)
        const external = current.filter(saved => !writeKeys.has(saved.key))
        if (writes.some(entry => storage.getItem(entry.key) !== entry.value || existingAlias(entry, external))) throw Error('暂存草稿或兼容别名在等待提交期间发生变化')
        requireOwned()
        storage.setItem(draftMigrationReceiptsKey, JSON.stringify([...previous, { id: payload.id, sha256: archive.sha256 }]))
      } catch (error) {
        if (activeImports.get(storage) === token) {
          try { rollback() } catch { throw Error('草稿导入失败且回滚未完成；禁止切换运行时，请保留现有数据与恢复日志') }
        }
        throw error
      }
      try { storage.removeItem(draftMigrationJournalKey) }
      finally { release() }
      return result
    },
  }
}

export async function importDraftArchive(storage: DraftStorage, serialized: string, expectedWorkspaceFingerprint: string): Promise<DraftImportResult> {
  const prepared = await prepareDraftImport(serialized, expectedWorkspaceFingerprint)
  return prepared.stage(storage, () => true).commit()
}

export type NativeDraftDecision = { archiveId: string; payloadSha256: string | null; journalSha256: string; recoveryJournal?: string; completed?: boolean; decision: 'pending' | 'commit' | 'abort' }

export async function recoverNativeDraftImport(storage: DraftStorage, decision: NativeDraftDecision): Promise<void> {
  identifier(decision.archiveId); hash(decision.payloadSha256); hash(decision.journalSha256)
  if (decision.decision !== 'commit' && decision.decision !== 'abort') throw Error('原生草稿事务尚无恢复决定，未改动存储')
  const beforeReceipts = storage.getItem(draftMigrationReceiptsKey)
  const previous = receipts(storage); const receipt = previous.find(entry => entry.id === decision.archiveId)
  if (receipt && receipt.sha256 !== decision.payloadSha256) throw Error('浏览器回执与原生草稿决定不一致')
  if (receipt && decision.decision === 'abort') throw Error('浏览器完成回执与原生中止冲突，未删除草稿')
  const originalJournal = storage.getItem(draftMigrationJournalKey)
  const needsCopy = decision.completed !== true || (decision.decision === 'commit' && !receipt)
  const raw = originalJournal ?? (needsCopy ? decision.recoveryJournal ?? null : null)
  if (raw === null) {
    if (decision.decision === 'commit' && !receipt) throw Error('原生草稿提交缺少日志或完成回执')
    activeImports.delete(storage)
    return
  }
  size(raw)
  if (await draftDigest(raw) !== decision.journalSha256) throw Error('真实草稿暂存日志与原生决定不匹配')
  const journal = record(JSON.parse(raw)); exact(journal, ['id', 'sha256', 'writes'])
  if (journal.id !== decision.archiveId || journal.sha256 !== decision.payloadSha256 || !Array.isArray(journal.writes) || journal.writes.length > maxEntries) return fail()
  const writes = journal.writes.map(validateDraftEntry)
  if (new Set(writes.map(entry => entry.key)).size !== writes.length) return fail()
  if (storage.getItem(draftMigrationJournalKey) !== originalJournal || storage.getItem(draftMigrationReceiptsKey) !== beforeReceipts) throw Error('浏览器草稿恢复状态在校验期间发生变化')
  if (originalJournal === null) {
    if (decision.decision === 'commit') {
      const writeKeys = new Set(writes.map(entry => entry.key)); const external = collectDrafts(storage).filter(entry => !writeKeys.has(entry.key))
      if (writes.some(entry => (storage.getItem(entry.key) !== null && storage.getItem(entry.key) !== entry.value) || existingAlias(entry, external))) throw Error('原生持久草稿与目标新内容冲突，未覆盖')
    }
    storage.setItem(draftMigrationJournalKey, raw)
  }
  if (decision.decision === 'abort') { recoverDraftImport(storage); return }
  if (!receipt || decision.completed !== true) {
    if (!receipt && previous.length >= maxReceipts) throw Error('草稿迁移记录已满，未丢弃历史回执')
    const writeKeys = new Set(writes.map(entry => entry.key)); const external = collectDrafts(storage).filter(entry => !writeKeys.has(entry.key))
    if (writes.some(entry => (storage.getItem(entry.key) !== null && storage.getItem(entry.key) !== entry.value) || existingAlias(entry, external))) throw Error('原生提交对应的暂存草稿已改变，保留日志等待受控恢复')
    for (const entry of writes) if (storage.getItem(entry.key) === null) storage.setItem(entry.key, entry.value)
    if (!receipt) storage.setItem(draftMigrationReceiptsKey, JSON.stringify([...previous, { id: decision.archiveId, sha256: decision.payloadSha256 }]))
  }
  storage.removeItem(draftMigrationJournalKey)
  activeImports.delete(storage)
}
