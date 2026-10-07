import { useState } from 'react'
import { newScreenshotDocument } from '../../../shared/screenshotDocument'
import { ScreenshotEditor } from '../screenshot/ScreenshotEditor'

// The same editor owns the live selection and the captured pixels. Selecting a
// tool never mounts another frame or captures the desktop.
export function RegionSelector() {
  const [payload] = useState(() => {
    const params = new URLSearchParams(location.search)
    const dimension = (name: string, fallback: number) => { const value = Number(params.get(name)); return value > 0 && value <= 32768 ? value : fallback }
    return {
      document: newScreenshotDocument('live-region', '', dimension('regionWidth', Math.round(innerWidth * devicePixelRatio)), dimension('regionHeight', Math.round(innerHeight * devicePixelRatio))),
      png: new Uint8Array(),
      placement: { x: 0, y: 0, width: dimension('regionDipWidth', innerWidth), height: dimension('regionDipHeight', innerHeight) }
    }
  })
  return <ScreenshotEditor payload={payload} floating liveRegion initialSelection={false} onCancel={() => void window.dustdesk.cancelScreenshotOverlay()} />
}
