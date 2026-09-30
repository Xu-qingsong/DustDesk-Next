import { useEffect, useState } from 'react'
import { Download, Eye, EyeOff, Grid2X2, Settings2, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import { useDialogFocus } from '../hooks/useDialogFocus'

export const openHotkeySettings = () => window.dispatchEvent(new Event('dustdesk:hotkey-settings'))

export function HotkeyEditor() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({ mainWindow: '', widgets: '', screenshot: '', pin: '', quickCapture: '' })
  const load = async () => {
    try { const state = await window.dustdesk.loadWorkspace(); setDraft({ mainWindow: state.Settings.MainWindowHotKey, widgets: state.Settings.DesktopWidgetsHotKey, screenshot: state.Settings.ScreenshotHotKey, pin: state.Settings.PinScreenshotHotKey, quickCapture: state.Settings.QuickCaptureHotKey }); setOpen(true) }
    catch { toast.error('无法读取快捷键设置，请重试') }
  }
  useEffect(() => { const show = () => { void load() }; window.addEventListener('dustdesk:hotkey-settings', show); return () => window.removeEventListener('dustdesk:hotkey-settings', show) }, [])
  useDialogFocus(open, '.hotkey-dialog', () => { if (!busy) setOpen(false) })
  const save = async () => {
    if (busy) return
    setBusy(true)
    try { const result = await window.dustdesk.setHotkeys(draft); if (result.ok) { toast.success('快捷键已生效'); setOpen(false) } else toast.error(result.error ?? '快捷键保存失败') }
    catch { toast.error('快捷键保存失败，请重试') }
    finally { setBusy(false) }
  }
  const fields = [['mainWindow', '主窗口'], ['widgets', '桌面小组件'], ['screenshot', '截图'], ['pin', '贴图'], ['quickCapture', '快速记录']] as const
  return <>{open && <div className="hotkey-overlay" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setOpen(false) }}><div className="hotkey-dialog" role="dialog" aria-modal="true" aria-labelledby="hotkey-dialog-title"><div className="panel-heading"><div><span className="section-kicker">Shortcuts</span><h3 id="hotkey-dialog-title">快捷键</h3></div><button className="icon-button subtle" title="关闭" disabled={busy} onClick={() => setOpen(false)}><X size={16} /></button></div>{fields.map(([key, label]) => <label key={key}>{label}<input value={draft[key]} disabled={busy} maxLength={80} onChange={event => setDraft({ ...draft, [key]: event.target.value })} /></label>)}<button className="primary-button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存快捷键'}</button></div></div>}<button className="floating-shortcuts" title="快捷键设置" onClick={() => void load()}><Settings2 size={15} />快捷键</button></>
}

export function WidgetPicker() {
  const [open, setOpen] = useState(false); const [presets, setPresets] = useState<string[]>([]); const [presetName, setPresetName] = useState(''); const [visibility, setVisibility] = useState<Record<string, boolean>>({})
  const widgets = [['todo', '任务'], ['notes', '便签'], ['projects', '项目'], ['launcher', '启动器'], ['links', '链接'], ['clipboard', '剪贴板'], ['organizer', '收纳'], ['search', '搜索'], ['monitor', '监控'], ['countdown', '倒计时']] as const
  const refresh = () => { void window.dustdesk.listWidgetPresets().then(setPresets); void window.dustdesk.getWidgetVisibility(widgets.map(([key]) => key)).then(setVisibility) }
  useEffect(() => window.dustdesk.onWidgetVisibilityChanged((key, visible) => setVisibility(current => ({ ...current, [key]: visible }))), [])
  const toggleWidget = async (key: string) => { const result = await window.dustdesk.toggleWidgets(key); setVisibility(current => ({ ...current, [key]: result.visible })) }
  const savePreset = async () => { if (!presetName.trim()) return; const result = await window.dustdesk.saveWidgetPreset(presetName.trim()); if (result.ok) { setPresetName(''); refresh(); toast.success('布局已保存') } else toast.error(result.error ?? '布局保存失败') }
  const applyPreset = async (name: string) => { const result = await window.dustdesk.applyWidgetPreset(name); if (!result.ok) toast.error(result.error ?? '布局应用失败'); else { refresh(); toast.success('布局已应用') } }
  return <>{open && <div className="widget-picker"><div className="widget-picker-head"><strong>桌面小组件</strong><button className="icon-button subtle" title="关闭" onClick={() => setOpen(false)}><X size={15} /></button></div><div className="widget-picker-body">{widgets.map(([key, label]) => { const visible = Boolean(visibility[key]); return <button key={key} className={`widget-picker-item ${visible ? 'active' : ''}`} aria-label={`${visible ? '隐藏' : '显示'}${label}小组件`} aria-pressed={visible} title={visible ? `隐藏${label}小组件` : `显示${label}小组件`} onClick={() => void toggleWidget(key)}><span>{label}</span><span className="widget-visibility-icon" aria-hidden="true">{visible ? <Eye size={15} /> : <EyeOff size={15} />}</span></button> })}<div className="widget-preset"><div className="widget-picker-label">布局预设</div><div className="widget-preset-add"><input value={presetName} onChange={event => setPresetName(event.target.value)} placeholder="预设名称" /><button className="icon-button subtle" title="保存布局" onClick={() => void savePreset()}><Download size={14} /></button></div>{presets.map(name => <div className="widget-preset-row" key={name}><button onClick={() => void applyPreset(name)}>{name}</button><button title="删除布局" onClick={() => void window.dustdesk.deleteWidgetPreset(name).then(refresh)}><Trash2 size={12} /></button></div>)}</div></div></div>}<button className="floating-widgets" title="桌面小组件" onClick={() => { setOpen(value => !value); refresh() }}><Grid2X2 size={15} />小组件</button></>
}



