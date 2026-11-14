// Restart admission barrier only. Native retained ownership, not this JSON,
// authenticates the latest Data/profile checkpoint. No application/unblock API.
import { lstatSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

export type RuntimeIdentity = { volume: number; index: string }
export type RuntimeBrowser = { ownershipId: string; path: string; identity: RuntimeIdentity; origin: string }
export type RuntimeHandbackFence = {
  format: 'dustdesk-runtime-handback-fence'; version: 1
  requestId: string; preparationId: string; runtimeId: string; ownershipId: string
  installation: string; data: string; userData: string; workspaceSha256: string
  runtimePath: string; runtimeIdentity: RuntimeIdentity; browser: RuntimeBrowser
}
export type RuntimeHandbackReceipt = {
  ownershipId: string; intentSha256: string; dataManifestSha256: string; workspaceSha256: string
  browser: RuntimeBrowser
  drafts: { archiveSha256: string; archiveBytes: number; payloadSha256: string; archiveId: string; entries: number; browserBinding: string }
  lan: { checkpoint: unknown; handbackIntentSha256: string | null }
  productionReady: false; migrationComplete: false
}
const name = 'RuntimeHandbackPreview.json'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hash = /^[0-9a-f]{64}$/
const blocked = '整体运行交还尚未应用，编辑器和后台服务保持停止；请核验整体交还并保留记录'
const invalid = (): never => { throw Error('整体运行交还屏障或回执无效，保留暂停状态') }
const identity = (value: RuntimeIdentity) => value && Number.isSafeInteger(value.volume) && value.volume >= 0 && /^[0-9a-f]{16}$/.test(value.index)

export function requireRuntimeHandbackReleased(profile: string) {
  try { lstatSync(path.join(profile, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw Error(blocked)
}
export async function assertRuntimeHandbackReleased(profile: string) {
  try { await fs.lstat(path.join(profile, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw Error(blocked)
}
async function ordinaryPath(file: string) {
  for (let current = file; ; current = path.dirname(current)) {
    try { if ((await fs.lstat(current)).isSymbolicLink()) return invalid() }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (path.dirname(current) === current) return
  }
}
function validate(value: RuntimeHandbackFence, profile: string) {
  const keys = ['format','version','requestId','preparationId','runtimeId','ownershipId','installation','data','userData','workspaceSha256','runtimePath','runtimeIdentity','browser']
  if (!value || Object.keys(value).sort().join() !== keys.sort().join() || value.format !== 'dustdesk-runtime-handback-fence' || value.version !== 1
    || ![value.requestId,value.preparationId,value.runtimeId,value.ownershipId].every(id => typeof id === 'string' && uuid.test(id))
    || ![value.installation,value.data,value.userData,value.runtimePath].every(file => typeof file === 'string' && path.isAbsolute(file) && path.resolve(file) === file)
    || value.userData !== profile || !hash.test(value.workspaceSha256) || !identity(value.runtimeIdentity)
    || !value.browser || value.browser.ownershipId !== value.ownershipId || value.browser.origin !== 'http://tauri.localhost' || !identity(value.browser.identity)
    || value.browser.path !== path.join(path.dirname(value.runtimePath), 'DustDesk-WebView2-' + value.ownershipId)
    || path.dirname(value.data) !== path.dirname(profile) || path.dirname(value.runtimePath) !== path.dirname(profile)
    || value.data === value.runtimePath || value.data === profile || value.runtimePath === profile) return invalid()
  return value
}
export async function readRuntimeHandbackFence(profile: string): Promise<RuntimeHandbackFence> {
  const file = path.join(profile, name)
  await ordinaryPath(file)
  const handle = await fs.open(file, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > 65536n) return invalid()
    const bytes = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, length); if (!result.bytesRead) break; length += result.bytesRead }
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true })
    await ordinaryPath(file)
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || after.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino) return invalid()
    return validate(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))), profile)
  } finally { await handle.close() }
}
export async function writeRuntimeHandbackFence(value: RuntimeHandbackFence) {
  validate(value, value.userData)
  const file = path.join(value.userData, name), temporary = file + '-' + randomUUID() + '.tmp'
  await ordinaryPath(file)
  const handle = await fs.open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close()
    await ordinaryPath(file)
    await fs.link(temporary, file)
  } finally { await handle.close(); await fs.unlink(temporary).catch(() => {}) }
}
export function verifyRuntimeHandbackReceipt(fence: RuntimeHandbackFence, value: unknown, expected?: RuntimeHandbackReceipt): RuntimeHandbackReceipt {
  const receipt = value as RuntimeHandbackReceipt
  if (!receipt || receipt.ownershipId !== fence.ownershipId || receipt.productionReady !== false || receipt.migrationComplete !== false
    || ![receipt.intentSha256,receipt.dataManifestSha256,receipt.workspaceSha256].every(value => typeof value === 'string' && hash.test(value))
    || !isDeepStrictEqual(receipt.browser, fence.browser) || !receipt.drafts || !uuid.test(receipt.drafts.archiveId)
    || ![receipt.drafts.archiveSha256,receipt.drafts.payloadSha256,receipt.drafts.browserBinding].every(value => typeof value === 'string' && hash.test(value))
    || !Number.isSafeInteger(receipt.drafts.archiveBytes) || receipt.drafts.archiveBytes < 1 || receipt.drafts.archiveBytes > 64 * 1024 * 1024
    || !Number.isSafeInteger(receipt.drafts.entries) || receipt.drafts.entries < 0 || receipt.drafts.entries > 5000
    || !receipt.lan?.checkpoint || !(receipt.lan.handbackIntentSha256 === null || hash.test(receipt.lan.handbackIntentSha256))
    || (expected && !isDeepStrictEqual(receipt, expected))) return invalid()
  return receipt
}
