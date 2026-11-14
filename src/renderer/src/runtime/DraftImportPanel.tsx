import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { FileInput, FileOutput } from 'lucide-react'
import { verifyDraftArchive, type DraftPayload } from '../../../shared/draftMigration'

type Preview = { name: string; serialized: string; payload: DraftPayload }
const savedMessage = () => { try { return sessionStorage.getItem('dustdesk:draft-import:message') ?? '' } catch { return '' } }
export function DraftImportPanel({ disabled, importDrafts }: { disabled: boolean; importDrafts: (serialized: string) => Promise<unknown> }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(savedMessage)
  useEffect(() => { try { sessionStorage.removeItem('dustdesk:draft-import:message') } catch {} }, [])
  const [error, setError] = useState('')
  const inspectLegacySource = async () => {
    setBusy(true); setError(''); setMessage(''); setPreview(null)
    try {
      const result = await invoke<{ canceled?: boolean; release: { version: string } }>('legacy_source_inspect')
      if (!result.canceled) setMessage('旧版安装的 EXE 与 app.asar 已匹配受信任正式版 ' + result.release.version + '。仅完成来源识别，未运行旧程序、读取旧数据或授权切换；目录证明不会作为后续迁移凭据复用。')
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const prepareHandoffSnapshot = async () => {
    setBusy(true); setError(''); setMessage(''); setPreview(null)
    try {
      const result = await invoke<{ canceled?: boolean; entries: number; warning?: string }>('handoff_snapshot_prepare')
      if (!result.canceled) setMessage('隔离交接快照已封存 Data、' + result.entries + ' 项草稿与 LAN 状态；原身份仅保留在原 profile，外部续传文件不包含，尚不能切换或灾难恢复。' + (result.warning ?? ''))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const prepareDataSnapshot = async () => {
    setBusy(true); setError(''); setMessage(''); setPreview(null)
    try {
      const result = await invoke<{ canceled?: boolean; warning?: string }>('data_snapshot_prepare')
      if (!result.canceled) setMessage('隔离 Data 快照已准备；不含浏览器草稿或独立 LAN 身份，不能用于完整迁移或恢复。' + (result.warning ?? ''))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const exportDrafts = async () => {
    setBusy(true); setError(''); setMessage(''); setPreview(null)
    try {
      const result = await invoke<{ canceled?: boolean; entries: number; warning?: string }>('drafts_export')
      if (!result.canceled) setMessage('已导出 ' + result.entries + ' 项草稿。' + (result.warning ?? ''))
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const choose = async () => {
    setBusy(true); setError(''); setPreview(null); setMessage('')
    try {
      const selected = await invoke<{ name: string; serialized: string } | null>('drafts_pick')
      if (selected) {
        const { payload } = await verifyDraftArchive(selected.serialized)
        setPreview({ ...selected, payload })
      }
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const confirm = async () => {
    if (!preview) return
    setBusy(true); setError('')
    try {
      await importDrafts(preview.serialized)
      setMessage(savedMessage() || '草稿导入结果已核验。')
      setPreview(null)
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return <section className="tauri-draft-import" aria-label="隔离草稿导入">
    <button disabled={disabled || busy} onClick={() => void choose()}><FileInput size={16} aria-hidden />导入草稿迁移包</button>
    <button disabled={disabled || busy} onClick={() => void exportDrafts()}><FileOutput size={16} aria-hidden />导出迁移草稿</button>
    <button disabled={disabled || busy} onClick={() => void prepareDataSnapshot()}><FileOutput size={16} aria-hidden />准备隔离 Data 快照</button>
    <button disabled={disabled || busy} onClick={() => void prepareHandoffSnapshot()}><FileOutput size={16} aria-hidden />准备隔离交接快照</button>
    <button disabled={disabled || busy} onClick={() => void inspectLegacySource()}><FileInput size={16} aria-hidden />校验正式旧版来源（不迁移）</button>
    {message && <p role="status">{message}</p>}
    {error && <p role="alert">{error}</p>}
    {preview && <div role="region" aria-label="草稿导入预览">
      <strong>{preview.name}</strong>
      <p>来源 {preview.payload.source.runtime} {preview.payload.source.appVersion} · {new Date(preview.payload.createdAt).toLocaleString('zh-CN')} · {preview.payload.entries.length} 项草稿</p>
      <p>仅导入与当前隔离工作区及原生导出回执匹配的包；不会覆盖已有草稿。确认后保存并暂停全部编辑器，完成后重载相关窗口。不接管生产目录。</p>
      <button disabled={busy} onClick={() => setPreview(null)}>取消导入</button>
      <button disabled={disabled || busy} onClick={() => void confirm()}>确认导入并重载编辑器</button>
    </div>}
  </section>
}
