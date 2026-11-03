import { Checkbox } from "../components/ui/FormControls"
import { Select } from '../components/ui/Select'
import { useEffect, useRef, useState } from 'react'
import { Copy, Download, Play, ClipboardPaste, Eraser } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader, Panel } from '../components/common'
import type { TextTool, TextRequest, TextResult } from '../../../shared/toolbox'
import { toolError } from '../../../shared/toolbox'
import { JobWorker } from '../toolbox/jobWorker'

const tools: [TextTool, string][] = [['json','JSON 格式化'],['jsonCompact','JSON 压缩'],['urlEncode','URL 编码'],['urlDecode','URL 解码'],['base64Encode','Base64 编码'],['base64Decode','Base64 解码'],['regex','正则测试'],['diff','文本对比'],['dedupe','按行去重'],['sort','自然排序'],['stats','文本统计'],['upper','转大写'],['lower','转小写']]
export function TextToolbox({ active }: { active: boolean }) {
  const [tool, setTool] = useState<TextTool>('json'), [input, setInput] = useState(''), [second, setSecond] = useState('')
  const [pattern, setPattern] = useState(''), [flags, setFlags] = useState('g'), [trim, setTrim] = useState(false), [ignoreEmpty, setIgnoreEmpty] = useState(false)
  const [result, setResult] = useState<TextResult>({ text: '' }), [error, setError] = useState(''), [busy, setBusy] = useState(false), [composing, setComposing] = useState(false)
  const [retry, setRetry] = useState(0), sequence = useRef(0)
  const inputElement = useRef<HTMLTextAreaElement>(null), outputElement = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const editors = [inputElement.current!, outputElement.current!] as const
    let sharedHeight = editors[0].getBoundingClientRect().height
    const observer = new ResizeObserver(entries => {
      const height = entries.map(entry => entry.target.getBoundingClientRect().height).find(value => value > 0 && Math.abs(value - sharedHeight) > .5)
      if (height === undefined) return
      sharedHeight = height
      for (const editor of editors) {
        if (Math.abs(editor.getBoundingClientRect().height - height) > .5) editor.style.height = `${height}px`
      }
    })
    editors.forEach(editor => observer.observe(editor))
    return () => observer.disconnect()
  }, [])
  const worker = useRef<JobWorker | null>(null)
  if (!worker.current) worker.current = new JobWorker(() => new Worker(new URL('../toolbox/text.worker.ts', import.meta.url), { type: 'module' }))
  const secondInput = tool === 'diff' ? second : ''
  const expression = tool === 'regex' ? pattern : undefined, expressionFlags = tool === 'regex' ? flags : undefined
  const lineTool = tool === 'dedupe' || tool === 'sort', trimLines = lineTool && trim, skipEmptyLines = lineTool && ignoreEmpty
  useEffect(() => {
    const version = ++sequence.current; worker.current!.cancel(); setBusy(false)
    if (!active) return
    setResult({ text: '' }); setError('')
    if (composing || (!input && !secondInput)) return
    const timer = setTimeout(() => {
      setBusy(true)
      const request: TextRequest = { tool, input, second: secondInput, pattern: expression, flags: expressionFlags, trim: trimLines, ignoreEmpty: skipEmptyLines }
      void worker.current!.run<TextResult>(request, tool === 'regex' ? 1000 : 5000).then(value => { if (version === sequence.current) setResult(value) }).catch(e => { if (version === sequence.current) setError(e.message) }).finally(() => { if (version === sequence.current) setBusy(false) })
    }, 300)
    return () => clearTimeout(timer)
  }, [active, tool, input, secondInput, expression, expressionFlags, trimLines, skipEmptyLines, composing, retry])
  useEffect(() => () => { sequence.current++; worker.current?.cancel() }, [])
  const output = async (save: boolean) => { try { if (save) { const value = await window.dustdesk.toolbox.exportText(result.text); if (value.path) toast.success('文本已导出') } else { await window.dustdesk.toolbox.copyText(result.text); toast.success('结果已复制') } } catch (e) { toast.error(toolError(e)) } }
  return <div className="toolbox-page"><PageHeader eyebrow="Text tools" title="文本工具箱" description="格式化、转换与对比，在本地完成。" />
    <Panel><div className="toolbox-toolbar"><div className="toolbox-tabs">{tools.map(([id, label]) => <button key={id} className={`category-chip ${tool === id ? 'selected' : ''}`} onClick={() => setTool(id)}>{label}</button>)}</div></div>
      {tool === 'regex' && <div className="toolbox-options"><label className="toolbox-grow">正则表达式<input value={pattern} onChange={e => setPattern(e.target.value)} placeholder="例如 (\d+)" /></label><label>标志<Select aria-label="标志" value={flags} onValueChange={value => setFlags(value)}>{['g','gi','gm','gim','gu','giu','gmsu','i','m','u',''].map(value => <option key={value} value={value}>{value || '无'}</option>)}</Select></label></div>}
      {(tool === 'dedupe' || tool === 'sort') && <div className="toolbox-options"><label className="toolbox-check"><Checkbox checked={trim} onChange={e => setTrim(e.target.checked)} />移除行首尾空白</label><label className="toolbox-check"><Checkbox checked={ignoreEmpty} onChange={e => setIgnoreEmpty(e.target.checked)} />忽略空行</label></div>}
      <div className="toolbox-columns"><div className="toolbox-editor"><div className="toolbox-heading"><strong>{tool === 'diff' ? '原文本' : '输入'}</strong><div className="toolbox-actions"><button className="mini-button" onClick={() => { void window.dustdesk.readClipboard().then(value => setInput(value.text)).catch(e => toast.error(toolError(e))) }}><ClipboardPaste size={14} />粘贴</button><button className="mini-button" onClick={() => { setInput(''); setSecond('') }}><Eraser size={14} />清空</button></div></div><textarea ref={inputElement} aria-label="文本输入" spellCheck={false} value={input} onChange={e => setInput(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} placeholder="粘贴或输入文本…" /></div>
      <div className="toolbox-editor"><div className="toolbox-heading"><strong>{tool === 'diff' ? '新文本' : '结果'}</strong><span className="muted">{busy ? '处理中…' : 'UTF-8 · 本地处理'}</span></div><textarea ref={outputElement} aria-label={tool === 'diff' ? '对比文本' : '文本结果'} spellCheck={false} value={tool === 'diff' ? second : result.text} readOnly={tool !== 'diff'} onChange={e => setSecond(e.target.value)} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} placeholder={tool === 'diff' ? '输入要对比的新文本…' : '结果将显示在这里'} /></div></div>
      {error && <div className="toolbox-error" role="alert">{error}</div>}
      {tool === 'diff' && result.diff && <div className="toolbox-diff" aria-label="逐行差异">{result.diff.slice(0, 3000).map((row, i) => <div key={i} className={`diff-${row.kind}`}><span>{row.kind === 'add' ? '+' : row.kind === 'remove' ? '−' : ' '}</span><code>{row.text || ' '}</code></div>)}{result.diff.length > 3000 && <p className="muted">预览显示前 3000 行，复制和导出包含完整结果。</p>}</div>}
      <div className="toolbox-footer"><span className="muted">每份输入最多 10 MiB · 切换页面保留内容</span><div className="toolbox-actions"><button className="secondary-button" onClick={() => setRetry(v => v + 1)} disabled={busy || composing}><Play size={14} />重新处理</button><button className="secondary-button" disabled={busy || !!error || !result.text} onClick={() => void output(false)}><Copy size={14} />复制结果</button><button className="primary-button" disabled={busy || !!error || !result.text} onClick={() => void output(true)}><Download size={14} />导出文本</button></div></div>
    </Panel></div>
}
