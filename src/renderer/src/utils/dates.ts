import type { TodoRecord } from '../../../shared/types'

export const reminderInputValue = (value?: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export const reminderIsoValue = (value: string) => value ? new Date(value).toISOString() : null

export const localDateInputValue = (value?: string | null) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : reminderInputValue(value).slice(0, 10)

export const localDateIsoValue = (value: string) => reminderIsoValue(value ? `${value}T00:00:00` : '')

const calendarDay = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000

export const isTodoOverdue = (todo: TodoRecord, now = new Date()) => !todo.IsCompleted && !!todo.ReminderAt && new Date(todo.ReminderAt) < now

export const daysUntilPayday = (now: Date, configuredDay: number) => {
  const day = Number.isFinite(configuredDay) ? Math.max(1, Math.min(31, Math.trunc(configuredDay))) : 10
  const paydayInMonth = (month: number) => new Date(now.getFullYear(), month, Math.min(day, new Date(now.getFullYear(), month + 1, 0).getDate()))
  let payday = paydayInMonth(now.getMonth())
  if (calendarDay(payday) < calendarDay(now)) payday = paydayInMonth(now.getMonth() + 1)
  return calendarDay(payday) - calendarDay(now)
}

export const formatCountdown = (seconds: number) => {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

export const formatUptime = (seconds: number) => {
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor(seconds % 86400 / 3600)
  const minutes = Math.floor(seconds % 3600 / 60)
  return days ? `${days}天 ${hours}小时` : `${hours}小时 ${minutes}分钟`
}
