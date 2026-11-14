import React, { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import type { AppSettings } from '../../../shared/types'
import type { ScreenshotPayload } from '../../../shared/screenshotDocument'
import { ScreenshotEditor, type ScreenshotCheckpoint, type ScreenshotRuntime } from '../screenshot/ScreenshotEditor'
import { screenshotFinishBytes } from './screenshotWire'
import { createRuntimeEvents } from './eventTransport'
import '../styles.css'
import '../screenshot/screenshot.css'
import '../components/ui/controls.css'

type CaptureSettings = Pick<AppSettings, 'ScreenshotAfterAction' | 'ScreenshotFormat'>

function Capture() {
  const [payload, setPayload] = useState<ScreenshotPayload>()
  const [settings, setSettings] = useState<CaptureSettings>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [live, setLive] = useState(false)
  const checkpoint = useRef<ScreenshotCheckpoint | null>(null)
  const cancel = () => void invoke('screenshot_overlay_cancel').catch(reason => setError(String(reason)))
  useEffect(() => {
    setError('')
    document.documentElement.classList.add('screenshot-window')
    let active = true
    const events = createRuntimeEvents(getCurrentWebviewWindow().label)
    type Request = { requestId: string }
    type Resume = Request & { error?: string }
    const flush = async ({ requestId }: Request, maintenance: boolean) => {
      if (active) setError('')
      let error: string | undefined
      try {
        await events.connect()
        if (!checkpoint.current) throw Error('截图编辑器尚未就绪，请稍后重试')
        checkpoint.current.freeze(requestId)
      } catch (reason) { error = String(reason) }
      try { await invoke('screenshot_overlay_checkpoint', { requestId, maintenance, token: events.token(), error }) }
      catch (reason) { if (active) setError(String(reason)) }
    }
    const resume = ({ requestId, error }: Resume) => {
      checkpoint.current?.resume(requestId)
      if (active) setError(error || '')
    }
    const initialize = async () => {
      await events.listen<Request>('lifecycle:flush', event => { void flush(event.payload, false) })
      await events.listen<Request>('drafts:flush', event => { void flush(event.payload, true) })
      await events.listen<Resume>('lifecycle:resume', event => resume(event.payload))
      await events.listen<Resume>('drafts:resume', event => resume(event.payload))
      await events.connect()
      if (!active) return
      const metadata = await invoke<Omit<ScreenshotPayload, 'png'> & {settings: CaptureSettings; liveRegion: boolean}>('screenshot_overlay_document')
      document.documentElement.classList.toggle('region-selection-window', metadata.liveRegion)
      const bytes = metadata.document.sourceAssetId ? await invoke<ArrayBuffer>('screenshot_overlay_source', {id:metadata.document.id}) : new ArrayBuffer(0)
      if (metadata.document.sourceAssetId) await invoke('screenshot_overlay_adopt',{id:metadata.document.id})
      if (active) { setSettings(metadata.settings); setLive(metadata.liveRegion); setPayload({...metadata,png:new Uint8Array(bytes)}) }
    }
    void initialize().catch(reason => { if (active) setError(String(reason)) })
    return () => { active = false; events.dispose(); document.documentElement.classList.remove('screenshot-window','region-selection-window') }
  }, [attempt])
  const runtime: ScreenshotRuntime = {
    readSettings: async () => settings!,
    selectRegion: rect => invoke<Omit<ScreenshotPayload,'png'>>('screenshot_overlay_region',{rect}).then(async metadata => {
      const png = new Uint8Array(await invoke<ArrayBuffer>('screenshot_overlay_source',{id:metadata.document.id}))
      await invoke('screenshot_overlay_adopt',{id:metadata.document.id})
      return {ok:true,payload:{...metadata,png}}
    }).catch(reason => ({ok:false,error:String(reason)})),
    finish: request => invoke<Awaited<ReturnType<ScreenshotRuntime['finish']>>>('screenshot_overlay_finish', screenshotFinishBytes(request)).catch(reason => ({ok:false,error:String(reason)}))
  }
  return payload && settings ? <><ScreenshotEditor payload={payload} runtime={runtime} checkpoint={checkpoint} floating liveRegion={live} initialSelection={!live || Boolean(payload.png.length)} onCancel={cancel} />{error && <div role="alert" className="screenshot-feedback">{error}</div>}</> : <div className="screenshot-loading"><div role={error ? 'alert' : 'status'} className={error ? 'screenshot-feedback screenshot-recovery' : 'screenshot-feedback'}>{error || '正在读取屏幕…'}{error && <><button onClick={() => setAttempt(value => value + 1)}>重试读取</button><button onClick={cancel}>关闭截图</button></>}</div></div>
}
createRoot(document.getElementById('root')!).render(<Capture />)
