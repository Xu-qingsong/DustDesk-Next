import { useEffect, useRef, useState } from 'react'
import type { WorkspaceState } from '../../../shared/types'
import type { RecycleEntry, ResourceHealth, ResourceScanProgress } from '../../../shared/productivity'
import { focusElapsed, focusPlannedSeconds } from '../../../shared/productivity'
import { Panel } from '../components/common'
import { ConfirmAction, runAction, useOperation } from '../components/Productivity'
import { toast } from 'sonner'

const kindLabels = { task: '任务', note: '便签', project: '项目', launcher: '启动器', group: '链接分类', link: '链接' }
const recycledTitle = (item: RecycleEntry) => 'Title' in item.value ? item.value.Title : item.value.Name

export function RecycleBinPage({ state }: { state: WorkspaceState }) {
  const [query, setQuery] = useState('')
  const [confirm, setConfirm] = useState<string[] | null>(null)
  const { busy, run } = useOperation()
  const entries = state.RecycleBin.filter(item => Date.parse(item.ExpiresAt) > Date.now())
  const shown = entries.filter(item => recycledTitle(item).toLowerCase().includes(query.toLowerCase()))
  return <Panel className="feature-panel"><div className="panel-heading"><div><h3>回收站</h3><p className="muted">删除后保留 30 天，仅移除记录，不删除关联文件。</p></div><button className="secondary-button danger" disabled={busy || !entries.length} onClick={() => setConfirm(entries.map(item => item.Id))}>清空回收站</button></div><input className="settings-input" aria-label="搜索回收站" placeholder="搜索已删除的内容" value={query} onChange={event => setQuery(event.target.value)} />
    {confirm && <ConfirmAction message={`永久删除这 ${confirm.length} 项记录？此操作无法撤销。`} busy={busy} onCancel={() => setConfirm(null)} onConfirm={() => void run(async () => { await runAction({ type: 'recycle-empty', ids: confirm }); setConfirm(null); toast.success('已永久删除所选记录') })} />}
    <div className="feature-stack">{shown.slice().reverse().map(item => <div className="feature-row" key={item.Id}><div className="feature-grow"><strong>{recycledTitle(item) || '未命名'}</strong><small>{kindLabels[item.kind]} · {new Date(item.DeletedAt).toLocaleString('zh-CN')} 删除 · 剩余 {Math.max(1, Math.ceil((Date.parse(item.ExpiresAt) - Date.now()) / 86400000))} 天</small></div><div className="studio-actions"><button className="mini-button" disabled={busy} onClick={() => void run(async () => { await runAction({ type: 'recycle-restore', id: item.Id }); toast.success('已恢复') })}>恢复</button><button className="mini-button danger" disabled={busy} onClick={() => setConfirm([item.Id])}>永久删除</button></div></div>)}</div>{!shown.length && <p className="feature-empty">{entries.length ? '没有匹配的记录' : '回收站为空'}</p>}
  </Panel>
}

