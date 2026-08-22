export type ReminderRepeat = 'None' | 'Daily' | 'Weekdays' | 'Weekly'
export type ProjectStatus = 'Todo' | 'Doing' | 'Done'
export type ClipboardContentKind = 'Text' | 'Image'

export interface TodoRecord {
  Id: string
  Title: string
  Tag: string
  Note: string
  IsCompleted: boolean
  CreatedAt: string
  ReminderAt?: string | null
  ReminderNotifiedAt?: string | null
  ReminderRepeat: ReminderRepeat
}

export interface NoteRecord {
  Id: string
  Title: string
  Text: string
  ColorArgb: number
  FontColorArgb: number
  FontSize: number
  FontBold: boolean
  BackgroundImagePath?: string | null
  BackgroundImageFileName: string
  ImageOnly: boolean
  CreatedAt: string
  UpdatedAt: string
}

export interface ProjectSubtaskRecord { Id: string; Title: string; IsCompleted: boolean; FilePath: string }
export interface ProjectPhaseRecord {
  Id: string
  Title: string
  Status: ProjectStatus
  StartDate?: string | null
  EndDate?: string | null
  ProgressPercent: number
  ProjectPath: string
  Subtasks: ProjectSubtaskRecord[]
}
export interface ProjectRecord { Id: string; Name: string; ProjectPath: string; Phases: ProjectPhaseRecord[] }
export interface LauncherRecord { Id: string; Name: string; Path: string; GroupId?: string }
export interface LinkRecord { Id: string; Name: string; Url: string; Note: string; CreatedAt: string; UpdatedAt: string }
export interface LinkGroupRecord { Id: string; Name: string; Links: LinkRecord[] }
export interface ClipboardRecord {
  Id: string
  Kind: ClipboardContentKind
  Text: string
  ImagePngBase64: string
  ImageFileName: string
  ImageSha256: string
  CreatedAt: string
  IsLocked: boolean
  IsPinned: boolean
}
export interface DesktopCategoryRecord { Id: string; Name: string; IsCollapsed: boolean; ItemPaths: string[] }
export interface OrganizerEntry { Name: string; Path: string; IsDirectory: boolean }
export interface SystemMetrics {
  CpuPercent: number
  MemoryPercent: number
  UsedMemoryBytes: number
  TotalMemoryBytes: number
  DownloadBytesPerSecond: number
  UploadBytesPerSecond: number
  DiskReadBytesPerSecond: number
  DiskWriteBytesPerSecond: number
  DiskSpaces: { DriveName: string; FreeBytes: number; TotalBytes: number }[]
  PingMilliseconds: number
  UptimeSeconds: number
}
export interface SearchFileResult { Name: string; Path: string; IsDirectory: boolean }
export interface OrganizerPlanItem { SourcePath: string; CategoryId: string; CategoryName: string }
export interface BackupEntry { path: string; name: string; size: number; modifiedAt: string }
export interface WidgetPlacement {
  Visible?: boolean
  Locked?: boolean
  TopMost?: boolean
  X?: number
  Y?: number
  Width?: number
  Height?: number
  AutoCollapseEnabled?: boolean
  IsCollapsed?: boolean
  SnapToEdges?: boolean
  TransparentBackground?: boolean
  DockEdge?: 'None' | 'Left' | 'Right' | 'Top' | 'Bottom'
}

export interface AppSettings {
  MainWindowDisplayName: string
  StartHiddenToTray: boolean
  StartWithWindows: boolean
  MainWindowHotKey: string
  DesktopWidgetsHotKey: string
  ScreenshotHotKey: string
  PinScreenshotHotKey: string
  ScreenshotFormat: string
  ScreenshotSaveDirectory: string
  ScreenshotDelaySeconds: number
  ScreenshotAfterAction: string
  ScreenshotAutoCopy: boolean
  ScreenshotAutoAddToClipboardHistory: boolean
  PinnedImageTopmost: boolean
  PinnedImageOpacityPercent: number
  PinnedImageMouseThrough: boolean
  WidgetOpacityPercent: number
  WidgetBackgroundColorArgb: number
  SearchDesktopFiles: boolean
  SearchAppData: boolean
  SearchStartMenuApps: boolean
  SearchProjectPaths: boolean
  SearchCustomPaths: boolean
  SearchCustomRoots: string[]
  ClipboardMonitoringEnabled: boolean
  DesktopHotKeyWidgetKeys: string[]
  LauncherWidgetSnapToEdges: boolean
  LauncherWidgetShowNames: boolean
  LauncherWidgetIconSize: number
  OrganizerWidgetShowNames: boolean
  OrganizerWidgetIconSize: number
  MonitorShowDownload: boolean
  MonitorShowUpload: boolean
  MonitorShowMemory: boolean
  MonitorShowCpu: boolean
  MonitorShowDiskIo: boolean
  MonitorShowDiskSpace: boolean
  MonitorShowPing: boolean
  MonitorShowUptime: boolean
  WorkdayStartMinutes: number
  WorkdayEndMinutes: number
  MonthlySalary: number
  PaydayDay: number
  CountdownFestivalName: string
  CountdownFestivalMonth: number
  CountdownFestivalDay: number
  WidgetPlacements: Record<string, WidgetPlacement>
  NoteWidgetPlacements: (WidgetPlacement & { NoteId: string })[]
  OrganizerGroupWidgetPlacements: (WidgetPlacement & { GroupId: string; CategoryIds: string[] })[]
  WidgetLayoutPresets: Record<string, Record<string, WidgetPlacement>>
}

