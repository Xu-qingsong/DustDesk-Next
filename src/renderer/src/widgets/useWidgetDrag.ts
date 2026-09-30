import { useRef } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'

type DragOrigin = {
  pointerId: number
  pointerX: number
  pointerY: number
  windowX: number
  windowY: number
}

const interactiveSelector = 'button, input, textarea, select, a, .widget-todos, .countdown-widget, .widget-metrics, [data-widget-no-drag]'

export function useWidgetDrag(widgetKey: string) {
  const origin = useRef<DragOrigin | null>(null)
  const frame = useRef<number | null>(null)
  const latest = useRef<{ x: number; y: number } | null>(null)

  const position = (event: ReactPointerEvent<HTMLElement>, start: DragOrigin) => ({
    x: start.windowX + event.screenX - start.pointerX,
    y: start.windowY + event.screenY - start.pointerY
  })

  const flush = (commit: boolean) => {
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    const next = latest.current
    if (next) void window.dustdesk.moveWidget(widgetKey, next.x, next.y, commit)
  }

  const end = (event: ReactPointerEvent<HTMLElement>) => {
    const start = origin.current
    if (!start || start.pointerId !== event.pointerId) return
    if (event.type === 'pointerup') latest.current = position(event, start)
    origin.current = null
    flush(true)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      const target = event.target as Element
      if (event.button !== 0 || (!target.closest('[data-widget-drag-handle]') && target.closest(interactiveSelector))) return
      origin.current = { pointerId: event.pointerId, pointerX: event.screenX, pointerY: event.screenY, windowX: window.screenX, windowY: window.screenY }
      latest.current = { x: window.screenX, y: window.screenY }
      event.currentTarget.setPointerCapture(event.pointerId)
      event.preventDefault()
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
      const start = origin.current
      if (!start || start.pointerId !== event.pointerId) return
      latest.current = position(event, start)
      if (frame.current === null) frame.current = requestAnimationFrame(() => { frame.current = null; const next = latest.current; if (next) void window.dustdesk.moveWidget(widgetKey, next.x, next.y) })
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end
  }
}
