import React, { useEffect, useRef, useState } from 'react'

export function ScreenshotOverlay() {
  const [source, setSource] = useState('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const imageRef = useRef<HTMLImageElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [selection, setSelection] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const cancel = async () => {
    try { await window.dustdesk.cancelScreenshotOverlay() }
    catch { setError('取消失败，请再次按 Esc 或点击取消') }
  }
  useEffect(() => {
    const unsubscribe = window.dustdesk.onScreenshotOverlaySource(value => { setReady(false); setSource(value) })
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); void cancel() } }
    window.addEventListener('keydown', onKey)
    return () => { unsubscribe(); window.removeEventListener('keydown', onKey) }
  }, [])
  const point = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)), y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)) }
  }
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !ready || lock.current) return
    const value = point(event); start.current = value; setError(''); setSelection({ ...value, width: 0, height: 0 })
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    const value = point(event)
    setSelection({ x: Math.min(start.current.x, value.x), y: Math.min(start.current.y, value.y), width: Math.abs(value.x - start.current.x), height: Math.abs(value.y - start.current.y) })
  }
  const up = async (event: React.PointerEvent<HTMLDivElement>) => {
    const image = imageRef.current
    if (!start.current || !image || !ready || lock.current) return
    move(event)
    const value = point(event); const origin = start.current; start.current = null
    const width = Math.abs(value.x - origin.x); const height = Math.abs(value.y - origin.y)
    if (width < 4 || height < 4) { setSelection(null); return }
    lock.current = true; setBusy(true)
    try {
      const rect = image.getBoundingClientRect(); const sx = image.naturalWidth / rect.width; const sy = image.naturalHeight / rect.height
      const x = Math.floor(Math.min(origin.x, value.x) * sx); const y = Math.floor(Math.min(origin.y, value.y) * sy)
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.min(image.naturalWidth - x, Math.round(width * sx)))
      canvas.height = Math.max(1, Math.min(image.naturalHeight - y, Math.round(height * sy)))
      const context = canvas.getContext('2d')
      if (!context) throw new Error('画布不可用')
      context.drawImage(image, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
      const result = await window.dustdesk.submitScreenshotOverlay(canvas.toDataURL('image/png'))
      if (!result.ok) setError('选区无法提交，请缩小选区重试或取消截图')
    } catch { setError('选区捕获失败，请重新框选或取消截图') }
    finally { lock.current = false; setBusy(false) }
  }
  const stopSelection = () => { start.current = null; setSelection(null) }
  return <div className="screenshot-overlay" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={stopSelection} onLostPointerCapture={() => { if (start.current) stopSelection() }}>
    <img ref={imageRef} src={source || undefined} alt="屏幕选择" draggable={false} onLoad={() => setReady(true)} onError={() => setError('无法读取屏幕图像，请取消后重试')} />
    {selection && <div className="screenshot-selection" style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }} />}
    <div className="screenshot-overlay-controls" onPointerDown={event => event.stopPropagation()}>
      <span role="status">{busy ? '正在处理选区…' : ready ? '拖动选择区域 · Esc 取消' : '正在读取屏幕…'}</span>
      <button type="button" onClick={() => void cancel()}>取消截图</button>
      {error && <span role="alert">{error}</span>}
    </div>
  </div>
}
