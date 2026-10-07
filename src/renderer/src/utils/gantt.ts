import type { ProjectPhaseRecord } from '../../../shared/types'
import { localDateInputValue } from './dates'

export type GanttScale = 'day' | 'week' | 'month'
const dayMilliseconds = 86400000

export function ganttDay(value?: string | null): number | null {
  const text = localDateInputValue(value)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null
  const year = Number(text.slice(0, 4)), month = Number(text.slice(5, 7)), day = Number(text.slice(8))
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day); date.setUTCHours(0, 0, 0, 0)
  if (year < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return date.getTime() / dayMilliseconds
}

export function ganttDate(day: number) {
  return new Date(day * dayMilliseconds).toISOString().slice(0, 10)
}

export function phaseSchedule(phase: ProjectPhaseRecord) {
  const start = ganttDay(phase.StartDate), end = ganttDay(phase.EndDate)
  const invalid = start !== null && end !== null && end < start
  return { start, end, invalid, days: start !== null && end !== null && !invalid ? end - start + 1 : null }
}

export function ganttRange(phases: ProjectPhaseRecord[], today = new Date()) {
  const currentDay = ganttDay(localDateInputValue(today.toISOString()))!
  const scheduled = phases.flatMap(phase => {
    const dates = phaseSchedule(phase)
    return dates.invalid ? [] : [dates.start, dates.end].filter((day): day is number => day !== null)
  })
  const first = scheduled.length ? Math.min(...scheduled) : currentDay
  const last = scheduled.length ? Math.max(...scheduled) : currentDay + 13
  return { start: first - 3, end: Math.max(last + 3, first + 13), today: currentDay }
}

export function ganttAxis(phases: ProjectPhaseRecord[], scale?: GanttScale, today?: Date, availableWidth?: number) {
  const range = ganttRange(phases, today)
  const span = range.end - range.start + 1
  const activeScale = scale ?? (span > 240 ? 'month' : span > 60 ? 'week' : 'day')
  let start = range.start, end = range.end
  if (activeScale === 'week') start -= (new Date(start * dayMilliseconds).getUTCDay() + 6) % 7
  if (activeScale === 'month') {
    const first = new Date(start * dayMilliseconds), last = new Date(end * dayMilliseconds)
    start = ganttDay(first.toISOString().slice(0, 8) + '01')!
    last.setUTCMonth(last.getUTCMonth() + 1, 0)
    end = last.getTime() / dayMilliseconds
  }
  const days = end - start + 1
  // Keep extreme legacy ranges usable without creating millions of tick nodes.
  const naturalWidth = activeScale === 'day' ? 32 : activeScale === 'week' ? 10 : 3.5
  const fittedWidth = scale === undefined && availableWidth ? Math.max(activeScale === 'day' ? 12 : activeScale === 'week' ? 5 : 1.7, Math.min(naturalWidth, availableWidth / days)) : naturalWidth
  const pixelsPerDay = Math.min(fittedWidth, 100000 / days)
  const ticks: { start: number; days: number; label: string; detail: string }[] = []
  const stride = Math.max(1, Math.ceil(days / 500), activeScale === 'day' ? Math.ceil(24 / pixelsPerDay) : 1)
  for (let day = start; day <= end;) {
    const date = new Date(day * dayMilliseconds)
    let next = day + (activeScale === 'week' ? 7 * stride : stride)
    if (activeScale === 'month') {
      date.setUTCMonth(date.getUTCMonth() + Math.max(1, Math.ceil(stride / 28)), 1)
      next = date.getTime() / dayMilliseconds
    }
    const text = ganttDate(day)
    ticks.push({ start: day, days: Math.min(next, end + 1) - day, label: activeScale === 'month' ? `${text.slice(0, 4)}年${Number(text.slice(5, 7))}月` : activeScale === 'week' ? `${Number(text.slice(5, 7))}/${Number(text.slice(8))}` : String(Number(text.slice(8))), detail: text })
    day = next
  }
  return { ...range, start, end, days, scale: activeScale, pixelsPerDay, width: days * pixelsPerDay, ticks }
}
