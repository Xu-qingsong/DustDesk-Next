import { Children, Fragment, isValidElement, useId, useState } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import * as SelectPrimitive from '@radix-ui/react-select'
import * as Popover from '@radix-ui/react-popover'
import { Command } from 'cmdk'
import { Check, ChevronDown, ChevronUp, Search } from 'lucide-react'

type Option = { value: string; label: ReactNode; disabled?: boolean }
type OptionProps = { value?: string | number; children?: ReactNode; disabled?: boolean }
type SelectProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'value' | 'defaultValue' | 'onChange' | 'children'> & {
  value: string | number
  onValueChange: (value: string) => void
  children: ReactNode
  placeholder?: string
  searchable?: boolean
}

function readOptions(children: ReactNode): Option[] {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement<OptionProps>(child)) return []
    if (child.type === Fragment) return readOptions(child.props.children)
    return child.type === 'option' ? [{ value: String(child.props.value ?? child.props.children ?? ''), label: child.props.children, disabled: child.props.disabled }] : []
  })
}

export function Select({ value, onValueChange, children, placeholder = '请选择', searchable = false, className = '', disabled, ...props }: SelectProps) {
  const options = readOptions(children), selected = options.find(option => option.value === String(value))
  const [open, setOpen] = useState(false), listId = useId()
  const trigger = <button {...props} type="button" className={`control-trigger ${className}`} data-control-trigger="select" data-state={open && !disabled ? 'open' : 'closed'} role="combobox" aria-expanded={open && !disabled} aria-controls={listId} aria-haspopup="listbox" disabled={disabled || !options.length}>
    <span className={selected ? '' : 'control-placeholder'}>{selected?.label ?? placeholder}</span><ChevronDown size={14} aria-hidden />
  </button>

  if (searchable) return <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Trigger asChild>{trigger}</Popover.Trigger>
    <Popover.Portal><Popover.Content className="control-popup control-combobox" data-control-popup sideOffset={6} collisionPadding={8} align="start" onKeyDown={event => event.stopPropagation()}>
      <Command label="搜索选项"><div className="control-search"><Search size={14} /><Command.Input aria-label="搜索选项" placeholder="搜索选项…" /></div>
        <Command.List id={listId} className="control-options" aria-label={props['aria-label'] ?? '可选项目'}><Command.Empty className="control-empty">没有匹配的选项</Command.Empty>
          {options.map(option => <Command.Item key={option.value} value={`v:${option.value}`} keywords={[String(option.label)]} disabled={option.disabled} className="control-option" data-control-option data-control-value={option.value} aria-selected={option.value === String(value)} onSelect={() => { onValueChange(option.value); setOpen(false) }}>
            <span>{option.label}</span>{option.value === String(value) && <Check size={14} />}
          </Command.Item>)}
        </Command.List>
      </Command>
    </Popover.Content></Popover.Portal>
  </Popover.Root>

  return <SelectPrimitive.Root value={selected ? `v:${value}` : ''} onValueChange={next => onValueChange(next.slice(2))} disabled={disabled || !options.length} open={open && !disabled} onOpenChange={setOpen}>
    <SelectPrimitive.Trigger {...props} className={`control-trigger ${className}`} data-control-trigger="select"><SelectPrimitive.Value placeholder={placeholder} /><SelectPrimitive.Icon><ChevronDown size={14} /></SelectPrimitive.Icon></SelectPrimitive.Trigger>
    <SelectPrimitive.Portal><SelectPrimitive.Content className="control-popup control-select" data-control-popup position="popper" sideOffset={6} collisionPadding={8} align="start" onKeyDown={event => event.stopPropagation()}>
      <SelectPrimitive.ScrollUpButton className="control-scroll"><ChevronUp size={14} /></SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport className="control-options">{options.map(option => <SelectPrimitive.Item key={option.value} value={`v:${option.value}`} disabled={option.disabled} className="control-option" data-control-option data-control-value={option.value}>
        <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText><SelectPrimitive.ItemIndicator><Check size={14} /></SelectPrimitive.ItemIndicator>
      </SelectPrimitive.Item>)}</SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="control-scroll"><ChevronDown size={14} /></SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content></SelectPrimitive.Portal>
  </SelectPrimitive.Root>
}
