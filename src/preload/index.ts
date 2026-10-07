import { contextBridge, ipcRenderer } from 'electron'
import type { ClipboardRecord, DustDeskApi, OrganizerEntry, OrganizerPlanItem, SearchFileResult, SystemMetrics, WorkspaceState } from '../shared/types'
import type { ResourceScanProgress } from '../shared/productivity'

const flushCallbacks = new Set<() => Promise<void>>()
const pendingSaves = new Set<Promise<unknown>>()
ipcRenderer.on('workspace:flush', async (_event, requestId: string) => {
  document.documentElement.inert = true
  try {
    for (const flush of flushCallbacks) await flush()
    while (pendingSaves.size) await Promise.all([...pendingSaves])
    ipcRenderer.send('workspace:flushed', requestId)
  } catch (error) {
    ipcRenderer.send('workspace:flushed', requestId, error instanceof Error ? error.message : String(error))
  }
})
ipcRenderer.on('workspace:resume', () => { document.documentElement.inert = false })

function trackedInvoke(channel: string, ...args: unknown[]) {
  const operation = ipcRenderer.invoke(channel, ...args)
  pendingSaves.add(operation)
  void operation.then(() => pendingSaves.delete(operation), () => pendingSaves.delete(operation))
  return operation
}
const api: DustDeskApi = {
  productivity: action => trackedInvoke('productivity:action', action),
  backupStatus: () => ipcRenderer.invoke('maintenance:status'),
  previewBackup: target => ipcRenderer.invoke('maintenance:preview', target),
  checkResources: request => ipcRenderer.invoke('resources:check', request),
  cancelResourceCheck: requestId => ipcRenderer.invoke('resources:cancel', requestId),
  onResourceCheckProgress: callback => {
    const listener = (_event: Electron.IpcRendererEvent, progress: ResourceScanProgress) => callback(progress)
    ipcRenderer.on('resources:progress', listener)
    return () => ipcRenderer.removeListener('resources:progress', listener)
  },
  showQuickCapture: () => ipcRenderer.invoke('capture:show'),
  hideQuickCapture: () => ipcRenderer.invoke('capture:hide'),
  loadWorkspace: () => ipcRenderer.invoke('workspace:load'),
  saveWorkspace: (state: WorkspaceState, baseline?: WorkspaceState) => {
    const operation = ipcRenderer.invoke('workspace:save', state, baseline)
    pendingSaves.add(operation)
    void operation.then(() => pendingSaves.delete(operation), () => pendingSaves.delete(operation))
    return operation
  },
  onBeforeQuit: flush => { flushCallbacks.add(flush); return () => { flushCallbacks.delete(flush) } },
  getDataLocation: () => ipcRenderer.invoke('data:location'),
  pickNoteBackground: (noteId, expectedPath) => trackedInvoke('notes:pick-background', noteId, expectedPath),
  importNoteBackground: (noteId, source, expectedPath) => trackedInvoke('notes:import-background', noteId, source, expectedPath),
  clearNoteBackground: (noteId, expectedPath) => trackedInvoke('notes:clear-background', noteId, expectedPath),
  pickFolder: (title?: string) => ipcRenderer.invoke('path:pick-folder', title),
  pickPath: (title?: string) => ipcRenderer.invoke('path:pick', title),
  readImageFile: (target: string) => ipcRenderer.invoke('notes:read-image', target),
  openPath: (target: string) => ipcRenderer.invoke('path:open', target),
  getPathIcon: (target: string) => ipcRenderer.invoke('path:icon', target),
  showPathContextMenu: (target: string) => ipcRenderer.invoke('path:context-menu', target),
  openUrl: (target: string) => ipcRenderer.invoke('url:open', target),
  showMainWindow: () => ipcRenderer.invoke('window:show'),
  hideMainWindow: () => ipcRenderer.invoke('window:hide'),
  toggleWidgets: (key?: string) => ipcRenderer.invoke('widgets:toggle', key),
  getWidgetVisibility: (keys: string[]) => ipcRenderer.invoke('widgets:visibility', keys),
  hideWidget: (key: string) => ipcRenderer.invoke('widgets:hide', key),
  setWidgetVisibility: (key: string, visible: boolean) => ipcRenderer.invoke('widgets:visibility:set', key, visible),
  setWidgetOptions: (key: string, options: { locked?: boolean; topMost?: boolean; transparentBackground?: boolean; autoCollapse?: boolean; collapsed?: boolean; snapToEdges?: boolean; height?: number }) => ipcRenderer.invoke('widgets:options', key, options),
  moveWidget: (key: string, x: number, y: number, commit = false) => ipcRenderer.invoke('widgets:move', key, x, y, commit),
  resizeWidget: (key: string, width: number, height: number, commit = false) => ipcRenderer.invoke('widgets:resize', key, width, height, commit),
  listWidgetPresets: () => ipcRenderer.invoke('widgets:presets:list'),
  saveWidgetPreset: (name: string) => ipcRenderer.invoke('widgets:presets:save', name),
  applyWidgetPreset: (name: string) => ipcRenderer.invoke('widgets:presets:apply', name),
  deleteWidgetPreset: (name: string) => ipcRenderer.invoke('widgets:presets:delete', name),
  listScreenshotWindows: () => ipcRenderer.invoke('screenshot:windows'),
  createScreenshotDocument: (png: Uint8Array) => ipcRenderer.invoke('screenshot:document:create', png),
  selectScreenshotRegion: (rect, action, tool) => ipcRenderer.invoke('screenshot:region-select', rect, action, tool),
  readScreenshotDocument: (id: string) => ipcRenderer.invoke('screenshot:document:read', id),
  finishScreenshot: (request: import('../shared/screenshotDocument').ScreenshotFinishRequest) => ipcRenderer.invoke('screenshot:finish', request),
  discardScreenshotDocument: (id: string) => ipcRenderer.invoke('screenshot:document:discard', id),
  onScreenshotDocument: (callback: (payload: import('../shared/screenshotDocument').ScreenshotPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/screenshotDocument').ScreenshotPayload) => callback(payload)
    ipcRenderer.on('screenshot:document', listener)
    return () => ipcRenderer.removeListener('screenshot:document', listener)
  },
  readPinnedScreenshot: (id: string, version?: number) => ipcRenderer.invoke('screenshot:pin:read', id, version),
  savePinnedScreenshot: (id, jpeg, version) => ipcRenderer.invoke('screenshot:pin:save', id, jpeg, version),
  onPinnedScreenshotSaveRequested: callback => {
    const listener = () => callback()
    ipcRenderer.on('screenshot:pin:save-request', listener)
    return () => ipcRenderer.removeListener('screenshot:pin:save-request', listener)
  },
  controlPinnedScreenshot: (id: string, action: string, value?: unknown) => ipcRenderer.invoke('screenshot:pin:control', id, action, value),
  onPinnedScreenshotChanged: (callback: () => void) => {
    const listener = () => callback()
    ipcRenderer.on('screenshot:pin:changed', listener)
    return () => ipcRenderer.removeListener('screenshot:pin:changed', listener)
  },
  startScreenshot: (mode = 'Region', sourceId?: string) => ipcRenderer.invoke('screenshot:start', mode, sourceId),
  onScreenshotOverlaySource: (callback: (dataUrl: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
    ipcRenderer.on('screenshot:overlay-source', listener)
    return () => ipcRenderer.removeListener('screenshot:overlay-source', listener)
  },
  onScreenshotCaptured: (callback: (dataUrl: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, dataUrl: string) => callback(dataUrl)
    ipcRenderer.on('screenshot:captured', listener)
    return () => ipcRenderer.removeListener('screenshot:captured', listener)
  },
  submitScreenshotOverlay: (dataUrl: string) => ipcRenderer.invoke('screenshot:overlay-submit', dataUrl),
  cancelScreenshotOverlay: () => ipcRenderer.invoke('screenshot:overlay-cancel'),
  saveScreenshot: (dataUrl: string) => ipcRenderer.invoke('screenshot:save', dataUrl),
  pinScreenshot: (dataUrl: string) => ipcRenderer.invoke('screenshot:pin', dataUrl),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (content: { text?: string; imagePngBase64?: string; recordId?: string }) => ipcRenderer.invoke('clipboard:write', content),
  onWorkspaceChanged: (callback: (state: WorkspaceState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: WorkspaceState) => callback(state)
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },
  onWidgetVisibilityChanged: (callback: (key: string, visible: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, key: string, visible: boolean) => callback(key, visible)
    ipcRenderer.on('widget:visibility', listener)
    return () => ipcRenderer.removeListener('widget:visibility', listener)
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
  restoreBackup: (target?: string, fingerprint?: string) => trackedInvoke('maintenance:restore', target, fingerprint),
  cancelFileSearch: (requestId: string) => ipcRenderer.invoke('search:cancel', requestId),
  searchFiles: (query: string, requestId?: string) => ipcRenderer.invoke('search:files', query, requestId) as Promise<SearchFileResult[]>,
  setHotkeys: (keys: { mainWindow?: string; widgets?: string; screenshot?: string; pin?: string; quickCapture?: string }) => ipcRenderer.invoke('hotkeys:set', keys),
  exportProjects: () => ipcRenderer.invoke('projects:export'),
  planSmartOrganize: () => ipcRenderer.invoke('organizer:plan-smart') as Promise<OrganizerPlanItem[]>,
  executeSmartOrganize: plan => trackedInvoke('organizer:execute-smart', plan),
  undoOrganizerMove: () => ipcRenderer.invoke('organizer:undo'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  platform: process.platform
}

contextBridge.exposeInMainWorld('dustdesk', api)
