import { focusElapsed, productivityDefaults, productivitySettings } from '../shared/productivity'
import { isHttpUrl } from '../shared/urls'
import { collectDeleted, normalizeProductivity, matchOrganizerRule } from './productivityState'
import { createProductivityRuntime } from './productivityRuntime'
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, screen, shell, Tray } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createReleaseUpdateChecker } from './releaseUpdates'
import { repository } from '../shared/repository'
import * as XLSX from 'xlsx'
import si from 'systeminformation'
import type { DesktopCategoryRecord, OrganizerPlanItem, SystemMetrics, WidgetPlacement, WorkspaceState } from '../shared/types'
import { assertPathWithinRoot, isWithinDirectory, moveFileSafely, safeName } from './fileOperations'
import { createClipboardSampler } from './clipboardSampler'
import { isCompleteWorkspace } from './workspaceValidation'
import { createNoteBackgroundManager } from './noteBackgrounds'
import { createClipboardAssets } from './clipboardAssets'
import { byteRate, sampleWindowsDiskThroughput } from './diskMetrics'
import { createFileSearch } from './fileSearch'
import { snapWidgetBounds } from './widgetSnapping'
import { createWindowsIconReader } from './windowsIcons'
import { createIconLoader } from '../shared/iconLoader'
import { createScreenshotSessions } from './screenshotSessions'
import { captureWindowsRegion } from './regionCapture'
import type { ScreenshotRect, ScreenshotTool } from '../shared/screenshotDocument'
import type { ScreenshotDocument, ScreenshotFinishRequest, ScreenshotPayload } from '../shared/screenshotDocument'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
if (process.env.DUSTDESK_TEST_USER_DATA_DIR) app.setPath('userData', path.resolve(process.env.DUSTDESK_TEST_USER_DATA_DIR))
let mainWindow: BrowserWindow | null = null
const releaseUpdates = createReleaseUpdateChecker({
  version: () => app.getVersion(),
  request: (input, init) => net.fetch(input, init),
  confirm: async (version, currentVersion, notes) => {
    const options: Electron.MessageBoxOptions = {
      type: 'info', title: '发现新版本', message: `发现 DustDesk ${version}，是否前往更新？`,
      detail: `当前版本：${currentVersion}\n\n更新内容\n${notes}\n\n确认后打开此版本的 GitHub 发布页面。`,
      buttons: ['暂不更新', '前往更新'], defaultId: 0, cancelId: 0, noLink: true
    }
    const result = await (mainWindow && !mainWindow.isDestroyed() ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options))
    return result.response === 1
  },
  open: url => shell.openExternal(url)
})
let captureWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let widgetsVisible = false
let clipboardTimer: NodeJS.Timeout | null = null
let lastClipboardFingerprint = ''
let lastScreenshotDataUrl = ''
let screenshotCaptureInFlight = false
const widgetWindows = new Map<string, BrowserWindow>()
const expandedWidgetHeights = new Map<string, number>()
const widgetResizePreviews = new Set<string>()
const lockedWidgets = new Set<string>()
const widgetPlacementSyncing = new Set<string>()
const widgetSnapModes = new Map<string, boolean>()
const widgetMovePreviews = new Set<string>()
const widgetDragVersions = new Map<string, number>()
const overlayWindows = new Set<BrowserWindow>()
const workspaceClientSnapshots = new Map<number, WorkspaceState>()
let activeOverlayResolve: ((dataUrl: string | null) => void) | null = null
const pinnedWindows = new Set<BrowserWindow>()
const screenshotOverlayDocuments = new Map<BrowserWindow, string>()
const screenshotRegionDisplays = new Map<BrowserWindow, Electron.Display>()
const screenshotRegionRequests = new Map<BrowserWindow, AbortController>()
const screenshotRegionMetadata = new Map<BrowserWindow, Pick<ScreenshotPayload, 'placement' | 'initialAction' | 'initialTool'>>()
type PinnedScreenshot = { window: BrowserWindow; png: Uint8Array; version: number; documentId: string; opacity: number; topmost: boolean; locked: boolean; mouseThrough: boolean; originalWidth: number; originalHeight: number }
const pinnedScreenshots = new Map<string, PinnedScreenshot>()
const screenshotSessions = createScreenshotSessions({
  decode: bytes => {
    if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw Error('图片无效或过大（最大 32 MB）')
    const image = nativeImage.createFromBuffer(Buffer.from(bytes))
    if (image.isEmpty()) throw Error('无法读取图片，请使用 PNG 或 JPG 图片')
    const size = image.getSize()
    if (size.width * size.height > 40_000_000) throw Error('图片尺寸过大（最大 4000 万像素）')
    const pngSignature = bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    return { png: pngSignature ? new Uint8Array(bytes) : new Uint8Array(image.toPNG()), ...size }
  },
  output: completeScreenshotOutput
})
let clipboardMonitoringEnabled = true
let reminderTimer: NodeJS.Timeout | null = null
type OrganizerUndoAction = { source: string; target: string; categoryId: string; sourceCategoryId?: string; sourceCategory?: DesktopCategoryRecord }
const organizerUndoStack: OrganizerUndoAction[] = []
let workspaceWriteQueue: Promise<string> = Promise.resolve('')
let workspaceMutationQueue: Promise<void> = Promise.resolve()
let defaultStateInitialization: Promise<WorkspaceState> | null = null
let workspaceSeen = false
let workspaceMigration: Promise<WorkspaceState> | null = null
const launchedHidden = process.argv.includes('--hidden')
const supportedWidgetKeys = new Set(['todo', 'notes', 'projects', 'launcher', 'links', 'clipboard', 'organizer', 'search', 'monitor', 'countdown'])
const maxImageBytes = 12 * 1024 * 1024
const clipboardAssets = createClipboardAssets(dataDirectory)
const searchFiles = createFileSearch()
const readWindowsIcon = createWindowsIconReader()
const pathIcons = createIconLoader(async target => {
  let isDirectory: boolean | undefined
  try {
    const info = await fs.stat(target)
    isDirectory = info.isDirectory()
    if (process.platform === 'win32') {
      const resourceFile = /\.(lnk|exe|dll|ico|icl)$/i.test(target)
      const dataUrl = await readWindowsIcon({ path: target, index: 0, directory: isDirectory, shortcut: !isDirectory && /\.lnk$/i.test(target), shellItem: !resourceFile }, `${info.size}:${info.mtimeMs}`)
      if (dataUrl) return { isDirectory, dataUrl }
      // Chromium can associate folders and extensionless files with the volume.
      // Its .url association also discards the shortcut's individual icon.
      if (isDirectory || !path.extname(target) || /\.url$/i.test(target)) return { isDirectory }
    }
    // File associations cover documents and unsupported resources on Windows.
    // A slow shell extension cannot hold the icon queue indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const icon = await Promise.race([
        app.getFileIcon(target, { size: 'large' }),
        new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1500) })
      ])
      if (icon && !icon.isEmpty()) return { isDirectory, dataUrl: icon.toDataURL() }
    } finally { clearTimeout(timer) }
  } catch { /* Missing files or damaged resources keep their visible type fallback. */ }
  return isDirectory === undefined ? {} : { isDirectory }
})
const fileSearches = new Map<number, { requestId: string; controller: AbortController }>()
const fileSearchOwners = new WeakSet<Electron.WebContents>()
const singleInstanceLock = app.requestSingleInstanceLock()
if (!singleInstanceLock) app.quit()
else app.on('second-instance', () => showWindow())

function broadcastWorkspaceChanged(state: WorkspaceState) {
  reconcileWidgetVisibility(state)
  for (const key of widgetWindows.keys()) widgetSnapModes.set(key, widgetSnappingEnabled(key, state))
  for (const target of BrowserWindow.getAllWindows()) {
    if (!target.isDestroyed()) {
      target.webContents.send('workspace:changed', state)
    }
  }
}

function broadcastWidgetVisibility(key: string, visible: boolean) {
  for (const target of BrowserWindow.getAllWindows()) if (!target.isDestroyed()) target.webContents.send('widget:visibility', key, visible)
}

function cloneWorkspace<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function equalValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function mergeRecordArray<T extends { Id?: string }>(latest: T[], incoming: T[], baseline: T[]) {
  if (!latest.every(item => item && typeof item === 'object' && typeof item.Id === 'string') || !incoming.every(item => item && typeof item === 'object' && typeof item.Id === 'string') || !baseline.every(item => item && typeof item === 'object' && typeof item.Id === 'string')) return incoming
  const baselineById = new Map(baseline.map(item => [item.Id!, item])); const latestById = new Map(latest.map(item => [item.Id!, item])); const incomingById = new Map(incoming.map(item => [item.Id!, item]))
  const result: T[] = []
  for (const item of incoming) {
    const previous = baselineById.get(item.Id!); const current = latestById.get(item.Id!)
    if (previous && !current) continue // A stale editor cannot resurrect a deleted record.
    if (!previous || !current) result.push(item)
    else result.push(mergeWorkspaceValue(current, item, previous) as T)
  }
  for (const item of latest) {
    if (incomingById.has(item.Id!)) continue
    const previous = baselineById.get(item.Id!)
    if (!previous) result.push(item)
  }
  return result
}

function mergeWorkspaceValue(latest: unknown, incoming: unknown, baseline: unknown): unknown {
  if (equalValue(incoming, baseline)) return latest
  if (equalValue(latest, baseline)) return incoming
  if (Array.isArray(latest) && Array.isArray(incoming) && Array.isArray(baseline) && latest.every(isRecordWithId) && incoming.every(isRecordWithId) && baseline.every(isRecordWithId)) {
    return mergeRecordArray(latest as { Id?: string }[], incoming as { Id?: string }[], baseline as { Id?: string }[])
  }
  if (isRecord(latest) && isRecord(incoming) && isRecord(baseline)) {
    const keys = new Set([...Object.keys(latest), ...Object.keys(incoming), ...Object.keys(baseline)])
    return Object.fromEntries([...keys].map(key => [key, mergeWorkspaceValue(latest[key], incoming[key], baseline[key])]))
  }
  return incoming
}

function isRecordWithId(value: unknown): value is { Id?: string } {
  return isRecord(value) && (value.Id === undefined || typeof value.Id === 'string')
}

