import { isComposingKey } from '../../utils/keyboard'
import { useEffect, useId, useRef, useState } from 'react'
import type { InputHTMLAttributes } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, Plus } from 'lucide-react'

type TagProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'list' | 'value' | 'defaultValue' | 'onChange' | 'onBlur'> & { options: string[]; value?: string; defaultValue?: string; onValueChange?: (value: string) => void; onValueCommit?: (value: string) => void }
export function TagInput({ options, value, defaultValue = '', onValueChange, onValueCommit, onKeyDown, ...props }: TagProps) {
  const [local, setLocal] = useState(defaultValue), [open, setOpen] = useState(false), [active, setActive] = useState(-1), [composing, setComposing] = useState(false)
  const input = useRef<HTMLInputElement>(null), list = useRef<HTMLDivElement>(null), id = useId(), text = value ?? local
  const unique = [...new Set(options)], filtered = unique.filter(option => option.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase()))
  const newTag = text.trim() && !unique.some(option => option.toLocaleLowerCase() === text.trim().toLocaleLowerCase()) ? text.trim() : ''
  const choices = [...filtered, ...(newTag ? [newTag] : [])]
  useEffect(() => { if (document.activeElement !== input.current) setLocal(defaultValue) }, [defaultValue])
  useEffect(() => setActive(-1), [text])
  useEffect(() => {
    const option = list.current?.querySelector<HTMLElement>(`[data-tag-index="${active}"]`), host = list.current
    if (option && host) { const top = option.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop; if (top < host.scrollTop) host.scrollTop = top; else if (top + option.offsetHeight > host.scrollTop + host.clientHeight) host.scrollTop = top + option.offsetHeight - host.clientHeight }
  }, [active])
  const choose = (next: string) => { setLocal(next); onValueChange?.(next); onValueCommit?.(next); setOpen(false); input.current?.focus({ preventScroll: true }) }
  return <Popover.Root open={open && !props.disabled && choices.length > 0} onOpenChange={setOpen}>
    <Popover.Anchor asChild><div className="control-tag"><input {...props} ref={input} value={text} role="combobox" aria-autocomplete="list" aria-expanded={open && choices.length > 0} aria-controls={id} aria-activedescendant={active >= 0 && open ? `${id}-${active}` : undefined} data-control-trigger="tag" onFocus={() => setOpen(true)} onChange={event => { setLocal(event.target.value); onValueChange?.(event.target.value); setOpen(true) }} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} onBlur={() => onValueCommit?.(text)} onKeyDown={event => {
      if (composing || isComposingKey(event.nativeEvent)) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); setOpen(true); setActive(index => event.key === 'ArrowDown' ? Math.min(choices.length - 1, index + 1) : Math.max(0, index - 1)); return }
      if (event.key === 'Enter' && open && active >= 0 && choices[active] !== undefined) { event.preventDefault(); event.stopPropagation(); choose(choices[active]); return }
      if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); return }
      onKeyDown?.(event)
    }} /></div></Popover.Anchor>
    <Popover.Portal><Popover.Content className="control-popup control-tag-popup" data-control-popup sideOffset={6} collisionPadding={8} align="start" onOpenAutoFocus={event => event.preventDefault()} onCloseAutoFocus={event => event.preventDefault()} onInteractOutside={event => { if (event.target === input.current) event.preventDefault() }}>
      <div id={id} role="listbox" aria-label="标签建议" ref={list} className="control-options">{choices.map((option, index) => <button key={option} id={`${id}-${index}`} type="button" role="option" aria-selected={active === index} data-tag-index={index} className={`control-tag-option ${active === index ? 'selected' : ''}`} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => choose(option)}>{newTag && index === choices.length - 1 ? <Plus size={14} /> : <Check size={14} style={{ visibility: option === text ? 'visible' : 'hidden' }} />}<span>{newTag && index === choices.length - 1 ? `新增标签「${option}」` : option}</span></button>)}</div>
    </Popover.Content></Popover.Portal>
  </Popover.Root>
}
