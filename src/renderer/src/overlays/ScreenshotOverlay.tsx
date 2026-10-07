import { useEffect, useLayoutEffect, useState } from 'react'
import type { ScreenshotPayload } from '../../../shared/screenshotDocument'
import { ScreenshotEditor } from '../screenshot/ScreenshotEditor'
import { RegionSelector } from './RegionSelector'

export function ScreenshotOverlay() {
  const [payload, setPayload] = useState<ScreenshotPayload | null>(null)
  const [direct, setDirect] = useState<'copy' | 'pin'>()
  const params = new URLSearchParams(location.search), region = params.has('region')
  const selected = params.has('selected') || region
  useEffect(() => {
    let canceled = false
    const receive = (value: ScreenshotPayload) => { if (!canceled) setPayload(current => current?.document.id === value.document.id ? current : value) }
    const unsubscribe = window.dustdesk.onScreenshotDocument(receive)
    void window.dustdesk.readScreenshotDocument('').then(result => { if (result.payload) receive(result.payload) })
    return () => { canceled = true; unsubscribe() }
  }, [])
  useEffect(() => { if (!selected) void window.dustdesk.loadWorkspace().then(state => { const action = state.Settings.ScreenshotAfterAction; if (action === 'copy' || action === 'pin') setDirect(action) }) }, [])
  useLayoutEffect(() => {
    document.documentElement.classList.add('screenshot-window')
    if (region) document.documentElement.classList.add('region-selection-window')
    return () => { document.documentElement.classList.remove('screenshot-window'); document.documentElement.classList.remove('region-selection-window') }
  }, [])
  if (region) return <RegionSelector />
  return payload ? <ScreenshotEditor key={payload.document.id} payload={payload} floating initialSelection={selected} directAction={direct} onCancel={() => void window.dustdesk.cancelScreenshotOverlay()} /> : <div className="screenshot-loading" role="status">正在读取屏幕…</div>
}
