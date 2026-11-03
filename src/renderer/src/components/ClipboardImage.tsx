import { useEffect, useRef, useState } from 'react'
import { ImageOff, LoaderCircle } from 'lucide-react'
import type { ClipboardImagePreview, ClipboardRecord } from '../../../shared/types'

/** Only visible thumbnails read images; full resolution is requested by the dialog. */
export function ClipboardImage({ item, thumbnail = true }: { item: ClipboardRecord; thumbnail?: boolean }) {
  const host = useRef<HTMLSpanElement>(null)
  const [image, setImage] = useState<ClipboardImagePreview>()
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let disposed = false
    setImage(undefined); setError('')
    const load = async () => {
      try {
        const result = await window.dustdesk.previewClipboardImage(item.Id, thumbnail)
        if (disposed) return
        if (!result.ok || !result.image) throw new Error(result.error || '图片预览失败，请重试')
        setImage(result.image)
      } catch (cause) { if (!disposed) setError(cause instanceof Error ? cause.message : '图片预览失败，请重试') }
    }
    const observer = thumbnail && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load() }
    }, { rootMargin: '80px' }) : undefined
    if (observer && host.current) observer.observe(host.current)
    else void load()
    return () => { disposed = true; observer?.disconnect() }
  }, [item.Id, item.ImageAssetName, item.ImagePngBase64, item.ImageSha256, thumbnail, attempt])
  return <span ref={host} className={`clipboard-image ${thumbnail ? 'is-thumbnail' : 'is-full'}`} aria-busy={!image && !error}>
    {error ? <span className="clipboard-image-error" role={thumbnail ? undefined : 'status'} title={error}><ImageOff size={thumbnail ? 20 : 32} /><span>{thumbnail ? '图片不可用' : error}</span>{!thumbnail && <button className="secondary-button" onClick={() => setAttempt(value => value + 1)}>重试预览</button>}</span>
      : image ? <><img src={image.dataUrl} alt={thumbnail ? `缩略图：${item.ImageFileName || '剪贴板图片'}` : item.ImageFileName || '剪贴板图片'} decoding="async" draggable={false} onError={() => { setImage(undefined); setError('图片无法显示，请重试') }} />{!thumbnail && <span className="clipboard-image-size">{image.width} × {image.height} px</span>}</>
        : <span className="clipboard-image-loading" role="status"><LoaderCircle size={thumbnail ? 18 : 26} /><span>{thumbnail ? '加载中' : '正在加载图片…'}</span></span>}
  </span>
}
