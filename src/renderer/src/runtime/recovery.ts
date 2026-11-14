import { invoke } from '@tauri-apps/api/core'
import { recoverNativeDraftImport, type NativeDraftDecision } from '../../../shared/draftMigration'

async function recover() {
  const decision = await invoke<NativeDraftDecision | null>('drafts_recovery')
  if (decision !== null) {
    await recoverNativeDraftImport(localStorage, decision)
    await invoke('drafts_recovery', { finish: true })
  }
  await invoke('drafts_startup_done', { error: null })
}

void recover().catch(error => invoke('drafts_startup_done', { error: String(error) }).catch(() => {}))
