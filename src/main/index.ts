import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { autoUpdater } from 'electron-updater'
import * as XLSX from 'xlsx'
import si from 'systeminformation'
import type { OrganizerPlanItem, SystemMetrics, WidgetPlacement, WorkspaceState } from '../shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
if (process.env.DUSTDESK_TEST_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DUSTDESK_TEST_USER_DATA_DIR))
let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let widgetsVisible = false
let clipboardTimer: NodeJS.Timeout | null = null
let lastClipboardFingerprint = ''
let lastScreenshotDataUrl = ''
const widgetWindows = new Map<string, BrowserWindow>()
const expandedWidgetHeights = new Map<string, number>()
const widgetResizePreviews = new Set<string>()
const overlayWindows = new Set<BrowserWindow>()
let activeOverlayResolve: ((dataUrl: string | null) => void) | null = null
const pinnedWindows = new Set<BrowserWindow>()
let clipboardMonitoringEnabled = true
let reminderTimer: NodeJS.Timeout | null = null
type OrganizerUndoAction = { source: string; target: string; categoryId: string }
const organizerUndoStack: OrganizerUndoAction[] = []
let workspaceWriteQueue: Promise<string> = Promise.resolve('')
let defaultStateInitialization: Promise<WorkspaceState> | null = null

function dataDirectory() {
  const injected = process.env.DUSTDESK_TEST_DATA_DIR
  return injected ? path.resolve(injected) : path.join(app.getPath('appData'), 'DustDesk.Next', 'Data')
}

function dataPath() { return path.join(dataDirectory(), 'workspace.json') }
function backupPath() { return `${dataPath()}.bak` }

function defaultState(): WorkspaceState {
  const now = new Date().toISOString()
  return {
    SchemaVersion: 2, LegacyImportCompleted: false, QuickNote: '',
    Settings: {
      MainWindowDisplayName: 'DustDesk', StartHiddenToTray: false, StartWithWindows: false,
      MainWindowHotKey: 'Ctrl+Shift+K', DesktopWidgetsHotKey: 'Ctrl+Shift+D', ScreenshotHotKey: 'Ctrl+Shift+S', PinScreenshotHotKey: 'F3',
      ScreenshotFormat: 'png', ScreenshotSaveDirectory: '', ScreenshotDelaySeconds: 0, ScreenshotAfterAction: 'edit', ScreenshotAutoCopy: true,
      ScreenshotAutoAddToClipboardHistory: true, PinnedImageTopmost: true, PinnedImageOpacityPercent: 100, PinnedImageMouseThrough: false,
      WidgetOpacityPercent: 86, WidgetBackgroundColorArgb: -1, SearchDesktopFiles: true, SearchAppData: true, SearchStartMenuApps: true, SearchProjectPaths: true,
      SearchCustomPaths: true, SearchCustomRoots: [], ClipboardMonitoringEnabled: true, DesktopHotKeyWidgetKeys: ['organizer'],
      LauncherWidgetSnapToEdges: false, LauncherWidgetShowNames: true, LauncherWidgetIconSize: 48, OrganizerWidgetShowNames: false,
      OrganizerWidgetIconSize: 48, MonitorShowDownload: true, MonitorShowUpload: true, MonitorShowMemory: true, MonitorShowCpu: true,
      MonitorShowDiskIo: true, MonitorShowDiskSpace: true, MonitorShowPing: true, MonitorShowUptime: true, WorkdayStartMinutes: 540,
      WorkdayEndMinutes: 1080, MonthlySalary: 0, PaydayDay: 10, CountdownFestivalName: '国庆节', CountdownFestivalMonth: 10,
      CountdownFestivalDay: 1, WidgetPlacements: {}, NoteWidgetPlacements: [], OrganizerGroupWidgetPlacements: [], WidgetLayoutPresets: {}
    },
    Todos: [
      { Id: crypto.randomUUID(), Title: '梳理今天最重要的一件事', Tag: '工作', Note: '', IsCompleted: false, CreatedAt: now, ReminderRepeat: 'None' },
      { Id: crypto.randomUUID(), Title: '把临时想法记到快速记录', Tag: '', Note: '', IsCompleted: false, CreatedAt: now, ReminderRepeat: 'None' }
    ], TagPresets: [{ Name: '工作', ColorArgb: -1576078 }, { Name: '生活', ColorArgb: -1427458 }, { Name: '重要', ColorArgb: -4045013 }],
    Notes: [{ Id: crypto.randomUUID(), Title: '快速便签', Text: '', ColorArgb: -411768, FontColorArgb: -1385444, FontSize: 14, FontBold: false, BackgroundImageFileName: '', ImageOnly: false, CreatedAt: now, UpdatedAt: now }],
    Projects: [], Launchers: [], LinkGroups: [{ Id: crypto.randomUUID(), Name: '常用', Links: [] }], ClipboardHistory: [],
    DesktopCategories: ['工作', '开发', '工具', '文件'].map(Name => ({ Id: crypto.randomUUID(), Name, IsCollapsed: false, ItemPaths: [] }))
  }
}

async function readState(): Promise<WorkspaceState> {
  await fs.mkdir(dataDirectory(), { recursive: true })
  for (const candidate of [dataPath(), backupPath()]) {
    try {
      const parsed = JSON.parse(await fs.readFile(candidate, 'utf8')) as WorkspaceState
      if (parsed && parsed.Settings && Array.isArray(parsed.Todos)) return parsed
    } catch { /* try the next recovery source */ }
  }
  if (!defaultStateInitialization) {
    defaultStateInitialization = (async () => {
      const state = defaultState()
      await writeState(state)
      return state
    })().catch(error => { defaultStateInitialization = null; throw error })
  }
  return defaultStateInitialization
}

async function writeState(state: WorkspaceState) {
  const operation = async () => {
    if (!state || typeof state !== 'object' || !state.Settings || !Array.isArray(state.Todos) || !Array.isArray(state.Notes)) throw new Error('工作区数据结构无效')
    ;(state as WorkspaceState & { OrganizerUndoStack?: OrganizerUndoAction[] }).OrganizerUndoStack = organizerUndoStack.slice(-100)
    const directory = dataDirectory()
    await fs.mkdir(directory, { recursive: true })
    const temporary = `${dataPath()}.electron-tmp-${process.pid}-${crypto.randomUUID()}`
    await fs.writeFile(temporary, JSON.stringify(state, null, 2), 'utf8')
    JSON.parse(await fs.readFile(temporary, 'utf8'))
    if (existsSync(dataPath())) {
      await fs.copyFile(dataPath(), backupPath())
      await fs.rename(temporary, dataPath())
    } else await fs.rename(temporary, dataPath())
    return dataPath()
  }
  const next = workspaceWriteQueue.then(operation, operation)
  workspaceWriteQueue = next.catch(() => '')
  return next
}

