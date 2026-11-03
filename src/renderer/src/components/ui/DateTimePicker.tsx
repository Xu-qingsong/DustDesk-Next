import { useEffect, useId, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { DayPicker } from 'react-day-picker'
import { zhCN } from 'react-day-picker/locale'
import { CalendarDays, ChevronLeft, ChevronRight, Clock3 } from 'lucide-react'

const pad = (value: number) => String(value).padStart(2, '0')
const dateValue = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
export const minutesToTime = (minutes: number) => `${pad(Math.floor(Math.max(0, Math.min(1439, minutes)) / 60))}:${pad(Math.max(0, Math.min(1439, minutes)) % 60)}`
export const timeToMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5))

function parseDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return
  const date = new Date(0); date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3])); date.setHours(0, 0, 0, 0)
  return dateValue(date) === value ? date : undefined
}
const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
type PickerProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: string
  onValueChange: (value: string) => void
  min?: string
  max?: string
}

function Calendar({ value, onChange, min, max }: { value: string; onChange: (value: string) => void; min?: string; max?: string }) {
  const selected = parseDate(value), [month, setMonth] = useState(selected ?? parseDate(min ?? '') ?? new Date())
  const earliest = parseDate(min ?? ''), latest = parseDate(max ?? '')
  const choose = (date?: Date) => { if (date) onChange(dateValue(date)) }
  const today = new Date(); today.setHours(0, 0, 0, 0)
  return <div className="control-calendar">
    <div className="control-calendar-heading"><button type="button" aria-label="上一年" onClick={() => setMonth(new Date(month.getFullYear() - 1, month.getMonth(), 1))}><ChevronLeft size={13} /></button><span>{month.getFullYear()} 年</span><button type="button" aria-label="下一年" onClick={() => setMonth(new Date(month.getFullYear() + 1, month.getMonth(), 1))}><ChevronRight size={13} /></button></div>
    <DayPicker locale={zhCN} mode="single" month={month} onMonthChange={setMonth} selected={selected} onSelect={choose} showOutsideDays fixedWeeks weekStartsOn={1} disabled={[...(earliest ? [{ before: earliest }] : []), ...(latest ? [{ after: latest }] : [])]} labels={{ labelPrevious: () => '上个月', labelNext: () => '下个月', labelDayButton: date => dateValue(date) }} />
    <div className="control-calendar-footer"><button type="button" disabled={Boolean(earliest && today < earliest || latest && today > latest)} onClick={() => { setMonth(today); choose(today) }}>今天</button><span>支持输入 YYYY-MM-DD</span></div>
  </div>
}

function TimeColumns({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const hour = value.slice(0, 2), minute = value.slice(3, 5), root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    root.current?.querySelectorAll<HTMLElement>('[aria-selected="true"]').forEach(item => {
      const list = item.parentElement!
      const offset = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop
      list.scrollTop = Math.max(0, offset - (list.clientHeight - item.offsetHeight) / 2)
    })
  }, [])
  return <div className="control-time-columns" ref={root}>
    {(['hour', 'minute'] as const).map((kind, column) => <div key={kind}><strong>{column ? '分钟' : '小时'}</strong><div className="control-time-list" role="listbox" aria-label={column ? '分钟' : '小时'}>
      {Array.from({ length: column ? 60 : 24 }, (_, index) => pad(index)).map(part => <button key={part} type="button" role="option" aria-selected={part === (column ? minute : hour)} tabIndex={part === (column ? minute : hour) ? 0 : -1} onClick={() => onChange(column ? `${hour}:${part}` : `${part}:${minute}`)} onKeyDown={event => {
        const movement = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
        const list = event.currentTarget.parentElement!, options = [...list.querySelectorAll<HTMLButtonElement>('button')]
        if (movement || event.key === 'Home' || event.key === 'End') { event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : Math.max(0, Math.min(options.length - 1, Number(part) + movement)); options[index]?.focus(); options[index]?.click() }
      }}>{part}</button>)}
    </div></div>)}
  </div>
}