function mergeWorkspaceState(latest: WorkspaceState, incoming: WorkspaceState, baseline?: WorkspaceState) {
  if (!baseline) return normalizeState(incoming) ?? latest
  const keys = new Set([...Object.keys(latest), ...Object.keys(incoming), ...Object.keys(baseline)])
  const merged = Object.fromEntries([...keys].map(key => [key, mergeWorkspaceValue(latest[key], incoming[key], baseline[key])])) as WorkspaceState
  return normalizeState(merged) ?? latest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeWidgetPlacement(value: unknown): WidgetPlacement | null {
  if (!isRecord(value)) return null
  const placement: WidgetPlacement = {}
  for (const [source, target] of [['Visible', 'Visible'], ['Locked', 'Locked'], ['TopMost', 'TopMost'], ['AutoCollapseEnabled', 'AutoCollapseEnabled'], ['IsCollapsed', 'IsCollapsed'], ['SnapToEdges', 'SnapToEdges'], ['TransparentBackground', 'TransparentBackground']] as const) if (typeof value[source] === 'boolean') placement[target] = value[source]
  for (const key of ['X', 'Y', 'Width', 'Height'] as const) if (typeof value[key] === 'number' && Number.isFinite(value[key])) placement[key] = Math.round(value[key])
  if (['None', 'Left', 'Right', 'Top', 'Bottom'].includes(String(value.DockEdge))) placement.DockEdge = value.DockEdge as WidgetPlacement['DockEdge']
  return placement
}

function normalizeState(value: unknown): WorkspaceState | null {
  if (!isRecord(value) || !isRecord(value.Settings) || !Array.isArray(value.Todos)) return null
  const base = defaultState()
  const settings = value.Settings as Record<string, unknown>; const normalizedSettings = { ...settings, ...base.Settings }
  for (const key of Object.keys(base.Settings) as (keyof WorkspaceState['Settings'])[]) {
    const expected = base.Settings[key]; const candidate = settings[key]
    if ((typeof expected === 'number' && typeof candidate === 'number' && Number.isFinite(candidate)) || (typeof expected === 'string' && typeof candidate === 'string') || (typeof expected === 'boolean' && typeof candidate === 'boolean')) normalizedSettings[key] = candidate as never
  }
  const normalized = { ...base, ...value, Settings: normalizedSettings } as WorkspaceState
  normalized.SchemaVersion = 3
  normalized.LegacyImportCompleted = value.LegacyImportCompleted === true
  normalized.QuickNote = typeof value.QuickNote === 'string' ? value.QuickNote : ''
  const records = (key: string) => Array.isArray(value[key]) ? value[key].filter(isRecord) : []
  normalized.Todos = records('Todos').map(item => ({ ...item, Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Title: typeof item.Title === 'string' ? item.Title : '', Tag: typeof item.Tag === 'string' ? item.Tag : '', Note: typeof item.Note === 'string' ? item.Note : '', IsCompleted: item.IsCompleted === true, CreatedAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : new Date().toISOString(), ReminderAt: typeof item.ReminderAt === 'string' ? item.ReminderAt : null, ReminderNotifiedAt: typeof item.ReminderNotifiedAt === 'string' ? item.ReminderNotifiedAt : null, ReminderRepeat: ['None', 'Daily', 'Weekdays', 'Weekly'].includes(String(item.ReminderRepeat)) ? item.ReminderRepeat as WorkspaceState['Todos'][number]['ReminderRepeat'] : 'None' }))
  normalized.TagPresets = records('TagPresets').map(item => ({ Name: typeof item.Name === 'string' ? item.Name : '', ColorArgb: typeof item.ColorArgb === 'number' && Number.isFinite(item.ColorArgb) ? item.ColorArgb : -1576078 })).filter(item => item.Name)
  normalized.Notes = records('Notes').map(item => ({ ...item, Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Title: typeof item.Title === 'string' ? item.Title : '', Text: typeof item.Text === 'string' ? item.Text : '', ColorArgb: typeof item.ColorArgb === 'number' ? item.ColorArgb : -411768, FontColorArgb: typeof item.FontColorArgb === 'number' ? item.FontColorArgb : -1385444, FontSize: typeof item.FontSize === 'number' && Number.isFinite(item.FontSize) ? item.FontSize : 14, FontBold: item.FontBold === true, BackgroundImagePath: typeof item.BackgroundImagePath === 'string' ? item.BackgroundImagePath : null, BackgroundImageFileName: typeof item.BackgroundImageFileName === 'string' ? item.BackgroundImageFileName : '', ImageOnly: item.ImageOnly === true, CreatedAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : new Date().toISOString(), UpdatedAt: typeof item.UpdatedAt === 'string' ? item.UpdatedAt : new Date().toISOString() }))
  normalized.Projects = records('Projects').map(item => ({ Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Name: typeof item.Name === 'string' ? item.Name : '', ProjectPath: typeof item.ProjectPath === 'string' ? item.ProjectPath : '', Phases: Array.isArray(item.Phases) ? item.Phases.filter(isRecord).map(phase => ({ Id: typeof phase.Id === 'string' ? phase.Id : crypto.randomUUID(), Title: typeof phase.Title === 'string' ? phase.Title : '', Status: ['Todo', 'Doing', 'Done'].includes(String(phase.Status)) ? phase.Status as 'Todo' | 'Doing' | 'Done' : 'Todo', StartDate: typeof phase.StartDate === 'string' ? phase.StartDate : null, EndDate: typeof phase.EndDate === 'string' ? phase.EndDate : null, ProgressPercent: typeof phase.ProgressPercent === 'number' && Number.isFinite(phase.ProgressPercent) ? phase.ProgressPercent : 0, ProjectPath: typeof phase.ProjectPath === 'string' ? phase.ProjectPath : '', Subtasks: Array.isArray(phase.Subtasks) ? phase.Subtasks.filter(isRecord).map(subtask => ({ Id: typeof subtask.Id === 'string' ? subtask.Id : crypto.randomUUID(), Title: typeof subtask.Title === 'string' ? subtask.Title : '', IsCompleted: subtask.IsCompleted === true, FilePath: typeof subtask.FilePath === 'string' ? subtask.FilePath : '' })) : [] })) : [] }))
  normalized.Launchers = records('Launchers').map(item => ({ Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Name: typeof item.Name === 'string' ? item.Name : '', Path: typeof item.Path === 'string' ? item.Path : '', ...(typeof item.GroupId === 'string' ? { GroupId: item.GroupId } : {}) }))
  normalized.LinkGroups = records('LinkGroups').map(group => ({ Id: typeof group.Id === 'string' ? group.Id : crypto.randomUUID(), Name: typeof group.Name === 'string' ? group.Name : '未命名', Links: Array.isArray(group.Links) ? group.Links.filter(isRecord).map(item => ({ Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Name: typeof item.Name === 'string' ? item.Name : '', Url: typeof item.Url === 'string' ? item.Url : '', Note: typeof item.Note === 'string' ? item.Note : '', CreatedAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : new Date().toISOString(), UpdatedAt: typeof item.UpdatedAt === 'string' ? item.UpdatedAt : new Date().toISOString() })) : [] }))
  normalized.ClipboardHistory = records('ClipboardHistory').map(item => ({ Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Kind: item.Kind === 'Image' ? 'Image' : 'Text', Text: typeof item.Text === 'string' ? item.Text : '', ImagePngBase64: typeof item.ImagePngBase64 === 'string' ? item.ImagePngBase64 : '', ...(typeof item.ImageAssetName === 'string' ? { ImageAssetName: item.ImageAssetName } : {}), ImageFileName: typeof item.ImageFileName === 'string' ? item.ImageFileName : '', ImageSha256: typeof item.ImageSha256 === 'string' ? item.ImageSha256 : '', CreatedAt: typeof item.CreatedAt === 'string' ? item.CreatedAt : new Date().toISOString(), IsLocked: item.IsLocked === true, IsPinned: item.IsPinned === true }))
  normalized.DesktopCategories = records('DesktopCategories').map(item => ({ Id: typeof item.Id === 'string' ? item.Id : crypto.randomUUID(), Name: typeof item.Name === 'string' ? item.Name : '未命名', IsCollapsed: item.IsCollapsed === true, ItemPaths: Array.isArray(item.ItemPaths) ? item.ItemPaths.filter((path): path is string => typeof path === 'string') : [] }))
  if (!normalized.LinkGroups.length) normalized.LinkGroups = base.LinkGroups
  if (!isRecord(settings.WidgetPlacements)) normalized.Settings.WidgetPlacements = {}
  else normalized.Settings.WidgetPlacements = Object.fromEntries(Object.entries(settings.WidgetPlacements).map(([key, placement]) => [key, normalizeWidgetPlacement(placement)] as const).filter((entry): entry is readonly [string, WidgetPlacement] => validWidgetKey(entry[0]) && entry[1] !== null))
  normalized.Settings.NoteWidgetPlacements = Array.isArray(settings.NoteWidgetPlacements) ? settings.NoteWidgetPlacements.filter(isRecord).map(item => ({ ...(normalizeWidgetPlacement(item) ?? {}), NoteId: typeof item.NoteId === 'string' ? item.NoteId : '' })).filter(item => item.NoteId) : []
  normalized.Settings.OrganizerGroupWidgetPlacements = Array.isArray(settings.OrganizerGroupWidgetPlacements) ? settings.OrganizerGroupWidgetPlacements.filter(isRecord).map(item => ({ ...(normalizeWidgetPlacement(item) ?? {}), GroupId: typeof item.GroupId === 'string' ? item.GroupId : '', CategoryIds: Array.isArray(item.CategoryIds) ? item.CategoryIds.filter((id): id is string => typeof id === 'string') : [] })).filter(item => item.GroupId) : []
  if (!isRecord(settings.WidgetLayoutPresets)) normalized.Settings.WidgetLayoutPresets = {}
  else normalized.Settings.WidgetLayoutPresets = Object.fromEntries(Object.entries(settings.WidgetLayoutPresets).flatMap(([name, preset]) => {
    if (!isRecord(preset)) return []
    return [[name, Object.fromEntries(Object.entries(preset).map(([key, placement]) => [key, normalizeWidgetPlacement(placement)] as const).filter((entry): entry is readonly [string, WidgetPlacement] => validWidgetKey(entry[0]) && entry[1] !== null))]]
  }))
  normalized.Settings.SearchCustomRoots = Array.isArray(settings.SearchCustomRoots) ? settings.SearchCustomRoots.filter((root): root is string => typeof root === 'string') : []
  normalized.Settings.DesktopHotKeyWidgetKeys = Array.isArray(settings.DesktopHotKeyWidgetKeys) ? settings.DesktopHotKeyWidgetKeys.filter(validWidgetKey) : []
  Object.assign(normalized, normalizeProductivity(value))
  normalized.Settings.BackupRetentionDays = Math.max(1, Math.min(365, Math.round(normalized.Settings.BackupRetentionDays)))
  return normalized
}

function dataDirectory() {
  const injected = process.env.DUSTDESK_TEST_DATA_DIR
  return injected ? path.resolve(injected) : path.join(app.getPath('appData'), 'DustDesk.Next', 'Data')
}

function dataPath() { return path.join(dataDirectory(), 'workspace.json') }
function backupPath() { return `${dataPath()}.bak` }

function defaultState(): WorkspaceState {
  const now = new Date().toISOString()
  return {
    ...productivityDefaults(),
    SchemaVersion: 3, LegacyImportCompleted: false, QuickNote: '',
    Settings: {
      ...productivitySettings,
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
  let foundExisting = false
  for (const [index, candidate] of [dataPath(), backupPath()].entries()) {
    try {
      const contents = await fs.readFile(candidate, 'utf8')
      foundExisting = true
      const raw = JSON.parse(contents)
      if (isRecord(raw) && typeof raw.SchemaVersion === 'number' && raw.SchemaVersion > 3) throw new Error('工作区版本较新，请使用新版应用打开')
      if (!isCompleteWorkspace(raw)) continue
      const parsed = normalizeState(raw)
      if (parsed) {
        workspaceSeen = true
        const needsImageMigration = parsed.ClipboardHistory.some(item => item.Kind === 'Image' && item.ImagePngBase64)
        // Asset migration belongs to the queued write. A storage failure must reject
        // this read, rather than treat valid data as corrupt and load an older .bak.
        if (!needsImageMigration && equalValue(raw, parsed)) {
          if (index === 0) return parsed
          if (!workspaceMigration) {
            const migration = writeState(parsed, false).then(() => parsed)
            workspaceMigration = migration
            void migration.then(() => { if (workspaceMigration === migration) workspaceMigration = null }, () => { if (workspaceMigration === migration) workspaceMigration = null })
          }
          return workspaceMigration
        }
        if (!workspaceMigration) {
          const migration = writeState(parsed, index === 0).then(() => parsed)
          workspaceMigration = migration
          void migration.then(() => { if (workspaceMigration === migration) workspaceMigration = null }, () => { if (workspaceMigration === migration) workspaceMigration = null })
        }
        return workspaceMigration
      }
    } catch (error) {
      if (error instanceof Error && error.message === '工作区版本较新，请使用新版应用打开') throw error
      // A sharing/permission/I/O failure says nothing about file integrity.
      // Only malformed JSON or a missing file may fall back to the recovery copy.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') foundExisting = true
    }
  }
  if (foundExisting) throw new Error('工作区与备份均无法完整读取，已保留原文件，请从备份恢复')
  if (defaultStateInitialization) return defaultStateInitialization
  if (workspaceSeen) {
    // Another initial read may have crossed the atomic rename while awaiting I/O.
    if (existsSync(dataPath())) return readState()
    throw new Error('工作区文件已丢失，未创建空白数据，请从备份恢复')
  }
  if (!defaultStateInitialization) {
    defaultStateInitialization = (async () => {
      const state = defaultState()
      await writeState(state)
      return state
    })()
    void defaultStateInitialization.then(() => { defaultStateInitialization = null }, () => { defaultStateInitialization = null })
  }
  return defaultStateInitialization
}

async function writeState(state: WorkspaceState, backupCurrent = true) {
  const operation = async () => {
    const normalized = normalizeState(state)
    if (!normalized || !isCompleteWorkspace(normalized)) throw new Error('工作区数据结构无效')
    await clipboardAssets.externalize(normalized)
    ;(normalized as WorkspaceState & { OrganizerUndoStack?: OrganizerUndoAction[] }).OrganizerUndoStack = organizerUndoStack.slice(-100)
    const directory = dataDirectory()
    await fs.mkdir(directory, { recursive: true })
    const temporary = `${dataPath()}.electron-tmp-${process.pid}-${crypto.randomUUID()}`
    const temporaryBackup = `${temporary}.bak`
    try {
      await fs.writeFile(temporary, JSON.stringify(normalized, null, 2), { encoding: 'utf8', flag: 'wx' })
      JSON.parse(await fs.readFile(temporary, 'utf8'))
      if (existsSync(dataPath()) && backupCurrent) {
        await fs.copyFile(dataPath(), temporaryBackup)
        await fs.rename(temporaryBackup, backupPath())
      }
      await fs.rename(temporary, dataPath())
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      await fs.rm(temporaryBackup, { force: true }).catch(() => undefined)
    }
    state.ClipboardHistory = normalized.ClipboardHistory
    state.SchemaVersion = normalized.SchemaVersion
    workspaceSeen = true
    return dataPath()
  }
  const next = workspaceWriteQueue.then(operation, operation)
  workspaceWriteQueue = next.catch(() => '')
  return next
}

function enqueueWorkspaceOperation<T>(operation: () => Promise<T>) {
  const next = workspaceMutationQueue.then(operation, operation)
  workspaceMutationQueue = next.then(() => undefined, () => undefined)
  return next
}

async function updateState(mutator: (latest: WorkspaceState) => WorkspaceState | void | Promise<WorkspaceState | void>) {
  return enqueueWorkspaceOperation(async () => {
    const latest = await readState()
    const changed = await mutator(latest)
    const state = changed ?? latest
    const output = await writeState(state)
    return { state, path: output }
  })
}

function desktopDirectory() { return process.env.DUSTDESK_TEST_DESKTOP_DIR ? path.resolve(process.env.DUSTDESK_TEST_DESKTOP_DIR) : app.getPath('desktop') }
function validWidgetKey(value: unknown): value is string {
  return typeof value === 'string' && (supportedWidgetKeys.has(value) || /^(?:note|project):[0-9a-f-]{36}$/i.test(value) || /^organizer-group:[0-9a-f-]{36}(,[0-9a-f-]{36})*$/i.test(value))
}
function widgetLimits(key: string) {
  return { minWidth: key === 'search' ? 52 : 300, minHeight: key === 'search' ? 52 : 120, maxWidth: 1200, maxHeight: 900 }
}
function widgetContentExists(key: string, state: WorkspaceState) {
  if (key.startsWith('note:')) return state.Notes.some(note => key === `note:${note.Id}`)
  if (key.startsWith('project:')) return state.Projects.some(project => key === `project:${project.Id}`)
  if (key.startsWith('organizer-group:')) return key.slice(16).split(',').some(id => state.DesktopCategories.some(category => category.Id === id))
  return supportedWidgetKeys.has(key)
}
function reconcileWidgetVisibility(state: WorkspaceState) {
  for (const [key, window] of widgetWindows) {
    if (window.isDestroyed()) continue
    const visible = state.Settings.WidgetPlacements?.[key]?.Visible === true && widgetContentExists(key, state)
    if (visible !== window.isVisible()) {
      visible ? window.show() : window.hide()
      broadcastWidgetVisibility(key, visible)
    }
  }
  for (const [key, placement] of Object.entries(state.Settings.WidgetPlacements ?? {})) {
    if (!validWidgetKey(key) || placement.Visible !== true || !widgetContentExists(key, state) || widgetWindows.has(key)) continue
    createWidgetWindow(key, state).show()
    broadcastWidgetVisibility(key, true)
  }
  widgetsVisible = [...widgetWindows.values()].some(window => !window.isDestroyed() && window.isVisible())
}
function widgetSnappingEnabled(key: string, state: WorkspaceState) {
  return state.Settings.WidgetPlacements?.[key]?.SnapToEdges ?? (key === 'launcher' && state.Settings.LauncherWidgetSnapToEdges === true)
}
function widgetSnappedBounds(key: string, bounds: { x: number; y: number; width: number; height: number }, enabled = widgetSnapModes.get(key) === true) {
  if (!enabled) return { ...bounds, dockEdge: 'None' as const }
  const display = screen.getDisplayNearestPoint({ x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) })
  return snapWidgetBounds(bounds, display.workArea, true)
}
function suppressWidgetPlacementSave(key: string) {
  widgetPlacementSyncing.add(key)
  setTimeout(() => widgetPlacementSyncing.delete(key), 250)
}
function restoredWidgetBounds(key: string, placement: WidgetPlacement | undefined, fallback: { x: number; y: number; width: number; height: number }) {
  const limits = widgetLimits(key)
  const width = Math.max(limits.minWidth, Math.min(limits.maxWidth, Math.round(Number.isFinite(placement?.Width) ? placement!.Width! : fallback.width)))
  const height = Math.max(limits.minHeight, Math.min(limits.maxHeight, Math.round(Number.isFinite(placement?.Height) ? placement!.Height! : fallback.height)))
  const requestedX = Number.isFinite(placement?.X) ? placement!.X! : fallback.x
  const requestedY = Number.isFinite(placement?.Y) ? placement!.Y! : fallback.y
  const displays = screen.getAllDisplays()
  if (!displays.length) return { x: requestedX, y: requestedY, width, height }
  const display = displays.find(item => {
    const point = { x: requestedX + Math.round(width / 2), y: requestedY + Math.round(height / 2) }
    return point.x >= item.workArea.x && point.x < item.workArea.x + item.workArea.width && point.y >= item.workArea.y && point.y < item.workArea.y + item.workArea.height
  }) ?? screen.getDisplayNearestPoint({ x: requestedX, y: requestedY })
  const area = display.workArea
  const minX = area.x - width + 80
  const maxX = area.x + area.width - 80
  const minY = area.y
  const maxY = area.y + area.height - 34
  return { x: Math.round(Math.max(minX, Math.min(maxX, requestedX))), y: Math.round(Math.max(minY, Math.min(maxY, requestedY))), width, height }
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
async function isRealPathWithinDirectory(root: string, target: string) {
  try {
    await assertPathWithinRoot(dataDirectory(), root)
    await assertPathWithinRoot(root, target)
    return true
  } catch { return false }
}

function uniqueFilePath(directory: string, prefix: string, extension: string) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(directory, `${prefix}-${stamp}-${crypto.randomUUID()}.${extension}`)
}

async function moveWithVerification(source: string, target: string) {
  if (!pathExists(source)) throw new Error('源文件或文件夹不存在')
  if (pathExists(target)) throw new Error('目标位置已存在同名项目')
  for (const [value, allowMissing] of [[source, false], [target, true]] as const) {
    const root = isWithinDirectory(dataDirectory(), value) ? dataDirectory() : desktopDirectory()
    if (path.resolve(root).toLowerCase() === path.resolve(value).toLowerCase()) throw new Error('不允许移动根目录')
    await assertPathWithinRoot(root, value, allowMissing)
  }
  return moveFileSafely(source, target)
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
  let text = value === null || value === undefined ? '' : String(value)
  if (/^[=+\-@]/.test(text)) text = `'${text}`
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
  const now = new Date()
  const initial = await readState()
  const dueIds = new Set(initial.Todos.filter(todo => { if (todo.IsCompleted || !todo.ReminderAt || todo.ReminderNotifiedAt) return false; const reminder = new Date(todo.ReminderAt); return !Number.isNaN(reminder.getTime()) && reminder <= now }).map(todo => todo.Id))
  if (!dueIds.size) return
  const notifications: string[] = []
  const { state } = await updateState(state => {
    for (const todo of state.Todos) {
      if (!dueIds.has(todo.Id) || todo.IsCompleted || !todo.ReminderAt || todo.ReminderNotifiedAt) continue
      const reminder = new Date(todo.ReminderAt)
      if (Number.isNaN(reminder.getTime()) || reminder > now) continue
      notifications.push(todo.Title || '有一项任务到期')
      if (todo.ReminderRepeat === 'None') todo.ReminderNotifiedAt = now.toISOString()
      else {
        let next = reminder
        do { next = todo.ReminderRepeat === 'Daily' ? new Date(next.getTime() + 86400000) : todo.ReminderRepeat === 'Weekly' ? new Date(next.getTime() + 7 * 86400000) : nextWeekday(next) } while (next <= now)
        todo.ReminderAt = next.toISOString(); todo.ReminderNotifiedAt = null
      }
    }
  })
  for (const body of notifications) if (Notification.isSupported()) { const notification = new Notification({ title: 'DustDesk 任务提醒', body }); notification.on('click', showWindow); notification.show() }
  broadcastWorkspaceChanged(state)
}

async function captureRegionScreenshot() {
  const displays = screen.getAllDisplays()
  if (!displays.length) throw new Error('没有找到可截图的屏幕，请重试')
  return new Promise<string | null>((resolve, reject) => {
    activeOverlayResolve = resolve
    const abort = (error: unknown) => {
      if (activeOverlayResolve !== resolve) return
      activeOverlayResolve = null
      for (const window of overlayWindows) if (!window.isDestroyed()) window.destroy()
      overlayWindows.clear()
      reject(error)
    }
    try {
      for (const display of displays) {
        const window = new BrowserWindow({ x: display.bounds.x, y: display.bounds.y, width: display.bounds.width, height: display.bounds.height, frame: false, transparent: true, backgroundColor: '#00000000', fullscreenable: false, resizable: false, movable: false, skipTaskbar: true, alwaysOnTop: true, show: false, webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
        // Windows excludes this overlay from screen capture while its selection
        // and tools stay visible and keep pointer capture throughout the stroke.
        window.setContentProtection(true)
        overlayWindows.add(window)
        screenshotRegionDisplays.set(window, display)
        window.on('closed', () => {
          overlayWindows.delete(window)
          screenshotRegionDisplays.delete(window); screenshotRegionMetadata.delete(window)
          screenshotRegionRequests.get(window)?.abort(); screenshotRegionRequests.delete(window)
          const documentId = screenshotOverlayDocuments.get(window); screenshotOverlayDocuments.delete(window)
          if (documentId) screenshotSessions.remove(documentId)
          if (!overlayWindows.size && activeOverlayResolve === resolve) { activeOverlayResolve = null; resolve(null) }
        })
        window.webContents.once('did-finish-load', () => {
          if (!window.isDestroyed() && activeOverlayResolve === resolve) { window.show(); if (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id === display.id) window.focus() }
        })
        window.webContents.once('render-process-gone', () => abort(new Error('截图选区窗口意外退出，请重试')))
        const physical = screen.dipToScreenRect(window, display.bounds)
        const query = { overlay: '1', region: '1', regionWidth: String(physical.width), regionHeight: String(physical.height), regionDipWidth: String(display.bounds.width), regionDipHeight: String(display.bounds.height) }
        const rendererUrl = process.env.ELECTRON_RENDERER_URL
        const loading = rendererUrl ? window.loadURL(`${rendererUrl}?${new URLSearchParams(query)}`) : window.loadFile(path.join(__dirname, '../renderer/index.html'), { query })
        void loading.catch(abort)
      }
    } catch (error) { abort(error) }
  })
}

function screenCaptureBytes(image: Electron.NativeImage, display: Electron.Display) {
  const width = Math.round(display.size.width * display.scaleFactor), height = Math.round(display.size.height * display.scaleFactor)
  const size = image.getSize()
  // Normalize each display independently before mapping DIP to native pixels.
  return new Uint8Array((size.width === width && size.height === height ? image : image.resize({ width, height, quality: 'best' })).toPNG())
}

function showWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show(); mainWindow.focus()
}
function closePinnedWindows() {
  for (const window of pinnedWindows) if (!window.isDestroyed()) window.destroy()
}

const productivity = createProductivityRuntime({ read: readState, update: updateState, enqueue: enqueueWorkspaceOperation, broadcast: broadcastWorkspaceChanged, directory: dataDirectory })
const noteBackgrounds = createNoteBackgroundManager({ read: readState, write: writeState, enqueue: enqueueWorkspaceOperation, broadcast: broadcastWorkspaceChanged, directory: dataDirectory })

function showQuickCapture() {
  if (captureWindow && !captureWindow.isDestroyed()) { captureWindow.show(); captureWindow.focus(); return }
  captureWindow = new BrowserWindow({
    width: 520, height: 430, minWidth: 380, minHeight: 360, show: false, alwaysOnTop: true, autoHideMenuBar: true,
    title: '快速记录', backgroundColor: '#f3f7f6',
    webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  captureWindow.on('close', event => { if (!isQuitting) { event.preventDefault(); captureWindow?.hide() } })
  captureWindow.once('ready-to-show', () => { captureWindow?.show(); captureWindow?.focus() })
  if (process.env.ELECTRON_RENDERER_URL) void captureWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}?capture=1`)
  else void captureWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { capture: '1' } })
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
  mainWindow.once('ready-to-show', () => undefined)
}

function applyWidgetPlacement(key: string, window: BrowserWindow, state: WorkspaceState) {
  widgetSnapModes.set(key, widgetSnappingEnabled(key, state))
  const placement = state.Settings.WidgetPlacements?.[key]
  const { minWidth, minHeight } = widgetLimits(key)
  const bounds = restoredWidgetBounds(key, placement, window.getBounds())
  if (placement?.Locked) lockedWidgets.add(key)
  else lockedWidgets.delete(key)
  suppressWidgetPlacementSave(key)
  window.setMinimumSize(minWidth, placement?.IsCollapsed ? 34 : minHeight)
  window.setBounds({ ...bounds, height: placement?.IsCollapsed ? 34 : bounds.height })
  if (placement?.IsCollapsed) expandedWidgetHeights.set(key, bounds.height)
  else expandedWidgetHeights.delete(key)
  window.setResizable(key !== 'search' && !placement?.Locked)
  window.setMovable(!placement?.Locked)
  window.setAlwaysOnTop(placement?.TopMost === true, 'floating')
  applyWidgetAppearance(window, state, placement)
}

function createWidgetWindow(key = 'todo', initialState?: WorkspaceState) {
  const existing = widgetWindows.get(key)
  if (existing && !existing.isDestroyed()) return existing
  const dimensions = key === 'search' ? { width: 520, height: 52 } : key === 'countdown' ? { width: 540, height: 254 } : key === 'launcher' ? { width: 390, height: 320 } : key === 'links' ? { width: 360, height: 320 } : key === 'monitor' ? { width: 420, height: 260 } : { width: 390, height: 320 }
  const widgetWindow = new BrowserWindow({ ...dimensions, minWidth: key === 'search' ? 52 : 300, minHeight: key === 'search' ? 52 : 34, frame: false, transparent: true, resizable: true, skipTaskbar: true, show: false, backgroundColor: '#00000000', webPreferences: { preload: path.join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  if (key === 'search') widgetWindow.setResizable(false)
  widgetWindows.set(key, widgetWindow)
  let snapping = false
  let restoring = true
  let moveSaveTimer: NodeJS.Timeout | null = null
  const savePlacement = async () => {
    if (widgetWindow.isDestroyed() || widgetPlacementSyncing.has(key) || widgetMovePreviews.has(key)) return
    const { x, y, width, height, dockEdge } = widgetSnappedBounds(key, widgetWindow.getBounds())
    const previousBounds = widgetWindow.getBounds()
    if (previousBounds.x !== x || previousBounds.y !== y) {
      snapping = true
      try { widgetWindow.setPosition(x, y) } finally { snapping = false }
    }
    const { state } = await updateState(state => {
      const previous = state.Settings.WidgetPlacements?.[key] ?? {}
      state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...previous, X: x, Y: y, Width: width, Height: previous.IsCollapsed ? previous.Height ?? expandedWidgetHeights.get(key) ?? 220 : height, Visible: previous.Visible !== false, DockEdge: dockEdge } }
    })
    broadcastWorkspaceChanged(state)
  }
  const onMove = () => {
    if (restoring || snapping || widgetPlacementSyncing.has(key) || widgetMovePreviews.has(key)) return
    if (moveSaveTimer) clearTimeout(moveSaveTimer)
    moveSaveTimer = setTimeout(() => { moveSaveTimer = null; void savePlacement() }, 150)
  }
  widgetWindow.on('move', onMove)
  widgetWindow.on('moved', onMove)
  widgetWindow.on('resized', () => { if (!restoring && !widgetResizePreviews.has(key) && !widgetPlacementSyncing.has(key)) void savePlacement() })
  widgetWindow.on('closed', () => {
    restoring = false; widgetResizePreviews.delete(key); widgetPlacementSyncing.delete(key); widgetMovePreviews.delete(key); widgetSnapModes.delete(key); widgetDragVersions.delete(key)
    if (moveSaveTimer) clearTimeout(moveSaveTimer)
    widgetWindows.delete(key)
    widgetsVisible = [...widgetWindows.values()].some(item => !item.isDestroyed() && item.isVisible())
    if (isQuitting) return
    broadcastWidgetVisibility(key, false)
    void updateState(state => {
      if (widgetWindows.has(key)) return
      const current = state.Settings.WidgetPlacements?.[key]
      if (current) state.Settings.WidgetPlacements = { ...state.Settings.WidgetPlacements, [key]: { ...current, Visible: false } }
    }).then(({ state }) => broadcastWorkspaceChanged(state)).catch(error => console.error('Unable to save closed widget:', error))
  })
  const restore = (state: WorkspaceState) => {
    if (widgetWindow.isDestroyed()) return
    applyWidgetPlacement(key, widgetWindow, state)
    widgetWindow.webContents.once('did-finish-load', () => {
      void readState().then(latest => applyWidgetAppearance(widgetWindow, latest, latest.Settings.WidgetPlacements?.[key]))
    })
    restoring = false
  }
  if (initialState) restore(initialState)
  else void readState().then(restore).catch(() => { restoring = false })
  const rendererUrl = process.env.ELECTRON_RENDERER_URL
  if (rendererUrl) void widgetWindow.loadURL(`${rendererUrl}?widget=${encodeURIComponent(key)}`)
  else void widgetWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { widget: key } })
  return widgetWindow
}

async function setWidgetVisibility(key: string, desired?: boolean) {
  return enqueueWorkspaceOperation(async () => {
    const state = await readState()
    if (!validWidgetKey(key) || (desired !== false && !widgetContentExists(key, state))) throw new Error('小组件对应的项目、便签或分类已不存在')
    const window = widgetWindows.get(key)
    const visible = desired ?? !(window && !window.isDestroyed() && window.isVisible())
    const current = state.Settings.WidgetPlacements?.[key] ?? {}
    state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...current, Visible: visible } }
    // Save before changing native windows, so write failures cannot leave a false pin state.
    await writeState(state)
    broadcastWorkspaceChanged(state)
    mainWindow?.webContents.send('widgets:toggle', widgetsVisible)
    broadcastWidgetVisibility(key, visible)
    return { visible }
  })
}
const toggleWidgetWindow = (key = 'todo') => setWidgetVisibility(key)

async function toggleConfiguredWidgets() {
  const state = await readState()
  const keys = [...new Set((state.Settings.DesktopHotKeyWidgetKeys ?? []).filter(validWidgetKey))]
  const targets = keys.length ? keys : ['todo']
  const visibility = targets.map(key => { const window = widgetWindows.get(key); return Boolean(window && !window.isDestroyed() && window.isVisible()) })
  const shouldShow = !visibility.some(Boolean)
  for (const key of targets) {
    if (shouldShow && !widgetContentExists(key, state)) continue
    await setWidgetVisibility(key, shouldShow)
  }
}

function restoreVisibleWidgets(state: WorkspaceState) {
  for (const [key, window] of widgetWindows) {
    if (window.isDestroyed()) continue
    applyWidgetPlacement(key, window, state)
    if (state.Settings.WidgetPlacements?.[key]?.Visible !== true) window.hide()
  }
  for (const [key, placement] of Object.entries(state.Settings.WidgetPlacements ?? {})) {
    if (!validWidgetKey(key) || placement?.Visible !== true || !widgetContentExists(key, state)) continue
    const window = createWidgetWindow(key, state)
    if (!window.isVisible()) window.show()
  }
  widgetsVisible = [...widgetWindows.values()].some(item => !item.isDestroyed() && item.isVisible())
  for (const [key, window] of widgetWindows) broadcastWidgetVisibility(key, !window.isDestroyed() && window.isVisible())
}

function registerHotkeys(settings: WorkspaceState['Settings']) {
  globalShortcut.unregisterAll()
  const entries: [string, () => void][] = [
    [settings.MainWindowHotKey, showWindow],
    [settings.QuickCaptureHotKey, showQuickCapture],
    [settings.DesktopWidgetsHotKey, toggleConfiguredWidgets],
    [settings.ScreenshotHotKey, () => { void captureScreenshot('Region') }],
    [settings.PinScreenshotHotKey, () => { void pinClipboardScreenshot().catch(error => tray?.displayBalloon?.({ title: '贴图失败', content: String(error) })) }]
  ]
  let registered = true
  for (const [accelerator, handler] of entries) { if (typeof accelerator === 'string' && accelerator.trim()) { try { registered = globalShortcut.register(accelerator, handler) && registered } catch { registered = false } } }
  return registered
}

function createTray() {
  const iconPath = path.resolve(__dirname, '../../Assets/DustDesk.ico')
  tray = new Tray(existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty())
  tray.setToolTip('DustDesk')
  tray.setContextMenu(Menu.buildFromTemplate([
     { label: '显示 DustDesk', click: showWindow },
     { label: '快速记录', click: showQuickCapture },
     { label: '显示/隐藏桌面小组件', click: toggleConfiguredWidgets },
     { label: '显示/隐藏所有贴图', click: () => { const hide = [...pinnedWindows].some(window => !window.isDestroyed() && window.isVisible()); for (const window of pinnedWindows) if (!window.isDestroyed()) hide ? window.hide() : window.showInactive() } },
     { label: '恢复所有贴图的鼠标操作', click: () => { for (const pin of pinnedScreenshots.values()) { pin.mouseThrough = false; pin.locked = false; pin.window.setIgnoreMouseEvents(false); pin.window.show(); pin.window.webContents.send('screenshot:pin:changed') } } },
     { label: '关闭所有桌面贴图', click: closePinnedWindows },
    { label: '检查更新', click: async () => { const result = await releaseUpdates.check(); if (!result.available) await dialog.showMessageBox({ type: result.ok ? 'info' : 'error', title: '检查更新', message: result.ok ? result.message || '当前已是最新版本' : result.error || '检查更新失败' }) } },
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
        { label: '关于 DustDesk', click: () => { void dialog.showMessageBox({ type: 'info', title: '关于 DustDesk', message: 'DustDesk', detail: `本地桌面工作台\n版本 ${app.getVersion()} · Electron\n${repository.url}` }) } },
        { label: '项目主页', click: () => { void shell.openExternal(repository.url) } },
        { label: '问题反馈', click: () => { void shell.openExternal(repository.issues) } }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function startClipboardMonitor() {
  const sample = createClipboardSampler(maxImageBytes)
  clipboardTimer = setInterval(() => {
    if (!clipboardMonitoringEnabled || !mainWindow || mainWindow.isDestroyed()) return
    let sampled: ReturnType<typeof sample>
    try { sampled = sample(clipboard.readText(), clipboard.readImage()) }
    catch { return }
    if (!sampled) return
    const { text, imagePngBase64, fingerprint } = sampled
    if (fingerprint === lastClipboardFingerprint) return
    lastClipboardFingerprint = fingerprint
    mainWindow.webContents.send('clipboard:changed', {
      Id: crypto.randomUUID(), Kind: imagePngBase64 ? 'Image' : 'Text', Text: text, ImagePngBase64: imagePngBase64,
      ImageFileName: imagePngBase64 ? `Clipboard-${new Date().toISOString().replace(/[:.]/g, '-')}.png` : '', ImageSha256: fingerprint,
      CreatedAt: new Date().toISOString(), IsLocked: false, IsPinned: false
    })
  }, 900)
}

async function captureScreenshot(mode: 'Region' | 'Window' | 'FullScreen', sourceId?: string) {
  if (screenshotCaptureInFlight || overlayWindows.size) return { ok: false, message: 'screenshot-in-progress' }
  screenshotCaptureInFlight = true
  try {
    if (!['Region', 'Window', 'FullScreen'].includes(mode)) throw new Error('截图模式无效')
    if (mode === 'Window' && (typeof sourceId !== 'string' || !sourceId.startsWith('window:') || sourceId.length > 256)) return { ok: false, message: 'select-capture-window' }
    return await captureScreenshotInternal(mode, sourceId)
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '截图失败，请重试' }
  } finally {
    screenshotCaptureInFlight = false
  }
}

async function captureScreenshotInternal(mode: 'Region' | 'Window' | 'FullScreen', sourceId?: string) {
  const settings = (await readState()).Settings
  if (settings.ScreenshotDelaySeconds > 0) await new Promise(resolve => setTimeout(resolve, Math.min(10, settings.ScreenshotDelaySeconds) * 1000))
  if (mode === 'Region') {
    const result = await captureRegionScreenshot()
    if (!result) return { ok: false, message: 'region-capture-canceled' }
    if (result === 'completed') return { ok: true, message: '截图处理完成' }
    const payload = screenshotSessions.create(new Uint8Array(decodeScreenshotImage(result).toPNG()))
    screenshotSessions.retainEditor(payload.document.id)
    mainWindow?.webContents.send('screenshot:document', payload); showWindow()
    return { ok: true, message: '截图已打开' }
  }
  const { desktopCapturer } = await import('electron')
  const displays = screen.getAllDisplays()
  const targetDisplay = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const sources = await desktopCapturer.getSources({ types: [mode === 'Window' ? 'window' : 'screen'], thumbnailSize: { width: Math.max(...displays.map(display => Math.round(display.size.width * display.scaleFactor))), height: Math.max(...displays.map(display => Math.round(display.size.height * display.scaleFactor))) } })
  const source = mode === 'Window' ? sources.find(item => item.id === sourceId) : sources.find(item => String(item.display_id) === String(targetDisplay.id))
  if (mode === 'Window' && !source) return { ok: false, message: 'capture-window-unavailable' }
  if (!source || source.thumbnail.isEmpty()) return { ok: false, message: 'no-capture-source' }
  const payload = screenshotSessions.create(mode === 'FullScreen' ? screenCaptureBytes(source.thumbnail, targetDisplay) : new Uint8Array(source.thumbnail.toPNG()))
  if (settings.ScreenshotAfterAction === 'copy' || settings.ScreenshotAfterAction === 'pin') {
    const result = await screenshotSessions.finish({ requestId: crypto.randomUUID(), document: payload.document, png: payload.png, action: settings.ScreenshotAfterAction })
    return { ...result, message: result.ok ? '截图处理完成' : result.error }
  }
  await showScreenshotOverlay(payload, targetDisplay.bounds)
  return { ok: true, message: '截图已打开' }
}

async function showScreenshotOverlay(payload: ScreenshotPayload, bounds: Electron.Rectangle) {
  const window = new BrowserWindow({ ...bounds, frame: false, show: false, resizable: false, skipTaskbar: true, alwaysOnTop: true, webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  overlayWindows.add(window); screenshotOverlayDocuments.set(window, payload.document.id)
  window.on('closed', () => { overlayWindows.delete(window); const id = screenshotOverlayDocuments.get(window); screenshotOverlayDocuments.delete(window); if (id) screenshotSessions.remove(id) })
  window.webContents.once('did-finish-load', () => { if (!window.isDestroyed()) { window.webContents.send('screenshot:document', payload); window.show(); window.focus() } })
  try {
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?overlay=1&selected=1`)
    else await window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { overlay: '1', selected: '1' } })
  } catch (error) { window.destroy(); throw error }
}