function desktopDirectory() { return process.env.DUSTDESK_TEST_DESKTOP_DIR ? path.resolve(process.env.DUSTDESK_TEST_DESKTOP_DIR) : app.getPath('desktop') }
function safeName(value: string) { const cleaned = value.replace(/[<>:"/\\|?*]/g, '_').trim(); return cleaned || '未命名' }
function validWidgetKey(value: unknown): value is string {
  return typeof value === 'string' && (/^[a-z][a-z-]{0,24}$/i.test(value) || /^(?:note|project):[0-9a-f-]{36}$/i.test(value) || /^organizer-group:[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i.test(value))
}
function applyWidgetAppearance(window: BrowserWindow, state: WorkspaceState, placement?: WidgetPlacement) {
  if (window.isDestroyed()) return
  const transparent = placement?.TransparentBackground === true
  window.setOpacity(Math.max(0.2, Math.min(1, Number(state.Settings.WidgetOpacityPercent ?? 86) / 100)))
  // The renderer owns the actual surface color. Keep the native window transparent so
  // rounded corners and the WPF-style transparent background remain visible.
  window.setBackgroundColor('#00000000')
  window.webContents.send('widget:appearance', {
    color: Number(state.Settings.WidgetBackgroundColorArgb ?? -1),
    alpha: transparent ? 72 / 255 : 245 / 255
  })
}
function pathExists(target: string) { return existsSync(target) }
async function moveWithVerification(source: string, target: string) {
  if (!pathExists(source)) throw new Error('源文件或文件夹不存在')
  if (pathExists(target)) throw new Error('目标位置已存在同名项目')
  await fs.mkdir(path.dirname(target), { recursive: true })
  try { await fs.rename(source, target) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false })
    await fs.rm(source, { recursive: true, force: true })
  }
  if (!pathExists(target)) throw new Error('移动校验失败')
  return target
}

async function logOrganizerFailure(operation: string, source: string, target: string, error: unknown) {
  try {
    const logDirectory = path.join(dataDirectory(), 'Logs')
    await fs.mkdir(logDirectory, { recursive: true })
    await fs.appendFile(path.join(logDirectory, 'organizer-move.log'), `${new Date().toISOString()} [${operation}] ${source} -> ${target}\n${error instanceof Error ? error.stack ?? error.message : String(error)}\n\n`, 'utf8')
  } catch { /* logging must not hide the original organizer error */ }
}

function classifyOrganizerEntry(name: string, categories: WorkspaceState['DesktopCategories']) {
  const lower = name.toLowerCase()
  const wanted = lower.match(/\.(docx?|xlsx?|pptx?|pdf|txt|md)$/) ? '工作' : lower.match(/\.(js|ts|tsx|jsx|cs|cpp|h|py|json|css|html)$/) ? '开发' : lower.match(/\.(exe|msi|lnk|bat|cmd)$/) ? '工具' : '文件'
  return categories.find(item => item.Name === wanted) ?? categories[0]
}

function nextWeekday(value: Date) {
  const next = new Date(value)
  do next.setDate(next.getDate() + 1)
  while (next.getDay() === 0 || next.getDay() === 6)
  return next
}

function csvCell(value: string | number | boolean | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

async function exportProjects() {
  const state = await readState()
  if (!state.Projects.length) return { ok: false, error: '没有可导出的项目' }
  const result = await dialog.showSaveDialog({
    title: '导出项目管理',
    defaultPath: path.join(app.getPath('documents'), `项目管理_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.xlsx`),
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }, { name: 'CSV 文件', extensions: ['csv'] }]
  })
  if (result.canceled || !result.filePath) return { ok: false, canceled: true }
  const rows: (string | number | boolean | null | undefined)[][] = [['项目', '项目路径', '阶段', '状态', '进度', '阶段路径', '子事项', '完成', '子事项路径']]
  for (const project of state.Projects) {
    if (!project.Phases.length) rows.push([project.Name, project.ProjectPath, '', '', '', '', '', '', ''])
    for (const phase of project.Phases) {
      const progress = phase.ProgressPercent >= 0 ? Math.max(0, Math.min(100, phase.ProgressPercent)) : phase.Subtasks.length ? Math.round(phase.Subtasks.filter(item => item.IsCompleted).length * 100 / phase.Subtasks.length) : phase.Status === 'Done' ? 100 : phase.Status === 'Doing' ? 50 : 0
      if (!phase.Subtasks.length) rows.push([project.Name, project.ProjectPath, phase.Title, phase.Status, `${progress}%`, phase.ProjectPath, '', '', ''])
      for (const subtask of phase.Subtasks) rows.push([project.Name, project.ProjectPath, phase.Title, phase.Status, `${progress}%`, phase.ProjectPath, subtask.Title, subtask.IsCompleted ? '是' : '否', subtask.FilePath])
    }
  }
  if (path.extname(result.filePath).toLowerCase() === '.csv') await fs.writeFile(result.filePath, `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`, 'utf8')
  else { const sheet = XLSX.utils.aoa_to_sheet(rows); sheet['!cols'] = [{ wch: 20 }, { wch: 34 }, { wch: 22 }, { wch: 12 }, { wch: 10 }, { wch: 34 }, { wch: 24 }, { wch: 10 }, { wch: 42 }]; const workbook = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(workbook, sheet, '项目管理'); XLSX.writeFile(workbook, result.filePath) }
  return { ok: true, path: result.filePath }
}

async function checkTodoReminders() {
  const state = await readState()
  const now = new Date()
  let changed = false
  for (const todo of state.Todos) {
    if (todo.IsCompleted || !todo.ReminderAt || todo.ReminderNotifiedAt) continue
    const reminder = new Date(todo.ReminderAt)
    if (Number.isNaN(reminder.getTime()) || reminder > now) continue
    if (Notification.isSupported()) {
      const notification = new Notification({ title: 'DustDesk 任务提醒', body: todo.Title || '有一项任务到期' })
      notification.on('click', showWindow)
      notification.show()
    }
    if (todo.ReminderRepeat === 'None') {
      todo.ReminderNotifiedAt = now.toISOString()
    } else {
      let next = reminder
      do {
        next = todo.ReminderRepeat === 'Daily' ? new Date(next.getTime() + 86400000)
          : todo.ReminderRepeat === 'Weekly' ? new Date(next.getTime() + 7 * 86400000)
            : nextWeekday(next)
      } while (next <= now)
      todo.ReminderAt = next.toISOString()
      todo.ReminderNotifiedAt = null
    }
    changed = true
  }
  if (changed) {
    await writeState(state)
    mainWindow?.webContents.send('workspace:changed', state)
  }
}

async function captureRegionScreenshot() {
  const { desktopCapturer } = await import('electron')
  const displays = screen.getAllDisplays()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 3840, height: 2160 } })
  if (!displays.length || !sources.length) return null
  return new Promise<string | null>((resolve) => {
    activeOverlayResolve = resolve
    for (const display of displays) {
      const source = sources.find(item => String((item as { display_id?: string }).display_id ?? '').includes(String(display.id))) ?? sources[displays.indexOf(display)] ?? sources[0]
      const window = new BrowserWindow({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, frame: false, transparent: false, fullscreenable: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
      overlayWindows.add(window)
      const closeAll = () => { for (const item of overlayWindows) { if (!item.isDestroyed()) item.destroy() }; overlayWindows.clear() }
      window.on('closed', () => overlayWindows.delete(window))
      window.webContents.once('did-finish-load', () => { if (!window.isDestroyed()) { window.webContents.send('screenshot:overlay-source', source.thumbnail.toDataURL()); window.show(); window.focus() } })
      window.on('blur', () => { if (!window.isDestroyed() && !activeOverlayResolve) closeAll() })
      const rendererUrl = process.env.ELECTRON_RENDERER_URL
      if (rendererUrl) void window.loadURL(`${rendererUrl}?overlay=1`)
      else void window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { overlay: '1' } })
    }
  })
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus()
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380, height: 880, minWidth: 1080, minHeight: 680, show: false,
    title: 'DustDesk', backgroundColor: '#f4f7f6',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  mainWindow.on('close', event => { if (!isQuitting) { event.preventDefault(); mainWindow?.hide() } })
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void mainWindow.loadURL(rendererUrl)
  else void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  mainWindow.once('ready-to-show', () => showWindow())
}

