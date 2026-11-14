import { ipcMain, Notification } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { WorkspaceState } from '../shared/types'
import type { BackupPreview, ProductivityAction, ResourceHealth, ResourceScanRequest, ResourceScanProgress } from '../shared/productivity'
import { focusElapsed } from '../shared/productivity'
import { isHttpUrl } from '../shared/urls'
import { applyProductivityAction, finishFocus } from './productivityState'
import { assertPathWithinRoot, isWithinDirectory, safeName } from './fileOperations'
import { isCompleteWorkspace } from './workspaceValidation'
import { createClipboardAssets } from './clipboardAssets'

interface Dependencies {
  read(): Promise<WorkspaceState>
  update(mutator: (state: WorkspaceState) => void | Promise<void>): Promise<{ state: WorkspaceState }>
  enqueue<T>(operation: () => Promise<T>): Promise<T>
  broadcast(state: WorkspaceState): void
  directory(): string
}

function validatedNoteAssets(value: unknown) {
  if (value === undefined) return []
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('备份中的图片集合无效')
  return Object.entries(value).map(([original, content]) => {
    if (typeof content !== 'string' || !content || content.length > 16 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(content)) throw new Error('备份中的图片数据无效')
    const extension = path.extname(original).toLowerCase()
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(extension)) throw new Error('备份图片格式无效')
    if (Buffer.from(content, 'base64').toString('base64') !== content) throw new Error('备份中的图片编码无效')
    return { original, content, extension }
  })
}