async function saveScreenshotBytes(png: Uint8Array, saveAs = false, format?: 'png' | 'jpg', jpeg?: Uint8Array) {
  const settings = (await readState()).Settings
  const extension = format || (settings.ScreenshotFormat === 'jpg' || settings.ScreenshotFormat === 'jpeg' ? 'jpg' : 'png')
  const directory = path.resolve(settings.ScreenshotSaveDirectory?.trim() || path.join(dataDirectory(), 'Screenshots'))
  let output = uniqueFilePath(directory, 'DustDesk-edited', extension)
  if (saveAs) {
    const result = await dialog.showSaveDialog({ title: '另存为截图', defaultPath: output, filters: [{ name: 'PNG 图片', extensions: ['png'] }, { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] }] })
    if (result.canceled || !result.filePath) return { ok: false, canceled: true }
    output = result.filePath
  }
  await fs.mkdir(path.dirname(output), { recursive: true })
  const image = nativeImage.createFromBuffer(Buffer.from(png))
  let bytes: Buffer = Buffer.from(png)
  if (/\.jpe?g$/i.test(output)) {
    if (jpeg) {
      if (jpeg.length > 32 * 1024 * 1024 || jpeg[0] !== 255 || jpeg[1] !== 216) throw Error('JPEG 导出数据无效')
      const converted = nativeImage.createFromBuffer(Buffer.from(jpeg)), size = converted.getSize(), original = image.getSize()
      if (converted.isEmpty() || size.width !== original.width || size.height !== original.height) throw Error('JPEG 导出尺寸不一致')
      bytes = Buffer.from(jpeg)
    } else bytes = image.toJPEG(92)
  }
  const temporary = `${output}.${crypto.randomUUID()}.tmp`
  try { await fs.writeFile(temporary, bytes); await fs.rename(temporary, output) }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => {}); throw error }
  return { ok: true, path: output }
}

