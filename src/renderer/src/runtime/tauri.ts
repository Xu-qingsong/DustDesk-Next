import { Channel, invoke } from '@tauri-apps/api/core'
import type { FilesDropped } from '../../../shared/fileDrop'
import type { ScreenshotDocument, ScreenshotPayload } from '../../../shared/screenshotDocument'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { DesktopPlatform, DustDeskApi, WorkspaceState } from '../../../shared/types'
import type { ActionResult } from '../../../shared/productivity'
import type { ResourceHealth, ResourceScanProgress } from '../../../shared/productivity'
import type { WorkspaceSnapshot } from '../migration/workspace'
import { createRuntimeEvents } from './eventTransport'
import { draftMigrationJournalKey, recoverNativeDraftImport, type NativeDraftDecision } from '../../../shared/draftMigration'
import { runDraftImport } from './draftImport'
import { screenshotFinishBytes } from './screenshotWire'

const unavailable = (name: string) => Error('Tauri 迁移中，尚未接通：' + name)
const reject = (name: string): Promise<never> => Promise.reject(unavailable(name))
function imageHeaders(name: string) {
  if (typeof name !== 'string' || name.length > 1024) throw Error('图片文件名无效或过长')
  return { 'x-dustdesk-name': btoa(String.fromCharCode(...new TextEncoder().encode(name))) }
}
export async function installTauriApi() {
  const label = getCurrentWindow().label
  if (label === 'workspace-main') {
    await invoke('drafts_startup_wait')
    const decision = await invoke<NativeDraftDecision | null>('drafts_recovery')
    if (decision !== null) {
      await recoverNativeDraftImport(localStorage, decision)
      await invoke('drafts_recovery', { finish: true })
    }
  }
  const platform = await invoke<DesktopPlatform>('workspace_platform')
  const lanLease = label === 'workspace-main' ? await invoke<string>('toolbox_lan_attach') : undefined
  if (label.startsWith('workspace-widget-') && localStorage.getItem(draftMigrationJournalKey) !== null) throw Error('存在未完成草稿导入，未打开组件编辑器；请从主窗口受控恢复')
  const events = createRuntimeEvents(label)
  const stops: UnlistenFn[] = []
  const pending = new Set<Promise<unknown>>()
  const fileDrops = new Set<(drop: FilesDropped) => boolean>()
  let dropToken: string | undefined
  const dropChannel = label === 'workspace-main' ? new Channel<FilesDropped & { token: string }>(packet => {
    if (disposed || paused || restoring || releasing || packet.token !== dropToken) return
    for (const callback of [...fileDrops]) {
      try { if (callback(packet)) break } catch (error) { console.error('文件拖入处理失败', error) }
    }
  }) : undefined
  const flushers = new Set<() => Promise<void>>()
  const changes = new Set<(state: WorkspaceState) => void>()
  const resourceProgress = new Set<(value: ResourceScanProgress) => void>()
  const screenshotReceivers = new Set<(payload: ScreenshotPayload) => void>()
  stops.push(() => screenshotReceivers.clear())
  let screenshotReceiving = false
  let screenshotAgain = false
  let receiveScreenshot = () => {}
  let snapshot: WorkspaceSnapshot | undefined
  let paused = false
  let maintenanceId: string | undefined
  let disposed = false
  let shutdownError = ''
  const releaseChecks = new Set<() => boolean>()
  let releasing: string | undefined
  let composing = false
  const startComposition = () => { composing = true }
  const endComposition = () => { composing = false }
  document.addEventListener('compositionstart', startComposition, true)
  document.addEventListener('compositionend', endComposition, true)
  let flushingCallbacks = false
  let restoring = false
  let importing = false
  let restoreFlushingCallbacks = false
  let restoreOperation: Promise<ActionResult> | undefined
  let flushGeneration = 0
  const accept = (next: WorkspaceSnapshot) => {
    if (snapshot && next.revision < snapshot.revision) return snapshot
    snapshot = next
    for (const callback of changes) callback(next.state)
    return next
  }
  const tracked = <Result,>(operation: Promise<Result>) => {
    pending.add(operation)
    void operation.then(() => pending.delete(operation), () => pending.delete(operation))
    return operation
  }
  const trackedLan = <Result,>(operation: Promise<Result>) => {
    // LAN decisions are canceled by native lifecycle barriers. Wait for their
    // completion without treating a declined/canceled request as a lost edit.
    void tracked(operation.then(() => undefined, () => undefined))
    return operation
  }
  const subscribe = <Arguments extends unknown[]>(event: string, callback: (...args: Arguments) => void) => {
    let active = true
    let stop: UnlistenFn | undefined
    void events.listen<Arguments>(event, message => { if (active) callback(...message.payload) }).then(unlisten => {
      if (!active || disposed) unlisten()
      else { stop = unlisten; stops.push(unlisten) }
    }).catch(error => { shutdownError = String(error) })
    return () => { active = false; stop?.() }
  }
  let flushing = false
  const flush = async (requestId: string, maintenance = false) => {
    if (flushing) return
    if (maintenance) maintenanceId = requestId
    releasing = undefined
    const generation = ++flushGeneration
    flushing = true
    paused = true
    document.documentElement.inert = true
    let error: string | undefined
    try {
      if (maintenance && composing) throw Error('输入法组合输入尚未结束，请完成输入后再准备迁移')
      if (restoreOperation) {
        const result = await restoreOperation
        if (!result.ok) throw Error(result.error || '恢复未完成，已取消退出')
      }
      flushingCallbacks = true
      for (const callback of flushers) {
        await callback()
        if (generation !== flushGeneration || disposed) return
      }
      flushingCallbacks = false
      while (pending.size) await Promise.all([...pending])
    } catch (reason) {
      if (generation !== flushGeneration || disposed) return
      flushingCallbacks = false; error = reason instanceof Error ? reason.message : String(reason)
    }
    if (generation !== flushGeneration || disposed) return
    try { await invoke(maintenance ? 'drafts_checkpoint_ready' : 'application_flushed', { requestId, error: error ?? null }) }
    catch (reason) { if (generation === flushGeneration) { if (maintenance) maintenanceId = undefined; resume(String(reason)) } }
  }
  const resume = (error: string) => {
    ++flushGeneration
    flushingCallbacks = false
    flushing = false; paused = false; shutdownError = error
    document.documentElement.inert = restoring
    window.dispatchEvent(new CustomEvent('dustdesk:quit-error', { detail: error }))
  }
  const releaseReady = () => !paused && !restoring && !importing && !disposed && !releasing && !composing && pending.size === 0 && releaseChecks.size > 0 && [...releaseChecks].every(check => check() === true)
  const resumeRelease = (requestId: string) => {
    if (releasing !== requestId) return
    releasing = undefined
    document.documentElement.inert = paused || restoring
  }
  try {
    if (label === 'workspace-main') stops.push(await events.listen('screenshot:editor', () => receiveScreenshot()))
    stops.push(await events.listen<WorkspaceSnapshot>('workspace:snapshot', event => accept(event.payload)))
    stops.push(await events.listen<{ requestId: string }>('lifecycle:flush', event => { void flush(event.payload.requestId) }))
    stops.push(await events.listen<string>('lifecycle:resume', event => resume(event.payload)))
    stops.push(await events.listen<{ requestId: string }>('drafts:flush', event => { void flush(event.payload.requestId, true) }))
    stops.push(await events.listen<{ requestId: string; error: string; reload?: boolean }>('drafts:resume', event => {
      if (maintenanceId !== event.payload.requestId) return
      if (event.payload.reload) {
        disposed = true
        ++flushGeneration
        document.documentElement.inert = true
        location.reload()
        return
      }
      maintenanceId = undefined
      resume(event.payload.error)
    }))
    stops.push(await events.listen<string>('window:release-check', event => {
      const requestId = event.payload
      let ready = false
      try { ready = releaseReady() } catch { ready = false }
      if (ready) { releasing = requestId; document.documentElement.inert = true }
      void invoke<boolean>('window_release_ready', { requestId, ready }).then(accepted => { if (!accepted) resumeRelease(requestId) }).catch(() => resumeRelease(requestId))
    }))
    stops.push(await events.listen<string>('window:release-resume', event => resumeRelease(event.payload)))
    stops.push(await events.listen<string>('system:action-error', event => { void import('sonner').then(({ toast }) => toast.error(event.payload)) }))
    stops.push(await events.listen<ResourceScanProgress>('resources:progress', event => {
      const value = event.payload
      if (value.item) value.item = { ...value.item, parentId: value.item.parentId }
      for (const callback of resourceProgress) callback(value)
    }))
    await events.connect()
    if (label === 'workspace-main') {
      const status = await invoke<{disabled:boolean;error:string|null}>('hotkeys_status')
      if (status.error) void import('sonner').then(({toast}) => toast.error(`快捷键未应用：${status.error}`))
    }
    if (dropChannel) dropToken = await invoke<string>('file_drop_attach', {channel:dropChannel})
  } catch (error) { for (const stop of stops) stop(); events.dispose(); document.removeEventListener('compositionstart', startComposition, true); document.removeEventListener('compositionend', endComposition, true); throw error }
  const writable = () => !releasing && (!paused || flushingCallbacks) && (!restoring || restoreFlushingCallbacks)
  const screenshotPayload = async (document: ScreenshotDocument): Promise<ScreenshotPayload> => {
    const bytes = await invoke<ArrayBuffer>('screenshot_source', { id: document.id })
    return { document, png: new Uint8Array(bytes) }
  }
  receiveScreenshot = () => {
    if (label !== 'workspace-main' || disposed || !writable() || importing || !screenshotReceivers.size) return
    if (screenshotReceiving) { screenshotAgain = true; return }
    screenshotReceiving = true
    const operation = (async () => {
      do {
        screenshotAgain = false
        let delivery: {ticket: string; document: ScreenshotDocument} | null = null
        try {
          delivery = await invoke('screenshot_editor_pending')
          if (!delivery) continue
          const payload = await screenshotPayload(delivery.document)
          if (disposed || !writable() || importing || !screenshotReceivers.size) throw Error('主编辑页当前不能接收截图')
          await invoke('screenshot_editor_received', {ticket: delivery.ticket, error: null})
          for (const callback of [...screenshotReceivers]) callback(payload)
        } catch (error) {
          if (delivery && !disposed) await invoke('screenshot_editor_received', {ticket: delivery.ticket, error: String(error)}).catch(() => undefined)
        }
      } while (screenshotAgain && !disposed && writable() && !importing && screenshotReceivers.size)
    })()
    void tracked(operation).finally(() => { screenshotReceiving = false }).catch(error => console.error('截图交接失败', error))
  }
  const restoreBackup: DustDeskApi['restoreBackup'] = (path, fingerprint) => {
    if (paused || restoring || importing) return Promise.resolve({ ok: false, error: '正在保存、恢复或退出，请稍后重试' })
    restoring = true
    document.documentElement.inert = true
    const operation = (async (): Promise<ActionResult> => {
      try {
        await invoke('system_cancel_picker')
        restoreFlushingCallbacks = true
        for (const callback of flushers) await callback()
        restoreFlushingCallbacks = false
        while (pending.size) await Promise.all([...pending])
        const reply = await invoke<{result: ActionResult; snapshot: WorkspaceSnapshot | null}>('workspace_backup_restore', { path: path ?? null, fingerprint: fingerprint ?? null })
        if (reply.snapshot) accept(reply.snapshot)
        return reply.result
      } catch (error) { return { ok: false, error: String(error) } }
      finally { restoring = false; restoreFlushingCallbacks = false; document.documentElement.inert = paused }
    })()
    restoreOperation = operation
    void operation.finally(() => { if (restoreOperation === operation) restoreOperation = undefined })
    return operation
  }
  const background = (command: string, noteId: string, expectedPath: string | null | undefined, source?: string) => {
    if (!writable()) return Promise.resolve({ ok:false, error:'正在恢复或退出，不能修改背景' })
    return tracked(invoke<{result: Awaited<ReturnType<DustDeskApi['pickNoteBackground']>>; snapshot:WorkspaceSnapshot|null}>(command,{noteId,expectedPath:expectedPath??null,checkExpected:expectedPath!==undefined,...(source!==undefined?{source}:{})}).then(reply=>{
      if(reply.snapshot) accept(reply.snapshot)
      return reply.result
    }).catch(error=>({ok:false,error:String(error)})))
  }
  const organizer = (action: 'move'|'restore'|'undo', categoryId?:string, source?:string) => {
    if(!writable()) return Promise.resolve({ok:false,error:'正在恢复或退出，不能移动文件'})
    return tracked(invoke<{result:Awaited<ReturnType<DustDeskApi['moveIntoCategory']>>;snapshot:WorkspaceSnapshot|null}>('workspace_organizer',{action,categoryId:categoryId??null,source:source??null}).then(reply=>{
      if(reply.snapshot) accept(reply.snapshot)
      return reply.result
    }).catch(error=>({ok:false,error:String(error)})))
  }
  type WidgetReply={ok:boolean;error?:string;visible?:boolean}
  const widgetAction=(command:string,args:Record<string,unknown>):Promise<WidgetReply>=>!writable()?Promise.resolve({ok:false,error:'正在恢复或退出，不能修改组件'}):tracked(invoke<WidgetReply>(command,args).catch(error=>({ok:false,error:String(error)})))
  const widgetMoves=new Map<string,Promise<WidgetReply>>()
  const geometry=(key:string,first:number,second:number,resize:boolean,commit=false)=>{
    const next=(widgetMoves.get(key)??Promise.resolve()).then(()=>widgetAction('widgets_geometry',{key,first,second,resize,commit}))
    widgetMoves.set(key,next);void next.then(()=>{if(widgetMoves.get(key)===next)widgetMoves.delete(key)})
    return next
  }
  const api: DustDeskApi = {
    platform,
    loadWorkspace: async () => accept(await invoke<WorkspaceSnapshot>('workspace_load')).state,
    saveWorkspace: (state, baseline) => !writable() ? Promise.reject(Error('正在恢复或退出，不能接受新保存')) : tracked(invoke<WorkspaceSnapshot>('workspace_save', { state, baseline: baseline ?? null }).then(next => {
      const accepted = accept(next)
      return { ok: true as const, path: accepted.path }
    })),
    getDataLocation: () => invoke<string>('workspace_location'),
    onWorkspaceChanged: callback => { changes.add(callback); return () => { changes.delete(callback) } },
    onBeforeQuit: callback => { flushers.add(callback); return () => { flushers.delete(callback) } },
    onMainWindowReleaseCheck: callback => { releaseChecks.add(callback); return () => { releaseChecks.delete(callback) } },
    showMainWindow: () => invoke('workspace_window', { visible: true }),
    hideMainWindow: () => invoke('workspace_window', { visible: false }),
    toolbox: {
      pick: kind => !writable() ? Promise.reject(Error('正在恢复或退出，不能导入图片')) : tracked(invoke('toolbox_pick', {kind})),
      registerPaths: (paths,kind) => !writable() ? Promise.reject(Error('正在恢复或退出，不能导入图片')) : tracked(invoke('toolbox_register_paths', {paths,kind})),
      importImage: (bytes,name) => !writable() ? Promise.reject(Error('正在恢复或退出，不能导入图片')) : tracked(invoke('toolbox_import_image', bytes, {headers:imageHeaders(name)})),
      readAsset: id => !writable() ? Promise.reject(Error('正在恢复或退出，不能读取图片')) : tracked(invoke<ArrayBuffer>('toolbox_read_asset', {id}).then(bytes=>new Uint8Array(bytes))),
      releaseAssets: ids => tracked(invoke('toolbox_release_assets', {ids})),
      exportText: text => !writable() ? Promise.reject(Error('正在恢复或退出，不能导出文本')) : tracked(invoke('toolbox_export_text', { text })),
      copyText: text => !writable() ? Promise.reject(Error('正在恢复或退出，不能复制文本')) : tracked(invoke('toolbox_copy_text', { text })),
      beginImageExport: (assets,format) => !writable() ? Promise.reject(Error('正在恢复或退出，不能导出图片')) : tracked(invoke('toolbox_begin_image_export', {assets,format})),
      exportImage: (batch,name,bytes) => !writable() ? Promise.reject(Error('正在恢复或退出，不能导出图片')) : tracked(invoke('toolbox_export_image', bytes, {headers:{...imageHeaders(name),'x-dustdesk-batch':batch}})),
      endImageExport: batch => !writable() ? Promise.reject(Error('正在恢复或退出，不能导出图片')) : tracked(invoke('toolbox_end_image_export', {batch})),
      lanSnapshot: () => trackedLan(invoke('toolbox_lan_snapshot',{lease:lanLease})),
      lanEnable: enabled => !writable() ? Promise.reject(Error('正在恢复或退出，不能更改局域网服务')) : trackedLan(invoke('toolbox_lan_enable', {lease:lanLease,enabled})),
      lanConnect: (address,port) => !writable() ? Promise.reject(Error('正在恢复或退出，不能连接设备')) : trackedLan(invoke('toolbox_lan_connect', {lease:lanLease,address,port})),
      lanSend: (device,assets,text) => !writable() ? Promise.reject(Error('正在恢复或退出，不能发送内容')) : trackedLan(invoke('toolbox_lan_send', {lease:lanLease,device,assets,text:text??null})),
      lanControl: (id,action) => !writable() ? Promise.reject(Error('正在恢复或退出，不能操作传输')) : trackedLan(invoke('toolbox_lan_control', {lease:lanLease,id,action})),
      onLanChanged: callback => subscribe('runtime:onLanChanged', callback),
    },
    getDroppedPaths: () => { throw unavailable('getDroppedPaths：请使用 onFilesDropped 原生拖放事件') },
    onFilesDropped: callback => { fileDrops.add(callback); return () => { fileDrops.delete(callback) } },
    selectScreenshotRegion: async () => ({ ok: false, error: unavailable('selectScreenshotRegion').message }),
    createScreenshotDocument: source => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出，不能导入截图'}) : tracked(Promise.resolve().then(() => {
      if (source instanceof Uint8Array) return invoke<ScreenshotDocument>('screenshot_create', source)
      if (!source || typeof source.path !== 'string' || Object.keys(source).length !== 1) throw Error('截图导入来源无效')
      return invoke<ScreenshotDocument>('screenshot_import', {path:source.path})
    }).then(async document => {
      try { return {ok:true,payload:await screenshotPayload(document)} }
      catch (error) { void invoke('screenshot_discard',{id:document.id}).catch(()=>undefined); throw error }
    }).catch(error=>({ok:false,error:String(error)}))),
    readScreenshotDocument: id => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出，不能读取截图'}) : tracked(invoke<ScreenshotDocument>('screenshot_document', {id}).then(screenshotPayload).then(payload=>({ok:true,payload})).catch(error=>({ok:false,error:String(error)}))),
    finishScreenshot: request => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出，不能输出截图'}) : tracked(Promise.resolve().then(()=>invoke<Awaited<ReturnType<DustDeskApi['finishScreenshot']>>>('screenshot_finish', screenshotFinishBytes(request))).catch(error=>({ok:false,error:String(error)}))),
    discardScreenshotDocument: id => tracked(invoke('screenshot_discard', {id})),
    onScreenshotDocument: callback => { screenshotReceivers.add(callback); receiveScreenshot(); return () => { screenshotReceivers.delete(callback) } },
    readPinnedScreenshot: async () => ({ ok: false, error: unavailable('readPinnedScreenshot').message }),
    onPinnedScreenshotSaveRequested: callback => subscribe('runtime:onPinnedScreenshotSaveRequested', callback),
    savePinnedScreenshot: async () => ({ ok: false, error: unavailable('savePinnedScreenshot').message }),
    controlPinnedScreenshot: async () => ({ ok: false, error: unavailable('controlPinnedScreenshot').message }),
    onPinnedScreenshotChanged: callback => subscribe('runtime:onPinnedScreenshotChanged', callback),
    productivity: action => !writable() ? Promise.resolve({ ok: false, error: '正在恢复或退出，不能接受新操作' }) : tracked(invoke<{result: ActionResult; snapshot: WorkspaceSnapshot | null}>('workspace_productivity', { action }).then(reply => {
      if (reply.snapshot) accept(reply.snapshot)
      return reply.result
    }).catch(error => ({ ok: false, error: String(error) }))),
    backupStatus: () => invoke('workspace_backup_status'),
    previewBackup: path => invoke('workspace_backup_preview', { path }),
    checkResources: async request => (await invoke<ResourceHealth[]>('workspace_resources_check', { request: request ?? null })).map(item => ({ ...item, parentId: item.parentId })),
    cancelResourceCheck: requestId => invoke('workspace_resources_cancel', { requestId }),
    onResourceCheckProgress: callback => {
      resourceProgress.add(callback)
      return () => { resourceProgress.delete(callback) }
    },
    showQuickCapture: () => invoke('quick_capture_show'),
    hideQuickCapture: () => invoke('quick_capture_request_hide'),
    pickNoteBackground: (noteId,expectedPath) => background('workspace_note_pick',noteId,expectedPath),
    importNoteBackground: (noteId,source,expectedPath) => background('workspace_note_import',noteId,expectedPath,source),
    clearNoteBackground: (noteId,expectedPath) => background('workspace_note_clear',noteId,expectedPath),
    pickFolder: title => !writable() ? Promise.resolve({ok:false,canceled:true}) : tracked(invoke('system_pick',{folder:true,title:title??null})),
    pickPath: title => !writable() ? Promise.resolve({ok:false,canceled:true}) : tracked(invoke('system_pick',{folder:false,title:title??null})),
    readImageFile: path => invoke('workspace_note_image', { path }),
    openPath: target => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出'}) : tracked(invoke('system_open',{target,url:false})),
    getPathIcon: target => typeof target !== 'string' ? Promise.resolve({}) : invoke('system_icon', { target }),
    showPathContextMenu: target => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出'}) : tracked(invoke('system_path_menu',{target})),
    openUrl: target => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出'}) : tracked(invoke('system_open',{target,url:true})),
    toggleWidgets: key => widgetAction('widgets_set',{key:key??'todo',visible:null}).then(result=>{if(!result.ok)throw Error(result.error);return {visible:result.visible===true}}),
    getWidgetVisibility: keys => invoke<Record<string,boolean>>('widgets_visibility',{keys}),
    hideWidget: key => widgetAction('widgets_set',{key,visible:false}),
    setWidgetVisibility: (key,visible) => widgetAction('widgets_set',{key,visible}).then(async result=>({...result,visible:result.visible??(await invoke<Record<string,boolean>>('widgets_visibility',{keys:[key]}).catch(()=>({} as Record<string,boolean>)))[key]??false})),
    setWidgetOptions: (key,options) => widgetAction('widgets_options',{key,options}),
    moveWidget: (key,coordinateX,coordinateY,commit) => geometry(key,coordinateX,coordinateY,false,commit),
    resizeWidget: (key,width,height,commit) => geometry(key,width,height,true,commit),
    listWidgetPresets: () => invoke<string[]>('widgets_presets',{action:'list',name:null}),
    saveWidgetPreset: name => widgetAction('widgets_presets',{action:'save',name}),
    applyWidgetPreset: name => widgetAction('widgets_presets',{action:'apply',name}),
    deleteWidgetPreset: name => widgetAction('widgets_presets',{action:'delete',name}),
    listScreenshotWindows: () => !writable() ? Promise.resolve({ok:false,message:'正在恢复或退出，不能列举截图窗口'}) : tracked(invoke<NonNullable<Awaited<ReturnType<DustDeskApi['listScreenshotWindows']>>['sources']>>('screenshot_windows').then(sources=>({ok:true,sources})).catch(error=>({ok:false,message:String(error)}))),
    startScreenshot: (mode = 'Region', sourceId) => !writable() ? Promise.resolve({ok:false,message:'正在恢复或退出，不能开始截图'}) : tracked(invoke<Awaited<ReturnType<DustDeskApi['startScreenshot']>>>('screenshot_start', {mode,sourceId:sourceId ?? null}).catch(error=>({ok:false,message:String(error)}))),
    onScreenshotOverlaySource: callback => subscribe('runtime:onScreenshotOverlaySource', callback),
    onScreenshotCaptured: callback => subscribe('runtime:onScreenshotCaptured', callback),
    submitScreenshotOverlay: () => reject('submitScreenshotOverlay'),
    cancelScreenshotOverlay: () => reject('cancelScreenshotOverlay'),
    saveScreenshot: async () => ({ ok: false, error: unavailable('saveScreenshot').message }),
    pinScreenshot: async () => ({ ok: false, error: unavailable('pinScreenshot').message }),
    readClipboard: () => invoke('clipboard_read'),
    previewClipboardImage: (recordId,thumbnail=true) => typeof recordId!=='string' || !recordId || recordId.length>128 || typeof thumbnail!=='boolean' ? Promise.resolve({ok:false,error:'剪贴板图片请求无效'}) : invoke<Awaited<ReturnType<DustDeskApi['previewClipboardImage']>>>('clipboard_preview',{recordId,thumbnail}).catch(error=>({ok:false,error:String(error)})),
    writeClipboard: content => !writable() ? Promise.reject(Error('正在恢复或退出，不能写入剪贴板')) : tracked(invoke('clipboard_write',{content})),
    onClipboardChanged: callback => subscribe('runtime:onClipboardChanged', callback),
    listDesktopEntries: () => invoke('system_desktop_entries'),
    moveIntoCategory: (categoryId,source) => organizer('move',categoryId,source),
    restoreToDesktop: (categoryId,source) => organizer('restore',categoryId,source),
    sampleSystemMetrics: () => writable() ? invoke('system_sample') : Promise.reject(Error('正在恢复或退出，不能采样系统指标')),
    getStartupEnabled: () => invoke('system_startup',{enabled:null}),
    setStartupEnabled: enabled => !writable() ? Promise.reject(Error('正在恢复或退出，不能更改开机启动')) : tracked(invoke('system_startup',{enabled}).then(()=>undefined)),
    createBackup: () => !writable() ? Promise.resolve({ ok: false, error: '正在恢复或退出，不能创建备份' }) : tracked(invoke('workspace_backup_create')),
    listBackups: () => invoke('workspace_backup_list'),
    restoreBackup,
    searchFiles: (query,requestId) => !writable() ? Promise.resolve([]) : invoke('system_search_files',{query,requestId:requestId??null}),
    cancelFileSearch: requestId => invoke('system_search_cancel',{requestId}),
    setHotkeys: keys => !writable() ? Promise.resolve({ok:false,error:'正在恢复或退出，不能修改快捷键'}) : tracked(invoke<ActionResult>('hotkeys_set', {keys}).catch(error => ({ok:false,error:String(error)}))),
    exportProjects: () => !writable() ? Promise.resolve({ ok: false, error: '正在恢复或退出，不能导出项目' }) : tracked(invoke<Awaited<ReturnType<DustDeskApi['exportProjects']>>>('projects_export').catch(error => ({ ok: false, error: String(error) }))),
    planSmartOrganize: async () => {
      if (!writable()) throw Error('正在恢复或退出，不能生成整理预览')
      const reply = await invoke<{result:Awaited<ReturnType<DustDeskApi['planSmartOrganize']>>}>('workspace_organizer', { action:'plan' })
      return reply.result
    },
    executeSmartOrganize: plan => {
      if (!writable()) return Promise.resolve({ok:false,moved:0,error:'正在恢复或退出，不能移动文件'})
      return tracked(invoke<{result:Awaited<ReturnType<DustDeskApi['executeSmartOrganize']>>;snapshot:WorkspaceSnapshot|null}>('workspace_organizer',{action:'execute',plan:plan??null}).then(reply=>{
        if(reply.snapshot) accept(reply.snapshot)
        return reply.result
      }).catch(error=>({ok:false,moved:0,error:String(error)})))
    },
    undoOrganizerMove: () => organizer('undo'),
    checkForUpdate: () => !writable() ? Promise.resolve({ ok: false, available: false, error: '正在恢复或退出，不能检查更新' }) : tracked(invoke<Awaited<ReturnType<DustDeskApi['checkForUpdate']>>>('release_check').catch(error => ({ ok: false, available: false, error: String(error) }))),
    onWidgetVisibilityChanged: callback => subscribe('runtime:onWidgetVisibilityChanged', callback),
    onWidgetAppearance: callback => subscribe('runtime:onWidgetAppearance', callback),
  }
  window.dustdesk = api
  return {
    api,
    initialize: async () => accept(await invoke<WorkspaceSnapshot>('workspace_initialize')),
    quit: () => invoke<void>('application_quit'),
    importDrafts: (serialized: string) => {
      if (label !== 'workspace-main' || paused || restoring || importing || releasing || disposed) return Promise.reject(Error('当前窗口不能开始草稿导入'))
      importing = true
      return runDraftImport(serialized, {
        invoke,
        storage: localStorage,
        active: requestId => maintenanceId === requestId && paused && document.documentElement.inert,
        currentRequest: () => maintenanceId,
        alive: () => !disposed,
        message: text => { sessionStorage.setItem('dustdesk:draft-import:message', text) },
        block: text => { try { sessionStorage.setItem('dustdesk:draft-import:message', text) } catch {} document.documentElement.inert = true; location.reload() },
      }).finally(() => { importing = false })
    },
    get paused() { return paused },
    get error() { return shutdownError },
    canRelease: releaseReady,
    dispose: () => { disposed = true; ++flushGeneration; if(dropChannel)dropChannel.onmessage=()=>undefined;if(dropToken)void invoke('file_drop_detach',{token:dropToken}).catch(()=>{});fileDrops.clear();for (const stop of stops) stop(); events.dispose(); document.removeEventListener('compositionstart', startComposition, true); document.removeEventListener('compositionend', endComposition, true); changes.clear(); resourceProgress.clear(); flushers.clear(); releaseChecks.clear() }
  }
}