export function createProductivityRuntime(deps: Dependencies) {
  let timer: NodeJS.Timeout | undefined
  let ticking = false
  let activeFocusExpected = false
  let lastMaintenance = 0
  let backupError = ''
  let lastAutomaticBackupAt = ''
  const scans = new Map<number, { requestId: string; controller: AbortController }>()
  const directory = () => path.join(deps.directory(), 'Backups')
  const clipboardAssets = createClipboardAssets(deps.directory)

  // Caller holds the workspace mutation queue. Managed note images travel with the JSON.
  async function backup(state: WorkspaceState, kind: 'manual' | 'auto' | 'before-restore' = 'manual') {
    const root = directory()
    await assertPathWithinRoot(deps.directory(), root, true)
    await fs.mkdir(root, { recursive: true })
    const assets: Record<string, string> = {}
    const warnings: string[] = []
    const notes = [...state.Notes, ...state.RecycleBin.flatMap(item => item.kind === 'note' ? [item.value] : [])]
    for (const note of notes) {
      if (!note.BackgroundImagePath) continue
      const target = path.resolve(note.BackgroundImagePath)
      try {
        await assertPathWithinRoot(path.join(deps.directory(), 'NoteBackgrounds'), target)
        const info = await fs.stat(target)
        if (info.size > 12 * 1024 * 1024) throw new Error('便签背景过大，备份未完成')
        assets[target] = (await fs.readFile(target)).toString('base64')
      } catch (error) {
        if (kind !== 'before-restore') throw error
        warnings.push(`便签「${note.Title}」的背景未能读取，已保留原路径：${target}`)
      }
    }
    const portable = await clipboardAssets.forBackup(state, kind === 'before-restore' ? warnings : undefined)
    const target = path.join(root, `${kind}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.json`)
    await assertPathWithinRoot(deps.directory(), target, true)
    const temporary = `${target}.tmp`
    try {
      await fs.writeFile(temporary, JSON.stringify({ ...portable, BackupNoteAssets: assets, BackupWarnings: warnings }), { flag: 'wx' })
      await fs.rename(temporary, target)
    } catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error }
    if (kind === 'auto') lastAutomaticBackupAt = new Date().toISOString()
    return target
  }

  async function protectBeforeRestore() {
    let state: WorkspaceState
    try { state = await deps.read() }
    catch {
      const root = directory()
      await assertPathWithinRoot(deps.directory(), root, true)
      await fs.mkdir(root, { recursive: true })
      for (const name of ['workspace.json', 'workspace.json.bak']) {
        const source = path.join(deps.directory(), name)
        const target = path.join(root, `before-restore-damaged-${Date.now()}-${crypto.randomUUID()}.json`)
        await assertPathWithinRoot(deps.directory(), source, true)
        await assertPathWithinRoot(root, target, true)
        try { await fs.copyFile(source, target) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      }
      return
    }
    await backup(state, 'before-restore')
  }

  async function inspect(target: string): Promise<{ raw: WorkspaceState; preview: BackupPreview }> {
    if (typeof target !== 'string' || !target.endsWith('.json')) throw new Error('备份路径无效')
    await assertPathWithinRoot(directory(), target)
    const contents = await fs.readFile(target, 'utf8')
    const raw = JSON.parse(contents) as WorkspaceState
    if (!isCompleteWorkspace(raw) || Number(raw.SchemaVersion) > 3) throw new Error('备份文件不完整或版本不受支持')
    validatedNoteAssets(raw.BackupNoteAssets)
    const info = await fs.stat(target)
    return { raw, preview: { path: target, modifiedAt: info.mtime.toISOString(), tasks: raw.Todos.length, notes: raw.Notes.length, projects: raw.Projects.length, links: raw.LinkGroups.reduce((sum, group) => sum + group.Links.length, 0), focusSessions: Array.isArray(raw.FocusSessions) ? raw.FocusSessions.length : 0, recycleEntries: Array.isArray(raw.RecycleBin) ? raw.RecycleBin.length : 0, fingerprint: createHash('sha256').update(contents).digest('hex'), warnings: Array.isArray(raw.BackupWarnings) ? raw.BackupWarnings.filter((item): item is string => typeof item === 'string') : [] } }
  }

  async function restoreAssets(state: WorkspaceState) {
    const assets = validatedNoteAssets(state.BackupNoteAssets)
    const created: string[] = []
    const rollback = async () => {
      for (const target of created) await fs.rm(target, { force: true }).catch(() => undefined)
    }
    if (!assets.length) { delete state.BackupNoteAssets; delete state.BackupWarnings; return rollback }
    const replacements = new Map<string, string>()
    const root = path.join(deps.directory(), 'NoteBackgrounds')
    await assertPathWithinRoot(deps.directory(), root, true)
    await fs.mkdir(root, { recursive: true })
    try {
      for (const { original, content, extension } of assets) {
        const destination = path.join(root, `restored-${crypto.randomUUID()}${extension}`)
        await assertPathWithinRoot(root, destination, true)
        const file = await fs.open(destination, 'wx')
        created.push(destination)
        try { await file.writeFile(Buffer.from(content, 'base64')) } finally { await file.close() }
        replacements.set(original, destination)
      }
    } catch (error) { await rollback(); throw error }
    const notes = [...state.Notes, ...state.RecycleBin.flatMap(item => item.kind === 'note' ? [item.value] : [])]
    for (const note of notes) if (note.BackgroundImagePath && replacements.has(note.BackgroundImagePath)) {
      note.BackgroundImagePath = replacements.get(note.BackgroundImagePath)!
      note.BackgroundImageFileName = path.basename(note.BackgroundImagePath)
    }
    delete state.BackupNoteAssets
    delete state.BackupWarnings
    return rollback
  }

  async function maintenance() {
    await deps.enqueue(async () => {
      const state = await deps.read()
      if (!state.Settings.AutomaticBackupEnabled) return
      const date = new Date().toLocaleDateString('en-CA')
      const root = directory()
      await assertPathWithinRoot(deps.directory(), root, true)
      await fs.mkdir(root, { recursive: true })
      const entries = (await fs.readdir(root, { withFileTypes: true })).filter(item => item.isFile() && /^auto-.*\.json$/.test(item.name))
      const points = await Promise.all(entries.map(async item => ({ target: path.join(root, item.name), info: await fs.stat(path.join(root, item.name)) })))
      lastAutomaticBackupAt = points.map(item => item.info.mtime.toISOString()).sort().at(-1) ?? ''
      if (!points.some(item => item.info.mtime.toLocaleDateString('en-CA') === date)) await backup(state, 'auto')
      const retention = Math.max(1, Math.min(365, Math.round(state.Settings.BackupRetentionDays)))
      for (const point of points) if (Date.now() - point.info.mtimeMs > retention * 86_400_000) {
        await assertPathWithinRoot(root, point.target)
        await fs.unlink(point.target)
      }
    })
  }

  async function pauseAtCheckpoint() {
    const current = await deps.read()
    if (!current.ActiveFocus?.RunningSince) return
    const { state } = await deps.update(state => {
      const active = state.ActiveFocus
      if (!active?.RunningSince) return
      active.ElapsedSeconds = focusElapsed(active, Date.parse(active.CheckpointAt)); active.RunningSince = null
    })
    deps.broadcast(state)
  }

  async function tick() {
    if (ticking || (!activeFocusExpected && Date.now() - lastMaintenance <= 60_000)) return
    ticking = true
    try {
      const current = await deps.read()
      activeFocusExpected = Boolean(current.ActiveFocus?.RunningSince)
      if (current.ActiveFocus?.RunningSince || current.RecycleBin.some(item => Date.parse(item.ExpiresAt) <= Date.now())) {
        let completed = false
        const { state } = await deps.update(state => {
          state.RecycleBin = state.RecycleBin.filter(item => Date.parse(item.ExpiresAt) > Date.now())
          const active = state.ActiveFocus
          if (!active?.RunningSince) return
          const now = Date.now()
          // A suspended computer cannot silently add hours of focus time.
          if (now - Date.parse(active.CheckpointAt) > 20_000) {
            active.ElapsedSeconds = focusElapsed(active, Date.parse(active.CheckpointAt)); active.RunningSince = null
          } else if (focusElapsed(active, now) >= active.PlannedSeconds) { finishFocus(state, now); completed = true }
          else active.CheckpointAt = new Date(now).toISOString()
        })
        activeFocusExpected = Boolean(state.ActiveFocus?.RunningSince)
        deps.broadcast(state)
        if (completed && Notification.isSupported()) new Notification({ title: '专注完成', body: '本轮专注已记录，可以休息一下。' }).show()
      }
      if (Date.now() - lastMaintenance > 60_000) {
        lastMaintenance = Date.now()
        try { await maintenance(); backupError = '' }
        catch (error) { backupError = error instanceof Error ? error.message : String(error); console.error('Automatic backup failed:', backupError) }
      }
    } catch (error) { console.error('DustDesk maintenance:', error) } finally { ticking = false }
  }

  function resources(state: WorkspaceState): ResourceHealth[] {
    const result: ResourceHealth[] = []
    const add = (kind: ResourceHealth['kind'], id: string, name: string, target: string, parentId?: string) => { if (target) result.push({ kind, id, parentId, name, target, status: 'ok', detail: '' }) }
    state.Launchers.forEach(item => add('launcher', item.Id, item.Name, item.Path))
    state.Projects.forEach(project => {
      add('project', project.Id, project.Name, project.ProjectPath)
      project.Phases.forEach(phase => {
        add('phase', phase.Id, `${project.Name} / ${phase.Title}`, phase.ProjectPath, project.Id)
        phase.Subtasks.forEach(item => add('subtask', item.Id, `${project.Name} / ${item.Title}`, item.FilePath, phase.Id))
      })
    })
    state.DesktopCategories.forEach(category => category.ItemPaths.forEach(target => add('organizer', target, category.Name, target, category.Id)))
    state.LinkGroups.forEach(group => group.Links.forEach(link => add('link', link.Id, link.Name, link.Url, group.Id)))
    return result
  }

  async function scanResources(request: ResourceScanRequest, signal: AbortSignal, progress: (value: ResourceScanProgress) => void) {
    const available = resources(await deps.read())
    const result = request.resource ? available.filter(item => item.kind === request.resource!.kind && item.id === request.resource!.id && item.parentId === request.resource!.parentId && item.target === request.resource!.target) : available
    if (request.resource && !result.length) throw new Error('资源已变化，请重新检查')
    const completed = new Set<ResourceHealth>()
    progress({ requestId: request.requestId, completed: 0, total: result.length })
    let index = 0
    const workers = Promise.all(Array.from({ length: 4 }, async () => {
      while (!signal.aborted && index < result.length) {
        const item = result[index++]!
        try {
          if (item.kind !== 'link') { await fs.access(item.target); item.detail = '路径可用' }
          else {
            if (!isHttpUrl(item.target)) throw new Error('需要 HTTP/HTTPS 地址')
            const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)])
            let response = await fetch(item.target, { method: 'HEAD', signal: requestSignal })
            if ([405, 501].includes(response.status)) { await response.body?.cancel(); response = await fetch(item.target, { method: 'GET', signal: requestSignal }) }
            item.detail = `HTTP ${response.status}${response.ok ? '' : '，可能需要登录或受访问限制'}`
            item.status = response.ok ? 'ok' : 'warning'
            await response.body?.cancel()
          }
        } catch (error) {
          if (signal.aborted) return
          const missing = ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
          item.status = item.kind !== 'link' && missing ? 'missing' : 'warning'
          item.detail = item.status === 'missing' ? '路径不存在，可重新关联' : item.kind === 'link' ? '暂时无法访问，请在浏览器中确认；不会自动删除' : '暂时无法读取路径，请检查权限或磁盘连接'
        }
        if (signal.aborted) return
        completed.add(item)
        progress({ requestId: request.requestId, completed: completed.size, total: result.length, item })
      }
    }))
    // Some disconnected filesystem paths cannot cancel fs.access itself. Stop
    // waiting immediately; any late worker still checks the aborted signal.
    let stopWaiting: () => void = () => undefined
    const aborted = new Promise<void>(resolve => { stopWaiting = resolve })
    signal.addEventListener('abort', stopWaiting, { once: true })
    if (signal.aborted) stopWaiting()
    try { await Promise.race([workers, aborted]) }
    finally { signal.removeEventListener('abort', stopWaiting) }
    return result.filter(item => completed.has(item))
  }

  async function relink(state: WorkspaceState, action: Extract<ProductivityAction, { type: 'resource-relink' }>) {
    const { resource, replacement } = action
    if (!resource || typeof replacement !== 'string' || !replacement.trim() || replacement.length > 4096) throw new Error('资源参数无效')
    if (!resources(state).some(item => item.kind === resource.kind && item.id === resource.id && item.parentId === resource.parentId && item.target === resource.target)) throw new Error('资源已变化，请重新检查')
    if (resource.kind === 'link') {
      if (!isHttpUrl(replacement)) throw new Error('请输入有效的 HTTP/HTTPS 地址')
      const item = state.LinkGroups.find(group => group.Id === resource.parentId)!.Links.find(item => item.Id === resource.id)!
      item.Url = replacement; item.UpdatedAt = new Date().toISOString(); return
    }
    await fs.access(replacement)
    switch (resource.kind) {
      case 'launcher': state.Launchers.find(item => item.Id === resource.id)!.Path = replacement; break
      case 'project': state.Projects.find(item => item.Id === resource.id)!.ProjectPath = replacement; break
      case 'phase': state.Projects.find(item => item.Id === resource.parentId)!.Phases.find(item => item.Id === resource.id)!.ProjectPath = replacement; break
      case 'subtask': state.Projects.flatMap(item => item.Phases).find(item => item.Id === resource.parentId)!.Subtasks.find(item => item.Id === resource.id)!.FilePath = replacement; break
      case 'organizer': {
        const category = state.DesktopCategories.find(item => item.Id === resource.parentId)!
        const root = path.join(deps.directory(), 'DesktopOrganizer')
        const categoryRoot = path.resolve(root, safeName(category.Name))
        const resolved = path.resolve(replacement)
        if (!isWithinDirectory(categoryRoot, resolved) || resolved.toLowerCase() === categoryRoot.toLowerCase()) throw new Error('只能重新关联当前分类目录中的项目')
        // Check from the managed root so a redirected category directory cannot bypass validation.
        await assertPathWithinRoot(root, resolved)
        const canonical = (value: string) => path.resolve(value).toLowerCase()
        const alreadyOwned = state.DesktopCategories.some(owner => owner.ItemPaths.some(item =>
          !(owner.Id === category.Id && item === resource.target) && canonical(item) === canonical(resolved)))
        if (alreadyOwned) throw new Error('此项目已被收纳记录关联，请选择其他项目')
        category.ItemPaths = category.ItemPaths.map(item => item === resource.target ? replacement : item); break
      }
    }
  }

  function register() {
    ipcMain.handle('productivity:action', async (_event, action: ProductivityAction) => {
      try {
        const { state } = await deps.update(async state => {
          if (action?.type === 'resource-relink') await relink(state, action)
          else if (action && typeof action === 'object') applyProductivityAction(state, action)
          else throw new Error('操作参数无效')
        })
        activeFocusExpected = Boolean(state.ActiveFocus?.RunningSince)
        deps.broadcast(state); return { ok: true }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        return { ok: false, error: error instanceof Error ? error.message : String(error), ...((code === 'NOTE_CONFLICT' || code === 'NOTE_DELETED') ? { code } : {}) }
      }
    })
    ipcMain.handle('maintenance:status', () => ({ error: backupError, lastAutomaticBackupAt }))
    ipcMain.handle('maintenance:preview', async (_event, target: string) => (await inspect(target)).preview)
    ipcMain.handle('resources:check', async (event, request: ResourceScanRequest = { requestId: crypto.randomUUID() }) => {
      if (!request || typeof request.requestId !== 'string' || !request.requestId || request.requestId.length > 100) throw new Error('检查请求无效')
      const sender = event.sender
      scans.get(sender.id)?.controller.abort()
      const scan = { requestId: request.requestId, controller: new AbortController() }
      scans.set(sender.id, scan)
      const cancel = () => scan.controller.abort()
      sender.once('destroyed', cancel)
      try {
        return await scanResources(request, scan.controller.signal, value => {
          if (!sender.isDestroyed() && scans.get(sender.id) === scan && !scan.controller.signal.aborted) sender.send('resources:progress', value)
        })
      } finally {
        sender.removeListener('destroyed', cancel)
        if (scans.get(sender.id) === scan) scans.delete(sender.id)
      }
    })
    ipcMain.handle('resources:cancel', (event, requestId: string) => {
      const scan = scans.get(event.sender.id)
      if (scan?.requestId === requestId) scan.controller.abort()
    })
  }

  return { register, backup, inspect, restoreAssets, protectBeforeRestore,
    dispose: () => { if (timer) clearInterval(timer); for (const scan of scans.values()) scan.controller.abort(); scans.clear() },
    start: async () => { await pauseAtCheckpoint(); await tick(); timer = setInterval(() => { void tick() }, 5000) },
    stop: async () => {
      const current = await deps.read()
      activeFocusExpected = false
      if (current.ActiveFocus?.RunningSince) {
        const { state } = await deps.update(state => { if (state.ActiveFocus?.RunningSince) applyProductivityAction(state, { type: 'focus-pause' }) }); deps.broadcast(state)
      }
    }
  }
}
