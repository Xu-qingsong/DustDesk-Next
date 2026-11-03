import { isComposingKey } from '../../utils/keyboard'
import { useEffect, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check } from 'lucide-react'
import { NumberInput } from './FormControls'

const presets = ['#ffffff', '#e5e7eb', '#6b7280', '#111827', '#ef4444', '#f97316', '#f59e0b', '#facc15', '#84cc16', '#22c55e', '#10b981', '#087f6c', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', '#ec4899']
const valid = (value: string) => /^#[0-9a-f]{6}$/i.test(value)
export function ColorPicker({ value, onValueChange, disabled, 'aria-label': label = '选择颜色' }: { value: string; onValueChange: (value: string) => void; disabled?: boolean; 'aria-label'?: string }) {
  const [draft, setDraft] = useState(value), [open, setOpen] = useState(false)
  useEffect(() => setDraft(value), [value])
  const choose = (next: string) => { setDraft(next); onValueChange(next.toLowerCase()) }
  const commit = () => { const next = draft.startsWith('#') ? draft : `#${draft}`; if (valid(next)) choose(next); else setDraft(value) }
  return <Popover.Root open={open && !disabled} onOpenChange={next => { setDraft(value); setOpen(next) }}>
    <Popover.Trigger asChild><button type="button" disabled={disabled} aria-label={label} data-control-trigger="color" className="control-color"><span className="control-color-chip" style={{ background: value }} /><span className="control-color-value">{value.toUpperCase()}</span></button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="control-popup control-color-popup" data-control-popup align="start" sideOffset={6} collisionPadding={8} onKeyDown={event => event.stopPropagation()}>
      <strong className="control-color-title">{label}</strong>
      <div className="control-color-presets" role="group" aria-label="预设颜色">{presets.map(color => <button key={color} type="button" aria-label={`颜色 ${color}`} aria-pressed={color === value.toLowerCase()} style={{ background: color }} onClick={() => choose(color)}>{color === value.toLowerCase() && <Check size={14} style={{ color: Number.parseInt(color.slice(1), 16) > 0xaaaaaa ? '#111827' : '#ffffff' }} />}</button>)}</div>
      <label className="control-color-hex">HEX<input aria-label="HEX 颜色" maxLength={7} value={draft} spellCheck={false} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter' && !isComposingKey(event.nativeEvent)) { event.preventDefault(); commit() } }} /></label>
      <div className="control-color-rgb">{['R', 'G', 'B'].map((part, index) => <label key={part}>{part}<NumberInput variant="input" aria-label={`${part} 通道`} min={0} max={255} value={Number.parseInt(value.slice(1 + index * 2, 3 + index * 2), 16)} onValueChange={next => { const bytes = [value.slice(1, 3), value.slice(3, 5), value.slice(5, 7)]; bytes[index] = Number(next).toString(16).padStart(2, '0'); choose(`#${bytes.join('')}`) }} /></label>)}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
