import { QuickCapture } from './overlays/QuickCapture'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import { WidgetHost } from './widgets/WidgetHost'
import { ScreenshotOverlay } from './overlays/ScreenshotOverlay'
import './styles.css'
import './productivity.css'

const params = new URLSearchParams(window.location.search)
const isWidget = params.has('widget')
const isOverlay = params.has('overlay')

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {params.has('capture') ? <QuickCapture /> : isOverlay ? <ScreenshotOverlay /> : isWidget ? <WidgetHost /> : <App />}
  </React.StrictMode>
)
