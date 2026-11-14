import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { DustDeskApi } from '../../../shared/types'
import { newScreenshotDocument } from '../../../shared/screenshotDocument'
import { createScreenshotRenderer } from './workerClient'

export type PinRuntime = Pick<DustDeskApi, 'readPinnedScreenshot' | 'onPinnedScreenshotChanged' | 'onPinnedScreenshotSaveRequested' | 'savePinnedScreenshot' | 'controlPinnedScreenshot'> & { onError?: (callback: (error: string) => void) => () => void }
export function PinnedScreenshot({ id, runtime }: { id: string; runtime?: PinRuntime }) {
  const api: PinRuntime = runtime || window.dustdesk
  const [source, setSource] = useState(''), [error, setError] = useState('')
  const [options, setOptions] = useState({ opacity: 100, locked: false })
  const drag = useRef<{ x: number; y: number; windowX: number; windowY: number } | null>(null)
  const position = useRef<{ x: number; y: number } | null>(null), frame = useRef(0)
  const host = useRef<HTMLDivElement>(null)
  const refreshSource = useRef<() => void>(() => {})
  const exportLock = useRef(false), exporter = useRef<ReturnType<typeof createScreenshotRenderer> | null>(null)
  const control = async (action: Parameters<typeof window.dustdesk.controlPinnedScreenshot>[1], value?: Parameters<typeof window.dustdesk.controlPinnedScreenshot>[2]) => {
    const result = await api.controlPinnedScreenshot(id, action, value)
    if (!result.ok) setError(result.error || '操作失败，请重试')
  }
  useEffect(() => {
    let disposed = false, url = '', generation = 0, version: number | undefined
    document.documentElement.classList.add('pin-window')
    const refresh = async () => {
      const seq = ++generation
      const result = await api.readPinnedScreenshot(id, version)
      if (disposed || seq !== generation) return
      if (!result.ok) { setError(result.error || '无法读取贴图'); return }
      setError('')
      if (result.png) {
        if (url) URL.revokeObjectURL(url)
        url = URL.createObjectURL(new Blob([new Uint8Array(result.png)], { type: 'image/png' })); setSource(url)
      }
      version = result.version
      setOptions({ opacity: result.opacity || 100, locked: Boolean(result.locked) })
    }
    void refresh()
    refreshSource.current = () => void refresh()
    const unsubscribe = api.onPinnedScreenshotChanged(() => void refresh())
    const stopErrors = api.onError?.(message => { if (!disposed) setError(message) })
    const saveRequested = api.onPinnedScreenshotSaveRequested(() => {
      if (exportLock.current) return
      exportLock.current = true; setError('')
      void (async () => {
        try {
          const result = await api.readPinnedScreenshot(id)
          if (disposed) return
          if (!result.ok || !result.png || !result.width || !result.height || result.version === undefined) throw Error(result.error || '无法读取贴图')
          const document = newScreenshotDocument(id, `${id}:${result.version}`, result.width, result.height)
          const worker = createScreenshotRenderer(); exporter.current = worker
          const encoded = await worker.render(document, result.png, true, 'jpg')
          if (disposed) return
          if (!encoded.bytes) throw Error('图片合成失败，请重试')
          const output = await api.savePinnedScreenshot(id, encoded.bytes, result.version)
          if (!output.ok && !output.canceled) throw Error(output.error || '保存失败，请重试')
        } catch (err) { if (!disposed) setError(err instanceof Error ? err.message : '保存失败，请重试') }
        finally { exportLock.current = false; exporter.current?.dispose(); exporter.current = null }
      })()
    })
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void control('close')
      if (event.ctrlKey && event.key.toLowerCase() === 'c') { event.preventDefault(); void control('copy') }
      if (event.ctrlKey && event.key.toLowerCase() === 's') { event.preventDefault(); void control('save') }
    }
    window.addEventListener('keydown', key)
    return () => { disposed = true; unsubscribe(); stopErrors?.(); saveRequested(); exporter.current?.dispose(); cancelAnimationFrame(frame.current); if (url) URL.revokeObjectURL(url); window.removeEventListener('keydown', key); document.documentElement.classList.remove('pin-window') }
  }, [id])
  const flushMove = () => { if (position.current) { void control('move', position.current); position.current = null } }
  useEffect(() => {
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey) { const opacity = Math.max(20, Math.min(100, options.opacity + (event.deltaY > 0 ? -5 : 5))); setOptions({ ...options, opacity }); void control('options', { opacity }) }
      else if (!options.locked) void control('resize', { width: innerWidth * (event.deltaY > 0 ? .9 : 1.1), height: innerHeight * (event.deltaY > 0 ? .9 : 1.1) })
    }
    host.current?.addEventListener('wheel', wheel, { passive: false })
    return () => host.current?.removeEventListener('wheel', wheel)
  })
  return <div ref={host} className="pinned-screenshot" onContextMenu={event => { event.preventDefault(); void control('menu') }} onDoubleClick={() => void control('edit')} onPointerDown={event => {
    if (event.button !== 0 || options.locked) return
    drag.current = { x: event.screenX, y: event.screenY, windowX: window.screenX, windowY: window.screenY }; event.currentTarget.setPointerCapture(event.pointerId)
  }} onPointerMove={event => {
    if (!drag.current) return
    position.current = { x: drag.current.windowX + event.screenX - drag.current.x, y: drag.current.windowY + event.screenY - drag.current.y }
    cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(flushMove)
  }} onPointerUp={() => { drag.current = null; flushMove() }} onPointerCancel={() => { drag.current = null }}>
    <img src={source || undefined} alt="贴图" draggable={false} />
    <button className="pin-close" aria-label="关闭贴图" onPointerDown={event => event.stopPropagation()} onClick={() => void control('close')}><X size={16} aria-hidden="true" /></button>
    {error && <span role="alert" className="pin-error">{error}<button onPointerDown={event => event.stopPropagation()} onClick={() => refreshSource.current()}>重试读取</button></span>}
  </div>
}
