import { ColorPicker } from "../components/ui/ColorPicker"
import { NumberInput, Switch } from "../components/ui/FormControls"
import { TimePicker, minutesToTime, timeToMinutes } from '../components/ui/DateTimePicker'
import { Select } from '../components/ui/Select'
import { SidebarMenuSettings } from '../components/SidebarMenuSettings'
import { BackupManager, CaptureSettings } from '../components/Productivity'
import { useScreenshotCapture } from '../hooks/useScreenshotCapture'
import { useEffect, useRef, useState } from 'react'
import { FolderOpen, Settings2 } from 'lucide-react'
import { toast } from 'sonner'
import { openHotkeySettings } from '../widgets/WidgetPicker'
import type { AppSettings, WorkspaceState } from '../../../shared/types'
import { Panel } from '../components/common'
import { argbCss, argbHex } from '../utils/colors'
import { repository } from '../../../shared/repository'

const settingsAnchors = [
  ['settings-menu', '侧栏菜单'],
  ['settings-general', '常规'],
  ['settings-data', '数据与备份'],
  ['settings-quick-capture', '快速记录'],
  ['settings-capture', '截图'],
  ['settings-hotkeys', '快捷键'],
  ['settings-countdown', '下班倒计时'],
  ['settings-widget', '组件背景色'],
  ['settings-startup', '启动与外观'],
  ['settings-capture-preferences', '截图偏好'],
  ['settings-search', '搜索与工作时间'],
  ['settings-update', '更新'],
  ['settings-help', '帮助与反馈']
] as const

export type SettingsAnchor = typeof settingsAnchors[number][0]