export function ResourceHealthPage() {
  const [results, setResults] = useState<ResourceHealth[] | null>(null)
  const [all, setAll] = useState(false)
  const [editing, setEditing] = useState<ResourceHealth | null>(null)
  const [replacement, setReplacement] = useState('')
  const [progress, setProgress] = useState<ResourceScanProgress | null>(null)
  const [scanning, setScanning] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const activeScan = useRef<{ id: string; single: boolean; cancelled: boolean } | null>(null)
  const { busy, run } = useOperation()
  const resourceKey = (item: ResourceHealth) => `${item.kind}:${item.parentId ?? ''}:${item.id}`
  useEffect(() => {
    const unsubscribe = window.dustdesk.onResourceCheckProgress(value => {
      const current = activeScan.current
      if (!current || current.id !== value.requestId || current.cancelled) return
      setProgress(value)
      if (value.item) setResults(previous => {
        const list = previous ?? []
        const exists = list.some(item => resourceKey(item) === resourceKey(value.item!))
        return exists ? list.map(item => resourceKey(item) === resourceKey(value.item!) ? value.item! : item) : [...list, value.item!]
      })
    })
    return () => {
      unsubscribe()
      if (activeScan.current) void window.dustdesk.cancelResourceCheck(activeScan.current.id).catch(() => undefined)
      activeScan.current = null
    }
  }, [])
  const scan = async (resource?: ResourceHealth) => {
    const current = { id: crypto.randomUUID(), single: Boolean(resource), cancelled: false }
    activeScan.current = current
    setScanning(true); setCancelled(false); setProgress(null)
    if (!resource) setResults([])
    try {
      const checked = await window.dustdesk.checkResources({ requestId: current.id, resource })
      if (activeScan.current !== current) return
      const checkedItem = checked[0]
      if (!resource) setResults(checked)
      else if (checkedItem) setResults(previous => (previous ?? []).map(item => resourceKey(item) === resourceKey(checkedItem) ? checkedItem : item))
    } catch (error) {
      if (activeScan.current === current) toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (activeScan.current === current) { activeScan.current = null; setScanning(false) }
    }
  }
  const cancelScan = async () => {
    const current = activeScan.current
    if (!current) return
    await window.dustdesk.cancelResourceCheck(current.id)
    current.cancelled = true; setCancelled(true)
  }
  const locked = busy || scanning
  const issues = results?.filter(item => item.status !== 'ok') ?? []
  const list = all ? results : issues
  return <Panel className="feature-panel"><div className="panel-heading"><div><h3>资源健康检查</h3><p className="muted">检查应用、项目、收纳路径与链接。网络失败只提示，不会自动删除。</p></div>{scanning ? <button className="secondary-button" disabled={cancelled} onClick={() => void run(cancelScan)}>取消检查</button> : <button className="primary-button" disabled={busy} onClick={() => void scan()}>开始检查</button>}</div>
    {(scanning || cancelled) && <div className="resource-progress" role="status"><span>{cancelled ? '已取消，保留已完成的结果' : `正在检查 ${progress?.completed ?? 0} / ${progress?.total ?? '…'} 项`}</span><progress aria-label="资源检查进度" value={progress?.completed ?? 0} max={progress?.total || 1} /></div>}
    {results && <div className="feature-row"><span>已检查 {results.length} 项 · {issues.length} 项需要确认</span><label className="feature-checkbox"><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} />显示全部</label></div>}
    {editing && <div className="feature-preview"><h3>重新关联 · {editing.name}</h3>{editing.kind === 'organizer' && <p className="muted">只能选择当前分类目录中尚未关联的项目，其他文件请通过桌面收纳功能移动。</p>}<div className="feature-form-row"><input aria-label="新的资源地址" disabled={locked} value={replacement} onChange={event => setReplacement(event.target.value)} placeholder={editing.kind === 'link' ? 'http:// 或 https://' : '完整文件路径'} />{editing.kind !== 'link' && <button className="secondary-button" disabled={locked} onClick={() => void run(async () => { const result = await window.dustdesk.pickPath('选择新的资源位置'); if (result.ok && result.path) setReplacement(result.path); else if (result.error) throw new Error(result.error) })}>选择</button>}<button className="secondary-button" disabled={locked} onClick={() => setEditing(null)}>取消</button><button className="primary-button" disabled={locked || !replacement.trim()} onClick={() => void run(async () => {
      await runAction({ type: 'resource-relink', resource: editing, replacement })
      const changed = { ...editing, target: replacement, id: editing.kind === 'organizer' ? replacement : editing.id, status: 'warning' as const, detail: '已重新关联，尚未完成检查' }
      setResults(previous => (previous ?? []).map(item => resourceKey(item) === resourceKey(editing) ? changed : item))
      setEditing(null); toast.success('已重新关联'); await scan(changed)
    })}>保存关联</button></div></div>}
    <div className="feature-stack">{list?.map(item => <div className="feature-row" key={resourceKey(item)}><div className="feature-grow"><strong>{item.name}</strong><code>{item.target}</code><small className={item.status === 'ok' ? 'health-ok' : 'health-warning'}>{item.detail}</small></div><div className="studio-actions"><button className="mini-button" disabled={locked} onClick={() => void scan(item)}>重新检查</button><button className="mini-button" disabled={locked} onClick={() => void run(async () => { const result = item.kind === 'link' ? await window.dustdesk.openUrl(item.target) : await window.dustdesk.openPath(item.target); if (!result.ok) throw new Error(result.error ?? '打开失败') })}>打开确认</button><button className="mini-button" disabled={locked} onClick={() => { setEditing(item); setReplacement(item.target) }}>重新关联</button></div></div>)}</div>
    <p className="feature-empty">{results === null ? '点击「开始检查」扫描当前工作区资源。' : !list?.length && !scanning ? cancelled ? '检查已取消，可重新开始。' : '没有发现需要处理的资源。' : ''}</p>
  </Panel>
}

