import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Session } from 'electron'
import { maxDraftArchiveBytes, verifyDraftArchive } from '../shared/draftMigration'
import type { WorkspaceOwnership } from './workspaceOwnership'
import type { DraftMaintenanceContext } from './draftMaintenance'
import { verifyDraftProvenance } from './draftLineage'
import { createElectronDraftTransactions } from './draftTransaction'
import { openDraftBrowser } from './draftBrowser'

export async function readDraftImport(location: string) {
  if (!path.isAbsolute(location) || path.extname(location).toLowerCase() !== '.json') throw Error('请选择原生 JSON 草稿迁移包')
  const checkPath = async () => {
    for (let current = location; ; current = path.dirname(current)) {
      if ((await fs.lstat(current)).isSymbolicLink()) throw Error('草稿迁移包路径包含链接或重解析点')
      if (path.dirname(current) === current) return
    }
  }
  await checkPath()
  const handle = await fs.open(location, 'r')
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxDraftArchiveBytes)) throw Error('草稿迁移包必须是独立普通文件且不超过 64 MiB')
    const buffer = Buffer.alloc(Number(before.size) + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (!bytesRead) break
      length += bytesRead
    }
    await checkPath()
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(location, { bigint: true })
    if (BigInt(length) !== before.size || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || current.dev !== before.dev || current.ino !== before.ino || current.nlink !== 1n || current.isSymbolicLink()) throw Error('草稿迁移包在读取时变化，未导入')
    const serialized = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length))
    await verifyDraftArchive(serialized)
    return serialized
  } finally { await handle.close() }
}

export async function importElectronDrafts(ownership: WorkspaceOwnership, session: Session, location: string, serialized: string, fingerprint: string, context: DraftMaintenanceContext, quiesce: () => Promise<void>) {
  context.assertActive()
  if (new URL(location).protocol !== 'file:') throw Error('草稿导入仅支持当前构建的本地应用入口，不支持开发服务器')
  await verifyDraftProvenance(ownership, serialized, fingerprint)
  const transactions = createElectronDraftTransactions(ownership)
  await transactions.requirePeerCompleted()
  const browser = await openDraftBrowser(session, location, context)
  try {
    context.holdForRecovery()
    await quiesce()
    context.assertActive()
    const previous = await transactions.read()
    const previousKeys = previous?.writes.map(entry => entry.key) ?? []
    const recovery = await transactions.recover(browser.binding, await browser.snapshot(previousKeys))
    if (recovery) {
      await browser.recover(recovery.decision)
      await browser.flush()
      await recovery.complete(await browser.snapshot(previousKeys))
    }
    const plan = await transactions.begin(randomUUID(), serialized, fingerprint, browser.binding, await browser.snapshot(), context.assertActive)
    if (plan.record) {
      const keys = plan.record.writes.map(entry => entry.key)
      await browser.stage(serialized, fingerprint)
      await transactions.decide(plan.record.requestId, plan.record.transactionId, true, browser.binding, await browser.snapshot(keys), context.assertActive)
      const committed = await transactions.recover(browser.binding, await browser.snapshot(keys))
      if (!committed || committed.decision.decision !== 'commit') throw Error('原生草稿提交尚未确认，须退出后受控恢复')
      await browser.recover(committed.decision)
      await browser.flush()
      await committed.complete(await browser.snapshot(keys))
    }
    context.assertActive()
    await ownership.assertHeld()
    return plan.result
  } finally { await browser.close() }
}
