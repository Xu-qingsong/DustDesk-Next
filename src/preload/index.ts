import { contextBridge, ipcRenderer } from 'electron'
import type { ClipboardRecord, DustDeskApi, OrganizerEntry, OrganizerPlanItem, SearchFileResult, SystemMetrics, WorkspaceState } from '../shared/types'

const api: DustDeskApi = {
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (state: WorkspaceState) => ipcRenderer.invoke('workspace:save', state),
  getDataLocation: () => ipcRenderer.invoke('data:location'),
  pickNoteBackground: () => ipcRenderer.invoke('notes:pick-background'),
  clearNoteBackground: (target: string) => ipcRenderer.invoke('notes:clear-background', target),
  pickFolder: (title?: string) => ipcRenderer.invoke('path:pick-folder', title),
  pickPath: (title?: string) => ipcRenderer.invoke('path:pick', title),
  readImageFile: (target: string) => ipcRenderer.invoke('notes:read-image', target),
  openPath: (target: string) => ipcRenderer.invoke('path:open', target),
  showPathContextMenu: (target: string) => ipcRenderer.invoke('path:context-menu', target),
  openUrl: (target: string) => ipcRenderer.invoke('url:open', target),
  showMainWindow: () => ipcRenderer.invoke('window:show'),
  hideMainWindow: () => ipcRenderer.invoke('window:hide'),
  toggleWidgets: (key?: string) => ipcRenderer.invoke('widgets:toggle', key),
  hideWidget: (key: string) => ipcRenderer.invoke('widgets:hide', key),
  setWidgetOptions: (key: string, options: { locked?: boolean; topMost?: boolean; transparentBackground?: boolean; autoCollapse?: boolean; collapsed?: boolean; snapToEdges?: boolean; height?: number }) => ipcRenderer.invoke('widgets:options', key, options),
  resizeWidget: (key: string, width: number, height: number, commit = false) => ipcRenderer.invoke('widgets:resize', key, width, height, commit),
  listWidgetPresets: () => ipcRenderer.invoke('widgets:presets:list'),
  saveWidgetPreset: (name: string) => ipcRenderer.invoke('widgets:presets:save', name),
  applyWidgetPreset: (name: string) => ipcRenderer.invoke('widgets:presets:apply', name),
  deleteWidgetPreset: (name: string) => ipcRenderer.invoke('widgets:presets:delete', name),
  startScreenshot: (mode = 'Region') => ipcRenderer.invoke('screenshot:start', mode),
  onScreenshotOverlaySource: (callback: (dataUrl: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
    ipcRenderer.on('screenshot:overlay-source', listener)
    return () => ipcRenderer.removeListener('screenshot:overlay-source', listener)
  },
  submitScreenshotOverlay: (dataUrl: string) => ipcRenderer.invoke('screenshot:overlay-submit', dataUrl),
  cancelScreenshotOverlay: () => ipcRenderer.invoke('screenshot:overlay-cancel'),
  saveScreenshot: (dataUrl: string) => ipcRenderer.invoke('screenshot:save', dataUrl),
  pinScreenshot: (dataUrl: string) => ipcRenderer.invoke('screenshot:pin', dataUrl),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (content: { text?: string; imagePngBase64?: string }) => ipcRenderer.invoke('clipboard:write', content),
  onWorkspaceChanged: (callback: (state: WorkspaceState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => callback(state)
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },
  onWidgetAppearance: (callback: (appearance: { color: number; alpha: number }) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, appearance: { color: number; alpha: number }) => callback(appearance)
    ipcRenderer.on('widget:appearance', listener)
    return () => ipcRenderer.removeListener('widget:appearance', listener)
  },
  onClipboardChanged: (callback: (record: ClipboardRecord) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, record: ClipboardRecord) => callback(record)
    ipcRenderer.on('clipboard:changed', listener)
    return () => ipcRenderer.removeListener('clipboard:changed', listener)
  },
  listDesktopEntries: () => ipcRenderer.invoke('organizer:list') as Promise<OrganizerEntry[]>,
  moveIntoCategory: (categoryId: string, sourcePath: string) => ipcRenderer.invoke('organizer:move', categoryId, sourcePath),
  restoreToDesktop: (categoryId: string, sourcePath: string) => ipcRenderer.invoke('organizer:restore', categoryId, sourcePath),
  sampleSystemMetrics: () => ipcRenderer.invoke('system:sample') as Promise<SystemMetrics>,
  getStartupEnabled: () => ipcRenderer.invoke('startup:get'),
  setStartupEnabled: (enabled: boolean) => ipcRenderer.invoke('startup:set', enabled),
  createBackup: () => ipcRenderer.invoke('maintenance:backup'),
  listBackups: () => ipcRenderer.invoke('maintenance:list'),
  restoreBackup: (target?: string) => ipcRenderer.invoke('maintenance:restore', target),
  searchFiles: (query: string) => ipcRenderer.invoke('search:files', query) as Promise<SearchFileResult[]>,
  setHotkeys: (keys: { mainWindow?: string; widgets?: string; screenshot?: string; pin?: string }) => ipcRenderer.invoke('hotkeys:set', keys),
  exportProjects: () => ipcRenderer.invoke('projects:export'),
  planSmartOrganize: () => ipcRenderer.invoke('organizer:plan-smart') as Promise<OrganizerPlanItem[]>,
  executeSmartOrganize: () => ipcRenderer.invoke('organizer:execute-smart'),
  undoOrganizerMove: () => ipcRenderer.invoke('organizer:undo'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  platform: process.platform
}

contextBridge.exposeInMainWorld('dustdesk', api)
