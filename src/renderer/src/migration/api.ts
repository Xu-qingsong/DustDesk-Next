import { invoke } from '@tauri-apps/api/core'
import { getCurrentWindow } from '@tauri-apps/api/window'
import type { UnlistenFn } from '@tauri-apps/api/event'
import { listenPrototype } from './events'

export interface ProbeWindow { label: string; visible: boolean; alwaysOnTop: boolean; x: number; y: number; width: number; height: number; scaleFactor: number; mouseThrough: boolean; opacity: number }
export interface ProbeMonitor { name: string; x: number; y: number; width: number; height: number; scaleFactor: number }
export interface ProbeDiagnostics { version: string; platform: string; preview: boolean; profileDirectory: string; windows: ProbeWindow[]; monitors: ProbeMonitor[]; shortcutError: string | null }
export interface CaptureRect { x: number; y: number; width: number; height: number }
export type ProbeOptions = Partial<Pick<ProbeWindow, 'x' | 'y' | 'width' | 'height' | 'visible' | 'opacity' | 'mouseThrough'>> & { topmost?: boolean; close?: boolean }

export const probe = {
  diagnostics: () => invoke<ProbeDiagnostics>('prototype_diagnostics'),
  open: (kind: 'widget' | 'pin' | 'overlay', monitor = 0) => invoke<string>('prototype_open_window', { kind, monitor }),
  control: (label: string, options: ProbeOptions) => invoke<void>('prototype_control_window', { label, options }),
  capture: async (rect: CaptureRect) => new Uint8Array(await invoke<ArrayBuffer>('prototype_capture_region', { rect })),
  readCapture: async () => new Uint8Array(await invoke<ArrayBuffer>('prototype_read_capture')),
  captureWindow: async (label: string) => new Uint8Array(await invoke<ArrayBuffer>('prototype_capture_window', { label })),
  updateCapture: (png: Uint8Array) => invoke<void>('prototype_update_capture', { png: Array.from(png) }),
  onCaptured: (callback: () => void) => listenPrototype('prototype:captured', callback),
  restore: () => invoke<void>('prototype_restore_windows'),
  quit: () => invoke<void>('prototype_quit'),
  drag: () => getCurrentWindow().startDragging(),
  onDrop: (callback: (paths: string[]) => void): Promise<UnlistenFn> => listenPrototype<{ paths: string[] }>('tauri://drag-drop', event => callback(event.paths))
}
