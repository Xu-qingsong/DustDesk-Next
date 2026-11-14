import { draftDigest, draftMigrationJournalKey, prepareDraftImport, recoverNativeDraftImport, type DraftImportResult, type DraftImportTransaction, type NativeDraftDecision } from '../../../shared/draftMigration'

type Checkpoint = { requestId: string; workspaceFingerprint: string }
type Status = NativeDraftDecision & { requestId: string; transactionId: string; archiveSha256: string }
type Host = {
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>
  storage: Storage
  active: (requestId: string) => boolean
  currentRequest: () => string | undefined
  alive: () => boolean
  message: (text: string) => void
  block: (text: string) => void
}

class NativeImportAborted extends Error {}

export async function runDraftImport(serialized: string, host: Host): Promise<DraftImportResult> {
  const call = <Result,>(command: string, args?: Record<string, unknown>) => host.invoke(command, args) as Promise<Result>
  const archiveSha256 = await draftDigest(serialized)
  let checkpoint: Checkpoint | undefined
  let staged: DraftImportTransaction | undefined
  let submitted = false
  const notify = (text: string) => { try { host.message(text) } catch {} }
  const end = async () => {
    const requestId = checkpoint?.requestId ?? host.currentRequest()
    if (requestId) await call('drafts_end', { requestId })
  }
  const settle = async (status: Status): Promise<DraftImportResult> => {
    if (!staged || !checkpoint || status.requestId !== checkpoint.requestId || status.archiveSha256 !== archiveSha256) throw Error('原生导入事务不属于当前维护请求，保留恢复日志')
    const decision = await call<Status | null>('drafts_recovery')
    const authoritative = decision ?? status
    if (!decision && !status.completed) throw Error('原生导入结果尚未核实，保留恢复日志')
    if (authoritative.decision !== 'commit' && authoritative.decision !== 'abort') throw Error('原生导入尚无终态，保留恢复日志')
    notify(authoritative.decision === 'commit'
      ? '草稿导入完成：新增 ' + staged.result.importedKeys.length + ' 项，保留已有 ' + staged.result.existingKeys.length + ' 项。'
      : '原生决定中止导入，未覆盖已有草稿。')
    if (decision) {
      await recoverNativeDraftImport(host.storage, decision)
      await call('drafts_recovery', { finish: true })
    }
    if (authoritative.decision === 'abort') throw new NativeImportAborted('原生决定中止导入，请重新准备后重试')
    return staged.result
  }
  try {
    checkpoint = await call<Checkpoint>('drafts_prepare', { refresh: true })
    await call('drafts_verify', { requestId: checkpoint.requestId, serialized })
    const prepared = await prepareDraftImport(serialized, checkpoint.workspaceFingerprint)
    const active = () => checkpoint !== undefined && host.alive() && host.active(checkpoint.requestId)
    staged = prepared.stage(host.storage, active)
    if (staged.result.alreadyImported) {
      const result = staged.commit()
      await end()
      notify('此草稿包已导入，未重复写入或复活已消费草稿。')
      return result
    }
    const raw = host.storage.getItem(draftMigrationJournalKey)
    if (raw === null) throw Error('草稿暂存日志已丢失，未请求原生提交')
    const journalSha256 = await draftDigest(raw)
    if (!active()) throw Error('维护屏障已失效，未请求原生提交')
    submitted = true
    const pending = await call<Status>('drafts_transaction', { requestId: checkpoint.requestId, serialized, journalSha256 })
    const decided = await call<Status>('drafts_transaction', { requestId: checkpoint.requestId, transactionId: pending.transactionId, commit: true })
    return await settle(decided)
  } catch (error) {
    if (error instanceof NativeImportAborted) throw error
    if (!host.alive()) throw error
    try {
      if (submitted && checkpoint) {
        const current = await call<Status | null>('drafts_import_state')
        if (current?.requestId === checkpoint.requestId && current.archiveSha256 === archiveSha256) {
          return await settle(current)
        }
        if (current && !current.completed) throw Error('存在另一未完成原生事务，未尝试本地回滚')
      }
      if (!staged && host.storage.getItem(draftMigrationJournalKey) !== null) throw Error('暂存失败后仍有浏览器恢复日志，未放行编辑器')
      staged?.rollback()
      await end()
    } catch (recoveryError) {
      if (recoveryError instanceof NativeImportAborted) throw recoveryError
      host.block('导入尚未确认完成，已保留数据和日志并重新核验：' + String(recoveryError))
      throw recoveryError
    }
    throw error
  }
}
