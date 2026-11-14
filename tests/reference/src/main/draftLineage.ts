import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { verifyDraftArchive } from '../shared/draftMigration'
import type { WorkspaceOwnership } from './workspaceOwnership'

const maximumBytes = 8 * 1024 * 1024
const maximumExports = 4096
type Export = { archiveId: string; archiveSha256: string; payloadSha256: string; workspaceFingerprint: string; runtime: 'electron' | 'tauri'; appVersion: string; createdAt: string }
type Lineage = { format: 'dustdesk-draft-lineage'; version: 1; workspaceId: string; root: { volume: string; file: string }; exports: Export[] }
export type DraftProvenance = { workspaceId: string; archiveId: string; archiveSha256: string; workspaceFingerprint: string; sourceRuntime: 'electron' | 'tauri' }
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hash = /^[a-f0-9]{64}$/
const identity = /^[a-f0-9]{16}$/
const writes = new WeakMap<WorkspaceOwnership, Promise<unknown>>()
const fail = (): never => { throw Error('原生草稿谱系回执无效或不属于当前工作区，未授权迁移') }
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const result = value as Record<string, unknown>
  if (Object.keys(result).length !== fields.length || fields.some(field => !Object.hasOwn(result, field))) return fail()
  return result
}
function checkedExport(value: unknown): Export {
  const entry = record(value, ['archiveId', 'archiveSha256', 'payloadSha256', 'workspaceFingerprint', 'runtime', 'appVersion', 'createdAt'])
  if (typeof entry.archiveId !== 'string' || !uuid.test(entry.archiveId)) return fail()
  for (const name of ['archiveSha256', 'payloadSha256', 'workspaceFingerprint']) if (typeof entry[name] !== 'string' || !hash.test(entry[name])) return fail()
  if (entry.runtime !== 'electron' && entry.runtime !== 'tauri') return fail()
  if (typeof entry.appVersion !== 'string' || !entry.appVersion.length || entry.appVersion.length > 128 || /[\u0000-\u001f\u007f]/.test(entry.appVersion)) return fail()
  if (typeof entry.createdAt !== 'string' || entry.createdAt.length > 64 || !Number.isFinite(Date.parse(entry.createdAt)) || new Date(entry.createdAt).toISOString() !== entry.createdAt) return fail()
  return { archiveId: entry.archiveId, archiveSha256: entry.archiveSha256 as string, payloadSha256: entry.payloadSha256 as string, workspaceFingerprint: entry.workspaceFingerprint as string, runtime: entry.runtime, appVersion: entry.appVersion, createdAt: entry.createdAt }
}
function checkedLineage(value: unknown, ownership: WorkspaceOwnership): Lineage {
  const ledger = record(value, ['format', 'version', 'workspaceId', 'root', 'exports'])
  const location = record(ledger.root, ['volume', 'file'])
  if (ledger.format !== 'dustdesk-draft-lineage' || ledger.version !== 1 || typeof ledger.workspaceId !== 'string' || !uuid.test(ledger.workspaceId)) return fail()
  for (const name of ['volume', 'file'] as const) if (typeof location[name] !== 'string' || !identity.test(location[name]) || location[name] !== ownership.identity[name]) return fail()
  if (!Array.isArray(ledger.exports) || ledger.exports.length > maximumExports) return fail()
  const exports = ledger.exports.map(checkedExport)
  if (new Set(exports.map(entry => entry.archiveId)).size !== exports.length) return fail()
  return { format: 'dustdesk-draft-lineage', version: 1, workspaceId: ledger.workspaceId, root: { ...ownership.identity }, exports }
}
async function checkPath(location: string) {
  for (let current = location; ; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error('草稿谱系路径含链接，未授权迁移') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) return
  }
}
async function readLedger(ownership: WorkspaceOwnership): Promise<Lineage | undefined> {
  await ownership.assertHeld()
  const location = path.join(ownership.root, 'MigrationLineage', 'lineage.json')
  await checkPath(location)
  const handle = await fs.open(location, 'r').catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; return undefined })
  if (!handle) return undefined
  try {
    const metadata = await handle.stat({ bigint: true }); const current = await fs.lstat(location, { bigint: true })
    if (!metadata.isFile() || metadata.nlink !== 1n || metadata.size > BigInt(maximumBytes) || current.isSymbolicLink() || current.dev !== metadata.dev || current.ino !== metadata.ino) return fail()
    const bytes = Buffer.alloc(maximumBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length)
      if (!read.bytesRead) break
      length += read.bytesRead
    }
    if (length > maximumBytes) return fail()
    await ownership.assertHeld()
    return checkedLineage(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))), ownership)
  } finally { await handle.close() }
}
async function exportReceipt(serialized: string, nativeFingerprint: string): Promise<Export> {
  const { archive, payload } = await verifyDraftArchive(serialized)
  if (!hash.test(nativeFingerprint) || payload.source.workspaceFingerprint !== nativeFingerprint) return fail()
  return checkedExport({ archiveId: payload.id, archiveSha256: digest(serialized), payloadSha256: archive.sha256, workspaceFingerprint: nativeFingerprint, runtime: payload.source.runtime, appVersion: payload.source.appVersion, createdAt: payload.createdAt })
}
function provenance(ledger: Lineage, entry: Export): DraftProvenance {
  return { workspaceId: ledger.workspaceId, archiveId: entry.archiveId, archiveSha256: entry.archiveSha256, workspaceFingerprint: entry.workspaceFingerprint, sourceRuntime: entry.runtime }
}
export function recordDraftProvenance(ownership: WorkspaceOwnership, serialized: string, nativeFingerprint: string): Promise<DraftProvenance> {
  const operation = (writes.get(ownership) ?? Promise.resolve()).catch(() => {}).then(() => recordExport(ownership, serialized, nativeFingerprint))
  writes.set(ownership, operation)
  return operation
}
async function recordExport(ownership: WorkspaceOwnership, serialized: string, nativeFingerprint: string): Promise<DraftProvenance> {
  const receipt = await exportReceipt(serialized, nativeFingerprint)
  const previous = await readLedger(ownership)
  const ledger: Lineage = previous ? { ...previous, exports: [...previous.exports] } : { format: 'dustdesk-draft-lineage', version: 1, workspaceId: randomUUID(), root: { ...ownership.identity }, exports: [] }
  const existing = ledger.exports.find(entry => entry.archiveId === receipt.archiveId)
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(receipt)) return fail()
    return provenance(ledger, existing)
  }
  if (ledger.exports.length >= maximumExports) throw Error('原生草稿谱系回执已达 4096 条上限，未清理历史或继续导出')
  ledger.exports.push(receipt)
  const directory = path.join(ownership.root, 'MigrationLineage'); const location = path.join(directory, 'lineage.json')
  await checkPath(directory); await fs.mkdir(directory, { recursive: true }); await checkPath(location)
  const temporary = path.join(directory, '.lineage-' + randomUUID() + '.tmp')
  try {
    const handle = await fs.open(temporary, 'wx')
    try { await handle.writeFile(JSON.stringify(ledger), 'utf8'); await handle.sync() } finally { await handle.close() }
    await ownership.assertHeld()
    const current = await readLedger(ownership)
    if (JSON.stringify(current) !== JSON.stringify(previous)) throw Error('原生草稿谱系在记录时发生变化，未覆盖')
    await checkPath(location)
    if (previous) await fs.rename(temporary, location)
    else { await fs.link(temporary, location); await fs.unlink(temporary) }
  } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
  return provenance(ledger, receipt)
}
export async function verifyDraftProvenance(ownership: WorkspaceOwnership, serialized: string, nativeFingerprint: string): Promise<DraftProvenance> {
  const receipt = await exportReceipt(serialized, nativeFingerprint)
  const ledger = await readLedger(ownership)
  const entry = ledger?.exports.find(entry => entry.archiveId === receipt.archiveId)
  if (!ledger || !entry || JSON.stringify(entry) !== JSON.stringify(receipt)) return fail()
  return provenance(ledger, entry)
}
