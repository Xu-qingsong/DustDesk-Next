import { useEffect, useState } from 'react'
import { newScreenshotDocument } from '../../../shared/screenshotDocument'
import type { ScreenshotPayload } from '../../../shared/screenshotDocument'
import { ScreenshotEditor, type ScreenshotRuntime } from '../screenshot/ScreenshotEditor'
import { probe } from './api'
import '../screenshot/screenshot.css'

const runtime: ScreenshotRuntime = {
  readSettings: async () => ({ ScreenshotAfterAction: 'edit', ScreenshotFormat: 'png' }),
  selectRegion: async () => ({ ok: false, error: '请先通过原生实时框选捕获像素' }),
  finish: async request => {
    if (request.action !== 'pin' && request.action !== 'updatePin') return { ok: false, error: '隔离原型暂只验证贴图输出；复制和保存将在正式后端迁移阶段实现' }
    if (!request.png?.length) return { ok: false, error: '缺少编辑结果' }
    await probe.updateCapture(request.png)
    await probe.open('pin')
    return { ok: true, pinId: 'probe-pin' }
  }
}

export function PrototypeEditor({ png }: { png: Uint8Array }) {
  const [payload, setPayload] = useState<ScreenshotPayload>()
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void createImageBitmap(new Blob([new Uint8Array(png)], { type: 'image/png' })).then(bitmap => {
      const { width, height } = bitmap
      bitmap.close()
      if (!cancelled) setPayload({ png, document: newScreenshotDocument(crypto.randomUUID(), crypto.randomUUID(), width, height) })
    }).catch(reason => { if (!cancelled) setError(String(reason)) })
    return () => { cancelled = true }
  }, [png])
  return <section data-testid="shared-screenshot-editor"><h2>现有截图编辑器 · 真实 WebView2 Worker</h2><p>可验证标注、撤销、裁剪和贴图；复制与保存未接通时会明确报错，不访问系统剪贴板。</p>{error && <p role="alert">{error}</p>}{payload ? <ScreenshotEditor key={payload.document.id} payload={payload} runtime={runtime} /> : <p role="status">正在准备编辑器…</p>}</section>
}
