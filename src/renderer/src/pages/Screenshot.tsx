import React, { useEffect, useRef, useState } from 'react'
import { Crop, ImagePlus } from 'lucide-react'
import type { ScreenshotPayload } from '../../../shared/screenshotDocument'
import { Empty, PageHeader, Panel } from '../components/common'
import { useScreenshotCapture } from '../hooks/useScreenshotCapture'
import { ScreenshotEditor } from '../screenshot/ScreenshotEditor'

export function ScreenshotPage({ initialImage, initialDocument, active = true }: { initialImage?: { dataUrl: string } | null; initialDocument?: ScreenshotPayload | null; active?: boolean }) {
  const [payload, setPayload] = useState<ScreenshotPayload | null>(null)
  const [mode, setMode] = useState<'Region' | 'Window' | 'FullScreen'>('Region')
  const [error, setError] = useState(''), [loading, setLoading] = useState(false)
  const input = useRef<HTMLInputElement>(null), current = useRef<ScreenshotPayload | null>(null), sequence = useRef(0)
  const replace = (value: ScreenshotPayload) => {
    if (current.current && current.current.document.id !== value.document.id) void window.dustdesk.discardScreenshotDocument(current.current.document.id)
    current.current = value; setPayload(value)
  }
  const importBytes = async (bytes: Uint8Array) => {
    const generation = ++sequence.current; setLoading(true); setError('')
    try {
      const result = await window.dustdesk.createScreenshotDocument(bytes)
      if (generation !== sequence.current) { if (result.payload) void window.dustdesk.discardScreenshotDocument(result.payload.document.id); return }
      if (!result.ok || !result.payload) throw Error(result.error || '无法读取图片')
      replace(result.payload)
    } catch (err) { if (generation === sequence.current) setError(err instanceof Error ? err.message : '导入失败') }
    finally { if (generation === sequence.current) setLoading(false) }
  }
  const importFile = async (file?: File) => {
    if (!file) return
    if (!/image\/(png|jpeg|webp|bmp)/.test(file.type) && !/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) { setError('请选择 PNG、JPG、WebP 或 BMP 图片'); return }
    if (file.size > 32 * 1024 * 1024) { setError('图片过大（最大 32 MB）'); return }
    await importBytes(new Uint8Array(await file.arrayBuffer()))
  }
  const capture = useScreenshotCapture(dataUrl => { void fetch(dataUrl).then(response => response.arrayBuffer()).then(bytes => importBytes(new Uint8Array(bytes))) })
  useEffect(() => { if (initialDocument) { ++sequence.current; setLoading(false); setError(''); replace(initialDocument) } }, [initialDocument])
  useEffect(() => { if (initialImage) void fetch(initialImage.dataUrl).then(response => response.arrayBuffer()).then(bytes => importBytes(new Uint8Array(bytes))) }, [initialImage])
  useEffect(() => {
    if (!active) return
    const paste = (event: ClipboardEvent) => {
      if (event.target instanceof HTMLElement && (event.target.matches('input,textarea') || event.target.isContentEditable)) return
      const file = [...(event.clipboardData?.items || [])].find(item => item.type.startsWith('image/'))?.getAsFile()
      if (file) { event.preventDefault(); void importFile(file) }
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [active])
  const importClipboard = async () => {
    try {
      const content = await window.dustdesk.readClipboard()
      if (!content.imagePngBase64) { setError('剪贴板中没有图片'); return }
      await importBytes(Uint8Array.from(atob(content.imagePngBase64), c => c.charCodeAt(0)))
    } catch (err) { setError(err instanceof Error ? err.message : '无法读取剪贴板') }
  }
  return <div className="screenshot-page" onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' }} onDrop={event => { event.preventDefault(); void importFile(event.dataTransfer.files[0]) }}>
    <PageHeader title="截图编辑" action={<div className="segmented">
      {(['Region', 'Window', 'FullScreen'] as const).map((item, index) => <button key={item} disabled={capture.busy || loading} className={mode === item ? 'selected' : ''} onClick={() => setMode(item)}>{['区域', '窗口', '全屏'][index]}</button>)}
      <button className="selected" disabled={capture.busy || loading} onClick={() => void capture.capture(mode)}><Crop size={14} />{capture.busy ? '捕获中…' : '捕获'}</button>
      <button disabled={loading} onClick={() => input.current?.click()}><ImagePlus size={14} />导入图片</button><button disabled={loading} onClick={() => void importClipboard()}>剪贴板图片</button>
    </div>} />
    <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/bmp" aria-label="导入截图图片" onChange={event => { void importFile(event.target.files?.[0]); event.target.value = '' }} />
    {error && <p role="alert" className="screenshot-import-error">{error}</p>}{loading && <p role="status">正在导入图片…</p>}
    <Panel className="screenshot-studio">{payload ? <ScreenshotEditor key={payload.document.id} payload={payload} active={active} /> : <Empty icon={Crop} title="还没有截图" description="框选屏幕，或拖入图片开始编辑。" action={<button className="primary-button" disabled={capture.busy} onClick={() => void capture.capture(mode)}>开始捕获</button>} />}</Panel>
    {capture.windowPicker}
  </div>
}
