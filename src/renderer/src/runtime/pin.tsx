import React from 'react'
import { createRoot } from 'react-dom/client'
import { Channel, invoke } from '@tauri-apps/api/core'
import { PinnedScreenshot, type PinRuntime } from '../screenshot/PinnedScreenshot'
import '../styles.css'
import '../screenshot/screenshot.css'

const id = new URLSearchParams(location.search).get('pin') || ''
const handlers = new Map<string, Set<(payload: unknown) => void>>()
let token: string | undefined
const channel = new Channel<{token: string; event: string; payload: unknown}>(packet => {
  if (packet.token !== token) return
  for (const callback of handlers.get(packet.event) || []) callback(packet.payload)
})
const subscribe = (event: string, callback: () => void) => {
  const listeners = handlers.get(event) || new Set<(payload: unknown) => void>()
  listeners.add(callback); handlers.set(event, listeners)
  return () => { listeners.delete(callback); if (!listeners.size) handlers.delete(event) }
}
const runtime: PinRuntime = {
  onError: callback => {
    const handler = (payload: unknown) => callback(String(payload))
    const listeners = handlers.get('pin:error') || new Set<(payload: unknown) => void>()
    listeners.add(handler); handlers.set('pin:error', listeners)
    return () => { listeners.delete(handler); if (!listeners.size) handlers.delete('pin:error') }
  },
  readPinnedScreenshot: async (id, version) => {
    try {
      const info = await invoke<Awaited<ReturnType<PinRuntime['readPinnedScreenshot']>>>('screenshot_pin_info', {id})
      if (info.version !== version) info.png = new Uint8Array(await invoke<ArrayBuffer>('screenshot_pin_source', {id, version: info.version}))
      return info
    } catch (error) { return {ok: false, error: String(error)} }
  },
  onPinnedScreenshotChanged: callback => subscribe('pin:changed', callback),
  onPinnedScreenshotSaveRequested: callback => subscribe('pin:save', callback),
  controlPinnedScreenshot: (id, action, value) => invoke('screenshot_pin_control', {id, action, value: value ?? null}).then(() => ({ok: true})).catch(error => ({ok: false, error: String(error)})),
  savePinnedScreenshot: (id, jpeg, version) => {
    if (!(jpeg instanceof Uint8Array) || !jpeg.byteLength || jpeg.byteLength > 32 * 1024 * 1024) return Promise.resolve({ok: false, error: '贴图 JPEG 无效或过大'})
    const metadata = new TextEncoder().encode(JSON.stringify({id, version}))
    const bytes = new Uint8Array(4 + metadata.length + jpeg.length)
    new DataView(bytes.buffer).setUint32(0, metadata.length, true); bytes.set(metadata, 4); bytes.set(jpeg, 4 + metadata.length)
    return invoke<Awaited<ReturnType<PinRuntime['savePinnedScreenshot']>>>('screenshot_pin_save', bytes).catch(error => ({ok: false, error: String(error)}))
  }
}
const root = createRoot(document.getElementById('root')!)
const connect = () => {
  root.render(<div role="status">正在读取贴图…</div>)
  void invoke<string>('screenshot_pin_attach', {channel}).then(connected => {
    token = connected
    root.render(<PinnedScreenshot id={id} runtime={runtime} />)
  }).catch(error => root.render(<div role="alert">{String(error)}<button onClick={connect}>重试连接</button></div>))
}
window.addEventListener('beforeunload', () => { if (token) void invoke('screenshot_pin_detach', {token}).catch(() => undefined); token = undefined; handlers.clear() })
connect()