async function completeScreenshotOutput(request: ScreenshotFinishRequest, png: Uint8Array) {
  if (request.action === 'openEditor') {
    const payload = screenshotSessions.read(request.document.id)
    const document = request.document.sourceRect ? screenshotSessions.snapshot(request.document) : request.document
    screenshotSessions.retainEditor(document.id)
    mainWindow?.webContents.send('screenshot:document', { ...payload, document }); showWindow()
    return { ok: true }
  }
  const settings = (await readState()).Settings
  let result: { ok: boolean; path?: string; canceled?: boolean; pinId?: string; warning?: string } = { ok: true }
  if (request.action === 'save' || request.action === 'saveAs') result = await saveScreenshotBytes(png, request.action === 'saveAs', request.format, request.jpeg)
  if (!result.ok) return result
  if (request.action === 'pin') result = await createPinnedScreenshot(request.document, png)
  if (request.action === 'updatePin') {
    const pinId = request.document.targetPinId; const pin = pinId && pinnedScreenshots.get(pinId)
    if (!pin || !pinId) throw Error('原贴图已关闭，请选择另存为或创建新贴图')
    const previousId = pin.documentId
    pin.png = new Uint8Array(png); pin.version++; pin.documentId = request.document.id; screenshotSessions.retainPin(pinId, request.document.id)
    if (previousId !== request.document.id) screenshotSessions.remove(previousId)
    pin.originalWidth = request.document.crop.width; pin.originalHeight = request.document.crop.height
    pin.window.webContents.send('screenshot:pin:changed')
  }
  const image = nativeImage.createFromBuffer(Buffer.from(png))
  const fingerprint = createHash('sha256').update(Buffer.from(png)).digest('hex')
  if (request.action === 'copy' || settings.ScreenshotAutoCopy) try { clipboard.writeImage(image); lastClipboardFingerprint = createHash('sha256').update('').update(Buffer.from(png).toString('base64')).digest('hex') }
  catch (error) { if (request.action === 'copy') throw error; result.warning = '输出已完成，自动复制失败，可点击复制重试' }
  lastScreenshotDataUrl = image.toDataURL()
  if (settings.ScreenshotAutoAddToClipboardHistory) try {
    const { state } = await updateState(state => {
      if (state.ClipboardHistory.some(record => record.ImageSha256 === fingerprint)) return
      state.ClipboardHistory.unshift({ Id: crypto.randomUUID(), Kind: 'Image', Text: '', ImagePngBase64: Buffer.from(png).toString('base64'), ImageFileName: path.basename(result.path || 'Screenshot.png'), ImageSha256: fingerprint, CreatedAt: new Date().toISOString(), IsLocked: false, IsPinned: false })
      state.ClipboardHistory = state.ClipboardHistory.filter((record, index) => index < 200 || record.IsLocked || record.IsPinned)
    })
    broadcastWorkspaceChanged(state)
  } catch (error) { console.error('无法加入截图历史', error); result.warning = [result.warning, '输出已完成，加入剪贴板历史失败'].filter(Boolean).join('；') }
  return result
}

