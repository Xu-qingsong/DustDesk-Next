import { invoke } from '@tauri-apps/api/core'
import { prepareDraftImport, recoverNativeDraftImport, type NativeDraftDecision } from '../../../shared/draftMigration'

const step = <T,>(action: string) => invoke<T>('runtime_drafts_step', { action })
async function start() {
  const previous = await step<NativeDraftDecision | null>('recover')
  if (previous) {
    await recoverNativeDraftImport(localStorage, previous)
    const result = await step<{ ready: boolean }>('finish')
    if (result.ready) return
  }
  const source = await step<{ serialized: string; workspaceFingerprint: string }>('source')
  const prepared = await prepareDraftImport(source.serialized, source.workspaceFingerprint)
  const staged = prepared.stage(localStorage, () => true)
  if (staged.result.alreadyImported) throw Error('浏览器回执没有对应原生完成决定，已保留现场')
  await step('begin')
  const decision = await step<NativeDraftDecision>('decide')
  await recoverNativeDraftImport(localStorage, decision)
  const result = await step<{ ready: boolean }>('finish')
  if (!result.ready) throw Error('原生决定中止本次导入，未开放运行')
}
void start().then(() => { document.getElementById('status')!.textContent = '隔离草稿恢复已核验，业务服务尚未启动。' }).catch(error => {
  document.getElementById('status')!.textContent = '启动恢复被阻断，已保留数据和日志：' + String(error)
})
