import { ipcRenderer } from 'electron'
import { prepareDraftImport, recoverNativeDraftImport, type NativeDraftDecision } from '../shared/draftMigration'

// This role exposes no API to the page. Only the native owner can issue a
// request to this WebContents; native code independently observes storage.
export function installDraftControl() {
  const token = process.argv.find(value => value.startsWith('--dustdesk-draft-token='))?.slice('--dustdesk-draft-token='.length)
  if (!token || !/^[0-9a-f-]{36}$/.test(token)) throw Error('受控草稿页缺少原生请求身份')
  let running = false
  ipcRenderer.on('draft-control:execute', async (_event, request: { token: string; id: string; operation: string; serialized?: string; fingerprint?: string; decision?: NativeDraftDecision }) => {
    if (request?.token !== token || typeof request.id !== 'string' || running) return
    running = true
    try {
      if (request.operation === 'stage' && typeof request.serialized === 'string' && typeof request.fingerprint === 'string') {
        const prepared = await prepareDraftImport(request.serialized, request.fingerprint)
        // The durable native plan must already exist. This local callback is
        // not commit authority; the native owner must observe and decide next.
        prepared.stage(localStorage, () => true)
      } else if (request.operation === 'recover' && request.decision) {
        await recoverNativeDraftImport(localStorage, request.decision)
      } else throw Error('受控草稿命令无效')
      ipcRenderer.send('draft-control:result', token, request.id, null)
    } catch (error) {
      ipcRenderer.send('draft-control:result', token, request.id, error instanceof Error ? error.message : String(error))
    } finally { running = false }
  })
  document.addEventListener('DOMContentLoaded', () => ipcRenderer.send('draft-control:ready', token), { once: true })
}