export interface WorkspaceState {
  SchemaVersion: number
  LegacyImportCompleted: boolean
  QuickNote: string
  Settings: AppSettings
  Todos: TodoRecord[]
  TagPresets: { Name: string; ColorArgb: number }[]
  Notes: NoteRecord[]
  Projects: ProjectRecord[]
  Launchers: LauncherRecord[]
  LinkGroups: LinkGroupRecord[]
  ClipboardHistory: ClipboardRecord[]
  DesktopCategories: DesktopCategoryRecord[]
  [key: string]: unknown
}

export interface DustDeskApi {
  loadWorkspace(): Promise<WorkspaceState>
  saveWorkspace(state: WorkspaceState): Promise<{ ok: true; path: string }>
  getDataLocation(): Promise<string>
  pickNoteBackground(): Promise<{ ok: boolean; path?: string; fileName?: string; dataUrl?: string; canceled?: boolean; error?: string }>
  clearNoteBackground(path: string): Promise<{ ok: boolean; error?: string }>
  pickFolder(title?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  pickPath(title?: string): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  readImageFile(path: string): Promise<{ ok: boolean; dataUrl?: string; error?: string }>
  openPath(path: string): Promise<{ ok: boolean; error?: string }>
  showPathContextMenu(path: string): Promise<{ ok: boolean; error?: string }>
  openUrl(url: string): Promise<{ ok: boolean; error?: string }>
  showMainWindow(): Promise<void>
  hideMainWindow(): Promise<void>
  toggleWidgets(key?: string): Promise<void>
  hideWidget(key: string): Promise<void>
  setWidgetOptions(key: string, options: { locked?: boolean; topMost?: boolean; transparentBackground?: boolean; autoCollapse?: boolean; collapsed?: boolean; snapToEdges?: boolean; height?: number }): Promise<{ ok: boolean; error?: string }>
  resizeWidget(key: string, width: number, height: number, commit?: boolean): Promise<{ ok: boolean; error?: string }>
  listWidgetPresets(): Promise<string[]>
  saveWidgetPreset(name: string): Promise<{ ok: boolean; error?: string }>
  applyWidgetPreset(name: string): Promise<{ ok: boolean; error?: string }>
  deleteWidgetPreset(name: string): Promise<{ ok: boolean; error?: string }>
  startScreenshot(mode?: 'Region' | 'Window' | 'FullScreen'): Promise<{ ok: boolean; message?: string; path?: string; dataUrl?: string }>
  onScreenshotOverlaySource(callback: (dataUrl: string) => void): () => void
  submitScreenshotOverlay(dataUrl: string): Promise<{ ok: boolean }>
  cancelScreenshotOverlay(): Promise<{ ok: boolean }>
  saveScreenshot(dataUrl: string): Promise<{ ok: boolean; path?: string; error?: string }>
  pinScreenshot(dataUrl: string): Promise<{ ok: boolean; error?: string }>
  readClipboard(): Promise<{ text: string; imagePngBase64: string }>
  writeClipboard(content: { text?: string; imagePngBase64?: string }): Promise<void>
  onClipboardChanged(callback: (record: ClipboardRecord) => void): () => void
  listDesktopEntries(): Promise<OrganizerEntry[]>
  moveIntoCategory(categoryId: string, sourcePath: string): Promise<{ ok: boolean; path?: string; error?: string }>
  restoreToDesktop(categoryId: string, sourcePath: string): Promise<{ ok: boolean; path?: string; error?: string }>
  sampleSystemMetrics(): Promise<SystemMetrics>
  getStartupEnabled(): Promise<boolean>
  setStartupEnabled(enabled: boolean): Promise<void>
  createBackup(): Promise<{ ok: boolean; path?: string; error?: string }>
  listBackups(): Promise<BackupEntry[]>
  restoreBackup(path?: string): Promise<{ ok: boolean; error?: string }>
  searchFiles(query: string): Promise<SearchFileResult[]>
  setHotkeys(keys: { mainWindow?: string; widgets?: string; screenshot?: string; pin?: string }): Promise<{ ok: boolean; error?: string }>
  exportProjects(): Promise<{ ok: boolean; path?: string; canceled?: boolean; error?: string }>
  planSmartOrganize(): Promise<OrganizerPlanItem[]>
  executeSmartOrganize(): Promise<{ ok: boolean; moved: number; error?: string }>
  undoOrganizerMove(): Promise<{ ok: boolean; error?: string }>
  checkForUpdate(): Promise<{ ok: boolean; available: boolean; version?: string; error?: string }>
  downloadUpdate(): Promise<{ ok: boolean; error?: string }>
  installUpdate(): Promise<{ ok: boolean; error?: string }>
  onWorkspaceChanged(callback: (state: WorkspaceState) => void): () => void
  onWidgetAppearance(callback: (appearance: { color: number; alpha: number }) => void): () => void
  platform: NodeJS.Platform
}
