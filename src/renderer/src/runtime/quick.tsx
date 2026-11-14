import React from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { toast } from 'sonner'
import { QuickCapture, type QuickCaptureApi } from '../overlays/QuickCapture'
import { createRuntimeEvents } from './eventTransport'
import { draftMigrationJournalKey } from '../../../shared/draftMigration'
import '../styles.css'
import '../productivity.css'
import '../components/ui/controls.css'

async function install(): Promise<QuickCaptureApi> {
  if (localStorage.getItem(draftMigrationJournalKey) !== null) throw Error('存在未完成草稿导入，请从主窗口受控恢复后重试')
  const events = createRuntimeEvents('quick-capture')
  const flushers = new Set<() => Promise<void>>()
  const pending = new Set<Promise<unknown>>()
  let paused = false
  let composing = false
  let releasing: string | undefined
  let maintenance: string | undefined
  let generation = 0
  const startComposition = () => { composing = true }
  const endComposition = () => { composing = false }
  document.addEventListener('compositionstart', startComposition, true)
  document.addEventListener('compositionend', endComposition, true)
  const persist = async () => {
    if (composing) throw Error('输入法组合输入尚未结束，请完成输入后重试')
    if (!flushers.size) throw Error('快速记录草稿尚未就绪')
    // Save callbacks include cleanup of the committed request's local draft.
    for (const callback of flushers) await callback()
    while (pending.size) await Promise.all([...pending])
  }
  const resume = (error = '') => {
    ++generation; paused = false; releasing = undefined
    document.documentElement.inert = false
    if (error) toast.error(error)
  }
  const hide = async () => {
    if (paused || releasing) throw Error('正在保存或维护，请稍后收起快速记录')
    await persist()
    if (paused || releasing) throw Error('窗口保存状态已变化，请稍后重试')
    await invoke('quick_capture_hide')
  }
  const flush = async (requestId: string, isMaintenance: boolean) => {
    const current = ++generation
    paused = true; releasing = undefined
    if (isMaintenance) maintenance = requestId
    document.documentElement.inert = true
    let error: string | undefined
    try { await persist() } catch (reason) { error = String(reason) }
    if (current !== generation) return
    try { await invoke(isMaintenance ? 'drafts_checkpoint_ready' : 'application_flushed', { requestId, error: error ?? null }) }
    catch (reason) { if (current === generation) { maintenance = undefined; resume(String(reason)) } }
  }
  try {
    await events.listen('quick-capture:hide', () => { void hide().catch(error => toast.error(String(error))) })
    await events.listen<{ requestId: string }>('lifecycle:flush', event => { void flush(event.payload.requestId, false) })
    await events.listen<string>('lifecycle:resume', event => resume(event.payload))
    await events.listen<{ requestId: string }>('drafts:flush', event => { void flush(event.payload.requestId, true) })
    await events.listen<{ requestId: string; error: string; reload?: boolean }>('drafts:resume', event => {
      if (event.payload.requestId !== maintenance) return
      maintenance = undefined
      if (event.payload.reload) { ++generation; location.reload(); return }
      resume(event.payload.error)
    })
    await events.listen<string>('window:release-check', event => {
      const requestId = event.payload
      const current = generation
      void (async () => {
        let ready = false
        try { if (!paused && !releasing) { await persist(); ready = current === generation && !paused && !releasing } } catch { /* retain failed drafts */ }
        if (ready) { releasing = requestId; document.documentElement.inert = true }
        const accepted = await invoke<boolean>('window_release_ready', { requestId, ready })
        if (!accepted && releasing === requestId) resume()
      })().catch(() => { if (releasing === requestId) resume() })
    })
    await events.listen<string>('window:release-resume', event => { if (releasing === event.payload) resume() })
    await events.connect()
  } catch (error) {
    events.dispose()
    document.removeEventListener('compositionstart', startComposition, true)
    document.removeEventListener('compositionend', endComposition, true)
    throw error
  }
  window.addEventListener('pagehide', () => { ++generation; events.dispose() }, { once: true })
  return {
    committed: requestId => invoke<boolean>('quick_capture_committed', { requestId }),
    save: draft => {
      if (paused || releasing) return Promise.reject(Error('正在退出或维护，不能提交新记录'))
      const operation = invoke<void>('quick_capture_save', { draft })
      pending.add(operation)
      void operation.then(() => pending.delete(operation), () => pending.delete(operation))
      return operation
    },
    hide,
    onBeforeQuit: callback => { flushers.add(callback); return () => { flushers.delete(callback) } },
  }
}

const root = createRoot(document.getElementById('root')!)
root.render(<main role="status">正在核对快速记录草稿…</main>)
void install().then(api => root.render(<React.StrictMode><QuickCapture api={api} /></React.StrictMode>)).catch(error => root.render(<StartupError error={String(error)} />))

function StartupError({ error }: { error: string }) {
  const [message, setMessage] = React.useState(error)
  return <main role="alert">无法打开快速记录，草稿未删除：{message}<button onClick={() => location.reload()}>重试打开</button><button onClick={() => { void invoke('quick_capture_abort').catch(reason => setMessage(String(reason))) }}>收起并保留草稿</button></main>
}
