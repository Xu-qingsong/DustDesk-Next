import { FocusSummary } from './ProductivityPages'
import type { WorkspaceState } from '../../../shared/types'
import { PageHeader, Panel } from '../components/common'

export function StatsPage({ state }: { state: WorkspaceState }) {
  const done = state.Todos.filter(item => item.IsCompleted).length
  const totalPhases = state.Projects.reduce((sum, project) => sum + project.Phases.length, 0)
  const rate = state.Todos.length ? Math.round(done / state.Todos.length * 100) : 0
  return <><PageHeader eyebrow="Insights" title="统计分析" description="用简单的数字回顾工作区的积累。" /><div className="metrics"><div className="metric"><span>任务总数</span><strong>{state.Todos.length}</strong><small>{done} 件已完成</small></div><div className="metric"><span>项目</span><strong>{state.Projects.length}</strong><small>{totalPhases} 个阶段</small></div><div className="metric"><span>便签</span><strong>{state.Notes.length}</strong><small>持续记录中</small></div><div className="metric"><span>剪贴板历史</span><strong>{state.ClipboardHistory.length}</strong><small>最近 200 条</small></div></div><Panel><div className="panel-heading"><div><span className="section-kicker">Completion</span><h3>任务完成率</h3></div><strong className="completion-rate">{rate}%</strong></div><div className="progress-track"><span style={{ width: `${rate}%` }} /></div><div className="panel-foot"><span>已完成 {done} 件</span><span>待完成 {state.Todos.length - done} 件</span></div></Panel><FocusSummary state={state} /></>
}