function createWidgetWindow(key = 'todo') {
  const existing = widgetWindows.get(key)
  if (existing && !existing.isDestroyed()) return existing
  const dimensions = key === 'search' ? { width: 520, height: 52 } : key === 'countdown' ? { width: 540, height: 254 } : key === 'launcher' ? { width: 390, height: 320 } : key === 'links' ? { width: 360, height: 320 } : key === 'monitor' ? { width: 420, height: 260 } : { width: 390, height: 320 }
  const widgetWindow = new BrowserWindow({ ...dimensions, minWidth: key === 'search' ? 52 : 300, minHeight: key === 'search' ? 52 : 34, frame: false, transparent: true, resizable: true, skipTaskbar: true, show: false, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  if (key === 'search') widgetWindow.setResizable(false)
  widgetWindows.set(key, widgetWindow)
  let snapping = false
  const savePlacement = async () => {
    if (widgetWindow.isDestroyed()) return
    const [x, y] = widgetWindow.getPosition(); const [width, height] = widgetWindow.getSize()
    const state = await readState(); const previous = state.Settings.WidgetPlacements?.[key] ?? {}
    state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...previous, X: x, Y: y, Width: width, Height: height, Visible: true } }
    await writeState(state)
  }
  const snapToEdges = () => {
    if (snapping || widgetWindow.isDestroyed()) return
    void readState().then(state => {
      const placement = state.Settings.WidgetPlacements?.[key]
      if (!placement?.SnapToEdges) return
      const [x, y] = widgetWindow.getPosition(); const [width, height] = widgetWindow.getSize()
      const display = screen.getDisplayNearestPoint({ x: x + Math.round(width / 2), y: y + Math.round(height / 2) })
      const area = display.workArea; const distance = 18
      const left = Math.abs(x - area.x) <= distance; const right = Math.abs(area.x + area.width - (x + width)) <= distance; const top = Math.abs(y - area.y) <= distance; const bottom = Math.abs(area.y + area.height - (y + height)) <= distance
      const nextX = left ? area.x : right ? area.x + area.width - width : x
      const nextY = top ? area.y : bottom ? area.y + area.height - height : y
      if (nextX === x && nextY === y) return
      snapping = true; widgetWindow.setPosition(nextX, nextY); snapping = false
      if (key === 'search') void readState().then(state => { const current = state.Settings.WidgetPlacements?.[key] ?? {}; state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...current, DockEdge: left ? 'Left' : right ? 'Right' : top ? 'Top' : bottom ? 'Bottom' : 'None' } }; return writeState(state) })
    })
  }
  widgetWindow.on('moved', () => { snapToEdges(); void savePlacement() }); widgetWindow.on('resized', () => { if (!widgetResizePreviews.has(key)) void savePlacement() }); widgetWindow.on('closed', () => { widgetWindows.delete(key); widgetsVisible = [...widgetWindows.values()].some(item => !item.isDestroyed() && item.isVisible()) })
  void readState().then(state => {
    const placement = state.Settings.WidgetPlacements?.[key] as WidgetPlacement | undefined
    if (widgetWindow.isDestroyed()) return
    if (placement?.X !== undefined && placement.Y !== undefined && placement.Width && placement.Height) widgetWindow.setBounds({ x: placement.X, y: placement.Y, width: placement.Width, height: placement.Height })
    if (placement?.IsCollapsed) {
      expandedWidgetHeights.set(key, placement.Height ?? dimensions.height)
      widgetWindow.setSize(widgetWindow.getSize()[0], 34)
    }
    if (placement?.Locked !== undefined) widgetWindow.setResizable(!placement.Locked)
    if (placement?.TopMost !== undefined) widgetWindow.setAlwaysOnTop(placement.TopMost, 'floating')
    applyWidgetAppearance(widgetWindow, state, placement)
    widgetWindow.webContents.once('did-finish-load', () => applyWidgetAppearance(widgetWindow, state, placement))
  })
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void widgetWindow.loadURL(`${rendererUrl}?widget=${encodeURIComponent(key)}`)
  else void widgetWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { widget: key } })
  return widgetWindow
}

function toggleWidgetWindow(key = 'todo') {
  const window = createWidgetWindow(key)
  if (window.isVisible()) window.hide()
  else window.show()
  widgetsVisible = [...widgetWindows.values()].some(item => !item.isDestroyed() && item.isVisible())
  mainWindow?.webContents.send('widgets:toggle', widgetsVisible)
}

function registerHotkeys(settings: WorkspaceState['Settings']) {
  globalShortcut.unregisterAll()
  const entries: [string, () => void][] = [
    [settings.MainWindowHotKey, showWindow],
    [settings.DesktopWidgetsHotKey, toggleWidgetWindow],
    [settings.ScreenshotHotKey, () => { void captureScreenshot('Region') }],
    [settings.PinScreenshotHotKey, () => { if (lastScreenshotDataUrl) void pinScreenshotData(lastScreenshotDataUrl) }]
  ]
  let registered = true
  for (const [accelerator, handler] of entries) { if (typeof accelerator === 'string' && accelerator.trim()) registered = globalShortcut.register(accelerator, handler) && registered }
  return registered
}