function duration(seconds: number) { return `${Math.floor(seconds / 60)} 分 ${Math.floor(seconds % 60)} 秒` }
export function FocusSummary({ state }: { state: WorkspaceState }) {
  const [grouping, setGrouping] = useState<'task' | 'project'>('task')
  const groups = new Map<string, { name: string; seconds: number; count: number }>()
  for (const session of state.FocusSessions) {
    const key = grouping === 'task' ? session.TaskId : session.ProjectId
    const name = grouping === 'task' ? state.Todos.find(item => item.Id === key)?.Title ?? session.TaskTitle : state.Projects.find(item => item.Id === key)?.Name ?? session.ProjectName
    const row = groups.get(key) ?? { name, seconds: 0, count: 0 }; row.seconds += session.Seconds; row.count++; groups.set(key, row)
  }
  return <Panel className="feature-panel"><div className="panel-heading"><div><h3>专注统计</h3><p className="muted">累计 {duration(state.FocusSessions.reduce((sum, item) => sum + item.Seconds, 0))} · {state.FocusSessions.length} 次记录</p></div><div className="segmented"><button className={grouping === 'task' ? 'selected' : ''} onClick={() => setGrouping('task')}>按任务</button><button className={grouping === 'project' ? 'selected' : ''} onClick={() => setGrouping('project')}>按项目</button></div></div>{[...groups].sort((a, b) => b[1].seconds - a[1].seconds).map(([id, row]) => <div className="feature-row" key={id}><strong>{row.name}</strong><span>{duration(row.seconds)} · {row.count} 次</span></div>)}{!groups.size && <p className="feature-empty">完成或提前结束一轮专注后，实际用时会显示在这里。</p>}</Panel>
}

export function FocusPage({ state }: { state: WorkspaceState }) {
  const [task, setTask] = useState(''); const [project, setProject] = useState(''); const [minutes, setMinutes] = useState('25')
  const [time, setTime] = useState(Date.now()); const [cancel, setCancel] = useState(false)
  const { busy, run } = useOperation()
  useEffect(() => { const timer = setInterval(() => setTime(Date.now()), 500); return () => clearInterval(timer) }, [])
  const active = state.ActiveFocus
  const plannedSeconds = focusPlannedSeconds(Number(minutes))
  const remaining = active ? Math.max(0, Math.ceil(active.PlannedSeconds - focusElapsed(active, time))) : plannedSeconds ?? 0
  return <div className="feature-stack"><Panel className="feature-panel"><div className="panel-heading"><h3>专注计时</h3><span className="muted">关闭应用或系统休眠后暂停，重新打开可继续</span></div><div className="focus-clock" role="timer" aria-label="剩余专注时间">{Math.floor(remaining / 60).toString().padStart(2, '0')}<span>:</span>{Math.max(0, remaining % 60).toString().padStart(2, '0')}</div>
    {active ? <><p className="focus-caption">{active.TaskTitle} · {active.ProjectName} · {active.RunningSince ? '专注中' : '已暂停'}</p><div className="studio-actions focus-actions"><button className="primary-button" disabled={busy} onClick={() => void run(() => runAction({ type: active.RunningSince ? 'focus-pause' : 'focus-resume' }))}>{active.RunningSince ? '暂停' : '继续'}</button><button className="secondary-button" disabled={busy} onClick={() => void run(() => runAction({ type: 'focus-finish' }))}>结束并记录</button><button className="secondary-button" disabled={busy} onClick={() => setCancel(true)}>放弃本轮</button></div>{cancel && <ConfirmAction message="放弃本轮专注？本轮用时不会计入统计。" busy={busy} onCancel={() => setCancel(false)} onConfirm={() => void run(async () => { await runAction({ type: 'focus-cancel' }); setCancel(false) })} />}</> : <div className="feature-form-row focus-actions"><label>关联任务<select aria-label="关联任务" value={task} onChange={event => setTask(event.target.value)}><option value="">自由专注</option>{state.Todos.filter(item => !item.IsCompleted).map(item => <option value={item.Id} key={item.Id}>{item.Title}</option>)}</select></label><label>关联项目<select aria-label="关联项目" value={project} onChange={event => setProject(event.target.value)}><option value="">未关联项目</option>{state.Projects.map(item => <option value={item.Id} key={item.Id}>{item.Name}</option>)}</select></label><label>分钟<input aria-label="专注分钟" type="number" min={1} max={180} step="any" value={minutes} onChange={event => setMinutes(event.target.value)} /></label><button className="primary-button" disabled={busy || plannedSeconds === null} onClick={() => void run(() => runAction({ type: 'focus-start', taskId: task, projectId: project, minutes: Number(minutes) }))}>开始专注</button></div>}
  </Panel><FocusSummary state={state} /></div>
}
