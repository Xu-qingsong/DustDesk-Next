import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowUpRight, Circle, Copy, Crop, Download, Eraser, Highlighter, Maximize, MousePointer2, Move, Pencil, Pin, Redo2, Save, Shield, Square, Type, Undo2, X, Hash, Minus, Grid2X2, Droplets } from 'lucide-react'
import { annotationBounds, applyDocumentEdit, clampRect, constrainedPoint, defaultAnnotationStyle, documentEdit, hitAnnotation, rectFromPoints, screenshotColors, transformAnnotation } from '../../../shared/screenshotDocument'
import type { AnnotationStyle, ScreenshotAction, ScreenshotAnnotation, ScreenshotDocument, ScreenshotPayload, ScreenshotPoint, ScreenshotRect, ScreenshotTool } from '../../../shared/screenshotDocument'
import { createScreenshotRenderer } from './workerClient'
import { paintAnnotation } from './render'
import { resizeCursors, screenshotToolCursors } from './cursors'

const tools: [ScreenshotTool, string, React.ElementType][] = [['select', '选择标注', MousePointer2], ['crop', '调整选区', Crop], ['pen', '画笔', Pencil], ['highlighter', '高亮', Highlighter], ['line', '直线', Minus], ['arrow', '箭头', ArrowUpRight], ['rectangle', '矩形', Square], ['ellipse', '椭圆', Circle], ['text', '文字', Type], ['number', '序号', Hash], ['mosaic', '马赛克', Grid2X2], ['blur', '模糊', Droplets], ['cover', '实色遮盖', Shield], ['eraser', '删除标注', Eraser]]
type PointerInput = { clientX: number; clientY: number; button: number; pointerId: number; shiftKey: boolean; target: EventTarget; currentTarget: HTMLDivElement }
const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'] as const
type Handle = typeof handles[number]
type Edit = ReturnType<typeof documentEdit>
type Gesture = { before: ScreenshotDocument; start: ScreenshotPoint; rect?: ScreenshotRect; handle?: Handle; annotation?: ScreenshotAnnotation; type: 'draw' | 'crop' | 'moveCrop' | 'resizeCrop' | 'move' | 'resize' | 'pan'; pan?: ScreenshotPoint; cropBefore?: ScreenshotRect | null }

function resizeRect(rect: ScreenshotRect, handle: Handle, delta: ScreenshotPoint): ScreenshotRect {
  let left = rect.x, top = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height
  if (handle.includes('w')) left = Math.min(right - 1, left + delta.x)
  if (handle.includes('e')) right = Math.max(left + 1, right + delta.x)
  if (handle.includes('n')) top = Math.min(bottom - 1, top + delta.y)
  if (handle.includes('s')) bottom = Math.max(top + 1, bottom + delta.y)
  return { x: left, y: top, width: right - left, height: bottom - top }
}

