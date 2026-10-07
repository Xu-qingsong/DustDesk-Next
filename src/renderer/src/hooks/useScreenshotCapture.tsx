import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useDialogFocus } from './useDialogFocus'

type CaptureMode = 'Region' | 'Window' | 'FullScreen'
type CaptureWindow = { id: string; name: string; thumbnail: string }

export function screenshotError(message?: string) {
  const messages: Record<string, string> = {
    'screenshot-in-progress': '已有截图正在进行，请完成或取消后重试',
    'no-capture-source': '没有找到可截图的画面，请打开目标窗口后重试',
    'select-capture-window': '请先选择要捕获的窗口',
    'capture-window-unavailable': '所选窗口已关闭或不可用，请重新选择',
    'invalid-region-capture': '选区图像无效，请重新截图'
  }
  if (message && /EACCES|EPERM|EEXIST|ENOSPC/.test(message)) return '截图无法保存，请检查保存目录权限和磁盘空间后重试'
  return (message && messages[message]) || (message ? `截图失败：${message}。请重试` : '截图失败，请重试')
}

export function useScreenshotCapture(onCaptured?: (dataUrl: string) => void) {
  const [busy, setBusy] = useState(false)
  const [sources, setSources] = useState<CaptureWindow[] | null>(null)
  const lock = useRef(false)
  const mounted = useRef(true)
  const selection = useRef<((id: string | undefined) => void) | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; selection.current?.(undefined); selection.current = null }
  }, [])
  const choose = (id?: string) => {
    const resolve = selection.current
    selection.current = null
    setSources(null)
    resolve?.(id)
  }
  useDialogFocus(Boolean(sources), '.screenshot-window-picker', () => choose())
  const capture = async (mode: CaptureMode) => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try {
      let sourceId: string | undefined
      if (mode === 'Window') {
        const available = await window.dustdesk.listScreenshotWindows()
        if (!mounted.current) return
        if (!available.ok) { toast.error(screenshotError(available.message)); return }
        if (!available.sources?.length) { toast.error(screenshotError('no-capture-source')); return }
        sourceId = await new Promise<string | undefined>(resolve => { selection.current = resolve; setSources(available.sources!) })
        if (!sourceId || !mounted.current) return
      }
      const result = await window.dustdesk.startScreenshot(mode, sourceId)
      if (!result.ok) {
        if (result.message !== 'region-capture-canceled') toast.error(screenshotError(result.message))
        return
      }
      if (!result.dataUrl) return
      if (mounted.current) onCaptured?.(result.dataUrl)
      toast.success('截图已捕获')
    } catch (error) {
      toast.error(screenshotError(error instanceof Error ? error.message : undefined))
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  const windowPicker = sources && <div className="modal-overlay" onMouseDown={event => { if (event.target === event.currentTarget) choose() }}>
    <div className="library-modal screenshot-window-picker" role="dialog" aria-modal="true" aria-labelledby="screenshot-window-title">
      <div className="modal-header"><h3 id="screenshot-window-title">选择截图窗口</h3></div>
      <div className="screenshot-window-list">{sources.map(source => <button type="button" key={source.id} className="screenshot-window-choice" onClick={() => choose(source.id)} title={source.name}>
        <img src={source.thumbnail} alt="" /><span>{source.name || '未命名窗口'}</span>
      </button>)}</div>
      <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => choose()}>取消</button></div>
    </div>
  </div>
  return { capture, busy, isBusy: () => lock.current, windowPicker }
}
