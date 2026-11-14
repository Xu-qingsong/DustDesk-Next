import type { Session } from 'electron'
import type { WorkspaceOwnership } from './workspaceOwnership'
import type { DraftCollectionContext } from './draftMaintenance'
import { createElectronDraftTransactions } from './draftTransaction'
import { openDraftBrowser } from './draftBrowser'

export async function recoverElectronDraftStartup(ownership: WorkspaceOwnership, session: Session, location: string, context: DraftCollectionContext) {
  const transactions = createElectronDraftTransactions(ownership)
  await transactions.requirePeerCompleted()
  const record = await transactions.read()
  if (new URL(location).protocol !== 'file:') {
    if (record) throw Error('存在原生草稿事务，请使用原构建的本地应用入口完成受控恢复')
    return // The development HTTP origin cannot receive file-origin imports.
  }
  const browser = await openDraftBrowser(session, location, context)
  try {
    const keys = record?.writes.map(entry => entry.key) ?? []
    const recovery = await transactions.recover(browser.binding, await browser.snapshot(keys))
    if (recovery) {
      await browser.recover(recovery.decision)
      await browser.flush()
      await recovery.complete(await browser.snapshot(keys))
    }
    context.assertActive()
    await ownership.assertHeld()
  } finally { await browser.close() }
}
