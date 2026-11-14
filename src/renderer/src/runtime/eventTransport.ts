import { Channel, invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

type Packet = { token: string; event: string; payload: unknown }
export function createRuntimeEvents(label: string) {
  const quick = label === 'quick-capture'
  const capture = label.startsWith('screenshot-overlay-')
  const widget = quick || capture || label.startsWith('workspace-widget-')
  const attach = capture ? 'screenshot_overlay_events_attach' : quick ? 'quick_capture_events_attach' : 'widget_events_attach'
  const detach = capture ? 'screenshot_overlay_events_detach' : quick ? 'quick_capture_events_detach' : 'widget_events_detach'
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  let token: string | undefined
  let disposed = false
  let connecting: Promise<void> | undefined
  const channel = widget ? new Channel<Packet>(packet => {
    if (disposed || (token !== undefined && token !== packet.token)) return
    for (const handler of [...(handlers.get(packet.event) ?? [])]) {
      try { handler(packet.payload) } catch (error) { console.error('组件事件处理失败', error) }
    }
  }) : undefined
  return {
    listen: async <Payload,>(event: string, callback: (message: { payload: Payload }) => void): Promise<UnlistenFn> => {
      if (disposed) throw Error('窗口事件通道已关闭')
      if (!widget) return listen<Payload>(event, callback, { target: { kind: 'WebviewWindow', label } })
      const handler = (payload: unknown) => callback({ payload: payload as Payload })
      const listeners = handlers.get(event) ?? new Set<(payload: unknown) => void>()
      listeners.add(handler); handlers.set(event, listeners)
      return () => { listeners.delete(handler); if (!listeners.size) handlers.delete(event) }
    },
    connect: () => {
      if (disposed) return Promise.reject(Error('窗口事件通道已关闭'))
      if (!channel) return Promise.resolve()
      connecting ??= invoke<string>(attach, { channel }).then(async connected => {
        if (disposed) { await invoke(detach, { token: connected }); return }
        token = connected
      })
      return connecting
    },
    dispose: () => {
      if (disposed) return
      disposed = true; handlers.clear()
      if (channel) channel.onmessage = () => undefined
      if (token !== undefined) void invoke(detach, { token }).catch(() => undefined)
    },
    token: () => token,
  }
}
