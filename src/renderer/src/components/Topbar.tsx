import { Monitor } from 'lucide-react'
import type React from 'react'
import { SearchBar } from './SearchBar'
import type { SearchResult } from '../app/searchNavigation'

export function Topbar({ title, description, query, setQuery, onKeyDown, results, onSelect, theme, setTheme }: { title: string; description: string; query: string; setQuery: (value: string) => void; onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void; results: SearchResult[]; onSelect: (result: SearchResult) => void; theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void }) {
  return <header className="topbar"><div className="topbar-title"><p className="eyebrow">{new Intl.DateTimeFormat('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date())}</p><h1>{title}</h1><p className="topbar-description">{description}</p></div><div className="top-actions"><SearchBar query={query} setQuery={setQuery} onKeyDown={onKeyDown} results={results} onSelect={onSelect} /><button className="icon-button" title="切换主题" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}><Monitor size={17} /></button><button className="avatar">DD</button></div></header>
}
