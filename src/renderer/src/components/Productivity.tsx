import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { openHotkeySettings } from '../widgets/WidgetPicker'
import type { WorkspaceState } from '../../../shared/types'
import type { ActionResult, BackupPreview, OrganizerRule, ProductivityAction } from '../../../shared/productivity'
import { Panel } from './common'

export async function runAction(action: ProductivityAction) {
  const result = await window.dustdesk.productivity(action)
  if (!result.ok) throw new Error(result.error ?? '操作失败')
}

export function useOperation() {
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const run = async (operation: () => Promise<unknown>) => {
    if (locked.current) return
    locked.current = true; setBusy(true)
    try { await operation() } catch (error) { toast.error(error instanceof Error ? error.message : String(error)) }
    finally { locked.current = false; setBusy(false) }
  }
  return { busy, run }
}

export function ConfirmAction({ message, onConfirm, onCancel, busy = false }: { message: string; onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return <div className="feature-confirm" role="alertdialog" aria-label="确认操作" aria-describedby="confirm-action-message"><p id="confirm-action-message">{message}</p><div className="studio-actions"><button className="secondary-button" disabled={busy} onClick={onCancel}>取消</button><button className="primary-button" disabled={busy} onClick={onConfirm}>确认</button></div></div>
}

export function BackupManager({ state, persist }: { state: WorkspaceState; persist: (state: WorkspaceState) => Promise<void> }) {
  const [points, setPoints] = useState<Awaited<ReturnType<typeof window.dustdesk.listBackups>>>([])
  const [status, setStatus] = useState({ error: '', lastAutomaticBackupAt: '' })
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [retention, setRetention] = useState(String(state.Settings.BackupRetentionDays))
  const { busy, run } = useOperation()
  const refresh = async () => { const [points, status] = await Promise.all([window.dustdesk.listBackups(), window.dustdesk.backupStatus()]); setPoints(points); setStatus(status) }
  useEffect(() => { void run(refresh) }, [])
  useEffect(() => setRetention(String(state.Settings.BackupRetentionDays)), [state.Settings.BackupRetentionDays])
  const check = (result: ActionResult) => { if (!result.ok) throw new Error(result.error ?? '备份操作失败') }
  return <div className="settings-section stacked feature-stack"><div><h3>自动备份与恢复</h3><p>每日首次运行时备份，当天保持运行也会检查。保留天数只清理自动备份；手动和恢复前备份始终保留。备份包含工作区记录与便签背景，不包含项目、启动器或收纳的实体文件。</p></div>
    {state.Settings.AutomaticBackupEnabled && status.error && <p className="inline-error" role="alert">自动备份未完成：{status.error}。排除问题后会自动重试，也可点击创建备份。</p>}
    {status.lastAutomaticBackupAt && <small className="muted">上次自动备份：{new Date(status.lastAutomaticBackupAt).toLocaleString('zh-CN')}</small>}
    <label className="feature-checkbox"><input type="checkbox" checked={state.Settings.AutomaticBackupEnabled} onChange={event => void persist({ ...state, Settings: { ...state.Settings, AutomaticBackupEnabled: event.target.checked } })} />开启每日自动备份</label>
    <div className="settings-inline"><label>自动备份保留天数<input aria-label="自动备份保留天数" type="number" min={1} max={365} value={retention} onChange={event => setRetention(event.target.value)} /></label><button className="mini-button" disabled={busy || !retention || !Number.isInteger(Number(retention)) || Number(retention) < 1 || Number(retention) > 365} onClick={() => void run(() => persist({ ...state, Settings: { ...state.Settings, BackupRetentionDays: Number(retention) } }))}>保存天数</button></div>
    <div className="studio-actions"><button className="secondary-button" disabled={busy} onClick={() => void run(async () => { check(await window.dustdesk.createBackup()); await refresh(); toast.success('备份已创建') })}>创建备份</button><button className="secondary-button" disabled={busy} onClick={() => void run(refresh)}>刷新备份</button></div>
    {preview && <div className="feature-preview" role="region" aria-label="恢复预览"><strong>恢复预览 · {new Date(preview.modifiedAt).toLocaleString('zh-CN')}</strong><p>任务 {preview.tasks} · 便签 {preview.notes} · 项目 {preview.projects} · 链接 {preview.links}<br />专注记录 {preview.focusSessions} · 回收站 {preview.recycleEntries}</p>{preview.warnings.map((warning, index) => <p className="inline-error" key={index}>{warning}</p>)}<ConfirmAction message="将替换当前工作区。恢复前会自动创建保护备份，关联的外部文件不会被移动。" busy={busy} onCancel={() => setPreview(null)} onConfirm={() => void run(async () => { check(await window.dustdesk.restoreBackup(preview.path, preview.fingerprint)); setPreview(null); await refresh(); toast.success('工作区已恢复，当前状态已另行备份') })} /></div>}
    <div className="backup-list feature-scroll">{points.map(point => <div className="backup-row" key={point.path}><span><strong>{point.name.startsWith('auto-') ? '自动备份' : point.name.startsWith('before-restore-') ? '恢复前保护备份' : '手动备份'}</strong><small>{new Date(point.modifiedAt).toLocaleString('zh-CN')} · {Math.ceil(point.size / 1024)} KB</small></span><button className="mini-button" disabled={busy} onClick={() => void run(async () => setPreview(await window.dustdesk.previewBackup(point.path)))}>预览恢复</button></div>)}{!points.length && <p className="muted">暂无备份</p>}</div>
  </div>
}

export function CaptureSettings({ state }: { state: WorkspaceState }) {
  return <div className="settings-section stacked"><h3>全局快速记录</h3><p>保存后自动收起。Esc 隐藏窗口，Ctrl+Enter 保存；未保存草稿会保留。</p><div className="settings-inline"><span className="muted">快捷键：{state.Settings.QuickCaptureHotKey || '未设置'}</span><button className="mini-button" onClick={openHotkeySettings}>管理快捷键</button><button className="secondary-button" onClick={() => void window.dustdesk.showQuickCapture()}>打开快速记录</button></div></div>
}

export function OrganizerRules({ state, onChanged }: { state: WorkspaceState; onChanged: () => void }) {
  const [pattern, setPattern] = useState('')
  const [match, setMatch] = useState<OrganizerRule['Match']>('extension')
  const [category, setCategory] = useState(state.DesktopCategories[0]?.Id ?? '')
  const { busy, run } = useOperation()
  const save = (rules: OrganizerRule[]) => run(async () => { await runAction({ type: 'rules-save', rules }); onChanged() })
  useEffect(() => { if (!state.DesktopCategories.some(item => item.Id === category)) setCategory(state.DesktopCategories[0]?.Id ?? '') }, [state.DesktopCategories, category])
  return <Panel className="feature-panel"><div className="panel-heading"><h3>收纳规则</h3><span className="muted">从上到下匹配；未命中时使用默认分类</span></div><div className="feature-form-row"><select aria-label="匹配方式" value={match} onChange={event => setMatch(event.target.value as OrganizerRule['Match'])}><option value="extension">扩展名</option><option value="name">文件名包含</option></select><input aria-label="规则内容" placeholder={match === 'extension' ? '例如 pdf, docx' : '例如 合同, 发票'} value={pattern} maxLength={100} onChange={event => setPattern(event.target.value)} /><select aria-label="规则目标分类" value={category} onChange={event => setCategory(event.target.value)}>{state.DesktopCategories.map(item => <option key={item.Id} value={item.Id}>{item.Name}</option>)}</select><button className="primary-button" disabled={busy || !pattern.trim() || !category} onClick={() => void run(async () => { await runAction({ type: 'rules-save', rules: [...state.OrganizerRules, { Id: crypto.randomUUID(), Enabled: true, Match: match, Pattern: pattern.trim(), CategoryId: category }] }); setPattern(''); onChanged() })}>新增规则</button></div>
    <div className="feature-stack">{state.OrganizerRules.map((rule, index) => <div className="feature-row" key={rule.Id}><label className="feature-checkbox"><input type="checkbox" aria-label={`启用规则 ${rule.Pattern}`} checked={rule.Enabled} disabled={busy} onChange={event => void save(state.OrganizerRules.map(item => item.Id === rule.Id ? { ...item, Enabled: event.target.checked } : item))} /><span>{rule.Match === 'extension' ? '扩展名' : '名称包含'}：{rule.Pattern}</span></label><span>→ {state.DesktopCategories.find(item => item.Id === rule.CategoryId)?.Name ?? '分类已删除，请删除此规则'}</span><div className="studio-actions"><button className="mini-button" disabled={busy || index === 0} onClick={() => { const rules = [...state.OrganizerRules]; [rules[index - 1], rules[index]] = [rules[index]!, rules[index - 1]!]; void save(rules) }}>上移</button><button className="mini-button" disabled={busy} onClick={() => void save(state.OrganizerRules.filter(item => item.Id !== rule.Id))}>删除</button></div></div>)}</div>
    {!state.OrganizerRules.length && <p className="muted">暂无自定义规则。新增后点击「智能预览」，确认后才会移动文件。</p>}
  </Panel>
}
