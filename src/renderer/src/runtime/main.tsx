import React, { lazy, Suspense, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { invoke } from '@tauri-apps/api/core'
import { ArchiveRestore, Database, LogOut, RefreshCw } from 'lucide-react'
import type { BackupEntry } from '../../../shared/types'
import type { BackupPreview } from '../../../shared/productivity'
import { installTauriApi } from './tauri'
import '../styles.css'
import '../productivity.css'
import '../screenshot/screenshot.css'
import 'react-day-picker/style.css'
import '../components/ui/controls.css'
import './tauri.css'

const App = lazy(() => import('../app/App').then(module => ({ default: module.App })))

function WorkspaceEntry({ runtime }: { runtime: Awaited<ReturnType<typeof installTauriApi>> }) {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [backups, setBackups] = useState<BackupEntry[] | null>(null)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const inspectBackups = async () => {
    setBusy(true); setError(''); setPreview(null)
    try { setBackups(await runtime.api.listBackups()) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const inspectBackup = async (path: string) => {
    setBusy(true); setError(''); setPreview(null)
    try { setPreview(await runtime.api.previewBackup(path)) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const recover = async () => {
    if (!preview) return
    setBusy(true); setError('')
    try {
      const result = await runtime.api.restoreBackup(preview.path, preview.fingerprint)
      if (!result.ok) throw Error(result.error || '备份恢复失败')
      await runtime.api.loadWorkspace()
      setReady(true); setPreview(null); setBackups(null)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const load = async () => {
    setBusy(true); setError('')
    try { await runtime.api.loadWorkspace(); setReady(true) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  useEffect(() => {
    void load()
    const resume = (event: Event) => { setError((event as CustomEvent<string>).detail); setBusy(false) }
    window.addEventListener('dustdesk:quit-error', resume)
    return () => window.removeEventListener('dustdesk:quit-error', resume)
  }, [])
  const initialize = async () => {
    setBusy(true); setError('')
    try { await runtime.initialize(); setReady(true) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const quit = async () => {
    setBusy(true); setError('')
    try { await runtime.quit() }
    catch (reason) { setError(String(reason)); setBusy(false) }
  }
  return <>
    {error && <p className="tauri-runtime-error" role="alert">{error}</p>}
    {ready ? <Suspense fallback={<div className="boot">正在打开 DustDesk…</div>}><App /></Suspense> : <main className="tauri-workspace-start">
      <h1><Database size={24} aria-hidden />打开工作区</h1>
      <p>读取失败时保留原文件，可重新读取或从备份恢复。</p>
      <button disabled={busy} onClick={() => void load()}><RefreshCw size={16} aria-hidden />重新读取</button>
      <button disabled={busy} onClick={() => void initialize()}>创建工作区</button>
      <button disabled={busy} onClick={() => void inspectBackups()}><ArchiveRestore size={16} aria-hidden />从已有备份恢复</button>
      {backups && <section aria-label="启动恢复" data-testid="tauri-backup-recovery">
        <h2>选择数据目录中的备份</h2>
        <p>恢复前先保留当前文件的保护副本，不会以默认空数据启动。损坏的保护副本不能直接作为有效备份恢复。</p>
        <div className="backup-list feature-scroll">{backups.map(point => <div className="backup-row" key={point.path}><span><strong>{point.name}</strong><small>{new Date(point.modifiedAt).toLocaleString('zh-CN')} · {Math.ceil(point.size / 1024)} KB</small></span><button disabled={busy} onClick={() => void inspectBackup(point.path)}>预览恢复</button></div>)}{!backups.length && <p>暂无备份</p>}</div>
        {preview && <div className="feature-preview" role="region" aria-label="启动恢复预览"><strong>恢复预览</strong><p>任务 {preview.tasks} · 便签 {preview.notes} · 项目 {preview.projects} · 链接 {preview.links} · 专注记录 {preview.focusSessions} · 回收站 {preview.recycleEntries}</p>{preview.warnings.map((warning, index) => <p className="inline-error" key={index}>{warning}</p>)}<p>确认使用此备份替换当前工作区？关联外部文件不会被移动。</p><button disabled={busy} onClick={() => setPreview(null)}>取消</button><button disabled={busy} onClick={() => void recover()}>确认恢复工作区</button></div>}
      </section>}
    </main>}
  </>
}

const root = createRoot(document.getElementById('root')!)
root.render(<main role="status">正在打开 DustDesk…</main>)
void installTauriApi().then(runtime => root.render(<React.StrictMode><WorkspaceEntry runtime={runtime} /></React.StrictMode>)).catch(error => root.render(<StartupError error={String(error)} />))

function StartupError({ error }: { error: string }) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(error)
  const retry = async () => {
    setBusy(true)
    try {
      await invoke('drafts_startup_retry')
      location.reload()
    } catch (reason) { setFailure(String(reason)); setBusy(false) }
  }
  const quit = async () => {
    setBusy(true)
    try { await invoke('application_quit') }
    catch (reason) { setFailure(String(reason)); setBusy(false) }
  }
  return <main role="alert">无法打开工作区：{failure}<button disabled={busy} onClick={() => void retry()}>重新打开</button><button disabled={busy} onClick={() => void quit()}>退出</button></main>
}
