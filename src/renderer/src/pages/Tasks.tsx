import { toast } from 'sonner'
import { useEffect, useState } from 'react'
import { ArrowLeft, ArrowRight, CalendarDays, Check, Pencil, Plus, Trash2 } from 'lucide-react'
import type { TodoRecord, WorkspaceState } from '../../../shared/types'
import { Empty, PageHeader, Panel } from '../components/common'
import { isTodoOverdue } from '../utils/dates'
import { searchTargetId, useSearchReveal, type SearchNavigation } from '../app/searchNavigation'

const now = () => new Date().toISOString()
const uid = () => crypto.randomUUID()
const reminderInputValue = (value?: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
const reminderIsoValue = (value: string) => value ? new Date(value).toISOString() : null
const withTagPreset = (state: WorkspaceState, tag: string) => {
  const normalized = tag.trim()
  if (!normalized || state.TagPresets.some(item => item.Name.toLowerCase() === normalized.toLowerCase())) return state
  return { ...state, TagPresets: [...state.TagPresets, { Name: normalized, ColorArgb: -65536 }] }
}

export function Tasks({ state, persist, navigation }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; navigation?: SearchNavigation }) {
  const [filter, setFilter] = useState<'all' | 'open' | 'done' | 'overdue'>('open')
  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState(() => new Date())
  const dateKey = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
  const selectedKey = dateKey(selectedDate)
  const dateTodos = filter === 'overdue' ? state.Todos : state.Todos.filter(todo => dateKey(new Date(todo.CreatedAt)) === selectedKey)
  const todos = dateTodos.filter(todo => filter === 'all' || filter === 'open' && !todo.IsCompleted || filter === 'done' && todo.IsCompleted || filter === 'overdue' && isTodoOverdue(todo))
  const target = navigation?.target.page === 'tasks' ? navigation.target : undefined
  const targetTodo = target ? state.Todos.find(todo => todo.Id === target.id) : undefined
  useEffect(() => {
    if (!targetTodo) return
    setSelectedDate(new Date(targetTodo.CreatedAt))
    setFilter('all')
    setSelected(targetTodo.Id)
  }, [navigation?.requestId, target?.id])
  useSearchReveal(navigation, Boolean(targetTodo && selected === targetTodo.Id && todos.some(todo => todo.Id === targetTodo.Id)))
  const setTodo = (id: string, changes: Partial<TodoRecord>, message = '任务已保存') => void persist({ ...state, Todos: state.Todos.map(item => item.Id === id ? { ...item, ...changes, ReminderNotifiedAt: changes.ReminderAt !== undefined ? null : item.ReminderNotifiedAt } : item) }, message)
  const add = () => { if (!title.trim()) return; const created = new Date(selectedDate); const current = new Date(); created.setHours(current.getHours(), current.getMinutes(), current.getSeconds(), current.getMilliseconds()); void persist(withTagPreset({ ...state, Todos: [...state.Todos, { Id: uid(), Title: title.trim(), Tag: tag.trim(), Note: '', IsCompleted: false, CreatedAt: created.toISOString(), ReminderAt: null, ReminderNotifiedAt: null, ReminderRepeat: 'None' }] }, tag), '任务已创建'); setTitle(''); setTag('') }
  const toggle = (id: string) => void persist({ ...state, Todos: state.Todos.map(todo => todo.Id === id ? { ...todo, IsCompleted: !todo.IsCompleted } : todo) }, '任务状态已更新')
  const remove = (id: string) => void persist({ ...state, Todos: state.Todos.filter(todo => todo.Id !== id) }, '任务已删除')
  const snooze = (todo: TodoRecord, minutes: number) => setTodo(todo.Id, { ReminderAt: new Date(Date.now() + minutes * 60_000).toISOString(), ReminderNotifiedAt: null }, `已推迟 ${minutes} 分钟`)
  return <><PageHeader eyebrow="Tasks" title="任务" description="把今天要完成的事情放在一个清晰的队列里。" action={<div className="task-toolbar"><div className="date-stepper"><button className="icon-button subtle" title="前一天" onClick={() => setSelectedDate(value => new Date(value.getTime() - 86400000))}><ArrowLeft size={14} /></button><span><CalendarDays size={14} />{selectedDate.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</span><button className="icon-button subtle" title="后一天" onClick={() => setSelectedDate(value => new Date(value.getTime() + 86400000))}><ArrowRight size={14} /></button><button className="mini-button" onClick={() => setSelectedDate(new Date())}>今天</button></div><div className="segmented">{(['open', 'all', 'done', 'overdue'] as const).map(item => <button key={item} className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)}>{item === 'open' ? '未完成' : item === 'all' ? '全部' : item === 'done' ? '已完成' : '逾期'}</button>)}</div></div>} /><Panel><div className="quick-add wide"><input value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => event.key === 'Enter' && add()} placeholder="添加一个任务，按 Enter 保存" autoFocus /><input value={tag} onChange={event => setTag(event.target.value)} list="todo-tags" placeholder="标签（可选）" /><datalist id="todo-tags">{state.TagPresets.map(item => <option key={item.Name} value={item.Name} />)}</datalist><button className="primary-button" onClick={add}><Plus size={16} />添加任务</button></div><div className="todo-list">{todos.map(todo => <div className={`todo-row detailed ${todo.IsCompleted ? 'completed' : ''}`} key={todo.Id} id={searchTargetId('task', todo.Id)} data-search-target tabIndex={-1}><button className={`todo-check ${todo.IsCompleted ? 'checked' : ''}`} onClick={() => toggle(todo.Id)} title={todo.IsCompleted ? '标记为未完成' : '标记为完成'}>{todo.IsCompleted && <Check size={13} />}</button><div className="todo-main"><span>{todo.Title}</span><small>{todo.Tag || '未分类'} · {new Date(todo.CreatedAt).toLocaleDateString('zh-CN')}{todo.ReminderAt ? ` · 提醒 ${new Date(todo.ReminderAt).toLocaleString('zh-CN')}` : ''}</small></div><button className="icon-button subtle" title="编辑任务" onClick={() => setSelected(selected === todo.Id ? null : todo.Id)}><Pencil size={15} /></button><button className="icon-button danger" title="删除任务" onClick={() => remove(todo.Id)}><Trash2 size={15} /></button>{selected === todo.Id && <div className="task-editor"><label className="task-title-field">任务标题<input aria-label="任务标题" className="task-inline-input" maxLength={300} defaultValue={todo.Title} onBlur={event => { const title = event.target.value.trim(); if (!title) { event.target.value = todo.Title; toast.error('任务标题不能为空'); return }; if (title !== todo.Title) setTodo(todo.Id, { Title: title }, '任务标题已保存') }} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }} /></label><input className="task-inline-input" defaultValue={todo.Tag} list="todo-tags" placeholder="标签" onBlur={event => setTodo(todo.Id, { Tag: event.target.value }, '标签已保存')} /><input className="task-inline-input" defaultValue={todo.Note} placeholder="任务备注" onBlur={event => setTodo(todo.Id, { Note: event.target.value }, '备注已保存')} /><label>提醒时间<input type="datetime-local" value={reminderInputValue(todo.ReminderAt)} onChange={event => setTodo(todo.Id, { ReminderAt: reminderIsoValue(event.target.value), ReminderRepeat: event.target.value ? todo.ReminderRepeat : 'None' })} /></label><label>重复<select value={todo.ReminderRepeat} disabled={!todo.ReminderAt} onChange={event => setTodo(todo.Id, { ReminderRepeat: event.target.value as TodoRecord['ReminderRepeat'] })}><option value="None">不重复</option><option value="Daily">每天</option><option value="Weekdays">工作日</option><option value="Weekly">每周</option></select></label>{todo.ReminderAt && <div className="task-snooze"><button className="text-button" onClick={() => snooze(todo, 15)}>15 分钟</button><button className="text-button" onClick={() => snooze(todo, 30)}>30 分钟</button><button className="text-button" onClick={() => snooze(todo, 60)}>1 小时</button><button className="text-button" onClick={() => snooze(todo, 1440)}>明天</button><button className="text-button" onClick={() => setTodo(todo.Id, { ReminderAt: null, ReminderRepeat: 'None', ReminderNotifiedAt: null }, '提醒已清除')}>清除提醒</button></div>}</div>}</div>)}{todos.length === 0 && <Empty icon={Check} title="这里还没有任务" description="添加一项任务，开始组织今天。" />}</div></Panel></>
}
