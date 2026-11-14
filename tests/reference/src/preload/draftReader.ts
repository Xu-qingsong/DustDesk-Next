import { ipcRenderer } from 'electron'
import { collectDrafts } from '../shared/draftMigration'

export function installDraftReader() {
  ipcRenderer.once('draft-reader:collect', (_event, request: string) => {
    try { ipcRenderer.send('draft-reader:result', request, collectDrafts(localStorage)) }
    catch (error) { ipcRenderer.send('draft-reader:result', request, undefined, error instanceof Error ? error.message : String(error)) }
  })
  document.addEventListener('DOMContentLoaded', () => ipcRenderer.send('draft-reader:ready'), { once: true })
}
