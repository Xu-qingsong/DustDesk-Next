import React, { useState } from 'react'
import { Crop, Download, Pin, RefreshCw, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import { Empty, PageHeader, Panel } from '../components/common'
import { composeScreenshot, createCanvas, loadImage, redactPixels } from '../utils/screenshot'
import { useScreenshotCapture } from '../hooks/useScreenshotCapture'
import { useDialogFocus } from '../hooks/useDialogFocus'

type Snapshot = { base: string; marks: string | null; number: number }
type Tool = 'select' | 'pen' | 'line' | 'arrow' | 'rectangle' | 'text' | 'number' | 'mosaic' | 'blur' | 'eraser'

export function ScreenshotPage({ initialImage }: { initialImage?: { dataUrl: string } | null }) {
  const [documentState, setDocumentState] = useState<Snapshot | null>(null)
  const image = documentState?.base ?? null
  const [mode, setMode] = useState<'Region' | 'Window' | 'FullScreen'>('Region')
  const [tool, setTool] = useState<Tool>('select')
  const [history, setHistory] = useState<Snapshot[]>([])
  const [redo, setRedo] = useState<Snapshot[]>([])
  const [busy, setBusy] = useState(false)
  const [actionBusy, setActionBusy] = useState<'save' | 'pin' | null>(null)
  const actionLock = React.useRef(false)
  const [pendingText, setPendingText] = useState<{ x: number; y: number; before: Snapshot } | null>(null)
  const [textDraft, setTextDraft] = useState('')
  useDialogFocus(Boolean(pendingText), '.screenshot-text-dialog', () => setPendingText(null))
  const busyRef = React.useRef(false)
  const canvasRef = React.useRef<HTMLCanvasElement>(null)
  const baseRef = React.useRef<HTMLCanvasElement | null>(null)
  const beforeStroke = React.useRef<Snapshot | null>(null)
  const strokeSource = React.useRef<HTMLCanvasElement | null>(null)
  const drawing = React.useRef(false)
  const start = React.useRef({ x: 0, y: 0 })
  const cropStart = React.useRef({ x: 0, y: 0 })
  const numberRef = React.useRef(1)

  const restore = (snapshot: Snapshot) => {
    busyRef.current = true; setBusy(true); setDocumentState(snapshot)
  }
  const reset = (source: string) => {
    drawing.current = false; setPendingText(null); setHistory([]); setRedo([]); setTool('select')
    restore({ base: source, marks: null, number: 1 })
  }
  const captureState = useScreenshotCapture(reset)
  React.useEffect(() => { if (initialImage) reset(initialImage.dataUrl) }, [initialImage])
  React.useEffect(() => {
    if (!documentState) return
    let cancelled = false
    void Promise.all([loadImage(documentState.base), documentState.marks ? loadImage(documentState.marks) : null]).then(([base, marks]) => {
      if (cancelled || !canvasRef.current) return
      const canvas = canvasRef.current
      const background = createCanvas(base.naturalWidth, base.naturalHeight)
      background.getContext('2d')!.drawImage(base, 0, 0)
      baseRef.current = background
      canvas.width = background.width; canvas.height = background.height
      if (marks) canvas.getContext('2d')!.drawImage(marks, 0, 0)
      numberRef.current = documentState.number
    }).catch(() => { if (!cancelled) toast.error('无法读取截图') }).finally(() => {
      if (!cancelled) { busyRef.current = false; setBusy(false) }
    })
    return () => { cancelled = true }
  }, [documentState])
  const snapshot = (): Snapshot | null => image && canvasRef.current ? { base: image, marks: canvasRef.current.toDataURL('image/png'), number: numberRef.current } : null
  const capture = async () => {
    if (busyRef.current || actionLock.current || drawing.current || pendingText) return
    await captureState.capture(mode)
  }
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * canvas.width / rect.width)), y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * canvas.height / rect.height)) }
  }
  const begin = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || busyRef.current || actionLock.current || captureState.isBusy() || pendingText || drawing.current) return
    const value = point(event); const canvas = canvasRef.current; const base = baseRef.current
    if (!value || !canvas || !base) return
    beforeStroke.current = snapshot()
    strokeSource.current = tool === 'mosaic' || tool === 'blur' ? composeScreenshot(base, canvas) : null
    drawing.current = true; start.current = value; cropStart.current = value
    event.currentTarget.setPointerCapture(event.pointerId)
    if ((tool === 'mosaic' || tool === 'blur') && strokeSource.current) redactPixels(strokeSource.current, canvas, value.x, value.y, tool)
  }
  const draw = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || busyRef.current) return
    const canvas = canvasRef.current; const value = point(event); const context = canvas?.getContext('2d')
    if (!canvas || !value || !context) return
    if ((tool === 'mosaic' || tool === 'blur') && strokeSource.current) {
      const steps = Math.max(1, Math.ceil(Math.hypot(value.x - start.current.x, value.y - start.current.y) / 8))
      for (let i = 1; i <= steps; i++) redactPixels(strokeSource.current, canvas, start.current.x + (value.x - start.current.x) * i / steps, start.current.y + (value.y - start.current.y) * i / steps, tool)
      start.current = value
    } else if (tool === 'pen' || tool === 'eraser') {
      context.save(); context.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over'
      context.strokeStyle = '#ff4d57'; context.lineWidth = tool === 'eraser' ? 26 : 4; context.lineCap = 'round'
      context.beginPath(); context.moveTo(start.current.x, start.current.y); context.lineTo(value.x, value.y); context.stroke(); context.restore()
      start.current = value
    }
  }
  const end = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || busyRef.current) return
    drawing.current = false
    const canvas = canvasRef.current; const base = baseRef.current; const value = point(event); const context = canvas?.getContext('2d')
    if (!canvas || !base || !value || !context || !beforeStroke.current) return
    if (tool === 'text') {
      setTextDraft(''); setPendingText({ ...value, before: beforeStroke.current }); return
    }
    if (tool === 'select') {
      const left = Math.floor(Math.min(cropStart.current.x, value.x)); const top = Math.floor(Math.min(cropStart.current.y, value.y))
      const width = Math.min(canvas.width - left, Math.floor(Math.abs(value.x - cropStart.current.x)))
      const height = Math.min(canvas.height - top, Math.floor(Math.abs(value.y - cropStart.current.y)))
      if (width <= 4 || height <= 4) return
      const background = createCanvas(width, height); const marks = createCanvas(width, height)
      background.getContext('2d')!.drawImage(base, left, top, width, height, 0, 0, width, height)
      marks.getContext('2d')!.drawImage(canvas, left, top, width, height, 0, 0, width, height)
      setHistory(previous => [...previous, beforeStroke.current!].slice(-30)); setRedo([])
      restore({ base: background.toDataURL('image/png'), marks: marks.toDataURL('image/png'), number: numberRef.current })
      setTool('pen')
      return
    }
    context.save(); context.globalCompositeOperation = 'source-over'
    context.strokeStyle = '#ff4d57'; context.fillStyle = '#ff4d57'; context.lineWidth = 4; context.lineCap = 'round'
    if (tool === 'rectangle') context.strokeRect(start.current.x, start.current.y, value.x - start.current.x, value.y - start.current.y)
    if (tool === 'line' || tool === 'arrow') {
      context.beginPath(); context.moveTo(start.current.x, start.current.y); context.lineTo(value.x, value.y); context.stroke()
      if (tool === 'arrow') {
        const angle = Math.atan2(value.y - start.current.y, value.x - start.current.x)
        context.beginPath(); context.moveTo(value.x, value.y)
        context.lineTo(value.x - 14 * Math.cos(angle - Math.PI / 6), value.y - 14 * Math.sin(angle - Math.PI / 6))
        context.lineTo(value.x - 14 * Math.cos(angle + Math.PI / 6), value.y - 14 * Math.sin(angle + Math.PI / 6))
        context.closePath(); context.fill()
      }
    }
    if (tool === 'number') {
      context.font = 'bold 24px Segoe UI, sans-serif'
      context.fillText(String(numberRef.current++), value.x, value.y)
    }
    context.restore()
    setHistory(previous => [...previous, beforeStroke.current!].slice(-30)); setRedo([])
    strokeSource.current = null
  }
  const cancel = () => {
    if (!drawing.current) return
    drawing.current = false
    if (beforeStroke.current) restore(beforeStroke.current)
  }
  const undo = () => {
    if (busyRef.current || actionLock.current || captureState.isBusy() || pendingText || drawing.current) return
    const previous = history.at(-1); const current = snapshot()
    if (!previous || !current) return
    setRedo(items => [...items, current]); setHistory(history.slice(0, -1)); restore(previous)
  }
  const redoAction = () => {
    if (busyRef.current || actionLock.current || captureState.isBusy() || pendingText || drawing.current) return
    const next = redo.at(-1); const current = snapshot()
    if (!next || !current) return
    setHistory(items => [...items, current].slice(-30)); setRedo(redo.slice(0, -1)); restore(next)
  }
  const compose = () => {
    if (busyRef.current || !canvasRef.current || !baseRef.current) return ''
    return composeScreenshot(baseRef.current, canvasRef.current).toDataURL('image/png')
  }
  const exportImage = async (action: 'save' | 'pin') => {
    if (actionLock.current || busyRef.current || captureState.isBusy() || drawing.current || pendingText) return
    actionLock.current = true; setActionBusy(action)
    try {
      const dataUrl = compose()
      if (!dataUrl) { toast.error('图像尚未就绪，请稍后重试'); return }
      if (action === 'save') {
        const result = await window.dustdesk.saveScreenshot(dataUrl)
        result.ok ? toast.success(`截图已保存：${result.path}`) : toast.error(result.error ?? '保存失败，请重试')
      } else {
        const result = await window.dustdesk.pinScreenshot(dataUrl)
        result.ok ? toast.success('截图已贴到桌面') : toast.error(result.error ?? '贴图失败，请重试')
      }
    } catch (error) {
      toast.error(`${action === 'save' ? '保存' : '贴图'}失败，请重试${error instanceof Error ? `：${error.message}` : ''}`)
    } finally { actionLock.current = false; setActionBusy(null) }
  }
  const addText = (event: React.FormEvent) => {
    event.preventDefault()
    const context = canvasRef.current?.getContext('2d'); const value = textDraft.trim()
    if (!pendingText || !context || !value) return
    context.save(); context.globalCompositeOperation = 'source-over'; context.fillStyle = '#ff4d57'; context.font = 'bold 24px Segoe UI, sans-serif'
    context.fillText(value, pendingText.x, pendingText.y); context.restore()
    const before = pendingText.before
    setHistory(items => [...items, before].slice(-30)); setRedo([]); setPendingText(null)
  }
  const controlsDisabled = busy || Boolean(actionBusy) || captureState.busy || Boolean(pendingText)
  return <>
    <PageHeader title="截图编辑" action={<div className="segmented">
      {(['Region', 'Window', 'FullScreen'] as const).map((item, index) => <button key={item} disabled={controlsDisabled} className={mode === item ? 'selected' : ''} onClick={() => setMode(item)}>{['区域', '窗口', '全屏'][index]}</button>)}
      <button className="selected" disabled={controlsDisabled} onClick={() => void capture()}><Crop size={14} />{captureState.busy ? '捕获中…' : '捕获'}</button>
    </div>} />
    <Panel className="screenshot-studio">
      <div className="studio-toolbar" aria-busy={busy || Boolean(actionBusy) || captureState.busy}>
        <div className="studio-actions"><div className="segmented">
          {([['select', '裁剪'], ['pen', '画笔'], ['line', '线条'], ['arrow', '箭头'], ['rectangle', '矩形'], ['text', '文字'], ['number', '序号'], ['mosaic', '马赛克'], ['blur', '模糊'], ['eraser', '橡皮擦']] as const).map(([item, label]) => <button key={item} disabled={controlsDisabled || !image} className={tool === item ? 'selected' : ''} onClick={() => setTool(item)}>{label}</button>)}
        </div><button className="icon-button" title="撤销" aria-label="撤销" disabled={controlsDisabled || !history.length} onClick={undo}><Undo2 size={15} /></button><button className="icon-button" title="重做" aria-label="重做" disabled={controlsDisabled || !redo.length} onClick={redoAction}><RefreshCw size={15} /></button></div>
        <div className="studio-actions"><button className="secondary-button" disabled={controlsDisabled || !image} onClick={() => void exportImage('pin')}><Pin size={15} />{actionBusy === 'pin' ? '贴图中…' : '贴到桌面'}</button><button className="secondary-button" disabled={controlsDisabled || !image} onClick={() => void exportImage('save')}><Download size={15} />{actionBusy === 'save' ? '保存中…' : '保存截图'}</button></div>
      </div>
      <div className="canvas-stage">{image ? <div className="canvas-wrap"><img src={image} alt="截图预览" /><canvas ref={canvasRef} onPointerDown={begin} onPointerMove={draw} onPointerUp={end} onPointerCancel={cancel} onLostPointerCapture={cancel} /></div> : <Empty icon={Crop} title="还没有截图" description="选择捕获模式后，截图会显示在这里。" action={<button className="primary-button" disabled={controlsDisabled} onClick={() => void capture()}><Crop size={15} />{captureState.busy ? '捕获中…' : '开始捕获'}</button>} />}</div>
    </Panel>
    {captureState.windowPicker}
    {pendingText && <div className="modal-overlay"><div className="library-modal screenshot-text-dialog" role="dialog" aria-modal="true" aria-labelledby="screenshot-text-title">
      <div className="modal-header"><h3 id="screenshot-text-title">添加文字标注</h3></div>
      <form className="modal-form" onSubmit={addText}><div className="modal-body"><label>标注文字<input autoFocus maxLength={500} value={textDraft} onChange={event => setTextDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault() }} /></label></div><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setPendingText(null)}>取消</button><button type="submit" className="primary-button" disabled={!textDraft.trim()}>添加文字</button></div></form>
    </div></div>}
  </>
}