function createTray() {
  const iconPath = path.resolve(__dirname, '../../Assets/DustDesk.ico')
  tray = new Tray(existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty())
  tray.setToolTip('DustDesk')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DustDesk', click: showWindow },
    { label: '显示/隐藏桌面小组件', click: toggleWidgetWindow },
    { label: '检查更新', click: async () => { try { const result = await autoUpdater.checkForUpdates(); tray?.displayBalloon?.({ title: 'DustDesk', content: result?.updateInfo.version ? `发现新版本 ${result.updateInfo.version}` : '当前已是最新版本' }) } catch (error) { tray?.displayBalloon?.({ title: 'DustDesk', content: `检查更新失败：${String(error)}` }) } } },
    { type: 'separator' },
    { label: '退出 DustDesk', click: () => { isQuitting = true; app.quit() } }
  ]))
  tray.on('double-click', showWindow)
}

function createApplicationMenu() {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '关闭窗口', role: 'close' },
        { type: 'separator' },
        { label: '退出 DustDesk', role: 'quit' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '查看',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', role: 'minimize' },
        { label: '关闭', role: 'close' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        { label: '关于 DustDesk', click: () => { void dialog.showMessageBox({ type: 'info', title: '关于 DustDesk', message: 'DustDesk', detail: '本地桌面工作台\nElectron 版本 2.0' }) } },
        { label: '项目主页', click: () => { void shell.openExternal('https://github.com/Abyxs/DustDesk-Desktop-Manager') } }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function startClipboardMonitor() {
  clipboardTimer = setInterval(() => {
    if (!clipboardMonitoringEnabled || !mainWindow || mainWindow.isDestroyed()) return
    const image = clipboard.readImage()
    const text = clipboard.readText()
    const imagePngBase64 = image.isEmpty() ? '' : image.toPNG().toString('base64')
    if (!text && !imagePngBase64) return
    const fingerprint = createHash('sha256').update(text).update(imagePngBase64).digest('hex')
    if (fingerprint === lastClipboardFingerprint) return
    lastClipboardFingerprint = fingerprint
    mainWindow.webContents.send('clipboard:changed', {
      Id: crypto.randomUUID(), Kind: imagePngBase64 ? 'Image' : 'Text', Text: text, ImagePngBase64: imagePngBase64,
      ImageFileName: imagePngBase64 ? `Clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png` : '', ImageSha256: fingerprint,
      CreatedAt: new Date().toISOString(), IsLocked: false, IsPinned: false
    })
  }, 900)
}

async function captureScreenshot(mode: 'Region' | 'Window' | 'FullScreen') {
  const settings = (await readState()).Settings
  if (settings.ScreenshotDelaySeconds > 0) await new Promise(resolve => setTimeout(resolve, Math.min(10, settings.ScreenshotDelaySeconds) * 1000))
  const directory = path.resolve(settings.ScreenshotSaveDirectory?.trim() || path.join(dataDirectory(), 'Screenshots'))
  await fs.mkdir(directory, { recursive: true })
  const extension = settings.ScreenshotFormat === 'jpg' || settings.ScreenshotFormat === 'jpeg' ? 'jpg' : 'png'
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const persist = async (dataUrl: string, fallbackBuffer?: Buffer) => {
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) throw new Error('截图图像无效')
    const buffer = extension === 'jpg' ? image.toJPEG(92) : fallbackBuffer ?? image.toPNG()
    const normalizedDataUrl = extension === 'jpg' ? image.toDataURL() : dataUrl
    const output = path.join(directory, `DustDesk-${stamp}.${extension}`)
    await fs.writeFile(output, buffer)
    lastScreenshotDataUrl = normalizedDataUrl
    if (settings.ScreenshotAutoCopy) clipboard.writeImage(image)
    if (settings.ScreenshotAutoAddToClipboardHistory && mainWindow && !mainWindow.isDestroyed()) {
      const imagePngBase64 = image.toPNG().toString('base64'); const fingerprint = createHash('sha256').update(imagePngBase64).digest('hex')
      mainWindow.webContents.send('clipboard:changed', { Id: crypto.randomUUID(), Kind: 'Image', Text: '', ImagePngBase64: imagePngBase64, ImageFileName: path.basename(output), ImageSha256: fingerprint, CreatedAt: new Date().toISOString(), IsLocked: false, IsPinned: false })
    }
    return { output, dataUrl: normalizedDataUrl }
  }
  if (mode === 'Region') {
    const dataUrl = await captureRegionScreenshot()
    if (!dataUrl) return { ok: false, message: 'region-capture-canceled' }
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl)
    if (!match) return { ok: false, message: 'invalid-region-capture' }
    const saved = await persist(dataUrl, Buffer.from(match[1], 'base64'))
    return { ok: true, path: saved.output, dataUrl: saved.dataUrl, message: '区域截图已捕获' }
  }
  const { desktopCapturer } = await import('electron')
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 3840, height: 2160 } })
  const source = mode === 'Window' ? sources.find(item => item.id.startsWith('window:')) ?? sources[0] : sources.find(item => item.id.startsWith('screen:')) ?? sources[0]
  if (!source || source.thumbnail.isEmpty()) return { ok: false, message: 'no-capture-source' }
  const saved = await persist(source.thumbnail.toDataURL(), source.thumbnail.toPNG())
  return { ok: true, path: saved.output, dataUrl: saved.dataUrl, message: `${mode} 截图已捕获` }
}