export function Settings({ state, persist, path, theme, setTheme, initialAnchor }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void>; path: string; theme: 'light' | 'dark'; setTheme: (theme: 'light' | 'dark') => void; initialAnchor?: SettingsAnchor }) {
  const settings = state.Settings
  const [startup, setStartup] = useState(settings.StartWithWindows)
  const [activeAnchor, setActiveAnchor] = useState<SettingsAnchor>('settings-menu')
  const layout = useRef<HTMLDivElement>(null)
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void persist({ ...state, Settings: { ...settings, [key]: value } }, '设置已保存')
  useEffect(() => { void window.dustdesk.getStartupEnabled().then(setStartup).catch(() => toast.error('读取开机启动设置失败')) }, [])
  const { capture, busy: captureBusy, windowPicker } = useScreenshotCapture()
  const toggleStartup = async () => { const next = !startup; await window.dustdesk.setStartupEnabled(next); setStartup(next); set('StartWithWindows', next) }

  useEffect(() => {
    const element = layout.current, scroller = element?.closest<HTMLElement>('.content')
    if (!element || !scroller) return
    let frame = 0
    const update = () => {
      frame = 0
      // Give the final sections enough scroll space to reach the same anchor
      // position; otherwise clicking Update at the bottom highlights Help.
      const last = element.querySelector<HTMLElement>(`#${settingsAnchors.at(-1)![0]}`)
      const bottomPadding = Number.parseFloat(getComputedStyle(scroller).paddingBottom) || 0
      const tail = `${Math.max(0, scroller.clientHeight - (last?.offsetHeight ?? 0) - bottomPadding - 16)}px`
      if (element.style.getPropertyValue('--settings-scroll-tail') !== tail) element.style.setProperty('--settings-scroll-tail', tail)
      const top = scroller.getBoundingClientRect().top + 20
      let current: SettingsAnchor = settingsAnchors[0][0]
      for (const [id] of settingsAnchors) {
        if ((element.querySelector<HTMLElement>(`#${id}`)?.getBoundingClientRect().top ?? Infinity) <= top) current = id
      }
      setActiveAnchor(current)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    scroller.addEventListener('scroll', schedule, { passive: true })
    const observer = new ResizeObserver(schedule)
    observer.observe(element); observer.observe(scroller)
    update()
    return () => { scroller.removeEventListener('scroll', schedule); observer.disconnect(); cancelAnimationFrame(frame) }
  }, [])

  const jumpTo = (id: SettingsAnchor) => {
    const target = layout.current?.querySelector<HTMLElement>(`#${id}`), scroller = layout.current?.closest<HTMLElement>('.content')
    if (!target || !scroller) return
    target.focus({ preventScroll: true })
    scroller.scrollTo({ top: scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 16, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
    setActiveAnchor(id)
  }
  useEffect(() => {
    if (!initialAnchor) return
    const frame = requestAnimationFrame(() => jumpTo(initialAnchor))
    return () => cancelAnimationFrame(frame)
  }, [initialAnchor])

  return <>
    <div className="settings-layout" ref={layout}>
      <nav className="settings-anchor-nav" aria-label="设置锚点导航">
        <span className="settings-anchor-label">设置目录</span>
        {settingsAnchors.map(([id, label]) => <a key={id} href={`#${id}`} aria-current={activeAnchor === id ? 'location' : undefined} onClick={event => { event.preventDefault(); jumpTo(id) }}>{label}</a>)}
      </nav>
      <div className="settings-main"><div className="settings-grid">
        <Panel>
          <div id="settings-menu" tabIndex={-1}><SidebarMenuSettings state={state} persist={persist} /></div>
          <div id="settings-general" tabIndex={-1} className="settings-section"><div><h3>外观</h3><p>选择工作台的颜色模式。</p></div><div className="segmented"><button className={theme === 'light' ? 'selected' : ''} onClick={() => setTheme('light')}>浅色</button><button className={theme === 'dark' ? 'selected' : ''} onClick={() => setTheme('dark')}>深色</button></div></div>
          <div className="settings-section"><div><h3>剪贴板监听</h3><p>记录复制的文字和图片。</p></div><Switch aria-label="剪贴板监听" checked={settings.ClipboardMonitoringEnabled} onCheckedChange={checked => set('ClipboardMonitoringEnabled', checked)} /></div>
          <div className="settings-section"><div><h3>开机启动</h3><p>登录 Windows 后自动打开 DustDesk。</p></div><Switch aria-label="开机启动" checked={startup} onCheckedChange={() => void toggleStartup()} /></div>
        </Panel>
        <Panel>
          <div id="settings-data" tabIndex={-1} className="settings-section stacked"><div><h3>数据位置</h3><p>状态文件和备份存放在这里。</p></div><code className="path-box">{path}</code><button className="secondary-button align-start" onClick={() => void window.dustdesk.openPath(path)}><FolderOpen size={16} />打开数据目录</button></div>
          <BackupManager state={state} persist={persist} />
          <div id="settings-quick-capture" tabIndex={-1}><CaptureSettings state={state} /></div>
          <div id="settings-capture" tabIndex={-1} className="settings-section stacked"><div><h3>截图</h3>{captureBusy && <span role="status">正在处理截图…</span>}<p>捕获结果可在截图编辑页标记、撤销、保存或贴到桌面。</p></div><div className="segmented"><button disabled={captureBusy} onClick={() => void capture('Region')}>区域</button><button disabled={captureBusy} onClick={() => void capture('Window')}>窗口</button><button disabled={captureBusy} onClick={() => void capture('FullScreen')}>全屏</button></div></div>
          <div id="settings-hotkeys" tabIndex={-1} className="settings-section stacked"><div><h3>快捷键</h3><p>主窗口：{settings.MainWindowHotKey} · 小组件：{settings.DesktopWidgetsHotKey} · 截图：{settings.ScreenshotHotKey} · 贴图：{settings.PinScreenshotHotKey} · 快速记录：{settings.QuickCaptureHotKey}</p></div><button className="secondary-button align-start" onClick={openHotkeySettings}><Settings2 size={16} />管理快捷键</button></div>
          <AdvancedSettings state={state} persist={persist} />
        </Panel>
      </div><div className="settings-scroll-tail" aria-hidden="true" /></div>
    </div>
    {windowPicker}
  </>
}

function AdvancedSettingsCore({ state, persist }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void> }) {
  const settings = state.Settings; const [rootDraft, setRootDraft] = useState('')
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void persist({ ...state, Settings: { ...settings, [key]: value } }, '设置已保存')
  const addRoot = () => { const root = rootDraft.trim(); if (!root || settings.SearchCustomRoots.some(item => item.toLowerCase() === root.toLowerCase())) return; setRootDraft(''); set('SearchCustomRoots', [...settings.SearchCustomRoots, root]) }
  const [checking, setChecking] = useState(false)
  const check = async () => {
    if (checking) return
    setChecking(true)
    try {
      const result = await window.dustdesk.checkForUpdate()
      if (!result.ok) toast.error(result.error ?? '检查更新失败')
      else if (!result.available) toast.info(result.message || '当前已是最新版本')
    } catch { toast.error('检查更新失败，请稍后重试') }
    finally { setChecking(false) }
  }
  return <div className="advanced-settings"><div id="settings-startup" tabIndex={-1} className="settings-section stacked"><div><h3>启动与外观</h3><p>控制启动行为、贴图和桌面组件材质。</p></div><div className="settings-inline"><button className={`mini-button ${settings.StartHiddenToTray ? 'selected' : ''}`} onClick={() => set('StartHiddenToTray', !settings.StartHiddenToTray)}>启动时隐藏</button><label>组件透明度<NumberInput min="20" max="100" value={settings.WidgetOpacityPercent} onValueChange={nextValue => set('WidgetOpacityPercent', Math.max(20, Math.min(100, Number(nextValue))))} aria-label="组件透明度" /></label><label>贴图透明度<NumberInput min="20" max="100" value={settings.PinnedImageOpacityPercent} onValueChange={nextValue => set('PinnedImageOpacityPercent', Math.max(20, Math.min(100, Number(nextValue))))} aria-label="贴图透明度" /></label></div></div><div id="settings-capture-preferences" tabIndex={-1} className="settings-section stacked"><div><h3>截图偏好</h3><p>控制格式、延时、自动复制和捕获后的动作。</p></div><div className="settings-inline"><label>格式<Select aria-label="格式" value={settings.ScreenshotFormat} onValueChange={value => set('ScreenshotFormat', value)}><option value="png">PNG</option><option value="jpg">JPG</option></Select></label><label>延时<NumberInput min="0" max="10" value={settings.ScreenshotDelaySeconds} onValueChange={nextValue => set('ScreenshotDelaySeconds', Math.max(0, Math.min(10, Number(nextValue))))} aria-label="延时" /></label><label>完成后<Select aria-label="完成后" value={settings.ScreenshotAfterAction} onValueChange={value => set('ScreenshotAfterAction', value)}><option value="edit">编辑</option><option value="copy">复制</option><option value="pin">贴图</option></Select></label></div><div className="settings-inline"><button className={`mini-button ${settings.ScreenshotAutoCopy ? 'selected' : ''}`} onClick={() => set('ScreenshotAutoCopy', !settings.ScreenshotAutoCopy)}>自动复制</button><button className={`mini-button ${settings.ScreenshotAutoAddToClipboardHistory ? 'selected' : ''}`} onClick={() => set('ScreenshotAutoAddToClipboardHistory', !settings.ScreenshotAutoAddToClipboardHistory)}>加入剪贴板</button><button className={`mini-button ${settings.PinnedImageTopmost ? 'selected' : ''}`} onClick={() => set('PinnedImageTopmost', !settings.PinnedImageTopmost)}>贴图置顶</button><button className={`mini-button ${settings.PinnedImageMouseThrough ? 'selected' : ''}`} onClick={() => set('PinnedImageMouseThrough', !settings.PinnedImageMouseThrough)}>鼠标穿透</button></div></div><div id="settings-search" tabIndex={-1} className="settings-section stacked"><div><h3>搜索与工作时间</h3><p>选择文件搜索来源、添加自定义目录并配置工作日统计。</p></div><div className="settings-inline"><button className={`mini-button ${settings.SearchDesktopFiles ? 'selected' : ''}`} onClick={() => set('SearchDesktopFiles', !settings.SearchDesktopFiles)}>桌面文件</button><button className={`mini-button ${settings.SearchStartMenuApps ? 'selected' : ''}`} onClick={() => set('SearchStartMenuApps', !settings.SearchStartMenuApps)}>开始菜单</button><button className={`mini-button ${settings.SearchAppData ? 'selected' : ''}`} onClick={() => set('SearchAppData', !settings.SearchAppData)}>应用数据</button><label>开始<TimePicker aria-label="工作开始时间" value={minutesToTime(settings.WorkdayStartMinutes)} onValueChange={value => { if (value) set('WorkdayStartMinutes', timeToMinutes(value)) }} required /></label><label>结束<TimePicker aria-label="工作结束时间" value={minutesToTime(settings.WorkdayEndMinutes)} onValueChange={value => { if (value) set('WorkdayEndMinutes', timeToMinutes(value)) }} required /></label></div><div className="settings-inline"><input className="settings-input" value={rootDraft} onChange={event => setRootDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') addRoot() }} placeholder="自定义搜索目录路径" /><button className="mini-button" onClick={addRoot}>添加目录</button></div>{settings.SearchCustomRoots.map(root => <div className="root-row" key={root}><code>{root}</code><button className="mini-button" onClick={() => set('SearchCustomRoots', settings.SearchCustomRoots.filter(item => item !== root))}>移除</button></div>)}</div><div id="settings-update" tabIndex={-1} className="settings-section stacked"><div><h3>更新</h3><p>查看 GitHub 正式版本及更新内容。</p><span className="settings-current-version">当前版本 <strong>v{__APP_VERSION__}</strong></span></div><div className="settings-inline"><button className="secondary-button" disabled={checking} onClick={() => void check()}>{checking ? '检查中…' : '检查更新'}</button></div></div></div>
}

function HelpAbout() { return <div id="settings-help" tabIndex={-1} className="settings-section stacked"><div><h3>帮助与反馈</h3><p>查看 DustDesk 使用提示或打开项目反馈页面。</p></div><div className="settings-inline"><button className="secondary-button" onClick={() => toast.info('使用 Ctrl+K 搜索，Ctrl+Shift+D 打开小组件，截图页支持撤销和贴图。')}>操作简介</button><button className="secondary-button" onClick={() => void window.dustdesk.openUrl(repository.url)}>关于项目</button><button className="secondary-button" onClick={() => void window.dustdesk.openUrl(repository.issues)}>问题反馈</button></div></div> }
function CountdownSettings({ state, persist }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void> }) {
  const settings = state.Settings
  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void persist({ ...state, Settings: { ...settings, [key]: value } }, '倒计时设置已保存')
  return <div id="settings-countdown" tabIndex={-1} className="settings-section stacked"><div><h3>下班倒计时</h3><p>配置发薪日和自定义目标日，数据会保存到本机。</p></div><div className="settings-inline"><label>月薪<NumberInput min="0" value={settings.MonthlySalary} onValueChange={nextValue => set('MonthlySalary', Math.max(0, Number(nextValue)))} aria-label="月薪" /></label><label>发薪日<NumberInput min="1" max="31" value={settings.PaydayDay} onValueChange={nextValue => set('PaydayDay', Math.max(1, Math.min(31, Number(nextValue))))} aria-label="发薪日" /></label><label>目标日名称<input value={settings.CountdownFestivalName} onChange={event => set('CountdownFestivalName', event.target.value.slice(0, 40))} /></label><label>目标月<NumberInput min="1" max="12" value={settings.CountdownFestivalMonth} onValueChange={nextValue => set('CountdownFestivalMonth', Math.max(1, Math.min(12, Number(nextValue))))} aria-label="目标月" /></label><label>目标日<NumberInput min="1" max="31" value={settings.CountdownFestivalDay} onValueChange={nextValue => set('CountdownFestivalDay', Math.max(1, Math.min(31, Number(nextValue))))} aria-label="目标日" /></label></div></div>
}
function WidgetAppearanceSettings({ state, persist }: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void> }) {
  const settings = state.Settings
  const set = (value: number) => void persist({ ...state, Settings: { ...settings, WidgetBackgroundColorArgb: value } }, '组件背景色已保存')
  const colors = [-1, -986895, -203060, -41144, -1703941, -983560]
  return <div id="settings-widget" tabIndex={-1} className="settings-section stacked"><div><h3>组件背景色</h3><p>透明背景仍保留 WPF 版本的颜色混合和玻璃效果。</p></div><div className="settings-inline"><ColorPicker value={argbHex(settings.WidgetBackgroundColorArgb ?? -1)} onValueChange={nextValue => set((Number.parseInt(nextValue.slice(1), 16) | 0xff000000))} />{colors.map(color => <button key={color} className="color-swatch" title="设置组件背景色" style={{ background: argbCss(color, 1) }} onClick={() => set(color)} />)}</div></div>
}
function AdvancedSettings(props: { state: WorkspaceState; persist: (next: WorkspaceState, message?: string) => Promise<void> }) { return <><CountdownSettings {...props} /><WidgetAppearanceSettings {...props} /><AdvancedSettingsCore {...props} /><HelpAbout /></> }
