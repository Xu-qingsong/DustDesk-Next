import { isComposingKey } from '../../utils/keyboard'
import { useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { ButtonHTMLAttributes, CSSProperties, InputHTMLAttributes } from 'react'
import { Check, Minus, Plus } from 'lucide-react'

export function Checkbox({ className = '', ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  return <span className="control-checkbox"><input {...props} type="checkbox" className={className} /><Check size={12} strokeWidth={3} aria-hidden /></span>
}

export function Switch({ checked, onCheckedChange, className = '', ...props }: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return <button {...props} type="button" role="switch" aria-checked={checked} className={`control-switch toggle ${checked ? 'on' : ''} ${className}`} onClick={() => onCheckedChange(!checked)}><span /></button>
}

type NumberProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange'> & { value: string | number; onValueChange: (value: string) => void; variant?: 'stepper' | 'input' }
export function NumberInput({ value, onValueChange, min, max, step = 1, variant = 'stepper', disabled, className = '', onBlur, onFocus, onKeyDown, ...props }: NumberProps) {
  const stepper = variant === 'stepper'
  const [draft, setDraft] = useState(String(value)), input = useRef<HTMLInputElement>(null), dirty = useRef(false)
  const [focused, setFocused] = useState(false)
  useEffect(() => {
    if (!focused) return
    const commitBeforePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !input.current?.parentElement?.contains(event.target)) {
        // Canvas pointer handlers run before the browser's default blur. Commit
        // here so the first stroke uses the style just entered in this field.
        flushSync(() => input.current?.blur())
      }
    }
    document.addEventListener('pointerdown', commitBeforePointer, true)
    return () => document.removeEventListener('pointerdown', commitBeforePointer, true)
  }, [focused])
  const lower = min === undefined ? -Infinity : Number(min), upper = max === undefined ? Infinity : Number(max), increment = step === 'any' ? 1 : Number(step)
  useEffect(() => { if (!dirty.current) setDraft(String(value)) }, [value])
  const commit = (text = draft) => {
    dirty.current = false
    if (!text.trim()) { setDraft(String(value)); return }
    const number = Number(text)
    if (!Number.isFinite(number)) { setDraft(String(value)); return }
    const next = String(Math.max(lower, Math.min(upper, number)))
    setDraft(next); onValueChange(next)
  }
  const adjust = (direction: number) => {
    const current = draft.trim() && Number.isFinite(Number(draft)) ? Number(draft) : Number(value) || 0
    commit(String(Number((current + direction * increment).toFixed(10))))
    input.current?.focus({ preventScroll: true })
  }
  return <div className={`control-number${stepper ? '' : ' control-number-input'}`}>
    <input {...props} ref={input} type="text" role={stepper ? 'spinbutton' : undefined} inputMode={Number.isInteger(increment) ? 'numeric' : 'decimal'} aria-valuemin={stepper && Number.isFinite(lower) ? lower : undefined} aria-valuemax={stepper && Number.isFinite(upper) ? upper : undefined} aria-valuenow={stepper && draft.trim() && Number.isFinite(Number(draft)) ? Number(draft) : undefined} className={className} disabled={disabled} value={draft} onChange={event => { dirty.current = true; setDraft(event.target.value) }} onFocus={event => { setFocused(true); onFocus?.(event) }} onBlur={event => { setFocused(false); commit(); onBlur?.(event) }} onKeyDown={event => {
      if (!isComposingKey(event.nativeEvent) && (event.key === 'Enter' || stepper && ['ArrowUp', 'ArrowDown'].includes(event.key))) {
        if (event.key === 'Enter') commit()
        else { event.preventDefault(); event.stopPropagation(); adjust(event.key === 'ArrowUp' ? 1 : -1) }
      }
      onKeyDown?.(event)
    }} />
    {stepper && <div className="control-number-actions">{([-1, 1] as const).map(direction => <button key={direction} type="button" tabIndex={-1} disabled={disabled || (direction < 0 ? Number(draft) <= lower : Number(draft) >= upper)} aria-label={direction < 0 ? '减少数值' : '增加数值'} onMouseDown={event => event.preventDefault()} onClick={() => adjust(direction)}>{direction < 0 ? <Minus size={12} /> : <Plus size={12} />}</button>)}</div>}
  </div>
}

export function Slider({ min = 0, max = 100, value, className = '', style, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const percent = Math.max(0, Math.min(100, (Number(value) - Number(min)) / (Number(max) - Number(min) || 1) * 100))
  return <input {...props} type="range" min={min} max={max} value={value} className={`control-slider ${className}`} style={{ ...style, '--control-progress': `${percent}%` } as CSSProperties} />
}

export function Progress({ value, max = 100, 'aria-label': label = '处理进度', className = '' }: { value?: number; max?: number; 'aria-label'?: string; className?: string }) {
  const limit = Math.max(1, max), current = value === undefined ? undefined : Math.max(0, Math.min(limit, value))
  return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={current} className={`control-progress ${current === undefined ? 'indeterminate' : ''} ${className}`}><span style={{ width: current === undefined ? '35%' : `${current / limit * 100}%` }} /></div>
}
