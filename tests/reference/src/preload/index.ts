import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ClipboardRecord, DustDeskApi, OrganizerEntry, OrganizerPlanItem, SearchFileResult, SystemMetrics, WorkspaceState } from '../shared/types'
import type { ResourceScanProgress } from '../shared/productivity'
import { collectDrafts } from '../shared/draftMigration'
import { installDraftReader } from './draftReader'
import { installDraftControl } from './draftControl'

function installDesktopApi() {
  const fileDrops = new Set<(drop: import('../shared/fileDrop').FilesDropped) => boolean>()
  let screenshotDrop: { path: string; file: File } | undefined
  document.addEventListener('drop', event => {
    const files = [...(event.dataTransfer?.files ?? [])]
    const paths = files.map(file => webUtils.getPathForFile(file)).filter(Boolean)
    screenshotDrop = undefined
    if (!paths.length) return
    event.preventDefault()
    if (activeFlush || document.documentElement.inert) { event.stopImmediatePropagation(); return }
    const file = files.find(file => webUtils.getPathForFile(file) === paths[0])
    if (file) screenshotDrop = { path: paths[0]!, file }
    const drop = { paths, position: { x: event.clientX, y: event.clientY } }
    for (const callback of [...fileDrops]) {
      try { if (callback(drop)) { event.stopImmediatePropagation(); break } } catch (error) { console.error('文件拖入处理失败', error) }
    }
  }, true)
  const flushCallbacks = new Set<() => Promise<void>>()
  const pendingSaves = new Set<Promise<unknown>>()
  let mainWindowReleaseCheck: (() => boolean) | undefined
  let flushGeneration = 0
  let activeFlush = false
  let maintenanceId: string | undefined
  let maintenanceReady = false
  let composing = false
  document.addEventListener('compositionstart', () => { composing = true }, true)
  document.addEventListener('compositionend', () => { composing = false }, true)
  async function flush(requestId: string, release = false, maintenance = false) {
    const channel = maintenance ? 'drafts:flushed' : 'workspace:flushed'
    if (activeFlush) { ipcRenderer.send(channel, requestId, '已有窗口保存或迁移维护正在处理'); return }
    const generation = ++flushGeneration
    screenshotDrop = undefined
    activeFlush = true
    if (maintenance) maintenanceId = requestId
    document.documentElement.inert = true
    try {
      if (maintenance && composing) throw Error('输入法组合输入尚未结束，请完成输入后再导出')
      for (const callback of flushCallbacks) { await callback(); if (generation !== flushGeneration) return }
      while (pendingSaves.size) await Promise.all([...pendingSaves])
      if (generation !== flushGeneration) return
      if (maintenance) maintenanceReady = true
      if (release) ipcRenderer.send(channel, requestId, undefined, mainWindowReleaseCheck?.() === true)
      else ipcRenderer.send(channel, requestId)
    } catch (error) {
      if (generation === flushGeneration) {
        if (!maintenance) activeFlush = false
        ipcRenderer.send(channel, requestId, error instanceof Error ? error.message : String(error))
      }
    }
  }
  ipcRenderer.on('workspace:flush', (_event, requestId: string, release = false) => { void flush(requestId, release) })
  ipcRenderer.on('workspace:resume', () => { if (maintenanceId) return; ++flushGeneration; activeFlush = false; document.documentElement.inert = false })
  ipcRenderer.on('drafts:flush', (_event, requestId: string) => { void flush(requestId, false, true) })
  ipcRenderer.on('drafts:resume', (_event, requestId: string) => {
    if (maintenanceId !== requestId) return
    maintenanceId = undefined; maintenanceReady = false; ++flushGeneration; activeFlush = false; document.documentElement.inert = false
  })
  ipcRenderer.on('drafts:collect', (_event, requestId: string) => {
    if (maintenanceId !== requestId) return
    try {
      if (!maintenanceReady || pendingSaves.size) throw Error('迁移草稿保存尚未完成')
      ipcRenderer.send('drafts:collected', requestId, collectDrafts(localStorage))
    } catch (error) { ipcRenderer.send('drafts:collected', requestId, undefined, error instanceof Error ? error.message : String(error)) }
  })

  function trackedInvoke(channel: string, ...args: unknown[]) {
    if (maintenanceReady) return Promise.reject(Error('正在迁移维护，不能接受新保存'))
    const operation = ipcRenderer.invoke(channel, ...args)
    pendingSaves.add(operation)
    void operation.then(() => pendingSaves.delete(operation), () => pendingSaves.delete(operation))
    return operation
  }
  const api: DustDeskApi = {
    onFilesDropped: callback => { fileDrops.add(callback); return () => { fileDrops.delete(callback) } },
    getDroppedPaths: files => files.map(file => webUtils.getPathForFile(file)).filter(Boolean),
    toolbox: {
      pick: kind => ipcRenderer.invoke('toolbox:pick', kind),
      registerPaths: (paths, kind) => ipcRenderer.invoke('toolbox:register-paths', paths, kind),
      importImage: (bytes, name) => ipcRenderer.invoke('toolbox:import-image', bytes, name),
      readAsset: id => ipcRenderer.invoke('toolbox:read-asset', id),
      releaseAssets: ids => ipcRenderer.invoke('toolbox:release-assets', ids),
      exportText: text => trackedInvoke('toolbox:export-text', text),
      copyText: text => ipcRenderer.invoke('toolbox:copy-text', text),
      beginImageExport: (assets, format) => ipcRenderer.invoke('toolbox:begin-image-export', assets, format),
      exportImage: (batch, name, bytes) => trackedInvoke('toolbox:export-image', batch, name, bytes),
      endImageExport: batch => trackedInvoke('toolbox:end-image-export', batch),
      lanSnapshot: () => ipcRenderer.invoke('toolbox:lan-snapshot'),
      lanEnable: enabled => ipcRenderer.invoke('toolbox:lan-enable', enabled),
      lanConnect: (address, port) => ipcRenderer.invoke('toolbox:lan-connect', address, port),
      lanSend: (device, assets, text) => ipcRenderer.invoke('toolbox:lan-send', device, assets, text),
      lanControl: (id, action) => ipcRenderer.invoke('toolbox:lan-control', id, action),
      onLanChanged: callback => {
        const listener = (_event: Electron.IpcRendererEvent, snapshot: import('../shared/toolbox').LanSnapshot) => callback(snapshot)
        ipcRenderer.on('toolbox:lan-changed', listener)
        return () => ipcRenderer.removeListener('toolbox:lan-changed', listener)
      }
    },
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
    onMainWindowReleaseCheck: check => { mainWindowReleaseCheck = check; return () => { if (mainWindowReleaseCheck === check) mainWindowReleaseCheck = undefined } },
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
    createScreenshotDocument: async source => {
      try {
        if (activeFlush) throw Error('正在恢复或退出，不能导入截图')
        const generation = flushGeneration
        let bytes: Uint8Array
        if (source instanceof Uint8Array) bytes = source
        else {
          if (!source || typeof source.path !== 'string' || Object.keys(source).length !== 1 || !screenshotDrop || source.path !== screenshotDrop.path) throw Error('截图文件未获实际拖入授权')
          const file = screenshotDrop.file
          if (!file.size || file.size > 32 * 1024 * 1024) throw Error('图片无效或过大（最大 32 MB）')
          bytes = new Uint8Array(await file.arrayBuffer())
        }
        if (activeFlush || generation !== flushGeneration) throw Error('截图导入已取消')
        return await trackedInvoke('screenshot:document:create', bytes)
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) } }
    },
    selectScreenshotRegion: (rect, action, tool) => ipcRenderer.invoke('screenshot:region-select', rect, action, tool),
    readScreenshotDocument: (id: string) => ipcRenderer.invoke('screenshot:document:read', id),
    finishScreenshot: (request: import('../shared/screenshotDocument').ScreenshotFinishRequest) => ipcRenderer.invoke('screenshot:finish', request),
    discardScreenshotDocument: (id: string) => ipcRenderer.invoke('screenshot:document:discard', id),
    onScreenshotDocument: (callback: (payload: import('../shared/screenshotDocument').ScreenshotPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/screenshotDocument').ScreenshotPayload) => callback(payload)
      ipcRenderer.on('screenshot:document', listener)
      ipcRenderer.send('screenshot:editor-ready')
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
    previewClipboardImage: (recordId, thumbnail = true) => ipcRenderer.invoke('clipboard:preview-image', recordId, thumbnail),
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
    platform: process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'unsupported'
  }

  contextBridge.exposeInMainWorld('dustdesk', api)
}

if (process.argv?.includes('--dustdesk-controlled-drafts')) installDraftControl()
else if (process.argv?.includes('--dustdesk-read-only-drafts')) installDraftReader()
else installDesktopApi()
