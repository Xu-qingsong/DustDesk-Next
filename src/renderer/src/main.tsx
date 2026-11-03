import React, { lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import './productivity.css'
import './screenshot/screenshot.css'
import 'react-day-picker/style.css'
import './components/ui/controls.css'

const params = new URLSearchParams(window.location.search)
const isWidget = params.has('widget')
const isOverlay = params.has('overlay')
const App = lazy(() => import('./app/App').then(module => ({ default: module.App })))
const WidgetHost = lazy(() => import('./widgets/WidgetHost').then(module => ({ default: module.WidgetHost })))
const QuickCapture = lazy(() => import('./overlays/QuickCapture').then(module => ({ default: module.QuickCapture })))
const ScreenshotOverlay = lazy(() => import('./overlays/ScreenshotOverlay').then(module => ({ default: module.ScreenshotOverlay })))
const PinnedScreenshot = lazy(() => import('./screenshot/PinnedScreenshot').then(module => ({ default: module.PinnedScreenshot })))

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Suspense fallback={<div className="boot">正在打开 DustDesk</div>}>
    {params.has('pin') ? <PinnedScreenshot id={params.get('pin')!} /> : params.has('capture') ? <QuickCapture /> : isOverlay ? <ScreenshotOverlay /> : isWidget ? <WidgetHost /> : <App />}
    </Suspense>
  </React.StrictMode>
)
