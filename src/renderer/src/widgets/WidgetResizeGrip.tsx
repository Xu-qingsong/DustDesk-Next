import React from 'react'

export function WidgetResizeGrip({ widgetKey, locked }: { widgetKey: string; locked?: boolean }) {
  const start = React.useRef<{ pointerId: number; x: number; y: number; width: number; height: number } | null>(null)
  const frame = React.useRef<number | null>(null)
  const latest = React.useRef<{ width: number; height: number } | null>(null)
  const dimensions = (event: React.PointerEvent<HTMLDivElement>, origin: NonNullable<typeof start.current>) => ({ width: origin.width + event.screenX - origin.x, height: origin.height + event.screenY - origin.y })
  React.useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); document.documentElement.classList.remove('widget-resizing') }, [])
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.pointerId !== event.pointerId) return
    latest.current = dimensions(event, start.current)
    if (frame.current !== null) return
    frame.current = requestAnimationFrame(() => {
      frame.current = null
      const next = latest.current
      if (start.current && next) void window.dustdesk.resizeWidget(widgetKey, next.width, next.height)
    })
  }
  const end = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || start.current.pointerId !== event.pointerId) return
    // Cancellation can carry unrelated native cursor coordinates. Commit the last
    // measured size, not coordinates from pointercancel/lostpointercapture.
    if (event.type === 'pointerup') latest.current = dimensions(event, start.current)
    start.current = null
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    const next = latest.current
    if (next) void window.dustdesk.resizeWidget(widgetKey, next.width, next.height, true)
    document.documentElement.classList.remove('widget-resizing')
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  return <div className={`widget-resize-grip ${locked ? 'disabled' : ''}`} title={locked ? '尺寸已锁定' : '拖拽调整大小'} onPointerDown={event => { if (locked || event.button !== 0) return; start.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY, width: window.outerWidth, height: window.outerHeight }; latest.current = { width: window.outerWidth, height: window.outerHeight }; document.documentElement.classList.add('widget-resizing'); event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault() }} onPointerMove={move} onPointerUp={end} onPointerCancel={end} onLostPointerCapture={end} />
}
