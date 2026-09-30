import { useEffect, useRef } from 'react'

export type SearchTarget =
  | { page: 'tasks'; kind: 'task'; id: string }
  | { page: 'notes'; kind: 'note'; id: string }
  | { page: 'projects'; kind: 'project' | 'phase' | 'subtask'; id: string; projectId: string; phaseId?: string }
  | { page: 'library'; kind: 'link' | 'launcher'; id: string; groupId: string }
  | { page: 'organizer'; kind: 'category'; id: string }

export type SearchResult = { key: string; title: string; meta: string; target?: SearchTarget; path?: string }
export type SearchNavigation = { target: SearchTarget; requestId: number }
export const searchTargetId = (kind: SearchTarget['kind'], id: string) => `search-target-${kind}-${id}`

// Wait until the destination has selected the right tab/date/record before moving
// focus. The request ID also makes choosing the same search result work again.
export function useSearchReveal(navigation: SearchNavigation | undefined, ready: boolean) {
  const target = navigation?.target
  const revealedRequest = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (!target || !ready || navigation?.requestId === revealedRequest.current) return
    const frame = requestAnimationFrame(() => {
      const element = document.getElementById(searchTargetId(target.kind, target.id))
      if (!element) return
      element?.focus({ preventScroll: true })
      element?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      revealedRequest.current = navigation?.requestId
    })
    return () => cancelAnimationFrame(frame)
  }, [navigation?.requestId, target, ready])
}
