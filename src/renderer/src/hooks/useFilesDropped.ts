import { useEffect, useRef, type RefObject } from 'react'
import { toast } from 'sonner'
import { acceptsFileDrop } from '../../../shared/fileDrop'

export function useFilesDropped(target: RefObject<HTMLElement | null>, active: boolean, callback: (paths: string[]) => void) {
  const current = useRef({ active, callback })
  current.current = { active, callback }
  useEffect(() => window.dustdesk.onFilesDropped(drop => {
    if (!Number.isFinite(drop.position.x) || !Number.isFinite(drop.position.y) || drop.position.x < 0 || drop.position.y < 0) return false
    if (!current.current.active || document.documentElement.inert || !acceptsFileDrop(target.current, document.elementFromPoint(drop.position.x, drop.position.y), drop.position)) return false
    if (drop.error) toast.error(drop.error)
    else current.current.callback(drop.paths)
    return true
  }), [target])
}
