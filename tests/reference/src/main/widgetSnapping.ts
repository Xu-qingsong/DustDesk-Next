type Bounds = { x: number; y: number; width: number; height: number }
type Edge = 'None' | 'Left' | 'Right' | 'Top' | 'Bottom'

// Electron window bounds and display work areas both use device-independent pixels.
export function snapWidgetBounds(bounds: Bounds, area: Bounds, enabled: boolean, distance = 24): Bounds & { dockEdge: Edge } {
  if (!enabled) return { ...bounds, dockEdge: 'None' }
  const rightX = area.x + area.width - bounds.width
  const bottomY = area.y + area.height - bounds.height
  const left = Math.abs(bounds.x - area.x)
  const right = Math.abs(bounds.x - rightX)
  const top = Math.abs(bounds.y - area.y)
  const bottom = Math.abs(bounds.y - bottomY)
  const horizontal: Edge = Math.min(left, right) <= distance ? left <= right ? 'Left' : 'Right' : 'None'
  const vertical: Edge = Math.min(top, bottom) <= distance ? top <= bottom ? 'Top' : 'Bottom' : 'None'
  return {
    ...bounds,
    x: horizontal === 'Left' ? area.x : horizontal === 'Right' ? rightX : bounds.x,
    y: vertical === 'Top' ? area.y : vertical === 'Bottom' ? bottomY : bounds.y,
    dockEdge: horizontal !== 'None' ? horizontal : vertical
  }
}
