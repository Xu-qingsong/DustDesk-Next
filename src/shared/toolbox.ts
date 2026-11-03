export type TextTool = 'json' | 'jsonCompact' | 'urlEncode' | 'urlDecode' | 'base64Encode' | 'base64Decode' | 'regex' | 'diff' | 'dedupe' | 'sort' | 'stats' | 'upper' | 'lower'
export interface TextRequest { tool: TextTool; input: string; second?: string; pattern?: string; flags?: string; ignoreEmpty?: boolean; trim?: boolean }
export interface TextResult { text: string; diff?: { kind: 'same' | 'add' | 'remove'; text: string }[] }
export interface ToolAsset { id: string; name: string; size: number }
export interface ImageExportResult { path?: string; directory?: string; count: number }
export interface ImageOptions {
  category?: 'general' | 'avatar' | 'portrait'
  avatarShape?: 'square' | 'circle'; preset?: string
  crop?: { x: number; y: number; zoom: number }
  dpi?: number
  format: 'original' | 'png' | 'jpeg' | 'webp'; quality: number
  resize: 'none' | 'percent' | 'dimensions'; percent: number; width: number; height: number
  fit: 'contain' | 'cover' | 'stretch'; upscale: boolean; background: string
  watermark: 'none' | 'text' | 'image'; text: string; watermarkAsset?: string
  position: number; margin: number; watermarkSize: number; opacity: number; color: string
}
export const defaultImageOptions: ImageOptions = { format: 'original', quality: 85, resize: 'none', percent: 100, width: 1920, height: 1080, fit: 'contain', upscale: false, background: '#ffffff', watermark: 'none', text: 'DustDesk', position: 8, margin: 20, watermarkSize: 32, opacity: 50, color: '#ffffff' }
export type TransferStatus = 'preparing' | 'waiting' | 'transferring' | 'paused' | 'failed' | 'completed' | 'canceled'
export interface LanDevice { id: string; name: string; address: string; port: number; fingerprint: string; lastSeen: number }
export interface TransferView { id: string; direction: 'send' | 'receive'; device: string; name: string; total: number; done: number; speed: number; status: TransferStatus; error?: string; directory?: string; text?: string }
export interface LanSnapshot { enabled: boolean; devices: LanDevice[]; tasks: TransferView[]; addresses: string[]; port: number; error?: string }
export interface ToolboxApi {
  pick(kind: 'image' | 'files' | 'folder'): Promise<ToolAsset[]>
  registerPaths(paths: string[], kind: 'image' | 'transfer'): Promise<ToolAsset[]>
  importImage(bytes: Uint8Array, name: string): Promise<ToolAsset>
  readAsset(id: string): Promise<Uint8Array>
  releaseAssets(ids: string[]): Promise<void>
  exportText(text: string): Promise<{ canceled?: boolean; path?: string }>
  copyText(text: string): Promise<void>
  beginImageExport(assets: string[], format: ImageOptions['format']): Promise<{ id?: string }>
  exportImage(batch: string, name: string, bytes: Uint8Array): Promise<string>
  endImageExport(batch: string): Promise<ImageExportResult>
  lanSnapshot(): Promise<LanSnapshot>
  lanEnable(enabled: boolean): Promise<LanSnapshot>
  lanConnect(address: string, port: number): Promise<LanDevice>
  // Resolves after submission; transfer progress and errors arrive in LanSnapshot.
  lanSend(device: string, assets: string[], text?: string): Promise<void>
  // Resume resolves after submission; pause/cancel/clear wait for transfer cleanup.
  lanControl(id: string, action: 'pause' | 'resume' | 'cancel' | 'clear'): Promise<void>
  onLanChanged(callback: (snapshot: LanSnapshot) => void): () => void
}

export function toolError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '').replace(/^Error:\s*/, '')
  if (/ENOSPC/.test(message)) return '磁盘空间不足，请清理空间或选择其他目录后重试'
  if (/\b(EBUSY|EACCES|EPERM)\b/.test(message)) return '文件被占用或目录没有写入权限，请关闭占用程序或更换目录后重试'
  if (/\b(ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT)\b/.test(message)) return '无法连接设备，请检查对方是否已开启局域网传输、地址端口及防火墙设置'
  return message
}
