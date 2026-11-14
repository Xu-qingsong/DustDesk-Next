import React, { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Camera, Check, FileText, Layers, MousePointer2, Move, RefreshCw, ShieldCheck, SunMoon, X } from 'lucide-react'
import { NumberInput } from '../components/ui/FormControls'
import { isComposingKey } from '../utils/keyboard'
import { probe, type ProbeDiagnostics, type CaptureRect } from './api'
import '../styles.css'
import '../components/ui/controls.css'
import './prototype.css'

const kind = new URLSearchParams(location.search).get('probe')
const ownLabel = kind ? 'probe-' + kind : 'main'
const PrototypeEditor = lazy(() => import('./PrototypeEditor').then(module => ({ default: module.PrototypeEditor })))
const WorkspaceProbe = lazy(() => import('./WorkspaceProbe').then(module => ({ default: module.WorkspaceProbe })))

function NativePrototype() {
  const [diagnostics, setDiagnostics] = useState<ProbeDiagnostics>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [files, setFiles] = useState<string[]>([])
  const [preview, setPreview] = useState('')
  const [captureBytes, setCaptureBytes] = useState<Uint8Array>()
  const [edit, setEdit] = useState(false)
  const [dark, setDark] = useState(false)
  const [opacity, setOpacity] = useState(100)
  const [rect, setRect] = useState<CaptureRect>()
  const start = useRef<{ x: number; y: number } | undefined>(undefined)
  const previewUrl = useRef('')
  const refresh = async () => setDiagnostics(await probe.diagnostics())
  const run = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await operation(); await refresh() } catch (reason) { setError(String(reason)) } finally { setBusy(false) }
  }
  const showCapture = (png: Uint8Array) => {
    setCaptureBytes(png)
    const url = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: 'image/png' }))
    URL.revokeObjectURL(previewUrl.current); previewUrl.current = url; setPreview(url)
  }
  const capture = async (selection: CaptureRect) => showCapture(await probe.capture(selection))
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let stopCapture: (() => void) | undefined
    void refresh().catch(reason => { if (!disposed) setError(String(reason)) })
    void probe.onDrop(paths => setFiles(paths)).then(stop => { if (disposed) stop(); else unsubscribe = stop }).catch(reason => { if (!disposed) setError(String(reason)) })
    if (ownLabel === 'main' || kind === 'pin') {
      void probe.onCaptured(() => { void probe.readCapture().then(png => { if (!disposed) showCapture(png) }).catch(reason => { if (!disposed) setError(String(reason)) }) }).then(stop => { if (disposed) stop(); else stopCapture = stop })
      if (kind === 'pin') void probe.readCapture().then(png => { if (!disposed) showCapture(png) }).catch(() => {})
    }
    return () => { disposed = true; unsubscribe?.(); stopCapture?.(); URL.revokeObjectURL(previewUrl.current) }
  }, [])
  useEffect(() => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; document.documentElement.dataset.probe = kind ?? 'main' }, [dark])
  useEffect(() => {
    if (kind !== 'overlay') return
    const keyboard = (event: KeyboardEvent) => {
      if (isComposingKey(event)) return
      if (event.key === 'Escape') { event.preventDefault(); void run(() => probe.control(ownLabel, { visible: false })) }
      if (event.key === 'Enter' && rect && !busy) { event.preventDefault(); void run(() => capture(rect)) }
    }
    document.addEventListener('keydown', keyboard)
    return () => document.removeEventListener('keydown', keyboard)
  }, [rect, busy])
  if (kind === 'overlay') {
    const own = diagnostics?.windows.find(window => window.label === ownLabel)
    const point = (event: React.PointerEvent) => ({ x: Math.round(event.clientX * (own?.scaleFactor ?? devicePixelRatio)) + (own?.x ?? 0), y: Math.round(event.clientY * (own?.scaleFactor ?? devicePixelRatio)) + (own?.y ?? 0) })
    return <main className="probe-overlay" onPointerDown={event => { if (event.target !== event.currentTarget || !own || busy) return; start.current = point(event); setRect(undefined); event.currentTarget.setPointerCapture(event.pointerId) }} onPointerMove={event => { if (!start.current) return; const end = point(event); setRect({ x: Math.min(start.current.x, end.x), y: Math.min(start.current.y, end.y), width: Math.abs(end.x - start.current.x), height: Math.abs(end.y - start.current.y) }) }} onPointerUp={() => { start.current = undefined }}>
    <div className="probe-overlay-help" role="status">拖动选择实时桌面区域 · Enter 捕获 · Esc 取消 · 确认前不截屏</div>
      {rect && own && <div className="probe-selection" style={{ left: (rect.x - own.x) / own.scaleFactor, top: (rect.y - own.y) / own.scaleFactor, width: rect.width / own.scaleFactor, height: rect.height / own.scaleFactor }}><span>{rect.width} × {rect.height}</span></div>}
      {error && <div role="alert" className="probe-overlay-help">{error}</div>}
    </main>
  }
  if (kind) return <main className="probe-widget" data-testid="native-probe">
    <header onPointerDown={event => { if (!(event.target as HTMLElement).closest('button')) void probe.drag().catch(reason => setError(String(reason))) }}><Move size={16} aria-hidden /><strong>{kind === 'widget' ? '透明小组件验证' : '贴图窗口验证'}</strong><button aria-label="关闭验证窗口" onClick={() => void run(() => probe.control(ownLabel, { close: true }))}><X size={16} aria-hidden /></button></header>
    <p>此窗口使用真实 Tauri 原生窗口。可拖动标题、调整边缘及从主窗口切换置顶和穿透。</p>
    {preview && <img src={preview} alt="贴图验证原始像素" className="probe-preview" />}
    {kind === 'widget' && <Suspense fallback={<p>正在读取隔离工作区…</p>}><WorkspaceProbe /></Suspense>}
    <label>中文输入法与草稿输入<input placeholder="在这里输入，不访问正式数据" aria-label="验证中文输入" /></label>
    <small>鼠标穿透后，通过托盘“恢复所有窗口的鼠标操作”恢复。</small>
    {error && <p role="alert">{error}</p>}
  </main>
  return <main className="probe-main" data-testid="native-probe">
    <header className="probe-title"><div><p className="probe-eyebrow">DustDesk · Tauri 2 · P1</p><h1>原生能力验证</h1></div><button aria-label="切换明暗主题" onClick={() => setDark(value => !value)}><SunMoon size={20} aria-hidden /></button></header>
    <p className="probe-notice"><ShieldCheck size={20} aria-hidden />隔离预览，不读取正式工作区、不写系统剪贴板；尚未替换 Electron。</p>
    <section aria-labelledby="probe-actions"><h2 id="probe-actions">窗口与捕获</h2><div className="probe-actions">
      <button disabled={busy} onClick={() => void run(() => probe.open('widget'))}><Layers size={20} aria-hidden />透明小组件</button>
      <button disabled={busy} onClick={() => void run(() => probe.open('pin'))}><FileText size={20} aria-hidden />贴图窗口</button>
      <button disabled={busy} onClick={() => void run(() => probe.open('overlay'))}><Camera size={20} aria-hidden />实时区域框选</button>
      <button disabled={busy} onClick={() => void run(async () => { await probe.open('widget'); showCapture(await probe.captureWindow('probe-widget')) })}><Camera size={20} aria-hidden />原生窗口截图</button>
      <button disabled={busy} onClick={() => void run(() => probe.restore())}><MousePointer2 size={20} aria-hidden />恢复窗口操作</button>
      <button disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={20} aria-hidden />刷新原生状态</button>
    </div><label className="probe-opacity">窗口透明度（10–100%）<NumberInput aria-label="窗口透明度" value={opacity} min={10} max={100} onValueChange={value => setOpacity(Number(value))} /></label></section>
    {error && <p className="probe-error" role="alert">{error}</p>}
    <Suspense fallback={<p>正在加载工作区验证…</p>}><WorkspaceProbe initialize /></Suspense>
    <section aria-labelledby="probe-windows"><h2 id="probe-windows">真实窗口状态</h2>{!diagnostics ? <p role="status">正在读取…</p> : <><p>v{diagnostics.version} · {diagnostics.platform} · {diagnostics.monitors.length} 个显示器</p><ul className="probe-windows">{diagnostics.windows.map(window => <li key={window.label}><div><strong>{window.label}</strong><small>{window.width} × {window.height} · ({window.x}, {window.y}) · DPI {window.scaleFactor} · {window.visible ? '显示' : '隐藏'}</small></div>{window.label !== 'main' && <div className="probe-actions"><button disabled={busy} aria-pressed={window.alwaysOnTop} onClick={() => void run(() => probe.control(window.label, { topmost: !window.alwaysOnTop }))}>置顶 {window.alwaysOnTop && <Check size={16} aria-hidden />}</button><button disabled={busy} aria-pressed={window.mouseThrough} onClick={() => void run(() => probe.control(window.label, { mouseThrough: !window.mouseThrough }))}>鼠标穿透</button><button disabled={busy} onClick={() => void run(() => probe.control(window.label, { opacity: Math.round(opacity * 2.55) }))}>应用透明度</button></div>}</li>)}</ul><p className="probe-path">独立浏览器目录：{diagnostics.profileDirectory}</p>{diagnostics.shortcutError && <p role="alert">快捷键注册失败：{diagnostics.shortcutError}</p>}</>}</section>
    <section><h2>显示器与原生文件拖入</h2>{diagnostics?.monitors.map((monitor, index) => <p key={index}>{monitor.name || '显示器 ' + (index + 1)} · {monitor.width} × {monitor.height} · ({monitor.x}, {monitor.y}) · DPI {monitor.scaleFactor} <button disabled={busy} onClick={() => void run(() => probe.open('overlay', index))}>在此框选</button></p>)}<div className="probe-drop" data-testid="native-drop">拖入文件，仅验证路径事件，不读取文件内容。{files.length > 0 && <ul>{files.map(path => <li key={path}>{path}</li>)}</ul>}</div></section>
    {preview && <section><h2>选区原始像素预览</h2><img src={preview} alt="确认选区后捕获的桌面区域" className="probe-preview" /></section>}
    {captureBytes && <><button onClick={() => setEdit(value => !value)}>{edit ? '收起编辑器' : '打开现有截图编辑器'}</button>{edit && <Suspense fallback={<p role="status">正在加载编辑器…</p>}><PrototypeEditor png={captureBytes} /></Suspense>}</>}
    <footer><span>验证完毕请明确退出，关闭主窗口会驻留托盘。</span><button disabled={busy} onClick={() => void run(() => probe.quit())}>退出迁移验证</button></footer>
  </main>
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><NativePrototype /></React.StrictMode>)
