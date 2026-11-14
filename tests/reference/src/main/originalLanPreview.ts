import { lstatSync, promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

type Identity = { volume: number; index: string }
type FileProof = { stamp: { identity: Identity; size: number }; sha256: string }
type Checkpoint = { format: string; version: number; appProfile: Identity; lanProfile: Identity | null; state: FileProof | null; originalIdentity: { file: FileProof } | null }
export type OriginalLanProof = { kind: 'notStarted' | 'handback'; checkpoint: Checkpoint; receipt?: { ownershipId: string; intentSha256: string; compatibleRuntime: string; productionReady: boolean; migrationComplete: boolean; checkpoint: Checkpoint } }
export type OriginalLanFence = { format: 'dustdesk-original-lan-preview-fence'; version: 1; requestId: string; preparationId: string; runtimeId: string; ownershipId: string; installation: string; data: string; userData: string; workspaceSha256: string }
const name = 'OriginalLanPreview.json'
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const hash = /^[0-9a-f]{64}$/
const blocked = '原 LAN 尚未完成原生交还，请使用“恢复原 LAN 交还（开发临时数据）”核验；不会自动重新启动服务'
export function requireOriginalLanReleased(profile: string) {
  try { lstatSync(path.join(profile, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw Error(blocked)
}
export async function assertOriginalLanReleased(profile: string) {
  try { await fs.lstat(path.join(profile, name)) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  throw Error(blocked)
}
export async function readOriginalLanFence(profile: string): Promise<OriginalLanFence> {
  const file = path.join(profile, name), stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error('原 LAN 阻断记录无效，保留暂停状态')
  const value = JSON.parse(await fs.readFile(file, 'utf8')) as OriginalLanFence
  const keys = ['format','version','requestId','preparationId','runtimeId','ownershipId','installation','data','userData','workspaceSha256']
  if (!value || Object.keys(value).sort().join() !== keys.sort().join() || value.format !== 'dustdesk-original-lan-preview-fence' || value.version !== 1
    || ![value.requestId,value.preparationId,value.runtimeId,value.ownershipId].every(id => typeof id === 'string' && uuid.test(id))
    || ![value.installation,value.data,value.userData].every(file => typeof file === 'string' && path.isAbsolute(file))
    || value.userData !== profile || !hash.test(value.workspaceSha256)) throw Error('原 LAN 阻断记录不完整，保留暂停状态')
  return value
}
export async function writeOriginalLanFence(value: OriginalLanFence) {
  const file = path.join(value.userData, name), temporary = file + '-' + randomUUID() + '.tmp'
  const handle = await fs.open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close()
    // link is no-overwrite; a crash before this cannot have started native LAN.
    await fs.link(temporary, file)
  } finally { await handle.close(); await fs.unlink(temporary).catch(() => {}) }
}
async function physical(file: string, expected: Identity) {
  const stat = await fs.lstat(file, { bigint: true })
  if (stat.isSymbolicLink() || !expected || stat.dev !== BigInt(expected.volume) || stat.ino.toString(16).padStart(16, '0') !== expected.index) throw Error('原 LAN 交还物理身份不匹配，保留阻断记录')
  return stat
}
/** Called only after the real helper close event and a bound native response.
 * The JSON fence is a restart barrier, never a source of native authority. */
export async function clearOriginalLanFence(fence: OriginalLanFence, proof: OriginalLanProof) {
  const observed = await readOriginalLanFence(fence.userData)
  if (JSON.stringify(observed) !== JSON.stringify(fence)) throw Error('原 LAN 阻断记录已改变')
  const checkpoint = proof?.checkpoint
  if (!checkpoint || checkpoint.format !== 'dustdesk-lan-original-checkpoint' || checkpoint.version !== 1 || !['notStarted','handback'].includes(proof.kind)) throw Error('原 LAN 缺少有效原生交还证明')
  if (proof.kind === 'handback') {
    const receipt = proof.receipt
    if (!receipt || receipt.ownershipId !== fence.ownershipId || !hash.test(receipt.intentSha256) || receipt.compatibleRuntime !== 'dustdesk-electron-lan-protocol-1'
      || receipt.productionReady !== false || receipt.migrationComplete !== false || JSON.stringify(receipt.checkpoint) !== JSON.stringify(checkpoint)) throw Error('原 LAN 持久交还回执不匹配')
  }
  await physical(fence.userData, checkpoint.appProfile)
  const lan = path.join(fence.userData, 'LanTransfers')
  if (checkpoint.lanProfile) await physical(lan, checkpoint.lanProfile)
  else { try { await fs.lstat(lan); throw Error('原 LAN 目录在交还后出现') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error } }
  for (const [file, expected, limit] of [[path.join(lan, 'state.json'), checkpoint.state, 64 * 1024 * 1024], [path.join(lan, 'identity.json'), checkpoint.originalIdentity?.file, 1024 * 1024]] as const) {
    if (!expected) { try { await fs.lstat(file); throw Error('原 LAN 文件在交还后出现') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }; continue }
    if (!hash.test(expected.sha256) || !Number.isSafeInteger(expected.stamp.size) || expected.stamp.size < 0 || expected.stamp.size > limit) throw Error('原 LAN 文件证明无效')
    const stat = await physical(file, expected.stamp.identity)
    if (!stat.isFile() || stat.size !== BigInt(expected.stamp.size)) throw Error('原 LAN 交还文件大小已变化，保留阻断记录')
    const handle = await fs.open(file, 'r')
    try {
      const opened = await handle.stat({ bigint: true })
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw Error('原 LAN 交还文件已替换，保留阻断记录')
      // Read at most the authenticated size plus one byte, even if another
      // process grows the file after the helper has released its native pins.
      const bytes = Buffer.alloc(expected.stamp.size + 1)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length !== expected.stamp.size || sha(bytes.subarray(0, length)) !== expected.sha256) throw Error('原 LAN 交还后文件已变化，保留阻断记录')
      const current = await physical(file, expected.stamp.identity)
      if (current.size !== stat.size) throw Error('原 LAN 交还后文件大小已变化，保留阻断记录')
    } finally { await handle.close() }
  }
  await fs.unlink(path.join(fence.userData, name))
}