export function ScreenshotEditor({ payload, floating = false, liveRegion = false, initialSelection = true, active = true, onCancel, directAction }: { payload: ScreenshotPayload; floating?: boolean; liveRegion?: boolean; initialSelection?: boolean; active?: boolean; onCancel?: () => void; directAction?: 'copy' | 'pin' }) {
  const [doc, setDoc] = useState(payload.document)
  const docRef = useRef(doc)
  const updateDoc = (value: ScreenshotDocument) => { docRef.current = value; setDoc(value) }
  const [tool, setTool] = useState<ScreenshotTool>(payload.initialTool || (initialSelection ? 'select' : 'crop'))
  const [selected, setSelected] = useState<string>()
  const [style, setStyle] = useState<AnnotationStyle>({ ...defaultAnnotationStyle })
  const [crop, setCrop] = useState<ScreenshotRect | null>(initialSelection ? payload.document.crop : null)
  const cropRef = useRef(crop)
  const updateCrop = (value: ScreenshotRect | null) => { cropRef.current = value; setCrop(value) }
  const [history, setHistory] = useState<Edit[]>([]), [redo, setRedo] = useState<Edit[]>([])
  const [text, setText] = useState<{ annotation: ScreenshotAnnotation; draft: string } | null>(null)
  const [zoom, setZoom] = useState<number | null>(null), [pan, setPan] = useState({ x: 0, y: 0 })
  const [size, setSize] = useState({ width: 100, height: 100 })
  // Allocate transparent preview surfaces before the first tool gesture. This
  // does not capture any desktop pixels.
  const [hasPixels, setHasPixels] = useState(liveRegion || Boolean(payload.png.length))
  const [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const [format, setFormat] = useState<'png' | 'jpg'>('png')
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), toolbar = useRef<HTMLDivElement>(null)
  const loadingCanvas = useRef<HTMLCanvasElement>(null), sourceLoading = useRef(false), presentedSource = useRef('')
  const localPreview = useRef<{ canvas: HTMLCanvasElement; annotations: ScreenshotAnnotation[] } | null>(null)
  const renderer = useRef<ReturnType<typeof createScreenshotRenderer> | null>(null)
  const gesture = useRef<Gesture | null>(null), actionLock = useRef(false), space = useRef(false)
  const refreshCursor = useRef<() => void>(() => {})
  const [toolbarSize, setToolbarSize] = useState({ width: 700, height: 126 })
  const captureLock = useRef<Promise<void> | null>(null)
  const nativeScale = 1 / (window.devicePixelRatio || 1)
  const placement = floating ? payload.placement : undefined
  const scale = zoom ?? (placement ? placement.width / doc.width : Math.min(size.width / doc.width, size.height / doc.height, floating ? Infinity : nativeScale))
  const offset = { x: (placement && zoom === null ? placement.x : (size.width - doc.width * scale) / 2) + pan.x, y: (placement && zoom === null ? placement.y : (size.height - doc.height * scale) / 2) + pan.y }
  const selectedAnnotation = doc.annotations.find(a => a.id === selected)
  const selectedBounds = selectedAnnotation && annotationBounds(selectedAnnotation)
  const hasSelection = Boolean(crop)
  const toolCursor = busy || !ready ? 'progress' : screenshotToolCursors[hasSelection ? tool : 'crop']
  const [liveDirect, setLiveDirect] = useState<'copy' | 'pin'>()
  useEffect(() => { void window.dustdesk.loadWorkspace().then(state => { if (liveRegion && ['copy', 'pin'].includes(state.Settings.ScreenshotAfterAction)) setLiveDirect(state.Settings.ScreenshotAfterAction as 'copy' | 'pin'); if (state.Settings.ScreenshotFormat === 'jpg' || state.Settings.ScreenshotFormat === 'jpeg') setFormat('jpg') }).catch(() => {}) }, [])

  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (host.current) setSize({ width: host.current.clientWidth, height: host.current.clientHeight })
      if (toolbar.current) setToolbarSize({ width: toolbar.current.offsetWidth, height: toolbar.current.offsetHeight })
    })
    if (host.current) observer.observe(host.current)
    if (toolbar.current) observer.observe(toolbar.current)
    return () => observer.disconnect()
  }, [hasSelection])

  // One worker request at a time. New pointer previews replace the queued preview.
  const latest = useRef<ScreenshotDocument | null>(null), rendering = useRef(false), frame = useRef(0), epoch = useRef(0)
  const paint = () => {
    if (!latest.current || !renderer.current) return
    const target = latest.current
    if (!target.sourceAssetId || sourceLoading.current || liveRegion && target.sourceAssetId !== presentedSource.current) {
      // The first stroke is visible immediately over the live desktop. Native
      // pixel capture continues independently; effects get a range preview until
      // those pixels arrive, then the worker renders their actual result.
      const surface = presentedSource.current ? loadingCanvas.current : canvas.current
      const context = surface?.getContext('2d')
      if (context) {
        const previous = localPreview.current?.canvas === surface ? localPreview.current.annotations : []
        const changed = [...previous.filter(a => !target.annotations.includes(a)), ...target.annotations.filter(a => !previous.includes(a))]
        latest.current = null
        if (!changed.length) return
        // Only clear/repaint affected pixels; avoid uploading a full 4K
        // transparent surface on every pointer sample.
        const bounds = changed.map(a => { const r = annotationBounds(a), padding = Math.max(16, a.style.width * 3); return { x: r.x - padding, y: r.y - padding, right: r.x + r.width + padding, bottom: r.y + r.height + padding } })
        const x = Math.max(0, Math.floor(Math.min(...bounds.map(r => r.x)))), y = Math.max(0, Math.floor(Math.min(...bounds.map(r => r.y))))
        const width = Math.max(1, Math.min(target.width, Math.ceil(Math.max(...bounds.map(r => r.right)))) - x), height = Math.max(1, Math.min(target.height, Math.ceil(Math.max(...bounds.map(r => r.bottom)))) - y)
        context.save(); context.beginPath(); context.rect(x, y, width, height); context.clip(); context.clearRect(x, y, width, height)
        for (const annotation of target.annotations) {
          if (['mosaic', 'blur', 'cover'].includes(annotation.kind)) {
            const preview = { ...annotation, kind: annotation.style.mode === 'brush' ? 'pen' as const : 'rectangle' as const, style: { ...annotation.style, filled: false } }
            paintAnnotation(context, preview)
          } else paintAnnotation(context, annotation)
        }
        context.restore()
        localPreview.current = { canvas: surface!, annotations: target.annotations }
      }
      return
    }
    if (rendering.current) return
    latest.current = null; rendering.current = true
    const generation = epoch.current
    void renderer.current.render(target).then(result => {
      if (generation !== epoch.current || target.sourceAssetId !== docRef.current.sourceAssetId) { result.bitmap?.close(); return }
      if (result.bitmap && canvas.current) {
        const context = canvas.current.getContext('2d')!
        const area = result.rect || { x: 0, y: 0, width: target.width, height: target.height }; context.clearRect(area.x, area.y, area.width, area.height); context.drawImage(result.bitmap, area.x, area.y); result.bitmap.close(); setReady(true)
      }
    }).catch(err => { if (generation === epoch.current) setError(err.message) }).finally(() => {
      if (generation !== epoch.current) return
      rendering.current = false
      if (latest.current) frame.current = requestAnimationFrame(paint)
    })
  }
  useEffect(() => {
    const generation = ++epoch.current
    const worker = createScreenshotRenderer(); renderer.current = worker; rendering.current = true
    presentedSource.current = ''; localPreview.current = null; sourceLoading.current = false
    if (!payload.png.length) {
      // Warm the drawing contexts while the user is selecting, rather than
      // mounting/allocating a native-resolution canvas on first pointerdown.
      for (const surface of [canvas.current, loadingCanvas.current]) { const context = surface?.getContext('2d'); context?.fillRect(0, 0, 1, 1); context?.clearRect(0, 0, 1, 1) }
      rendering.current = false; setReady(true); return () => { ++epoch.current; cancelAnimationFrame(frame.current); worker.dispose(); renderer.current = null; latest.current = null }
    }
    setReady(false)
    void worker.render(payload.document, payload.png).then(result => {
      if (generation !== epoch.current) { result.bitmap?.close(); return }
      if (result.bitmap && canvas.current) { canvas.current.getContext('2d')!.drawImage(result.bitmap, 0, 0); result.bitmap.close(); presentedSource.current = payload.document.sourceAssetId; setReady(true) }
    }).catch(err => { if (generation === epoch.current) setError(err.message) }).finally(() => {
      if (generation === epoch.current) { rendering.current = false; if (latest.current) frame.current = requestAnimationFrame(paint) }
    })
    return () => { ++epoch.current; cancelAnimationFrame(frame.current); worker.dispose(); renderer.current = null; latest.current = null; rendering.current = false }
  }, [payload])
  useEffect(() => { latest.current = docRef.current; cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(paint) }, [doc])

  const previewDoc = (value: ScreenshotDocument) => { docRef.current = value; latest.current = value; cancelAnimationFrame(frame.current); frame.current = requestAnimationFrame(paint) }

  const ensureSource = async () => {
    if (!liveRegion || !cropRef.current) return
    if (captureLock.current) return captureLock.current
    const current = docRef.current, crop = cropRef.current, source = current.sourceRect
    if (source && presentedSource.current === current.sourceAssetId && crop.x >= source.x && crop.y >= source.y && crop.x + crop.width <= source.x + source.width && crop.y + crop.height <= source.y + source.height) return
    const generation = epoch.current
    const task = (async () => {
      setError('')
      try {
        const ratio = current.width / payload.placement!.width
        const result = await window.dustdesk.selectScreenshotRegion({ x: crop.x / ratio, y: crop.y / ratio, width: crop.width / ratio, height: crop.height / ratio })
        if (generation !== epoch.current) throw Error('截图已取消')
        if (!result.ok || !result.payload) throw Error(result.error || '无法捕获选区，请重试')
        const editing = docRef.current
        const next = { ...result.payload.document, annotations: editing.annotations, nextNumber: editing.nextNumber, revision: editing.revision }
        if (gesture.current) gesture.current.before = { ...next, annotations: gesture.current.before.annotations, revision: gesture.current.before.revision, nextNumber: gesture.current.before.nextNumber }
        sourceLoading.current = true
        updateDoc(next); updateCrop(next.crop); setHasPixels(true)
        // Preserve the viewport/toolbar nodes while loading the region's pixels.
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
        let snapshot = next
        let rendered = await renderer.current!.render(snapshot, result.payload.png)
        // Pointer previews remain independent while the worker initializes.
        // Present only a current snapshot, so loading cannot rewind a stroke.
        while (generation === epoch.current && snapshot.annotations !== docRef.current.annotations) {
          rendered.bitmap?.close(); snapshot = docRef.current
          rendered = await renderer.current!.render(snapshot, undefined, false, 'png', true)
        }
        if (generation !== epoch.current) { rendered.bitmap?.close(); return }
        if (rendered.bitmap && canvas.current) {
          const context = canvas.current.getContext('2d')!; context.clearRect(0, 0, next.width, next.height); context.drawImage(rendered.bitmap, 0, 0); rendered.bitmap.close()
          presentedSource.current = next.sourceAssetId; localPreview.current = null
          loadingCanvas.current?.getContext('2d')?.clearRect(0, 0, next.width, next.height)
        }
      } finally {
        if (generation === epoch.current) { sourceLoading.current = false; if (latest.current) frame.current = requestAnimationFrame(paint) }
      }
    })()
    captureLock.current = task
    try { await task } finally { captureLock.current = null }
  }

  const commit = (next: ScreenshotDocument, before = docRef.current) => {
    const value = { ...next, revision: before.revision + 1 }
    const edit = documentEdit(before, value)
    if (!edit.changes.length && JSON.stringify(edit.beforeCrop) === JSON.stringify(edit.afterCrop) && edit.beforeNumber === edit.afterNumber) return
    setHistory(items => [...items, edit].slice(-100)); setRedo([]); updateDoc(value); docRef.current = value
  }
  const undo = (forward = false) => {
    if (busy || text || gesture.current) return
    const stack = forward ? redo : history, edit = stack.at(-1)
    if (!edit) return
    const value = applyDocumentEdit(docRef.current, edit, !forward)
    updateDoc(value); docRef.current = value; updateCrop(value.crop); setSelected(undefined)
    if (forward) { setRedo(stack.slice(0, -1)); setHistory(items => [...items, edit].slice(-100)) }
    else { setHistory(stack.slice(0, -1)); setRedo(items => [...items, edit]) }
  }
  const removeSelected = () => { if (selected) { commit({ ...docRef.current, annotations: docRef.current.annotations.filter(a => a.id !== selected) }); setSelected(undefined) } }
  const changeStyle = (patch: Partial<AnnotationStyle>) => {
    setStyle(current => ({ ...current, ...patch }))
    if (selected) commit({ ...docRef.current, annotations: docRef.current.annotations.map(a => a.id === selected ? { ...a, style: { ...a.style, ...patch } } : a) })
    if (text) setText({ ...text, annotation: { ...text.annotation, style: { ...text.annotation.style, ...patch } } })
  }
  const finishText = () => {
    if (!text) return
    const old = docRef.current.annotations.find(a => a.id === text.annotation.id)
    const annotation = { ...text.annotation, text: text.draft.slice(0, 5000) }
    if (text.draft.trim()) commit({ ...docRef.current, annotations: old ? docRef.current.annotations.map(a => a.id === old.id ? annotation : a) : [...docRef.current.annotations, annotation] })
    setText(null)
  }
  const cancelGesture = () => {
    if (gesture.current) { updateDoc(gesture.current.before); updateCrop(gesture.current.cropBefore ?? (gesture.current.cropBefore === null ? null : gesture.current.before.crop)); if (gesture.current.type === 'pan') setPan(gesture.current.pan!); gesture.current = null }
    updateCursor()
  }
  const finish = async (action: ScreenshotAction, override?: ScreenshotDocument) => {
    if (actionLock.current || !ready || text || gesture.current || !cropRef.current || !renderer.current || !floating && JSON.stringify(cropRef.current) !== JSON.stringify(docRef.current.crop)) return
    actionLock.current = true; setBusy(true); setError(''); setMessage('')
    const generation = epoch.current
    try {
      await ensureSource()
      setBusy(true)
      const current = override && !liveRegion ? override : docRef.current
      const result = action === 'openEditor' ? {} : await renderer.current.render(current, undefined, true)
      // Save As can choose JPEG independently of the current format dropdown.
      const jpeg = action === 'saveAs' || action === 'save' && format === 'jpg' ? (await renderer.current.render(current, undefined, true, 'jpg')).bytes : undefined
      if (generation !== epoch.current) return
      const output = await window.dustdesk.finishScreenshot({ requestId: crypto.randomUUID(), document: current, action, png: result.bytes, jpeg, format })
      if (!output.ok && !output.canceled) throw Error(output.error || '操作失败，请重试')
      if (output.ok) setMessage([output.path ? `已保存：${output.path}` : action === 'copy' ? '已复制编辑结果' : action === 'updatePin' ? '贴图已更新' : '操作完成', output.warning].filter(Boolean).join('；'))
    } catch (err) { if (generation === epoch.current) setError(err instanceof Error ? err.message : '导出失败，请重试') }
    finally { actionLock.current = false; if (generation === epoch.current) setBusy(false) }
  }
  const initialActionStarted = useRef(false)
  useEffect(() => { if (ready && payload.initialAction && !initialActionStarted.current) { initialActionStarted.current = true; void finish(payload.initialAction) } }, [ready])
  const keyboard = useRef<(event: KeyboardEvent) => void>(() => {}), keyboardBlur = useRef<() => void>(() => {})
  keyboard.current = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return
      const input = event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable)
      if (input) return
      if (event.code === 'Space') { event.preventDefault(); space.current = true; updateCursor(); return }
      if (busy && event.key !== 'Escape') return
      const ctrl = event.ctrlKey || event.metaKey
      if (event.key === 'Escape') {
        event.preventDefault()
        if (gesture.current) cancelGesture()
        else if (text) setText(null)
        else if (captureLock.current) onCancel?.()
        else if (crop && JSON.stringify(crop) !== JSON.stringify(doc.crop)) updateCrop(doc.crop)
        else onCancel?.()
      } else if (ctrl && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey) }
      else if (ctrl && event.key.toLowerCase() === 'y') { event.preventDefault(); undo(true) }
      else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeSelected() }
      else if (ctrl && event.key.toLowerCase() === 'c' || floating && event.key === 'Enter') { event.preventDefault(); void finish('copy') }
      else if (ctrl && event.key.toLowerCase() === 's') { event.preventDefault(); void finish(event.shiftKey ? 'saveAs' : 'save') }
    }
  keyboardBlur.current = () => { space.current = false; cancelGesture() }
  useEffect(() => {
    if (!active) return
    const key = (event: KeyboardEvent) => keyboard.current(event)
    const up = (event: KeyboardEvent) => { if (event.code === 'Space') { space.current = false; refreshCursor.current() } }
    const blur = () => keyboardBlur.current()
    window.addEventListener('keydown', key); window.addEventListener('keyup', up); window.addEventListener('blur', blur)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', up); window.removeEventListener('blur', blur); space.current = false; refreshCursor.current() }
  }, [active])
  const point = (event: { clientX: number; clientY: number }): ScreenshotPoint => {
    const rect = host.current!.getBoundingClientRect()
    return { x: Math.max(0, Math.min(docRef.current.width - 1, (event.clientX - rect.left - offset.x) / scale)), y: Math.max(0, Math.min(docRef.current.height - 1, (event.clientY - rect.top - offset.y) / scale)) }
  }
  const updateCursor = (event?: { clientX: number; clientY: number }) => {
    if (!host.current) return
    const g = gesture.current
    let cursor = toolCursor
    if (!busy && ready) {
      if (g?.type === 'pan') cursor = 'grabbing'
      else if (space.current) cursor = 'grab'
      else if (g?.type === 'resize' || g?.type === 'resizeCrop') cursor = resizeCursors[g.handle!] || toolCursor
      else if (g?.type === 'move' || g?.type === 'moveCrop') cursor = 'move'
      else if (!g && event) {
        const p = point(event), area = cropRef.current
        if (tool === 'crop' && area && p.x >= area.x && p.y >= area.y && p.x <= area.x + area.width && p.y <= area.y + area.height) cursor = 'move'
        else if (tool === 'select' && docRef.current.annotations.some(annotation => hitAnnotation(annotation, p, 6 / scale))) cursor = 'move'
      }
    }
    // Pointer hover only updates the native cursor, without rerendering tools.
    if (host.current.style.cursor !== cursor) host.current.style.cursor = cursor
  }
  refreshCursor.current = () => updateCursor()
  const begin = (event: PointerInput, capturePointer = true) => {
    if (event.button !== 0 && event.button !== 1 || !ready || text) return
    const origin = point(event), before = docRef.current
    const handle = (event.target as HTMLElement).dataset.handle as Handle | undefined
    if (space.current || event.button === 1) gesture.current = { type: 'pan', before, start: { x: event.clientX, y: event.clientY }, pan }
    else if (tool === 'crop' || !crop) {
      const inside = crop && origin.x >= crop.x && origin.y >= crop.y && origin.x <= crop.x + crop.width && origin.y <= crop.y + crop.height
      gesture.current = { type: handle ? 'resizeCrop' : inside ? 'moveCrop' : 'crop', before, start: origin, rect: crop || undefined, handle }
      if (handle && crop) gesture.current.start = { x: handle.includes('w') ? crop.x : handle.includes('e') ? crop.x + crop.width : origin.x, y: handle.includes('n') ? crop.y : handle.includes('s') ? crop.y + crop.height : origin.y }
      if (!inside && !handle) updateCrop({ ...origin, width: 1, height: 1 })
    } else if (tool === 'select' || tool === 'eraser') {
      const found = handle ? selectedAnnotation : [...before.annotations].reverse().find(a => hitAnnotation(a, origin, 6 / scale))
      setSelected(found?.id)
      if (found && tool === 'eraser') commit({ ...before, annotations: before.annotations.filter(a => a.id !== found.id) })
      else if (found) { setStyle(found.style); gesture.current = { type: handle ? 'resize' : 'move', before, start: origin, annotation: found, rect: annotationBounds(found), handle } }
    } else {
      if (origin.x < crop.x || origin.y < crop.y || origin.x > crop.x + crop.width || origin.y > crop.y + crop.height) return
      const annotation: ScreenshotAnnotation = { id: crypto.randomUUID(), kind: tool, points: [origin], style: { ...style } }
      if (tool === 'text') { setSelected(undefined); setText({ annotation, draft: '' }); return }
      if (tool === 'number') { annotation.number = before.nextNumber; commit({ ...before, annotations: [...before.annotations, annotation], nextNumber: before.nextNumber + 1 }); return }
      setSelected(undefined); gesture.current = { type: 'draw', before, start: origin, annotation }; previewDoc({ ...before, annotations: [...before.annotations, annotation] })
    }
    if (gesture.current) { gesture.current.cropBefore = crop; if (capturePointer) event.currentTarget.setPointerCapture(event.pointerId) }
    updateCursor(event)
  }
  const down = (event: React.PointerEvent<HTMLDivElement>) => {
    if (busy || gesture.current || captureLock.current && (tool === 'crop' || !cropRef.current)) return
    const input: PointerInput = { clientX: event.clientX, clientY: event.clientY, button: event.button, pointerId: event.pointerId, shiftKey: event.shiftKey, target: event.target as HTMLElement, currentTarget: event.currentTarget }
    if (!liveRegion || tool === 'crop' || !cropRef.current || tool === 'select' || tool === 'eraser' || event.button !== 0 || space.current) { begin(input); return }
    setHasPixels(true); begin(input)
    // Keep every pointer sample (including freehand curves) while the source is
    // captured. Loading never delays starting or ending the gesture.
    void ensureSource().catch(err => { setError(err instanceof Error ? err.message : '无法捕获选区') })
  }
  const move = (event: PointerInput) => {
    updateCursor(event)
    const g = gesture.current; if (!g) return
    if (g.type === 'pan') { setPan({ x: g.pan!.x + event.clientX - g.start.x, y: g.pan!.y + event.clientY - g.start.y }); return }
    const p = point(event), delta = { x: p.x - g.start.x, y: p.y - g.start.y }
    if (g.type === 'crop') updateCrop(clampRect(rectFromPoints(g.start, constrainedPoint(g.start, p, 'crop', event.shiftKey)), doc.width, doc.height))
    else if (g.type === 'moveCrop') updateCrop({ ...g.rect!, x: Math.round(Math.max(0, Math.min(doc.width - g.rect!.width, g.rect!.x + delta.x))), y: Math.round(Math.max(0, Math.min(doc.height - g.rect!.height, g.rect!.y + delta.y))) })
    else if (g.type === 'resizeCrop') updateCrop(clampRect(resizeRect(g.rect!, g.handle!, delta), doc.width, doc.height))
    else if (g.type === 'move' || g.type === 'resize') {
      const nextRect = g.type === 'resize' ? resizeRect(g.rect!, g.handle!, delta) : { ...g.rect!, x: g.rect!.x + delta.x, y: g.rect!.y + delta.y }
      const changed = transformAnnotation(g.annotation!, g.rect!, nextRect)
      previewDoc({ ...g.before, annotations: g.before.annotations.map(a => a.id === changed.id ? changed : a) })
    } else {
      const annotation = g.annotation!, brush = ['pen', 'highlighter'].includes(annotation.kind) || ['mosaic', 'blur', 'cover'].includes(annotation.kind) && annotation.style.mode === 'brush'
      if (brush) {
        const last = annotation.points.at(-1)!, distance = Math.hypot(p.x - last.x, p.y - last.y), steps = Math.max(1, Math.ceil(distance / Math.max(1, annotation.style.width / 3)))
        if (annotation.points.length + steps <= 20000) for (let i = 1; i <= steps; i++) annotation.points.push({ x: last.x + (p.x - last.x) * i / steps, y: last.y + (p.y - last.y) * i / steps })
      } else annotation.points = [g.start, constrainedPoint(g.start, p, annotation.kind, event.shiftKey)]
      previewDoc({ ...g.before, annotations: [...g.before.annotations, { ...annotation, points: [...annotation.points] }] })
    }
  }
  const up = (event: PointerInput) => {
    if (gesture.current) move(event)
    const g = gesture.current; gesture.current = null; if (!g) return
    updateCursor(event)
    if (g.type === 'draw' || g.type === 'move' || g.type === 'resize') commit(docRef.current, g.before)
    else if (g.type.includes('Crop') || g.type === 'crop') {
      const candidate = cropRef.current
      if (!candidate) return
      if (floating) {
        const next = { ...g.before, crop: candidate, revision: g.before.revision + 1 }
        commit(next, g.before)
        if (directAction || liveDirect) void finish((directAction || liveDirect)!, next)
      }
    }
  }
  const rectStyle = (rect: ScreenshotRect): React.CSSProperties => ({ left: offset.x + rect.x * scale, top: offset.y + rect.y * scale, width: rect.width * scale, height: rect.height * scale })
  const zoomAt = (value: number, center = { x: size.width / 2, y: size.height / 2 }) => {
    if (captureLock.current) return
    const next = Math.max(.05, Math.min(8, value))
    const px = (center.x - offset.x) / scale, py = (center.y - offset.y) / scale
    setZoom(next); setPan({ x: center.x - px * next - (size.width - doc.width * next) / 2, y: center.y - py * next - (size.height - doc.height * next) / 2 })
  }
  const toolbarLeft = Math.max(8, Math.min(size.width - toolbarSize.width - 8, offset.x + (crop?.x || 0) * scale))
  const wheelHandler = useRef<(event: WheelEvent) => void>(() => {})
  wheelHandler.current = (event: WheelEvent) => {
      event.preventDefault()
      if (busy) return
      const rect = host.current!.getBoundingClientRect()
      zoomAt(scale * (event.deltaY > 0 ? .9 : 1.1), { x: event.clientX - rect.left, y: event.clientY - rect.top })
    }
  useEffect(() => {
    const element = host.current, wheel = (event: WheelEvent) => wheelHandler.current(event)
    element?.addEventListener('wheel', wheel, { passive: false })
    return () => element?.removeEventListener('wheel', wheel)
  }, [])
  const below = offset.y + ((crop?.y || 0) + (crop?.height || 0)) * scale + 12
  const toolbarTop = Math.max(8, Math.min(size.height - toolbarSize.height - 8, below + toolbarSize.height <= size.height ? below : offset.y + (crop?.y || 0) * scale + 30))
  const activeStyle = selectedAnnotation?.style || text?.annotation.style || style
  const pendingCrop = !floating && crop && JSON.stringify(crop) !== JSON.stringify(doc.crop)
  const button = (label: string, Icon: React.ElementType, action: () => void, disabled = false) => <button type="button" title={label} aria-label={label} disabled={busy || !ready || disabled} onClick={action}><Icon size={16} /></button>
  return <div className={`screenshot-editor ${floating ? 'floating' : ''} ${liveRegion ? 'region-live-selector' : ''}`} aria-busy={busy}>
    <div className="screenshot-viewport" ref={host} style={{ cursor: toolCursor }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (gesture.current) cancelGesture() }} onDoubleClick={event => {
      if (busy || text || tool !== 'select') return
      const found = [...doc.annotations].reverse().find(a => a.kind === 'text' && hitAnnotation(a, point(event), 6 / scale))
      if (found) { setSelected(undefined); setText({ annotation: found, draft: found.text || '' }) }
    }}>
      {hasPixels && <canvas className="screenshot-image" ref={canvas} width={doc.width} height={doc.height} style={{ left: offset.x, top: offset.y, width: doc.width * scale, height: doc.height * scale }} />}
      {liveRegion && <canvas className="screenshot-loading-preview" ref={loadingCanvas} width={doc.width} height={doc.height} style={{ position: 'absolute', pointerEvents: 'none', left: offset.x, top: offset.y, width: doc.width * scale, height: doc.height * scale }} />}
      {crop && <div className="editor-selection" style={rectStyle(crop)}><span className="selection-size" style={{ top: offset.y + crop.y * scale < 26 ? 3 : -26 }}>{crop.width} × {crop.height} px</span>{tool === 'crop' && handles.map(handle => <i key={handle} data-handle={handle} className={`selection-handle ${handle}`} />)}</div>}
      {selectedBounds && tool === 'select' && <div className="annotation-selection" style={rectStyle(selectedBounds)}>{handles.map(handle => <i key={handle} data-handle={handle} className={`selection-handle ${handle}`} />)}</div>}
      {text && <div className="inline-text-editor" style={{ left: offset.x + text.annotation.points[0]!.x * scale, top: offset.y + text.annotation.points[0]!.y * scale }} onPointerDown={event => event.stopPropagation()}>
        <textarea autoFocus aria-label="标注文字" placeholder="输入多行文字" value={text.draft} maxLength={5000} style={{ fontSize: text.annotation.style.fontSize * scale, color: text.annotation.style.color }} onChange={event => setText({ ...text, draft: event.target.value })} onKeyDown={event => {
          event.stopPropagation(); if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
          if (event.key === 'Escape') { event.preventDefault(); setText(null) }
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); finishText() }
        }} />
        <div><button onClick={finishText}>确定</button><button onClick={() => setText(null)}>取消</button><small>Ctrl+Enter 确定</small></div>
      </div>}
    </div>
    {(hasSelection || !floating) && <div ref={toolbar} className="screenshot-tools" style={floating ? { left: toolbarLeft, top: toolbarTop } : undefined} onPointerDown={event => event.stopPropagation()}>
      <div className="screenshot-tool-row"><div className="screenshot-tool-group">{tools.map(([item, label, Icon]) => <button type="button" key={item} title={label} aria-label={label} disabled={busy || !ready || Boolean(text)} className={tool === item ? 'selected' : ''} onClick={() => { setTool(item); setSelected(undefined); if (item === 'crop' && !floating) updateCrop(null) }}><Icon size={16} /></button>)}</div>
        <div className="screenshot-tool-group">{button('撤销', Undo2, () => undo(), !history.length)}{button('重做', Redo2, () => undo(true), !redo.length)}</div>
        <div className="screenshot-tool-group">{button('复制', Copy, () => void finish('copy'), Boolean(text) || Boolean(pendingCrop))}{button('保存', Save, () => void finish('save'), Boolean(text) || Boolean(pendingCrop))}{button('另存为', Download, () => void finish('saveAs'), Boolean(text) || Boolean(pendingCrop))}{button('贴图', Pin, () => void finish('pin'), Boolean(text) || Boolean(pendingCrop))}{doc.targetPinId && <button disabled={busy || !ready || Boolean(text) || Boolean(pendingCrop)} onClick={() => void finish('updatePin')}>更新贴图</button>}{floating && button('在应用内编辑', Maximize, () => void finish('openEditor'), Boolean(text))}{onCancel && button('取消截图', X, onCancel)}</div>
      </div>
      <div className="screenshot-style-row">
        <div className="screenshot-palette">{screenshotColors.map(color => <button type="button" key={color} aria-label={`颜色 ${color}`} title={color} disabled={busy} style={{ background: color }} className={activeStyle.color === color ? 'selected' : ''} onClick={() => changeStyle({ color })} />)}<input type="color" aria-label="自定义颜色" disabled={busy} value={activeStyle.color} onChange={event => changeStyle({ color: event.target.value })} /></div>
        <label>粗细<input aria-label="粗细" type="number" min={1} max={200} disabled={busy} value={activeStyle.width} onChange={event => changeStyle({ width: Math.max(1, Math.min(200, Number(event.target.value) || 1)) })} /></label>
        <label>字号<input aria-label="字号" type="number" min={8} max={200} disabled={busy} value={activeStyle.fontSize} onChange={event => changeStyle({ fontSize: Math.max(8, Math.min(200, Number(event.target.value) || 8)) })} /></label>
        <label><input type="checkbox" aria-label="填充" disabled={busy} checked={activeStyle.filled} onChange={event => changeStyle({ filled: event.target.checked })} />填充</label>
        {(['mosaic', 'blur', 'cover'].includes(tool) || selectedAnnotation && ['mosaic', 'blur', 'cover'].includes(selectedAnnotation.kind)) && <><select aria-label="遮盖方式" disabled={busy} value={activeStyle.mode} onChange={event => changeStyle({ mode: event.target.value as AnnotationStyle['mode'] })}><option value="rectangle">框选</option><option value="brush">涂抹</option></select><label>强度<input aria-label="遮盖强度" type="number" min={1} max={80} disabled={busy} value={activeStyle.strength} onChange={event => changeStyle({ strength: Math.max(1, Math.min(80, Number(event.target.value) || 1)) })} /></label></>}
        <select aria-label="导出格式" disabled={busy} value={format} onChange={event => setFormat(event.target.value as 'png' | 'jpg')}><option value="png">PNG</option><option value="jpg">JPG</option></select>
      </div>
      <div className="screenshot-view-row">{button('适应窗口', Maximize, () => { setZoom(null); setPan({ x: 0, y: 0 }) })}<button disabled={busy} onClick={() => { setZoom(nativeScale); setPan({ x: 0, y: 0 }) }}>100%</button><button disabled={busy} aria-label="缩小" onClick={() => zoomAt(scale / 1.2)}>−</button><span>{Math.round(scale / nativeScale * 100)}%</span><button disabled={busy} aria-label="放大" onClick={() => zoomAt(scale * 1.2)}>＋</button><span><Move size={12} /> 空格拖动画布 · Shift 约束</span>
        {pendingCrop && <><button disabled={busy} onClick={() => commit({ ...doc, crop: crop! })}>确认裁剪</button><button disabled={busy} onClick={() => updateCrop(doc.crop)}>取消裁剪</button></>}
        {selected && button('删除选中标注', Eraser, removeSelected)}
      </div>
    </div>}
    <div className="screenshot-feedback" aria-live="polite">{error ? <span role="alert">{error}</span> : busy ? captureLock.current ? '正在捕获选区…' : '正在合成图像…' : !ready ? '正在读取图片…' : !crop ? '拖动框选区域 · Esc 取消' : message || (floating ? 'Enter 复制并结束 · Esc 取消' : '拖入图片或粘贴剪贴板图片 · 双击文字再次编辑')}</div>
  </div>
}