async function createPinnedScreenshot(document: ScreenshotDocument, png: Uint8Array) {
  const settings = (await readState()).Settings; const pinId = crypto.randomUUID()
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()), area = display.workArea
  const fit = Math.min(1 / (display.scaleFactor || 1), (area.width * .7) / document.crop.width, (area.height * .7) / document.crop.height)
  const window = new BrowserWindow({ width: Math.max(64, Math.round(document.crop.width * fit)), height: Math.max(48, Math.round(document.crop.height * fit)), minWidth: 32, minHeight: 32, show: false, frame: false, transparent: true, alwaysOnTop: settings.PinnedImageTopmost !== false, resizable: true, skipTaskbar: true, webPreferences: { preload: path.join(__dirname, '../preload/index.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
  // A pin keeps the exact document represented by its PNG, independent of later editor saves.
  document = screenshotSessions.snapshot(document)
  const pin: PinnedScreenshot = { window, png: new Uint8Array(png), version: 0, documentId: document.id, opacity: Math.max(20, Math.min(100, settings.PinnedImageOpacityPercent || 100)), topmost: settings.PinnedImageTopmost !== false, locked: false, mouseThrough: Boolean(settings.PinnedImageMouseThrough), originalWidth: document.crop.width, originalHeight: document.crop.height }
  pinnedScreenshots.set(pinId, pin); pinnedWindows.add(window); screenshotSessions.retainPin(pinId, document.id)
  window.setOpacity(pin.opacity / 100); window.setAlwaysOnTop(pin.topmost, 'floating'); window.setIgnoreMouseEvents(pin.mouseThrough, { forward: true })
  window.on('closed', () => { pinnedScreenshots.delete(pinId); pinnedWindows.delete(window); screenshotSessions.releasePin(pinId); screenshotSessions.remove(pin.documentId) })
  try {
    if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}?pin=${pinId}`)
    else await window.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { pin: pinId } })
    if (!window.isDestroyed()) window.show()
  } catch (error) { window.destroy(); throw error }
  return { ok: true, pinId }
}

async function pinClipboardScreenshot() {
  const image = clipboard.readImage()
  if (!image.isEmpty()) {
    const payload = screenshotSessions.create(new Uint8Array(image.toPNG()))
    return createPinnedScreenshot(payload.document, payload.png)
  }
  if (lastScreenshotDataUrl) return pinScreenshotData(lastScreenshotDataUrl)
  throw Error('剪贴板中没有图片，请先截图或复制一张图片')
}

async function controlPin(id: string, action: string, value: { opacity?: number; topmost?: boolean; locked?: boolean; mouseThrough?: boolean; x?: number; y?: number; width?: number; height?: number } = {}) {
  const pin = pinnedScreenshots.get(id)
  if (!pin || pin.window.isDestroyed()) throw Error('贴图已关闭')
  const window = pin.window
  if (action === 'close') window.close()
  else if (action === 'copy') clipboard.writeImage(nativeImage.createFromBuffer(Buffer.from(pin.png)))
  else if (action === 'save') window.webContents.send('screenshot:pin:save-request')
  else if (action === 'edit') {
    if (overlayWindows.size) throw Error('请先完成或取消当前截图')
    const payload = screenshotSessions.editPin(id)
    await showScreenshotOverlay(payload, screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds)
  } else if (action === 'options') {
    if (typeof value.opacity === 'number' && Number.isFinite(value.opacity)) { pin.opacity = Math.max(20, Math.min(100, value.opacity)); window.setOpacity(pin.opacity / 100) }
    if (typeof value.topmost === 'boolean') { pin.topmost = value.topmost; window.setAlwaysOnTop(pin.topmost, 'floating') }
    if (typeof value.locked === 'boolean') { pin.locked = value.locked; window.setResizable(!pin.locked) }
    if (typeof value.mouseThrough === 'boolean') { pin.mouseThrough = value.mouseThrough; window.setIgnoreMouseEvents(pin.mouseThrough, { forward: true }) }
    window.webContents.send('screenshot:pin:changed')
  } else if (action === 'move' && !pin.locked && Number.isFinite(value.x) && Number.isFinite(value.y)) {
    window.setPosition(Math.round(Math.max(-32768, Math.min(32768, value.x!))), Math.round(Math.max(-32768, Math.min(32768, value.y!))))
  } else if (action === 'resize' && !pin.locked && Number.isFinite(value.width) && Number.isFinite(value.height)) {
    const area = screen.getDisplayMatching(window.getBounds()).workArea
    const ratio = pin.originalWidth / pin.originalHeight
    const width = Math.max(32, Math.min(area.width * 2, area.height * 2 * ratio, value.width!))
    window.setSize(Math.round(width), Math.max(32, Math.round(width / ratio)))
  } else if (action === 'menu') {
    const run = (command: string, options?: typeof value) => { void controlPin(id, command, options).catch(error => { tray?.displayBalloon({ title: '贴图操作失败', content: error.message }) }) }
    Menu.buildFromTemplate([
      { label: '恢复原始比例', click: () => { const dpi = screen.getDisplayMatching(window.getBounds()).scaleFactor || 1; run('resize', { width: pin.originalWidth / dpi, height: pin.originalHeight / dpi }) } },
      { label: '复制', accelerator: 'CommandOrControl+C', click: () => run('copy') },
      { label: '保存…', accelerator: 'CommandOrControl+S', click: () => run('save') },
      { label: '重新编辑', click: () => run('edit') },
      { type: 'separator' },
      { label: '置顶', type: 'checkbox', checked: pin.topmost, click: () => run('options', { topmost: !pin.topmost }) },
      { label: '锁定位置', type: 'checkbox', checked: pin.locked, click: () => run('options', { locked: !pin.locked }) },
      { label: '鼠标穿透（从托盘恢复）', type: 'checkbox', checked: pin.mouseThrough, click: () => run('options', { mouseThrough: !pin.mouseThrough }) },
      { type: 'separator' },
      { label: '关闭贴图', click: () => run('close') }
    ]).popup({ window })
  }
  return { ok: true }
}

function decodeScreenshotImage(dataUrl: string) {
  if (typeof dataUrl !== 'string' || dataUrl.length > Math.ceil(maxImageBytes * 4 / 3) || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(dataUrl)) throw new Error('无效的图片数据')
  const image = nativeImage.createFromDataURL(dataUrl)
  if (image.isEmpty() || image.toPNG().length > maxImageBytes) throw new Error('截图图像无效或过大')
  return image
}

async function pinScreenshotData(dataUrl: string) {
  const payload = screenshotSessions.create(new Uint8Array(decodeScreenshotImage(dataUrl).toPNG()))
  return createPinnedScreenshot(payload.document, payload.png)
}

let metricsInFlight: Promise<SystemMetrics> | null = null
let recentMetrics: { expires: number; value: SystemMetrics } | null = null
function sampleSystemMetrics(): Promise<SystemMetrics> {
  if (recentMetrics && recentMetrics.expires > Date.now()) return Promise.resolve(recentMetrics.value)
  if (metricsInFlight) return metricsInFlight
  const operation = collectSystemMetrics().then(value => { recentMetrics = { expires: Date.now() + 2000, value }; return value })
  metricsInFlight = operation
  void operation.then(() => { metricsInFlight = null }, () => { metricsInFlight = null })
  return operation
}

async function listBackupEntries() {
  const directory = path.join(dataDirectory(), 'Backups')
  await assertPathWithinRoot(dataDirectory(), directory)
  const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(item => item.isFile() && item.name.toLowerCase().endsWith('.json'))
  const files = await Promise.all(entries.map(async item => {
    const filePath = path.join(directory, item.name)
    const info = await fs.stat(filePath)
    return { path: filePath, name: item.name, size: info.size, modifiedAt: info.mtime.toISOString() }
  }))
  return files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.name.localeCompare(a.name))
}

async function collectSystemMetrics(): Promise<SystemMetrics> {
  const fallbackTotal = os.totalmem()
  const [load, memory, disks, network, diskIo, latency, time] = await Promise.all([
    si.currentLoad().catch(() => null),
    si.mem().catch(() => null),
    si.fsSize().catch(() => []),
    si.networkStats().catch(() => []),
    process.platform === 'win32' ? sampleWindowsDiskThroughput() : si.fsStats().then(value => ({ read: byteRate(value?.rx_sec), write: byteRate(value?.wx_sec) })).catch(() => ({ read: null, write: null })),
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
    DiskReadBytesPerSecond: diskIo.read,
    DiskWriteBytesPerSecond: diskIo.write,
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
  ipcMain.handle('workspace:load', async event => {
    const state = await readState()
    if (!workspaceClientSnapshots.has(event.sender.id)) event.sender.once('destroyed', () => { workspaceClientSnapshots.delete(event.sender.id) })
    const snapshot = cloneWorkspace(state)
    workspaceClientSnapshots.set(event.sender.id, snapshot)
    return state
  })
  ipcMain.handle('workspace:save', async (_event, state: WorkspaceState, editingBaseline?: WorkspaceState) => {
    const event = _event
    if (!isCompleteWorkspace(state) || (editingBaseline !== undefined && !isCompleteWorkspace(editingBaseline))) throw new Error('工作区数据不完整，未保存')
    const baseline = editingBaseline ?? workspaceClientSnapshots.get(event.sender.id) ?? await readState()
    const result = await updateState(latest => collectDeleted(latest, mergeWorkspaceState(latest, state, baseline)))
    const merged = result.state
    clipboardMonitoringEnabled = merged.Settings.ClipboardMonitoringEnabled !== false
    const snapshot = cloneWorkspace(merged)
    workspaceClientSnapshots.set(event.sender.id, snapshot)
    for (const [key, window] of widgetWindows) applyWidgetAppearance(window, merged, merged.Settings.WidgetPlacements?.[key])
    broadcastWorkspaceChanged(merged)
    return { ok: true, path: result.path }
  })
  ipcMain.handle('data:location', () => dataDirectory())
  ipcMain.handle('notes:pick-background', async (_event, noteId: string, expectedPath?: string | null) => {
    const result = await dialog.showOpenDialog({ title: '选择便签背景图片', properties: ['openFile'], filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] })
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true }
    try { return await noteBackgrounds.importBackground(noteId, result.filePaths[0], expectedPath) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('notes:import-background', async (_event, noteId: string, source: string, expectedPath?: string | null) => {
    try { return await noteBackgrounds.importBackground(noteId, source, expectedPath) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('notes:clear-background', async (_event, noteId: string, expectedPath?: string | null) => {
    try { return await noteBackgrounds.clearBackground(noteId, expectedPath) }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('notes:read-image', async (_event, target: string) => {
    try {
      if (typeof target !== 'string' || target.length > 4096) throw new Error('图片路径无效')
      const resolved = path.resolve(target); const managed = path.resolve(path.join(dataDirectory(), 'NoteBackgrounds')); if (!resolved.toLowerCase().startsWith(`${managed.toLowerCase()}${path.sep}`)) throw new Error('只允许读取便签背景目录')
      if ((await fs.lstat(resolved)).isSymbolicLink()) throw new Error('不允许读取符号链接')
      await assertPathWithinRoot(dataDirectory(), resolved)
      const info = await fs.stat(resolved); if (info.size > maxImageBytes) throw new Error('图片过大'); const extension = path.extname(resolved).toLowerCase(); const mime = extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : extension === '.webp' ? 'image/webp' : extension === '.gif' ? 'image/gif' : extension === '.bmp' ? 'image/bmp' : 'image/png'; return { ok: true, dataUrl: `data:${mime};base64,${(await fs.readFile(resolved)).toString('base64')}` }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  productivity.register()
  ipcMain.handle('capture:show', showQuickCapture)
  ipcMain.handle('capture:hide', () => captureWindow?.hide())
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
  ipcMain.handle('widgets:visibility', (_event, keys: string[]) => {
    if (!Array.isArray(keys) || keys.length > 100) return {}
    return Object.fromEntries(keys.filter(validWidgetKey).map(key => { const window = widgetWindows.get(key); return [key, Boolean(window && !window.isDestroyed() && window.isVisible())] }))
  })
  ipcMain.handle('widgets:visibility:set', async (_event, key: string, visible: boolean) => {
    try {
      if (!validWidgetKey(key) || typeof visible !== 'boolean') throw new Error('小组件显示参数无效')
      return { ok: true, ...await setWidgetVisibility(key, visible) }
    } catch (error) {
      const window = widgetWindows.get(key)
      return { ok: false, visible: Boolean(window && !window.isDestroyed() && window.isVisible()), error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('widgets:move', async (_event, key: string, x: number, y: number, commit = false) => {
    if (!validWidgetKey(key) || !Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: '小组件位置无效' }
    const window = widgetWindows.get(key); if (!window || window.isDestroyed()) return { ok: false, error: '小组件窗口不可用' }
    if (lockedWidgets.has(key)) return { ok: false, error: '小组件已锁定位置' }
    const version = (widgetDragVersions.get(key) ?? 0) + 1
    widgetDragVersions.set(key, version)
    widgetMovePreviews.add(key)
    // Preview snapping stays in memory; never read/write the workspace per frame.
    const next = widgetSnappedBounds(key, { ...window.getBounds(), x: Math.round(x), y: Math.round(y) })
    window.setPosition(next.x, next.y)
    if (!commit) return { ok: true }
    try {
      const { state } = await updateState(state => { const latest = state.Settings.WidgetPlacements?.[key]; state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...(latest ?? {}), X: next.x, Y: next.y, DockEdge: next.dockEdge } } })
      broadcastWorkspaceChanged(state)
      return { ok: true }
    } finally {
      if (widgetDragVersions.get(key) === version) widgetMovePreviews.delete(key)
    }
  })
  ipcMain.handle('widgets:resize', async (_event, key: string, width: number, height: number, commit = false) => {
    if (!validWidgetKey(key) || !Number.isFinite(width) || !Number.isFinite(height)) return { ok: false, error: '小组件尺寸无效' }
    const window = widgetWindows.get(key); if (!window || window.isDestroyed()) return { ok: false, error: '小组件窗口不可用' }
    if (lockedWidgets.has(key)) return { ok: false, error: '小组件已锁定尺寸' }
    const minWidth = key === 'search' ? 52 : 300; const minHeight = key === 'search' ? 52 : 120
    const nextWidth = Math.max(minWidth, Math.min(1200, Math.round(width))); const nextHeight = Math.max(minHeight, Math.min(900, Math.round(height)))
    // Keep preview resizes in memory; disk reads and workspace broadcasts make pointer updates visibly lag.
    if (!commit) {
      widgetResizePreviews.add(key)
      window.setMinimumSize(minWidth, minHeight)
      window.setSize(nextWidth, nextHeight)
      return { ok: true }
    }
    const current = (await readState()).Settings.WidgetPlacements?.[key] as WidgetPlacement | undefined
    if (current?.Locked) return { ok: false, error: '小组件已锁定尺寸' }
    widgetResizePreviews.add(key)
    window.setMinimumSize(minWidth, minHeight)
    window.setSize(nextWidth, nextHeight)
    try {
      const { state } = await updateState(state => { const latest = state.Settings.WidgetPlacements?.[key] as WidgetPlacement | undefined; state.Settings.WidgetPlacements = { ...(state.Settings.WidgetPlacements ?? {}), [key]: { ...(latest ?? {}), Width: nextWidth, Height: nextHeight } } })
      broadcastWorkspaceChanged(state)
      return { ok: true }
    } finally { setTimeout(() => widgetResizePreviews.delete(key), 100) }
  })
  ipcMain.handle('widgets:hide', async (_event, key: string) => {
    if (!validWidgetKey(key)) return { ok: false, error: '小组件标识无效' }
    try { await setWidgetVisibility(key, false); return { ok: true } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('widgets:options', async (_event, key: string, options: { locked?: boolean; topMost?: boolean; transparentBackground?: boolean; autoCollapse?: boolean; collapsed?: boolean; snapToEdges?: boolean; height?: number }) => {
    if (!validWidgetKey(key) || !options || typeof options !== 'object') return { ok: false, error: '小组件参数无效' }
    const requestedHeight = key === 'search' && Number.isFinite(options.height) ? Math.max(52, Math.min(480, Math.round(Number(options.height)))) : undefined
    let placement: WidgetPlacement = {}
    const window = widgetWindows.get(key)
    const { state } = await updateState(latest => {
      const current = latest.Settings.WidgetPlacements?.[key]
      placement = { ...(current ?? {}), ...(options.locked === undefined ? {} : { Locked: Boolean(options.locked) }), ...(options.topMost === undefined ? {} : { TopMost: Boolean(options.topMost) }), ...(options.transparentBackground === undefined ? {} : { TransparentBackground: Boolean(options.transparentBackground) }), ...(options.autoCollapse === undefined ? {} : { AutoCollapseEnabled: Boolean(options.autoCollapse) }), ...(options.collapsed === undefined ? {} : { IsCollapsed: Boolean(options.collapsed) }), ...(options.snapToEdges === undefined ? {} : { SnapToEdges: Boolean(options.snapToEdges) }), ...(requestedHeight === undefined ? {} : { Height: requestedHeight }) }
      if (options.snapToEdges === false) placement.DockEdge = 'None'
      if (options.snapToEdges === true && window && !window.isDestroyed() && !placement.Locked) {
        const next = widgetSnappedBounds(key, window.getBounds(), true)
        placement = { ...placement, X: next.x, Y: next.y, DockEdge: next.dockEdge }
      }
      latest.Settings.WidgetPlacements = { ...(latest.Settings.WidgetPlacements ?? {}), [key]: placement }
    })
    if (window && !window.isDestroyed()) {
      widgetSnapModes.set(key, widgetSnappingEnabled(key, state))
      if (options.snapToEdges === true && !placement.Locked && placement.X !== undefined && placement.Y !== undefined) {
        suppressWidgetPlacementSave(key)
        window.setPosition(placement.X, placement.Y)
      }
      if (placement.Locked) lockedWidgets.add(key)
      else lockedWidgets.delete(key)
      if (options.locked !== undefined) { window.setResizable(key !== 'search' && !options.locked); window.setMovable(!options.locked) }
      if (options.topMost !== undefined) window.setAlwaysOnTop(Boolean(options.topMost), 'floating')
      if (options.collapsed !== undefined) {
        const { width, height } = window.getBounds()
        if (options.collapsed) { if (height > 34) expandedWidgetHeights.set(key, height); suppressWidgetPlacementSave(key); window.setMinimumSize(key === 'search' ? 52 : 300, 34); window.setSize(width, 34) }
        else { const restoreHeight = expandedWidgetHeights.get(key) ?? (Number((placement as Record<string, unknown>).Height) || 220); suppressWidgetPlacementSave(key); window.setMinimumSize(key === 'search' ? 52 : 300, key === 'search' ? 52 : 120); window.setSize(width, Math.max(key === 'search' ? 52 : 120, restoreHeight)); expandedWidgetHeights.delete(key) }
      }
      if (requestedHeight !== undefined && options.collapsed === undefined) window.setSize(window.getBounds().width, requestedHeight)
      applyWidgetAppearance(window, state, placement as WidgetPlacement)
    }
    broadcastWorkspaceChanged(state)
    return { ok: true }
  })
  ipcMain.handle('widgets:presets:list', async () => Object.keys((await readState()).Settings.WidgetLayoutPresets ?? {}).sort((a, b) => a.localeCompare(b, 'zh-CN')))
  ipcMain.handle('widgets:presets:save', async (_event, name: string) => {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) return { ok: false, error: '布局名称无效' }
    const { state } = await updateState(state => { state.Settings.WidgetLayoutPresets = { ...(state.Settings.WidgetLayoutPresets ?? {}), [name.trim()]: cloneWorkspace(state.Settings.WidgetPlacements ?? {}) } }); broadcastWorkspaceChanged(state); return { ok: true }
  })
  ipcMain.handle('widgets:presets:apply', async (_event, name: string) => {
    let found = false
    const { state } = await updateState(state => { const preset = state.Settings.WidgetLayoutPresets?.[name]; if (!preset) return; found = true; state.Settings.WidgetPlacements = cloneWorkspace(preset) })
    if (!found) return { ok: false, error: '布局不存在' }
    restoreVisibleWidgets(state)
    mainWindow?.webContents.send('widgets:toggle', widgetsVisible)
    broadcastWorkspaceChanged(state)
    return { ok: true }
  })
  ipcMain.handle('widgets:presets:delete', async (_event, name: string) => { let found = false; const { state } = await updateState(state => { if (!state.Settings.WidgetLayoutPresets?.[name]) return; found = true; delete state.Settings.WidgetLayoutPresets[name] }); if (!found) return { ok: false, error: '布局不存在' }; broadcastWorkspaceChanged(state); return { ok: true } })
  ipcMain.handle('path:open', async (_event, target: string) => { if (typeof target !== 'string' || target.length > 4096) return { ok: false, error: '路径无效' }; return { ok: !await shell.openPath(target) } })
  ipcMain.handle('path:icon', (_event, target: unknown) => {
    if (typeof target !== 'string' || target.length > 4096 || target.includes('\0') || !path.isAbsolute(target)) return {}
    return pathIcons.read(target)
  })
  ipcMain.handle('path:context-menu', async (event, target: string) => { try { if (typeof target !== 'string' || target.length > 4096) throw new Error('路径无效'); const sender = BrowserWindow.fromWebContents(event.sender); if (!sender) throw new Error('窗口不可用'); const menu = Menu.buildFromTemplate([{ label: '打开', click: () => { void shell.openPath(target) } }, { label: '在资源管理器中显示', click: () => shell.showItemInFolder(target) }, { label: '复制路径', click: () => clipboard.writeText(target) }]); menu.popup({ window: sender }); return { ok: true } } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } } })
  ipcMain.handle('url:open', async (_event, target: string) => { try { const value = target.trim(); if (!isHttpUrl(value)) throw new Error('只允许打开 HTTP/HTTPS 链接'); await shell.openExternal(value); return { ok: true } } catch (error) { return { ok: false, error: String(error) } } })
  ipcMain.handle('clipboard:read', () => ({ text: clipboard.readText(), imagePngBase64: clipboard.readImage().isEmpty() ? '' : clipboard.readImage().toPNG().toString('base64') }))
  ipcMain.handle('clipboard:write', async (_event, content: { text?: string; imagePngBase64?: string; recordId?: string }) => {
    if (content?.recordId !== undefined) {
      const item = (await readState()).ClipboardHistory.find(item => item.Id === content.recordId)
      if (!item) throw new Error('剪贴板记录已删除')
      content = item.Kind === 'Image' ? { imagePngBase64: await clipboardAssets.read(item) } : { text: item.Text }
    }
    if (!content || (content.text === undefined && !content.imagePngBase64)) throw new Error('剪贴板内容为空')
    if (content.text !== undefined && (typeof content.text !== 'string' || content.text.length > 5_000_000)) throw new Error('剪贴板文本过大')
    if (content.text !== undefined) clipboard.writeText(content.text)
    if (content.imagePngBase64) {
      if (typeof content.imagePngBase64 !== 'string' || content.imagePngBase64.length > Math.ceil(maxImageBytes * 4 / 3) || !/^[A-Za-z0-9+/]+={0,2}$/.test(content.imagePngBase64)) throw new Error('剪贴板图片无效或过大')
      const image = nativeImage.createFromBuffer(Buffer.from(content.imagePngBase64, 'base64'))
      if (image.isEmpty() || image.toPNG().length > maxImageBytes) throw new Error('剪贴板图片无效或过大')
      clipboard.writeImage(image)
    }
  })
  ipcMain.handle('screenshot:windows', async () => {
    try {
      const { desktopCapturer } = await import('electron')
      const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 320, height: 180 } })
      return { ok: true, sources: sources.filter(source => source.id.startsWith('window:') && !source.thumbnail.isEmpty()).map(source => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() })) }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '无法读取窗口列表，请重试' } }
  })
  ipcMain.handle('screenshot:start', async (_event, mode: 'Region' | 'Window' | 'FullScreen' = 'Region', sourceId?: string) => captureScreenshot(mode, sourceId))
  const ownsDocument = (event: Electron.IpcMainInvokeEvent, id: string) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    return Boolean(sender && (sender === mainWindow || screenshotOverlayDocuments.get(sender) === id))
  }
  ipcMain.handle('screenshot:document:create', (event, bytes: Uint8Array) => {
    try {
      if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) throw Error('只能在编辑页面导入图片')
      const payload = screenshotSessions.create(new Uint8Array(bytes)); screenshotSessions.retainEditor(payload.document.id)
      return { ok: true, payload }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('screenshot:document:read', (event, id: string) => {
    try { const sender = BrowserWindow.fromWebContents(event.sender)!; id = id || screenshotOverlayDocuments.get(sender) || ''; if (!ownsDocument(event, id)) throw Error('无法访问该截图'); return { ok: true, payload: { ...screenshotSessions.read(id), ...screenshotRegionMetadata.get(sender) } } }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('screenshot:region-select', async (event, rect: ScreenshotRect, action: 'edit' | 'copy' | 'save' | 'pin' = 'edit', tool: ScreenshotTool = 'select') => {
    const sender = BrowserWindow.fromWebContents(event.sender), display = sender && screenshotRegionDisplays.get(sender)
    if (!sender || !display || !activeOverlayResolve) return { ok: false, error: '框选会话已结束' }
    if (screenshotRegionRequests.size) return { ok: false, error: '正在捕获选区，请稍候' }
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 2 || rect.height < 2 || rect.x < 0 || rect.y < 0 || rect.x + rect.width > display.bounds.width || rect.y + rect.height > display.bounds.height || !['edit', 'copy', 'save', 'pin'].includes(action) || !['select', 'pen', 'highlighter', 'line', 'arrow', 'rectangle', 'ellipse', 'text', 'number', 'mosaic', 'blur', 'cover'].includes(tool)) return { ok: false, error: '请选择屏幕内的有效区域' }
    const controller = new AbortController(); screenshotRegionRequests.set(sender, controller)
    try {
      const physical = screen.dipToScreenRect(sender, { x: display.bounds.x + rect.x, y: display.bounds.y + rect.y, width: rect.width, height: rect.height })
      if (controller.signal.aborted) throw Error('截图已取消')
      const png = await captureWindowsRegion(physical, controller.signal)
      if (controller.signal.aborted || sender.isDestroyed() || !activeOverlayResolve) throw Error('截图已取消')
      const physicalDisplay = screen.dipToScreenRect(sender, display.bounds)
      const sourceRect = { x: physical.x - physicalDisplay.x, y: physical.y - physicalDisplay.y, width: physical.width, height: physical.height }
      const payload: ScreenshotPayload = { ...screenshotSessions.create(png, { width: physicalDisplay.width, height: physicalDisplay.height, rect: sourceRect }), placement: { x: 0, y: 0, width: display.bounds.width, height: display.bounds.height }, initialTool: tool, initialAction: action === 'edit' ? undefined : action }
      const previousId = screenshotOverlayDocuments.get(sender)
      screenshotOverlayDocuments.set(sender, payload.document.id)
      screenshotRegionMetadata.set(sender, { placement: payload.placement, initialTool: tool, initialAction: payload.initialAction })
      if (previousId) screenshotSessions.remove(previousId)
      return { ok: true, payload }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally { screenshotRegionRequests.delete(sender) }
  })
  ipcMain.handle('screenshot:document:discard', (event, id: string) => { if (ownsDocument(event, id)) { screenshotSessions.releaseEditor(id); screenshotSessions.remove(id) } })
  ipcMain.handle('screenshot:finish', async (event, request: ScreenshotFinishRequest) => {
    if (!ownsDocument(event, request?.document?.id)) return { ok: false, error: '截图会话已结束' }
    const result = await screenshotSessions.finish(request)
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (result.ok && sender && overlayWindows.has(sender)) {
      if (request.action === 'openEditor' && !request.document.sourceRect) screenshotOverlayDocuments.delete(sender)
      const resolve = activeOverlayResolve; activeOverlayResolve = null; resolve?.('completed')
      for (const window of overlayWindows) if (!window.isDestroyed()) window.close()
    }
    return result
  })
  ipcMain.handle('screenshot:pin:read', (event, id: string, version?: number) => {
    const pin = pinnedScreenshots.get(id)
    if (!pin || BrowserWindow.fromWebContents(event.sender) !== pin.window) return { ok: false, error: '贴图已关闭' }
    return { ok: true, png: version === pin.version ? undefined : new Uint8Array(pin.png), version: pin.version, width: pin.originalWidth, height: pin.originalHeight, opacity: pin.opacity, topmost: pin.topmost, locked: pin.locked, mouseThrough: pin.mouseThrough }
  })
  const pinSaveLocks = new Set<string>()
  ipcMain.handle('screenshot:pin:save', async (event, id: string, jpeg: Uint8Array, version: number) => {
    try {
      const pin = pinnedScreenshots.get(id)
      if (!pin || BrowserWindow.fromWebContents(event.sender) !== pin.window) throw Error('贴图已关闭')
      if (pin.version !== version) throw Error('贴图已更新，请重新保存')
      if (pinSaveLocks.has(id)) return { ok: false, error: '正在保存该贴图' }
      pinSaveLocks.add(id)
      try { return await saveScreenshotBytes(pin.png, true, undefined, new Uint8Array(jpeg)) }
      finally { pinSaveLocks.delete(id) }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('screenshot:pin:control', async (event, id: string, action: string, value?: Parameters<typeof controlPin>[2]) => {
    try {
      if (BrowserWindow.fromWebContents(event.sender) !== pinnedScreenshots.get(id)?.window) throw Error('无法控制该贴图')
      return await controlPin(id, action, value)
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('screenshot:overlay-submit', (event, dataUrl: string) => {
    const sender = BrowserWindow.fromWebContents(event.sender)
    if (!activeOverlayResolve || !sender || !overlayWindows.has(sender)) return { ok: false }
    let normalized: string
    try { normalized = decodeScreenshotImage(dataUrl).toDataURL() } catch { return { ok: false } }
    const resolve = activeOverlayResolve; activeOverlayResolve = null; resolve(normalized)
    for (const window of overlayWindows) { if (!window.isDestroyed()) window.destroy() }; overlayWindows.clear()
    return { ok: true }
  })
  ipcMain.handle('screenshot:overlay-cancel', event => { const sender = BrowserWindow.fromWebContents(event.sender); if (!sender || !overlayWindows.has(sender)) return { ok: false }; const resolve = activeOverlayResolve; activeOverlayResolve = null; resolve?.(null); for (const window of overlayWindows) { if (!window.isDestroyed()) window.destroy() }; overlayWindows.clear(); return { ok: true } })
  ipcMain.handle('screenshot:save', async (_event, dataUrl: string) => {
    try { const image = decodeScreenshotImage(dataUrl); const settings = (await readState()).Settings; const extension = settings.ScreenshotFormat === 'jpg' || settings.ScreenshotFormat === 'jpeg' ? 'jpg' : 'png'; const directory = path.resolve(settings.ScreenshotSaveDirectory?.trim() || path.join(dataDirectory(), 'Screenshots')); await fs.mkdir(directory, { recursive: true }); const output = uniqueFilePath(directory, 'DustDesk-edited', extension); await fs.writeFile(output, extension === 'jpg' ? image.toJPEG(92) : image.toPNG()); return { ok: true, path: output } }
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
    let moved = ''; let resolvedSource = ''
    try {
      const desktopRoot = path.resolve(desktopDirectory())
      if (typeof sourcePath !== 'string') throw new Error('源路径无效')
      resolvedSource = path.resolve(sourcePath)
      if ((await fs.lstat(resolvedSource)).isSymbolicLink()) throw new Error('不允许收纳符号链接')
      const { state } = await updateState(async state => {
        const category = state.DesktopCategories.find(item => item.Id === categoryId)
        if (!category) throw new Error('分类不存在')
        const fromDesktop = process.platform === 'win32' ? path.dirname(resolvedSource).toLowerCase() === desktopRoot.toLowerCase() : path.dirname(resolvedSource) === desktopRoot
        const sourceCategory = state.DesktopCategories.find(item => item.ItemPaths.some(itemPath => path.resolve(itemPath).toLowerCase() === resolvedSource.toLowerCase()))
        if (!fromDesktop && (!sourceCategory || !isWithinDirectory(path.join(dataDirectory(), 'DesktopOrganizer'), resolvedSource) || !(await isRealPathWithinDirectory(path.join(dataDirectory(), 'DesktopOrganizer'), resolvedSource)))) throw new Error('只能移动桌面项目或已收纳项目')
        if (sourceCategory?.Id === categoryId) throw new Error('项目已在当前分类中')
        const target = path.join(dataDirectory(), 'DesktopOrganizer', safeName(category.Name), path.basename(resolvedSource))
        moved = await moveWithVerification(resolvedSource, target)
        organizerUndoStack.push({ source: resolvedSource, target: moved, categoryId, sourceCategoryId: sourceCategory?.Id, sourceCategory: sourceCategory ? { ...sourceCategory, ItemPaths: [] } : undefined })
        for (const item of state.DesktopCategories) item.ItemPaths = item.ItemPaths.filter(itemPath => path.resolve(itemPath).toLowerCase() !== resolvedSource.toLowerCase())
        category.ItemPaths = [...new Set([...category.ItemPaths, moved])]
      })
      broadcastWorkspaceChanged(state)
      return { ok: true, path: moved }
    } catch (error) { if (moved && pathExists(moved) && resolvedSource && !pathExists(resolvedSource)) await moveWithVerification(moved, resolvedSource).catch(() => undefined); const undoIndex = organizerUndoStack.findLastIndex(item => item.target === moved); if (undoIndex >= 0) organizerUndoStack.splice(undoIndex, 1); await logOrganizerFailure('收纳', sourcePath, path.join(dataDirectory(), 'DesktopOrganizer'), error); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('organizer:plan-smart', async () => { const state = await readState(); const entries = await fs.readdir(desktopDirectory(), { withFileTypes: true }); return entries.filter(item => item.name.toLowerCase() !== 'desktop.ini').map(item => { const category = (matchOrganizerRule(item.name, state) ?? classifyOrganizerEntry(item.name, state.DesktopCategories)); return category ? { SourcePath: path.join(desktopDirectory(), item.name), CategoryId: category.Id, CategoryName: category.Name } : null }).filter((item): item is OrganizerPlanItem => item !== null) })
  ipcMain.handle('organizer:execute-smart', async (_event, suppliedPlan?: OrganizerPlanItem[]) => {
    if (!Array.isArray(suppliedPlan) || suppliedPlan.length > 5000 || suppliedPlan.some(item => !item || typeof item.SourcePath !== 'string' || typeof item.CategoryId !== 'string')) return { ok: false, moved: 0, error: '请先生成并确认整理预览' }
    const plan = suppliedPlan.filter((item, index, all) => all.findIndex(value => value.SourcePath === item.SourcePath) === index)
    let moved = 0; let changedState: WorkspaceState | null = null
    for (const item of plan) {
      let movedPath = ''
      try {
        const source = path.resolve(item.SourcePath)
        if (process.platform === 'win32' ? path.dirname(source).toLowerCase() !== path.resolve(desktopDirectory()).toLowerCase() : path.dirname(source) !== path.resolve(desktopDirectory())) throw new Error('只能收纳桌面顶层项目')
        if ((await fs.lstat(source)).isSymbolicLink()) throw new Error('不允许收纳符号链接')
        const result = await updateState(async latest => {
          const category = latest.DesktopCategories.find(value => value.Id === item.CategoryId)
          if (!category) throw new Error('分类不存在')
          const target = path.join(dataDirectory(), 'DesktopOrganizer', safeName(category.Name), path.basename(source))
          movedPath = await moveWithVerification(source, target)
          organizerUndoStack.push({ source, target: movedPath, categoryId: item.CategoryId })
          category.ItemPaths = [...new Set([...category.ItemPaths, movedPath])]
        })
        changedState = result.state; moved++
      } catch (error) { if (movedPath && pathExists(movedPath) && !pathExists(item.SourcePath)) await moveWithVerification(movedPath, item.SourcePath).catch(() => undefined); const undoIndex = organizerUndoStack.findLastIndex(action => action.target === movedPath); if (undoIndex >= 0) organizerUndoStack.splice(undoIndex, 1); await logOrganizerFailure('智能收纳', item.SourcePath, path.join(dataDirectory(), 'DesktopOrganizer'), error) }
    }
    if (changedState) broadcastWorkspaceChanged(changedState)
    return { ok: moved === plan.length, moved, ...(moved < plan.length ? { error: `已整理 ${moved} 项，${plan.length - moved} 项失败，请重新扫描；已完成的项目可逐项撤销` } : {}) }
  })
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
    const organizerRoot = path.resolve(path.join(dataDirectory(), 'DesktopOrganizer'))
    const sourceInDesktop = isWithinDirectory(path.resolve(desktopDirectory()), path.resolve(action.source))
    const sourceInOrganizer = isWithinDirectory(organizerRoot, path.resolve(action.source)) && await isRealPathWithinDirectory(organizerRoot, path.dirname(action.source))
    if ((!sourceInDesktop && !sourceInOrganizer) || !isWithinDirectory(organizerRoot, path.resolve(action.target)) || !(await isRealPathWithinDirectory(organizerRoot, action.target))) return { ok: false, error: '撤销路径无效' }
    let restored = ''
    try {
      const { state } = await updateState(async state => {
        let sourceCategory = state.DesktopCategories.find(item => item.Id === action.sourceCategoryId)
        if (sourceInOrganizer && !sourceCategory) {
          const name = action.sourceCategory?.Name || path.basename(path.dirname(action.source))
          // Merging removes the original category. Restore ownership together with the file,
          // or reuse a category that now owns that directory instead of orphaning the item.
          sourceCategory = state.DesktopCategories.find(item => safeName(item.Name).toLowerCase() === safeName(name).toLowerCase())
          if (!sourceCategory) {
            sourceCategory = { Id: action.sourceCategoryId || crypto.randomUUID(), Name: name, IsCollapsed: action.sourceCategory?.IsCollapsed ?? false, ItemPaths: [] }
            state.DesktopCategories.push(sourceCategory)
          }
        }
        restored = await moveWithVerification(action.target, action.source)
        for (const category of state.DesktopCategories) category.ItemPaths = category.ItemPaths.filter(item => path.resolve(item).toLowerCase() !== path.resolve(action.target).toLowerCase())
        if (sourceCategory) sourceCategory.ItemPaths = [...new Set([...sourceCategory.ItemPaths, restored])]
      })
      broadcastWorkspaceChanged(state)
      return { ok: true, path: restored }
    }
    catch (error) { if (restored && pathExists(restored) && !pathExists(action.target)) await moveWithVerification(restored, action.target).catch(() => undefined); await logOrganizerFailure('撤销', action.target, desktopDirectory(), error); organizerUndoStack.splice(index, 0, action); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('organizer:restore', async (_event, categoryId: string, sourcePath: string) => {
    let restored = ''; let resolvedSource = ''
    try {
      const organizerRoot = path.resolve(path.join(dataDirectory(), 'DesktopOrganizer'))
      if (typeof sourcePath !== 'string') throw new Error('源路径无效')
      resolvedSource = path.resolve(sourcePath)
      if ((await fs.lstat(resolvedSource)).isSymbolicLink()) throw new Error('不允许恢复符号链接')
      const { state } = await updateState(async state => {
        const category = state.DesktopCategories.find(item => item.Id === categoryId)
        if (!category) throw new Error('分类不存在')
        const categoryRoot = path.resolve(path.join(organizerRoot, safeName(category.Name)))
        if (!isWithinDirectory(categoryRoot, resolvedSource) || !(await isRealPathWithinDirectory(categoryRoot, resolvedSource)) || resolvedSource === categoryRoot) throw new Error('只能恢复当前分类中的项目')
        const target = path.join(desktopDirectory(), path.basename(resolvedSource)); restored = await moveWithVerification(resolvedSource, target)
        category.ItemPaths = category.ItemPaths.filter(item => path.resolve(item).toLowerCase() !== resolvedSource.toLowerCase())
      })
      broadcastWorkspaceChanged(state)
      return { ok: true, path: restored }
    } catch (error) { if (restored && pathExists(restored) && resolvedSource && !pathExists(resolvedSource)) await moveWithVerification(restored, resolvedSource).catch(() => undefined); await logOrganizerFailure('恢复桌面', sourcePath, desktopDirectory(), error); return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('system:sample', sampleSystemMetrics)
  ipcMain.handle('startup:get', () => app.getLoginItemSettings().openAtLogin)
  ipcMain.handle('startup:set', (_event, enabled: boolean) => { app.setLoginItemSettings({ openAtLogin: Boolean(enabled), args: ['--hidden'] }) })
  ipcMain.handle('maintenance:backup', async () => {
    try {
      return await enqueueWorkspaceOperation(async () => {
        const target = await productivity.backup(await readState())
        return { ok: true, path: target }
      })
    }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('maintenance:list', async () => {
    try { return await listBackupEntries() } catch { return [] }
  })
  ipcMain.handle('maintenance:restore', async (_event, target?: string, fingerprint?: string) => {
    try {
      const directory = path.resolve(path.join(dataDirectory(), 'Backups'))
      await assertPathWithinRoot(dataDirectory(), directory)
      const selected = typeof target === 'string' && target ? path.resolve(target) : (await listBackupEntries())[0]?.path ?? ''
       if (!selected || !isWithinDirectory(directory, selected) || !selected.toLowerCase().endsWith('.json') || !(await isRealPathWithinDirectory(directory, selected))) throw new Error('备份路径无效')
      const inspected = await productivity.inspect(selected)
      if (fingerprint && fingerprint !== inspected.preview.fingerprint) throw new Error('备份已变化，请重新预览')
      const raw = inspected.raw
      if (!isCompleteWorkspace(raw)) throw new Error('备份文件不完整或版本不受支持，未恢复')
      const restored = normalizeState(raw)
      if (!restored) throw new Error('备份文件格式无效')
      const state = await enqueueWorkspaceOperation(async () => {
        await productivity.protectBeforeRestore()
        const rollbackAssets = await productivity.restoreAssets(restored)
        try {
          if (restored.ActiveFocus) {
            restored.ActiveFocus.ElapsedSeconds = focusElapsed(restored.ActiveFocus, Date.parse(restored.ActiveFocus.CheckpointAt))
            restored.ActiveFocus.RunningSince = null
          }
          await writeState(restored, false)
          return restored
        } catch (error) {
          await rollbackAssets()
          throw error
        }
      })
      clipboardMonitoringEnabled = state.Settings.ClipboardMonitoringEnabled !== false
      registerHotkeys(state.Settings)
      restoreVisibleWidgets(state)
      broadcastWorkspaceChanged(state)
      return { ok: true }
    }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('search:cancel', (event, requestId: string) => {
    const active = fileSearches.get(event.sender.id)
    if (active?.requestId === requestId) { active.controller.abort(); fileSearches.delete(event.sender.id) }
  })
  ipcMain.handle('search:files', async (event, query: string, requestId = crypto.randomUUID()) => {
    const owner = event.sender.id
    fileSearches.get(owner)?.controller.abort()
    const active = { requestId, controller: new AbortController() }
    fileSearches.set(owner, active)
    if (!fileSearchOwners.has(event.sender)) {
      fileSearchOwners.add(event.sender)
      event.sender.once('destroyed', () => { fileSearches.get(owner)?.controller.abort(); fileSearches.delete(owner) })
    }
    const { signal } = active.controller
    try {
      if (typeof query !== 'string' || query.trim().length < 2 || query.length > 256) return []
      const state = await readState()
      if (signal.aborted) return []
      const projectPaths = state.Settings.SearchProjectPaths ? state.Projects.flatMap(project => [project.ProjectPath, ...project.Phases.flatMap(phase => [phase.ProjectPath, ...phase.Subtasks.map(item => item.FilePath)])]).filter(Boolean) : []
      const projectRoots = await Promise.all([...new Set(projectPaths)].map(async target => {
        if (signal.aborted) return ''
        try { return (await fs.stat(target)).isDirectory() ? target : path.dirname(target) } catch { return '' }
      }))
      if (signal.aborted) return []
      const roots = [
        state.Settings.SearchDesktopFiles ? desktopDirectory() : '',
        state.Settings.SearchStartMenuApps ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs') : '',
        state.Settings.SearchAppData ? app.getPath('appData') : '',
        ...projectRoots,
        ...(state.Settings.SearchCustomPaths ? state.Settings.SearchCustomRoots : [])
      ].filter(Boolean)
      return await searchFiles(roots, query, signal)
    } finally { if (fileSearches.get(owner) === active) fileSearches.delete(owner) }
  })
  ipcMain.handle('hotkeys:set', async (_event, keys: { mainWindow?: string; widgets?: string; screenshot?: string; pin?: string; quickCapture?: string }) => {
    if (!keys || typeof keys !== 'object') return { ok: false, error: '快捷键格式无效' }
    const values = [keys.mainWindow, keys.widgets, keys.screenshot, keys.pin, keys.quickCapture].filter(value => value !== undefined)
    if (values.some(value => typeof value !== 'string' || value.length > 80)) return { ok: false, error: '快捷键格式无效' }
    try {
      const state = await enqueueWorkspaceOperation(async () => {
        const state = await readState()
        const previous = { ...state.Settings }
        try {
          if (keys.mainWindow !== undefined) state.Settings.MainWindowHotKey = keys.mainWindow
          if (keys.widgets !== undefined) state.Settings.DesktopWidgetsHotKey = keys.widgets
          if (keys.screenshot !== undefined) state.Settings.ScreenshotHotKey = keys.screenshot
          if (keys.quickCapture !== undefined) state.Settings.QuickCaptureHotKey = keys.quickCapture
          if (keys.pin !== undefined) state.Settings.PinScreenshotHotKey = keys.pin
          const accelerators = [state.Settings.MainWindowHotKey, state.Settings.DesktopWidgetsHotKey, state.Settings.ScreenshotHotKey, state.Settings.PinScreenshotHotKey, state.Settings.QuickCaptureHotKey].map(value => value.trim().toLowerCase()).filter(Boolean)
          if (new Set(accelerators).size !== accelerators.length) throw new Error('快捷键不能重复')
          if (!registerHotkeys(state.Settings)) throw new Error('快捷键无效或已被其他程序占用')
          await writeState(state)
          return state
        } catch (error) {
          // Roll back before releasing the mutation queue, so a later change wins.
          registerHotkeys(previous)
          throw error
        }
      })
      broadcastWorkspaceChanged(state)
      return { ok: true }
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
  })
  ipcMain.handle('projects:export', exportProjects)
  ipcMain.handle('update:check', () => releaseUpdates.check())
}

app.whenReady().then(() => {
  if (!singleInstanceLock) return
  if (process.platform === 'win32') app.setAppUserModelId('com.dustdesk.next')
  registerIpc(); void productivity.start().catch(error => console.error(error)); createApplicationMenu(); createWindow(); createTray(); startClipboardMonitor()
  reminderTimer = setInterval(() => { void checkTodoReminders().catch(() => undefined) }, 30_000)
  void checkTodoReminders().catch(() => undefined)
  void readState().then(state => {
    clipboardMonitoringEnabled = state.Settings.ClipboardMonitoringEnabled !== false
    const persisted = (state as WorkspaceState & { OrganizerUndoStack?: OrganizerUndoAction[] }).OrganizerUndoStack
    if (Array.isArray(persisted)) organizerUndoStack.push(...persisted.filter(item => item && typeof item.source === 'string' && typeof item.target === 'string' && typeof item.categoryId === 'string').slice(-100))
    if (!launchedHidden && !state.Settings.StartHiddenToTray) showWindow()
    else mainWindow?.hide()
    restoreVisibleWidgets(state)
  }).catch(() => { if (!launchedHidden) showWindow() })
  void readState().then(state => { registerHotkeys(state.Settings) }).catch(() => { registerHotkeys(defaultState().Settings) })
  powerMonitor.on('suspend', () => { void productivity.stop().catch(error => console.error('Unable to pause focus:', error)) })
  app.on('activate', showWindow)
})
let waitingForQuit = false
let readyToQuit = false
async function prepareToQuit() {
  // Only editing windows participate in the preload save protocol. Pinned images
  // and screenshot overlays cannot acknowledge a workspace flush.
  const editingWindows = [mainWindow, captureWindow, ...widgetWindows.values()].filter((window): window is BrowserWindow => window !== null && !window.isDestroyed())
  await Promise.all(editingWindows.map(window => new Promise<void>((resolve, reject) => {
    const sender = window.webContents
    const requestId = crypto.randomUUID()
    const finish = (error?: string) => {
      clearTimeout(timer)
      ipcMain.removeListener('workspace:flushed', acknowledge)
      sender.removeListener('destroyed', destroyed)
      error ? reject(new Error(error)) : resolve()
    }
    const acknowledge = (event: Electron.IpcMainEvent, id: string, error?: string) => {
      if (event.sender.id === sender.id && id === requestId) finish(error)
    }
    const destroyed = () => finish('窗口在保存完成前关闭，退出已取消')
    const timer = setTimeout(() => finish('等待窗口保存超时，退出已取消，请重试'), 15_000)
    ipcMain.on('workspace:flushed', acknowledge)
    sender.once('destroyed', destroyed)
    sender.send('workspace:flush', requestId)
  })))
  let mutations: Promise<void>; let writes: Promise<string>
  do {
    mutations = workspaceMutationQueue; writes = workspaceWriteQueue
    await Promise.all([mutations, writes])
  } while (mutations !== workspaceMutationQueue || writes !== workspaceWriteQueue)
  await productivity.stop()
}

function resumeAfterQuitFailure() {
  waitingForQuit = false; readyToQuit = false; isQuitting = false
  for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('workspace:resume')
}

app.on('before-quit', event => {
  if (readyToQuit) return
  event.preventDefault()
  if (waitingForQuit) return
  waitingForQuit = true
  void prepareToQuit().then(() => {
    isQuitting = true; readyToQuit = true
    app.quit()
  }).catch(error => {
    resumeAfterQuitFailure()
    dialog.showErrorBox('尚未完成保存', error instanceof Error ? error.message : String(error))
  })
})
app.on('window-all-closed', () => { /* The tray keeps the application running. */ })
app.on('will-quit', () => { productivity.dispose(); globalShortcut.unregisterAll(); if (clipboardTimer) clearInterval(clipboardTimer); if (reminderTimer) clearInterval(reminderTimer); for (const window of widgetWindows.values()) window.destroy(); closePinnedWindows(); for (const window of overlayWindows) if (!window.isDestroyed()) window.destroy(); screenshotSessions.clear(); tray?.destroy() })