function Picker({ kind, value, onValueChange, min, max, className = '', disabled, ...props }: PickerProps & { kind: 'date' | 'time' | 'datetime' }) {
  const [open, setOpen] = useState(false), [draft, setDraft] = useState(value.replace('T', ' ')), [popupDate, setPopupDate] = useState(''), [popupTime, setPopupTime] = useState('00:00')
  const input = useRef<HTMLInputElement>(null), errorId = useId(), label = props['aria-label'] ?? (kind === 'date' ? '日期' : kind === 'time' ? '时间' : '日期与时间')
  const normalize = (text: string) => kind === 'datetime' ? text.trim().replace(' ', 'T') : text.trim()
  const validate = (text: string) => {
    if (!text) return props.required ? '请填写此项' : ''
    const normalized = normalize(text)
    if (kind !== 'time' && !parseDate(kind === 'date' ? normalized : normalized.slice(0, 10))) return '请输入有效日期，例如 2026-10-07'
    if (kind !== 'date' && (!validTime(kind === 'time' ? normalized : normalized.slice(11)) || kind === 'datetime' && normalized[10] !== 'T')) return '请输入 24 小时时间，例如 09:30'
    if (min && normalized < min) return `不能早于 ${min.replace('T', ' ')}`
    if (max && normalized > max) return `不能晚于 ${max.replace('T', ' ')}`
    return ''
  }
  const error = validate(draft)
  useEffect(() => { setDraft(value.replace('T', ' ')) }, [value])
  useEffect(() => { input.current?.setCustomValidity(error) }, [error])
  const openChange = (next: boolean) => {
    if (next) {
      const valid = !validate(draft) && draft ? normalize(draft) : value
      const earliest = parseDate(min?.slice(0, 10) ?? '')
      let initialDate = parseDate(valid.slice(0, 10)) ?? earliest ?? new Date()
      const latest = parseDate(max?.slice(0, 10) ?? '')
      if (earliest && initialDate < earliest) initialDate = earliest
      if (latest && initialDate > latest) initialDate = latest
      setPopupDate(dateValue(initialDate))
      setPopupTime(validTime(kind === 'time' ? valid : valid.slice(11)) ? (kind === 'time' ? valid : valid.slice(11)) : `${pad(new Date().getHours())}:${pad(new Date().getMinutes())}`)
    }
    setOpen(next)
  }
  const commit = (next: string) => { if (validate(next)) return; setDraft(next.replace('T', ' ')); onValueChange(next); setOpen(false) }
  const Icon = kind === 'time' ? Clock3 : CalendarDays
  return <div className={`control-field ${className}`}>
    <Popover.Root open={open && !disabled} onOpenChange={openChange}>
      <Popover.Anchor asChild><div className={`control-date-input ${error ? 'is-invalid' : ''}`}>
        <input {...props} ref={input} aria-label={label} aria-invalid={Boolean(error)} aria-describedby={error ? errorId : props['aria-describedby']} type="text" autoComplete="off" disabled={disabled} value={draft} placeholder={props.placeholder ?? (kind === 'date' ? 'YYYY-MM-DD' : kind === 'time' ? 'HH:mm' : 'YYYY-MM-DD HH:mm')} onChange={event => { const next = event.target.value; setDraft(next); if (!(event.nativeEvent instanceof InputEvent && event.nativeEvent.isComposing) && !validate(next)) onValueChange(normalize(next)) }} onCompositionEnd={event => { const next = event.currentTarget.value; if (!validate(next)) onValueChange(normalize(next)) }} onKeyDown={event => { event.stopPropagation(); if (event.key === 'ArrowDown' && event.altKey) { event.preventDefault(); openChange(true) } }} />
        <Popover.Trigger asChild><button type="button" data-control-trigger="picker" className="control-picker-button" disabled={disabled} aria-label={`选择${label}`} title={`选择${label}`}><Icon size={16} /></button></Popover.Trigger>
      </div></Popover.Anchor>
      <Popover.Portal><Popover.Content className={`control-popup control-picker-popup ${kind === 'datetime' ? 'control-datetime-popup' : ''}`} data-control-popup sideOffset={6} collisionPadding={8} align="start" onKeyDown={event => event.stopPropagation()} onOpenAutoFocus={event => { event.preventDefault(); requestAnimationFrame(() => document.getElementById(`${errorId}-popup`)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true })) }}>
        <div id={`${errorId}-popup`} className="control-picker-body">
          {kind !== 'time' && <Calendar value={popupDate} min={min?.slice(0, 10)} max={max?.slice(0, 10)} onChange={next => { setPopupDate(next); if (kind === 'date') commit(next) }} />}
          {kind !== 'date' && <div className="control-time-panel"><div className="control-time-heading"><Clock3 size={15} /><strong>{popupTime}</strong><span>24 小时制</span></div><TimeColumns value={popupTime} onChange={setPopupTime} /></div>}
        </div>
        <div className="control-picker-footer"><button type="button" disabled={props.required} onClick={() => commit('')}>清空</button>{kind !== 'date' && <><button type="button" onClick={() => { const now = new Date(); setPopupDate(dateValue(now)); setPopupTime(`${pad(now.getHours())}:${pad(now.getMinutes())}`) }}>现在</button><button type="button" className="control-confirm" disabled={Boolean(validate(kind === 'time' ? popupTime : `${popupDate}T${popupTime}`))} onClick={() => commit(kind === 'time' ? popupTime : `${popupDate}T${popupTime}`)}>确定</button></>}</div>
      </Popover.Content></Popover.Portal>
    </Popover.Root>
    {error && <span id={errorId} className="control-error" role="status">{error}</span>}
  </div>
}

export const DatePicker = (props: PickerProps) => <Picker {...props} kind="date" />
export const TimePicker = (props: PickerProps) => <Picker {...props} kind="time" />
export const DateTimePicker = (props: PickerProps) => <Picker {...props} kind="datetime" />