async function pinScreenshotData(dataUrl: string) {
  if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl)) throw new Error('无效的图片数据')
  const settings = (await readState()).Settings
  const window = new BrowserWindow({ width: 620, height: 420, minWidth: 240, minHeight: 160, frame: false, transparent: true, alwaysOnTop: settings.PinnedImageTopmost, resizable: true, skipTaskbar: true, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  pinnedWindows.add(window); window.on('closed', () => pinnedWindows.delete(window)); window.setAlwaysOnTop(settings.PinnedImageTopmost !== false, 'floating'); window.setOpacity(Math.max(0.2, Math.min(1, Number(settings.PinnedImageOpacityPercent ?? 100) / 100))); if (settings.PinnedImageMouseThrough) window.setIgnoreMouseEvents(true, { forward: true })
  const html = `<html><body style="margin:0;background:transparent;overflow:hidden"><img src="${dataUrl}" style="display:block;width:100%;height:100%;object-fit:contain;user-select:none;-webkit-user-drag:none" /></body></html>`
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  return { ok: true }
}

async function sampleSystemMetrics(): Promise<SystemMetrics> {
  const fallbackTotal = os.totalmem()
  const [load, memory, disks, network, diskIo, latency, time] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.fsSize().catch(() => []),
    si.networkStats().catch(() => []),
    si.disksIO().catch(() => null),
    si.inetLatency('1.1.1.1').catch(() => -1),
    Promise.resolve().then(() => si.time()).catch(() => ({ uptime: os.uptime() }))
  ])
  const totalMemory = memory?.total || fallbackTotal
  const freeMemory = memory?.available ?? memory?.free ?? os.freemem()
  const networkRows = Array.isArray(network) ? network : []
  const diskRows = Array.isArray(disks) ? disks : []
  return {
    CpuPercent: Math.max(0, Math.min(100, Number(load?.currentLoad ?? 0))),
    MemoryPercent: totalMemory ? Math.max(0, Math.min(100, (1 - freeMemory / totalMemory) * 100)) : 0,
    UsedMemoryBytes: Math.max(0, totalMemory - freeMemory),
    TotalMemoryBytes: totalMemory,
    DownloadBytesPerSecond: networkRows.reduce((sum, row) => sum + Math.max(0, Number(row.rx_sec ?? 0)), 0),
    UploadBytesPerSecond: networkRows.reduce((sum, row) => sum + Math.max(0, Number(row.tx_sec ?? 0)), 0),
    DiskReadBytesPerSecond: Math.max(0, Number(diskIo?.rIO_sec ?? 0)),
    DiskWriteBytesPerSecond: Math.max(0, Number(diskIo?.wIO_sec ?? 0)),
    DiskSpaces: diskRows.filter(row => Number(row.size) > 0).map(row => ({
      DriveName: String(row.mount ?? row.fs ?? ''),
      FreeBytes: Math.max(0, Number(row.available ?? 0)),
      TotalBytes: Math.max(0, Number(row.size ?? 0))
    })).filter(row => row.DriveName && row.TotalBytes > 0),
    PingMilliseconds: Number.isFinite(Number(latency)) && Number(latency) >= 0 ? Number(latency) : -1,
    UptimeSeconds: Math.max(0, Number(time?.uptime ?? os.uptime()))
  }
}

