import { useEffect, useRef, useState } from 'react'
import type { SearchFileResult } from '../../../shared/types'

const emptyResults: SearchFileResult[] = []

export function useFileSearch(query: string, delay = 220) {
  const [result, setResult] = useState<{ query: string; items: SearchFileResult[] }>({ query: '', items: emptyResults })
  const requestId = useRef(0)
  const text = query.trim()
  useEffect(() => {
    const currentRequest = ++requestId.current
    if (text.length < 2) return
    const timer = window.setTimeout(() => {
      void window.dustdesk.searchFiles(text).then(items => { if (requestId.current === currentRequest) setResult({ query: text, items }) }).catch(() => { if (requestId.current === currentRequest) setResult({ query: text, items: emptyResults }) })
    }, delay)
    return () => window.clearTimeout(timer)
  }, [text, delay])
  return text.length >= 2 && result.query === text ? result.items : emptyResults
}
