import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import type React from 'react'
import type { SearchResult } from '../app/searchNavigation'

export function SearchBar({ query, setQuery, onKeyDown, results, onSelect }: { query: string; setQuery: (value: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void; results: SearchResult[]; onSelect: (result: SearchResult) => void }) {
  const [activeIndex, setActiveIndex] = useState(-1)
  useEffect(() => { setActiveIndex(-1) }, [query])
  const handleKey = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { setQuery(''); setActiveIndex(-1); return }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
      event.preventDefault()
      const next = event.key === 'ArrowDown' ? (activeIndex + 1) % results.length : (activeIndex < 0 ? results.length - 1 : (activeIndex + results.length - 1) % results.length)
      setActiveIndex(next)
      document.getElementById('global-result-' + next)?.scrollIntoView({ block: 'nearest' })
      return
    }
    if (event.key === 'Enter' && results.length && (activeIndex >= 0 || !/^(todo|task|note|clip|open)\s/i.test(query))) {
      event.preventDefault()
      onSelect(results[activeIndex >= 0 && activeIndex < results.length ? activeIndex : 0]!)
      return
    }
    onKeyDown(event)
  }
  return <div className="search-wrap"><Search size={16} /><input id="global-search" role="combobox" aria-label="全局搜索" aria-expanded={Boolean(query)} aria-controls="global-search-results" aria-activedescendant={activeIndex >= 0 ? 'global-result-' + activeIndex : undefined} aria-autocomplete="list" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={handleKey} placeholder="搜索任务、便签、项目和文件" /><kbd>Ctrl K</kbd>{query && <div className="search-popover" id="global-search-results" role="listbox">{results.length ? results.map((result, index) => <button id={'global-result-' + index} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? 'selected' : ''} key={result.key} onMouseEnter={() => setActiveIndex(index)} onClick={() => onSelect(result)}><span>{result.title}</span><small>{result.meta}</small></button>) : <div className="search-empty">没有匹配结果</div>}</div>}</div>
}
