import { useEffect, useRef, useState } from 'react'
import { AppWindow, ArrowUpRight, FileText, FolderOpen } from 'lucide-react'
import { createIconLoader } from '../../../shared/iconLoader'

const icons = createIconLoader(path => window.dustdesk.getPathIcon(path))

/** Native file icons with a visible fallback while loading or unavailable. */
export function PathIcon({ path, isDirectory = false, size = 48, className = 'path-icon' }: { path: string; isDirectory?: boolean; size?: number; className?: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const [result, setResult] = useState<{ path: string; dataUrl?: string; isDirectory?: boolean }>()
  const dataUrl = result?.path === path ? result.dataUrl : undefined
  const directory = result?.path === path ? result.isDirectory ?? isDirectory : isDirectory
  const shortcut = /\.lnk$/i.test(path)
  useEffect(() => {
    const controller = new AbortController()
    let retry: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    async function load() {
      try {
        const icon = await icons.read(path, controller.signal)
        if (controller.signal.aborted) return
        setResult({ path, ...icon })
        if (!icon.dataUrl && ++attempts < 2) {
          // Retry once after the short failure cache expires; never poll broken links.
          retry = setTimeout(() => { icons.invalidate(path); void load() }, 3500)
        }
      } catch { /* Unmounted and recycled tiles cannot update another file's icon. */ }
    }
    const observer = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); void load() }
    }, { rootMargin: '80px' })
    if (observer && host.current) observer.observe(host.current)
    else void load()
    return () => { observer?.disconnect(); controller.abort(); clearTimeout(retry) }
  }, [path, isDirectory])
  const Fallback = directory ? FolderOpen : shortcut || /\.(exe|msi)$/i.test(path) ? AppWindow : FileText
  return <span ref={host} className={className} style={{ width: size, height: size }} aria-hidden="true">
    {dataUrl ? <img src={dataUrl} alt="" draggable={false} decoding="async" onError={() => { icons.invalidate(path); setResult({ path, isDirectory: directory }) }} /> : <Fallback size={size} strokeWidth={1.5} />}
    {shortcut && <span className="path-shortcut-badge"><ArrowUpRight size={12} strokeWidth={2} /></span>}
  </span>
}
