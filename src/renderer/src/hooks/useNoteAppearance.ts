import { useEffect, useState, type CSSProperties } from 'react'
import type { NoteRecord } from '../../../shared/types'
import { argbHex } from '../utils/colors'

export function useNoteAppearance(note?: NoteRecord) {
  const path = note?.BackgroundImagePath || ''
  const [image, setImage] = useState({ path: '', url: '', error: '' })
  useEffect(() => {
    let cancelled = false
    if (!path) { setImage({ path: '', url: '', error: '' }); return }
    void window.dustdesk.readImageFile(path).then(result => {
      if (!cancelled) setImage({ path, url: result.ok ? result.dataUrl || '' : '', error: result.ok ? '' : result.error || '背景图片读取失败' })
    }).catch(() => { if (!cancelled) setImage({ path, url: '', error: '背景图片读取失败，请重新导入或清除背景' }) })
    return () => { cancelled = true }
  }, [path])
  const backgroundUrl = image.path === path ? image.url : ''
  const backgroundError = image.path === path ? image.error : ''
  const textStyle: CSSProperties = note ? {
    backgroundColor: argbHex(note.ColorArgb), color: argbHex(note.FontColorArgb),
    fontSize: Math.max(10, Math.min(42, note.FontSize)), fontWeight: note.FontBold ? 700 : 400,
    backgroundImage: backgroundUrl ? 'url(' + backgroundUrl + ')' : undefined,
    backgroundSize: 'cover', backgroundPosition: 'center'
  } : {}
  return { backgroundUrl, backgroundError, textStyle }
}
