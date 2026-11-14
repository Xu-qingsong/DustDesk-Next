import { Channel, invoke } from '@tauri-apps/api/core'

type Event = 'prototype:captured' | 'prototype:workspace-changed' | 'tauri://drag-drop'
export async function listenPrototype<Payload>(event: Event, callback: (payload: Payload) => void) {
  let active = true
  const channel = new Channel<Payload>(payload => { if (active) callback(payload) })
  const token = await invoke<string>('prototype_event_attach', { event, channel })
  return () => {
    if (!active) return
    active = false
    channel.onmessage = () => undefined
    void invoke('prototype_event_detach', { event, token }).catch(() => undefined)
  }
}
