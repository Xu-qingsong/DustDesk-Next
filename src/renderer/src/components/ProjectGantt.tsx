import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CalendarDays } from 'lucide-react'
import type { ProjectPhaseRecord } from '../../../shared/types'
import { searchTargetId } from '../app/searchNavigation'
import { ganttAxis, ganttDate, phaseSchedule, type GanttScale } from '../utils/gantt'
import './projectGantt.css'

const statusNames = { Todo: '待开始', Doing: '进行中', Done: '已完成' }

export function ProjectGantt({ phases, expandedPhaseId, onExpand, onEdit, children }: {
  phases: ProjectPhaseRecord[]; expandedPhaseId: string | null; onExpand: (id: string) => void; onEdit: (phase: ProjectPhaseRecord) => void; children?: ReactNode
}) {
  const [scale, setScale] = useState<GanttScale>()
  const viewport = useRef<HTMLDivElement>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const measure = () => setAvailableWidth(Math.max(0, node.clientWidth - 190))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const axis = ganttAxis(phases, scale, undefined, availableWidth)
  const todayVisible = axis.today >= axis.start && axis.today <= axis.end
  const todayLeft = (axis.today - axis.start + 0.5) * axis.pixelsPerDay
  return <section className="project-gantt" aria-label="阶段甘特图">
    <div className="gantt-toolbar">
      <div><h3>阶段计划</h3><span>{phases.length} 个阶段 · 点击阶段条编辑</span></div>
      <div className="gantt-view-controls">
        <button className="mini-button" disabled={!todayVisible} onClick={() => viewport.current?.scrollTo({ left: Math.max(0, todayLeft - (viewport.current.clientWidth - 190) / 2) })}>今天</button>
        <div className="segmented" role="group" aria-label="时间轴刻度">{([['fit', '适应'], ['day', '日'], ['week', '周'], ['month', '月']] as const).map(([value, label]) => <button key={value} className={(value === 'fit' ? scale === undefined : scale === value) ? 'selected' : ''} aria-pressed={value === 'fit' ? scale === undefined : scale === value} onClick={() => setScale(value === 'fit' ? undefined : value)}>{label}</button>)}</div>
      </div>
    </div>
    <div className="gantt-scroll" ref={viewport} tabIndex={0} role="region" aria-label="阶段时间轴，可横向滚动" style={{ '--gantt-axis-width': `${axis.width}px` } as CSSProperties}>
      <div className="gantt-table">
        <div className="gantt-header">
          <div className="gantt-label-heading">阶段 / 进度</div>
          <div className="gantt-axis"><div className="gantt-date-range">{ganttDate(axis.start)} — {ganttDate(axis.end)}</div>{axis.ticks.map(tick => <span className="gantt-tick" key={tick.start} title={tick.detail} style={{ left: (tick.start - axis.start) * axis.pixelsPerDay, width: tick.days * axis.pixelsPerDay }}>{tick.label}</span>)}</div>
        </div>
        {phases.map(phase => {
          const schedule = phaseSchedule(phase)
          const progress = Math.max(0, Math.min(100, phase.ProgressPercent || 0))
          const completed = phase.Subtasks.filter(task => task.IsCompleted).length
          const dateText = schedule.invalid ? '日期需调整' : schedule.days !== null ? `${ganttDate(schedule.start!)} 至 ${ganttDate(schedule.end!)} · ${schedule.days} 天` : schedule.start !== null ? `${ganttDate(schedule.start)} 起，结束待定` : schedule.end !== null ? `截止 ${ganttDate(schedule.end)}，开始待定` : '未设置日期'
          const position = schedule.start ?? schedule.end
          const markerLeft = position !== null ? (position - axis.start) * axis.pixelsPerDay : null
          return <div key={phase.Id} className={`gantt-row ${expandedPhaseId === phase.Id ? 'selected' : ''}`} id={searchTargetId('phase', phase.Id)} data-search-target tabIndex={-1}>
            <div className="gantt-phase-label">
              <button className="gantt-expand" aria-label={`${expandedPhaseId === phase.Id ? '收起' : '展开'} ${phase.Title} 的子事项`} aria-expanded={expandedPhaseId === phase.Id} onClick={() => onExpand(phase.Id)}>{expandedPhaseId === phase.Id ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
              <button className="gantt-phase-name" title={phase.Title} aria-label={`编辑阶段 ${phase.Title}`} onClick={() => onEdit(phase)}><strong>{phase.Title || '未命名阶段'}</strong><small><span className={`gantt-status ${phase.Status.toLowerCase()}`}>{statusNames[phase.Status]}</span>{phase.Subtasks.length ? `${completed}/${phase.Subtasks.length} 子事项` : '暂无子事项'}</small></button>
              <span className="gantt-percent">{progress}%</span>
            </div>
            <div className="gantt-track">
              {axis.ticks.map(tick => <span key={tick.start} className="gantt-gridline" style={{ left: (tick.start - axis.start) * axis.pixelsPerDay }} />)}
              {todayVisible && <span className="gantt-today-line" style={{ left: todayLeft }} title="今天" />}
              {schedule.days !== null ? <button className={`gantt-bar ${phase.Status.toLowerCase()}`} title={`${phase.Title} · ${dateText} · ${progress}%`} aria-label={`编辑 ${phase.Title}：${dateText}，进度 ${progress}%`} style={{ left: (schedule.start! - axis.start) * axis.pixelsPerDay, width: schedule.days * axis.pixelsPerDay }} onClick={() => onEdit(phase)}><span className="gantt-bar-progress" style={{ width: `${progress}%` }} /><span className="gantt-bar-caption">{phase.Title}</span></button>
                : <button className={`gantt-unscheduled ${schedule.invalid ? 'invalid' : ''}`} style={markerLeft !== null && !schedule.invalid ? { left: markerLeft, transform: markerLeft > axis.width / 2 ? 'translateX(-100%)' : undefined } : undefined} onClick={() => onEdit(phase)} title={dateText}><CalendarDays size={13} />{dateText}</button>}
            </div>
          </div>
        })}
      </div>
    </div>
    <div className="gantt-foot"><span><i className="gantt-today-dot" />今天</span><span>色块内的填充表示阶段进度</span></div>
    {children}
  </section>
}