function registerIpc() {
  ipcMain.handle('workspace:load', readState)
  ipcMain.handle('workspace:save', async (_event, state: WorkspaceState) => {
    clipboardMonitoringEnabled = state.Settings.ClipboardMonitoringEnabled !== false
    const result = await writeState(state)
    for (const [key, window] of widgetWindows) applyWidgetAppearance(window, state, state.Settings.WidgetPlacements?.[key])
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('workspace:changed', state)
    return { ok: true, path: result }
  })
  ipcMain.handle('data:location', () => dataDirectory())
  ipcMain.handle('notes:pick-background', async () => {
    const result = await dialog.showOpenDialog({ title: '选择便签背景图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] })
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    try {
      const source = result.filePaths[0]; const extension = path.extname(source).toLowerCase() || '.png'; const fileName = `note-${crypto.randomUUID()}${extension}`; const directory = path.join(dataDirectory(), 'NoteBackgrounds'); const target = path.join(directory, fileName); await fs.mkdir(directory, { recursive: true }); await fs.copyFile(source, target); const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : extension === '.bmp' ? 'image/bmp' : 'image/png'; const dataUrl = `data:${mime};base64,${(await fs.readFile(target)).toString('base64')}`; return { ok: true, path: target, fileName, dataUrl }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('notes:clear-background', async (_event, target: string) => {
    try {
      if (typeof target !== 'string' || target.length > 4096) throw new Error('图片路径无效')
      const resolved = path.resolve(target); const managed = path.resolve(path.join(dataDirectory(), 'NoteBackgrounds'))
      if (!resolved.toLowerCase().startsWith(`${managed.toLowerCase()}${path.sep}`)) throw new Error('只允许删除便签背景目录中的图片')
      await fs.rm(resolved, { force: true }); return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('notes:read-image', async (_event, target: string) => {
    try {
      if (typeof target !== 'string' || target.length > 4096) throw new Error('图片路径无效')
      const resolved = path.resolve(target); const managed = path.resolve(path.join(dataDirectory(), 'NoteBackgrounds')); if (!resolved.toLowerCase().startsWith(`${managed.toLowerCase()}${path.sep}`)) throw new Error('只允许读取便签背景目录')
      const extension = path.extname(resolved).toLowerCase(); const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : extension === '.bmp' ? 'image/bmp' : 'image/png'; return { ok: true, dataUrl: `data:${mime};base64,${(await fs.readFile(resolved)).toString('base64')}` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('window:show', showWindow)
  ipcMain.handle('window:hide', () => mainWindow?.hide())
  ipcMain.handle('path:pick-folder', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog({ title: typeof title === 'string' && title.trim() ? title.slice(0, 120) : '选择文件夹', properties: ['openDirectory'] })
    return result.canceled || !result.filePaths[0] ? { ok: false, canceled: true } : { ok: true, path: result.filePaths[0] }
  })
  ipcMain.handle('path:pick', async (_event, title?: string) => {
    const result = await dialog.showOpenDialog({ title: typeof title === 'string' && title.trim() ? title.slice(0, 120) : '选择文件或文件夹', properties: ['openFile', 'openDirectory'] })
    return result.canceled || !result.filePaths[0] ? { ok: false, canceled: true } : { ok: true, path: result.filePaths[0] }
  })
  ipcMain.handle('widgets:toggle', (_event, key?: string) => toggleWidgetWindow(validWidgetKey(key) ? key : 'todo'))
  ipcMain.handle('widgets:resize', async (_event, key: string, width: number, height: number, commit = false) => {
    if (!validWidgetKey(key) || !Number.isFinite(width) || !Number.isFinite(height)) return { ok: false, error: '小组件尺寸无效' }
    const state = await readState(); const current = state.Settings.WidgetPlacements?.[key] as WidgetPlacement | undefined
    if (current?.Locked) return { ok: false, error: '小组件已锁定尺寸' }
    const minWidth = key === 'search' ? 52 : 300; const minHeight = key === 'search' ? 52 : 120
    const nextWidth = Math.max(minWidth, Math.min(1200, Math.round(width))); const nextHeight = Math.max(minHeight, Math.min(900, Math.round(height)))
    const window = widgetWindows.get(key); if (!window || window.isDestroyed()) return { ok: false, error: '小组件窗口不可用' }
    // Transparent frameless windows can promote their current bounds to the native minimum after setSize.
    // Re-apply the intended floor before every custom resize so dragging back down remains possible.
    window.setMinimumSize(minWidth, minHeight)
    if (!commit) { widgetResizePreviews.add(key); window.setSize(nextWidth, nextHeight); setTimeout(() => widgetResizePreviews.delete(key), 100); return { ok: true } }
    widgetResizePreviews.delete(key); window.setSize(nextWidth, nextHeight)
    state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...(current ?? {}), Width: nextWidth, Height: nextHeight, Visible: true } }
    await writeState(state); for (const target of BrowserWindow.getAllWindows()) if (!target.isDestroyed()) target.webContents.send('workspace:changed', state)
    return { ok: true }
  })
  ipcMain.handle('widgets:hide', (_event, key: string) => { if (!validWidgetKey(key)) return; const window = widgetWindows.get(key); if (window && !window.isDestroyed()) window.hide() })
  ipcMain.handle('widgets:options', async (_event, key: string, options: { locked?: boolean; topMost?: boolean; transparentBackground?: boolean; autoCollapse?: boolean; collapsed?: boolean; snapToEdges?: boolean; height?: number }) => {
    if (!validWidgetKey(key) || !options || typeof options !== 'object') return { ok: false, error: '小组件参数无效' }
    const state = await readState(); const current = state.Settings.WidgetPlacements?.[key] as Record<string, unknown> | undefined
    const requestedHeight = key === 'search' && Number.isFinite(options.height) ? Math.max(52, Math.min(480, Math.round(Number(options.height)))) : undefined
    const placement = { ...(current ?? {}), ...(options.locked === undefined ? {} : { Locked: Boolean(options.locked) }), ...(options.topMost === undefined ? {} : { TopMost: Boolean(options.topMost) }), ...(options.transparentBackground === undefined ? {} : { TransparentBackground: Boolean(options.transparentBackground) }), ...(options.autoCollapse === undefined ? {} : { AutoCollapseEnabled: Boolean(options.autoCollapse) }), ...(options.collapsed === undefined ? {} : { IsCollapsed: Boolean(options.collapsed) }), ...(options.snapToEdges === undefined ? {} : { SnapToEdges: Boolean(options.snapToEdges) }), ...(requestedHeight === undefined ? {} : { Height: requestedHeight }) }
    state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: placement }
    const window = widgetWindows.get(key)
    if (window && !window.isDestroyed()) {
      if (options.locked !== undefined) window.setResizable(!options.locked)
      if (options.topMost !== undefined) window.setAlwaysOnTop(Boolean(options.topMost), 'floating')
      if (options.collapsed !== undefined) {
        const [width, height] = window.getSize()
        if (options.collapsed) { if (height > 34) expandedWidgetHeights.set(key, height); window.setMinimumSize(key === 'search' ? 52 : 300, 34); window.setSize(width, 34) }
        else { const restoreHeight = expandedWidgetHeights.get(key) ?? (Number((placement as Record<string, unknown>).Height) || 220); window.setMinimumSize(key === 'search' ? 52 : 300, key === 'search' ? 52 : 120); window.setSize(width, Math.max(key === 'search' ? 52 : 120, restoreHeight)); expandedWidgetHeights.delete(key) }
      }
      if (requestedHeight !== undefined && options.collapsed === undefined) window.setSize(window.getSize()[0], requestedHeight)
      applyWidgetAppearance(window, state, placement as WidgetPlacement)
    }
    await writeState(state)
    for (const target of BrowserWindow.getAllWindows()) if (!target.isDestroyed()) target.webContents.send('workspace:changed', state)
    return { ok: true }
  })
  ipcMain.handle('widgets:presets:list', async () => Object.keys((await readState()).Settings.WidgetLayoutPresets ?? {}).sort((a, b) => a.localeCompare(b, 'zh-CN')))
  ipcMain.handle('widgets:presets:save', async (_event, name: string) => {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) return { ok: false, error: '布局名称无效' }
    const state = await readState(); state.Settings.WidgetLayoutPresets = { ...(state.Settings.WidgetLayoutPresets ?? {}), [name.trim()]: JSON.parse(JSON.stringify(state.Settings.WidgetPlacements ?? {})) }; await writeState(state); return { ok: true }
  })
  ipcMain.handle('widgets:presets:apply', async (_event, name: string) => {
    const state = await readState(); const preset = state.Settings.WidgetLayoutPresets?.[name]
    if (!preset) return { ok: false, error: '布局不存在' }
    state.Settings.WidgetPlacements = JSON.parse(JSON.stringify(preset)); await writeState(state)
    for (const [key, window] of widgetWindows) { const placement = state.Settings.WidgetPlacements[key] as { X?: number; Y?: number; Width?: number; Height?: number; Locked?: boolean; TopMost?: boolean } | undefined; if (!placement || window.isDestroyed()) continue; if (placement.X !== undefined && placement.Y !== undefined && placement.Width && placement.Height) window.setBounds({ x: placement.X, y: placement.Y, width: placement.Width, height: placement.Height }); if (placement.Locked !== undefined) window.setResizable(!placement.Locked); if (placement.TopMost !== undefined) window.setAlwaysOnTop(placement.TopMost, 'floating') }
    return { ok: true }
  })
  ipcMain.handle('widgets:presets:delete', async (_event, name: string) => { const state = await readState(); if (!state.Settings.WidgetLayoutPresets?.[name]) return { ok: false, error: '布局不存在' }; delete state.Settings.WidgetLayoutPresets[name]; await writeState(state); return { ok: true } })
  ipcMain.handle('path:open', async (_event, target: string) => { if (typeof target !== 'string' || target.length > 4096) return { ok: false, error: '路径无效' }; return { ok: !await shell.openPath(target) } })
  ipcMain.handle('path:context-menu', async (event, target: string) => { try { if (typeof target !== 'string' || target.length > 4096) throw new Error('路径无效'); const sender = BrowserWindow.fromWebContents(event.sender); if (!sender) throw new Error('窗口不可用'); const menu = Menu.buildFromTemplate([{ label: '打开', click: () => { void shell.openPath(target) } }, { label: '在资源管理器中显示', click: () => shell.showItemInFolder(target) }, { label: '复制路径', click: () => clipboard.writeText(target) }]); menu.popup({ window: sender }); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })
  ipcMain.handle('url:open', async (_event, target: string) => { try { const url = new URL(target); if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许打开 HTTP/HTTPS 链接'); await shell.openExternal(url.toString()); return { ok: true } } catch (error) { return { ok: false, error: String(error) } } })
  ipcMain.handle('clipboard:read', () => ({ text: clipboard.readText(), imagePngBase64: clipboard.readImage().isEmpty() ? '' : clipboard.readImage().toPNG().toString('base64') }))
  ipcMain.handle('clipboard:write', (_event, content: { text?: string; imagePngBase64?: string }) => {
    if (!content || (content.text === undefined && !content.imagePngBase64)) throw new Error('剪贴板内容为空')
    if (content.text !== undefined && (typeof content.text !== 'string' || content.text.length > 5_000_000)) throw new Error('剪贴板文本过大')
    if (content.text !== undefined) clipboard.writeText(content.text)
    if (content.imagePngBase64) clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(content.imagePngBase64, 'base64')))
  })
  ipcMain.handle('screenshot:start', async (_event, mode: 'Region' | 'Window' | 'FullScreen' = 'Region') => captureScreenshot(mode))
  ipcMain.handle('screenshot:overlay-submit', (_event, dataUrl: string) => {
    if (!activeOverlayResolve || typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) return { ok: false }
    const resolve = activeOverlayResolve; activeOverlayResolve = null; resolve(dataUrl)
    for (const window of overlayWindows) { if (!window.isDestroyed()) window.destroy() }; overlayWindows.clear()
    return { ok: true }
  })
  ipcMain.handle('screenshot:overlay-cancel', () => { const resolve = activeOverlayResolve; activeOverlayResolve = null; resolve?.(null); for (const window of overlayWindows) { if (!window.isDestroyed()) window.destroy() }; overlayWindows.clear(); return { ok: true } })
  ipcMain.handle('screenshot:save', async (_event, dataUrl: string) => {
    try { if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpeg);base64,/.test(dataUrl)) throw new Error('无效的图片数据'); const settings = (await readState()).Settings; const image = nativeImage.createFromDataURL(dataUrl); if (image.isEmpty()) throw new Error('截图图像无效'); const extension = settings.ScreenshotFormat === 'jpg' || settings.ScreenshotFormat === 'jpeg' ? 'jpg' : 'png'; const directory = path.resolve(settings.ScreenshotSaveDirectory?.trim() || path.join(dataDirectory(), 'Screenshots')); await fs.mkdir(directory, { recursive: true }); const output = path.join(directory, `DustDesk-edited-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`); await fs.writeFile(output, extension === 'jpg' ? image.toJPEG(92) : image.toPNG()); return { ok: true, path: output } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('screenshot:pin', async (_event, dataUrl: string) => {
    try { return await pinScreenshotData(dataUrl) } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('organizer:list', async () => {
    try {
      return (await fs.readdir(desktopDirectory(), { withFileTypes: true }))
        .filter(item => item.name.toLowerCase() !== 'desktop.ini')
        .map(item => ({ Name: item.name, Path: path.join(desktopDirectory(), item.name), IsDirectory: item.isDirectory() }))
        .sort((left, right) => Number(right.IsDirectory) - Number(left.IsDirectory) || left.Name.localeCompare(right.Name, 'zh-CN'))
    } catch { return [] }
  })
  ipcMain.handle('organizer:move', async (_event, categoryId: string, sourcePath: string) => {
    try {
      const state = await readState(); const category = state.DesktopCategories.find(item => item.Id === categoryId)
      if (!category) throw new Error('分类不存在')
      const target = path.join(dataDirectory(), 'DesktopOrganizer', safeName(category.Name), path.basename(sourcePath))
      const moved = await moveWithVerification(sourcePath, target)
      organizerUndoStack.push({ source: sourcePath, target: moved, categoryId })
      category.ItemPaths = [...new Set([...category.ItemPaths, moved])]
      await writeState(state)
      return { ok: true, path: moved }
    } catch (error) { await logOrganizerFailure('收纳', sourcePath, path.join(dataDirectory(), 'DesktopOrganizer'), error); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('organizer:plan-smart', async () => { const state = await readState(); const entries = await fs.readdir(desktopDirectory(), { withFileTypes: true }); return entries.filter(item => item.name.toLowerCase() !== 'desktop.ini').map(item => { const category = classifyOrganizerEntry(item.name, state.DesktopCategories); return category ? { SourcePath: path.join(desktopDirectory(), item.name), CategoryId: category.Id, CategoryName: category.Name } : null }).filter((item): item is OrganizerPlanItem => item !== null) })
  ipcMain.handle('organizer:execute-smart', async () => { const plan = await (async () => { const state = await readState(); const entries = await fs.readdir(desktopDirectory(), { withFileTypes: true }); return entries.filter(item => item.name.toLowerCase() !== 'desktop.ini').map(item => { const category = classifyOrganizerEntry(item.name, state.DesktopCategories); return category ? { SourcePath: path.join(desktopDirectory(), item.name), CategoryId: category.Id, CategoryName: category.Name } : null }).filter((item): item is OrganizerPlanItem => item !== null) })(); let moved = 0; for (const item of plan) { const result = await new Promise<{ ok: boolean }>(resolve => { void (async () => { try { const state = await readState(); const category = state.DesktopCategories.find(value => value.Id === item.CategoryId); if (!category) return resolve({ ok: false }); const target = path.join(dataDirectory(), 'DesktopOrganizer', safeName(category.Name), path.basename(item.SourcePath)); const movedPath = await moveWithVerification(item.SourcePath, target); organizerUndoStack.push({ source: item.SourcePath, target: movedPath, categoryId: item.CategoryId }); category.ItemPaths = [...new Set([...category.ItemPaths, movedPath])]; await writeState(state); resolve({ ok: true }) } catch (error) { await logOrganizerFailure('智能收纳', item.SourcePath, path.join(dataDirectory(), 'DesktopOrganizer'), error); resolve({ ok: false }) } })() }); if (result.ok) moved++ } return { ok: true, moved } })
  ipcMain.handle('organizer:undo', async () => {
    const stateForRecovery = await readState(); const root = path.join(dataDirectory(), 'DesktopOrganizer'); const recovered: OrganizerUndoAction[] = []
    try {
      for (const category of stateForRecovery.DesktopCategories) {
        const directory = path.join(root, safeName(category.Name)); const entries = await fs.readdir(directory, { withFileTypes: true })
        for (const entry of entries.filter(item => item.isFile() || item.isDirectory())) recovered.push({ source: path.join(desktopDirectory(), entry.name), target: path.join(directory, entry.name), categoryId: category.Id })
      }
    } catch { /* no organizer directory yet */ }
    for (const action of recovered) if (!organizerUndoStack.some(item => path.resolve(item.target).toLowerCase() === path.resolve(action.target).toLowerCase())) organizerUndoStack.push(action)
    const index = [...organizerUndoStack].map((action, position) => ({ action, position })).reverse().find(item => pathExists(item.action.target))?.position
    if (index === undefined) return { ok: false, error: '没有可撤销的收纳操作' }
    const action = organizerUndoStack.splice(index, 1)[0]
    if (!action) return { ok: false, error: '没有可撤销的收纳操作' }
    try { const restored = await moveWithVerification(action.target, path.join(desktopDirectory(), path.basename(action.target))); const state = await readState(); const category = state.DesktopCategories.find(item => item.Id === action.categoryId); if (category) category.ItemPaths = category.ItemPaths.filter(item => path.resolve(item).toLowerCase() !== path.resolve(action.target).toLowerCase()); await writeState(state); return { ok: true, path: restored } }
    catch (error) { await logOrganizerFailure('撤销', action.target, desktopDirectory(), error); organizerUndoStack.splice(index, 0, action); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('organizer:restore', async (_event, categoryId: string, sourcePath: string) => {
    try {
      const state = await readState(); const category = state.DesktopCategories.find(item => item.Id === categoryId)
      if (!category) throw new Error('分类不存在')
      const target = path.join(desktopDirectory(), path.basename(sourcePath)); const restored = await moveWithVerification(sourcePath, target)
      category.ItemPaths = category.ItemPaths.filter(item => path.resolve(item).toLowerCase() !== path.resolve(sourcePath).toLowerCase())
      await writeState(state)
      return { ok: true, path: restored }
    } catch (error) { await logOrganizerFailure('恢复桌面', sourcePath, desktopDirectory(), error); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('system:sample', sampleSystemMetrics)
  ipcMain.handle('startup:get', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('startup:set', (_event, enabled: boolean) => { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] }) })
  ipcMain.handle('maintenance:backup', async () => {
    try { const directory = path.join(dataDirectory(), 'Backups'); await fs.mkdir(directory, { recursive: true }); const target = path.join(directory, `workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.json`); await fs.copyFile(dataPath(), target); return { ok: true, path: target } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('maintenance:list', async () => {
    try { const directory = path.join(dataDirectory(), 'Backups'); const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.json')); return Promise.all(entries.map(async item => { const filePath = path.join(directory, item.name); const info = await fs.stat(filePath); return { path: filePath, name: item.name, size: info.size, modifiedAt: info.mtime.toISOString() } })).then(items => items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt))) } catch { return [] }
  })
  ipcMain.handle('maintenance:restore', async (_event, target?: string) => {
    try { const directory = path.resolve(path.join(dataDirectory(), 'Backups')); const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && item.name.endsWith('.json')).sort((a, b) => b.name.localeCompare(a.name)); const selected = typeof target === 'string' && target ? path.resolve(target) : entries[0] ? path.join(directory, entries[0].name) : ''; if (!selected || !selected.toLowerCase().startsWith(`${directory.toLowerCase()}${path.sep}`) || !selected.endsWith('.json')) throw new Error('备份路径无效'); await fs.copyFile(selected, dataPath()); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('search:files', async (_event, query: string) => {
    if (typeof query !== 'string' || query.trim().length < 2) return []
    const state = await readState(); const configuredRoots = [state.Settings.SearchDesktopFiles ? desktopDirectory() : '', state.Settings.SearchStartMenuApps ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '', state.Settings.SearchAppData ? app.getPath('appData') : '', ...(state.Settings.SearchCustomPaths ? (state.Settings.SearchCustomRoots ?? []) : [])]; const roots = configuredRoots.filter(root => typeof root === 'string' && existsSync(root)); const needle = query.trim().toLowerCase(); const results: { Name: string; Path: string; IsDirectory: boolean }[] = []
    for (const root of roots.slice(0, 10)) {
      try {
        const entries = await fs.readdir(root, { withFileTypes: true, recursive: true })
        for (const entry of entries) { if (results.length >= 40) break; if (entry.name.toLowerCase().includes(needle)) results.push({ Name: entry.name, Path: path.join(root, entry.name), IsDirectory: entry.isDirectory() }) }
      } catch { }
      if (results.length >= 40) break
    }
    return results
  })
  ipcMain.handle('hotkeys:set', async (_event, keys: { mainWindow?: string; widgets?: string; screenshot?: string; pin?: string }) => {
    const state = await readState(); const values = [keys.mainWindow, keys.widgets, keys.screenshot, keys.pin].filter(value => value !== undefined)
    if (values.some(value => typeof value !== 'string' || value.length > 80)) return { ok: false, error: '快捷键格式无效' }
    const previous = { ...state.Settings }
    if (keys.mainWindow !== undefined) state.Settings.MainWindowHotKey = keys.mainWindow
    if (keys.widgets !== undefined) state.Settings.DesktopWidgetsHotKey = keys.widgets
    if (keys.screenshot !== undefined) state.Settings.ScreenshotHotKey = keys.screenshot
    if (keys.pin !== undefined) state.Settings.PinScreenshotHotKey = keys.pin
    const accelerators = [state.Settings.MainWindowHotKey, state.Settings.DesktopWidgetsHotKey, state.Settings.ScreenshotHotKey, state.Settings.PinScreenshotHotKey].map(value => value.trim().toLowerCase()).filter(Boolean)
    if (new Set(accelerators).size !== accelerators.length) { registerHotkeys(previous); return { ok: false, error: '快捷键不能重复' } }
    if (!registerHotkeys(state.Settings)) { registerHotkeys(previous); return { ok: false, error: '快捷键无效或已被其他程序占用' } }
    await writeState(state); return { ok: true }
  })
  ipcMain.handle('projects:export', exportProjects)
  ipcMain.handle('update:check', async () => { try { const result = await autoUpdater.checkForUpdates(); return { ok: true, available: Boolean(result?.updateInfo.version), version: result?.updateInfo.version } } catch (error) { return { ok: false, available: false, error: error instanceof Error ? error.message : String(error) } } })
  ipcMain.handle('update:download', async () => { try { await autoUpdater.downloadUpdate(); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })
  ipcMain.handle('update:install', () => { try { autoUpdater.quitAndInstall(); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })
}

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('com.dustdesk.next')
  const feedUrl = process.env.DUSTDESK_UPDATE_FEED_URL
  if (feedUrl) {
    try {
      const parsed = new URL(feedUrl)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') autoUpdater.setFeedURL({ provider: 'generic', url: parsed.toString().endsWith('/') ? parsed.toString() : `${parsed.toString()}/` })
    } catch { /* ignore invalid test or local override and use packaged publish config */ }
  }
  autoUpdater.autoDownload = false
  registerIpc(); createApplicationMenu(); createWindow(); createTray(); startClipboardMonitor()
  reminderTimer = setInterval(() => { void checkTodoReminders() }, 30_000)
  void checkTodoReminders()
  void readState().then(state => {
    clipboardMonitoringEnabled = state.Settings.ClipboardMonitoringEnabled !== false
    const persisted = (state as WorkspaceState & { OrganizerUndoStack?: OrganizerUndoAction[] }).OrganizerUndoStack
    if (Array.isArray(persisted)) organizerUndoStack.push(...persisted.filter(item => item && typeof item.source === 'string' && typeof item.target === 'string' && typeof item.categoryId === 'string').slice(-100))
    if (state.Settings.StartHiddenToTray) mainWindow?.hide()
  })
  void readState().then(state => { registerHotkeys(state.Settings) }).catch(() => { registerHotkeys(defaultState().Settings) })
  app.on('activate', showWindow)
})
app.on('window-all-closed', event => { event.preventDefault() })
app.on('will-quit', () => { globalShortcut.unregisterAll(); if (clipboardTimer) clearInterval(clipboardTimer); if (reminderTimer) clearInterval(reminderTimer); for (const window of widgetWindows.values()) window.destroy(); tray?.destroy() })
