import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { waitFor } from './tauri-harness.mjs'

export async function nativeWindowFixture({ title, width = 700, height = 500, x = 80, y = 80, split = false }) {
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64')
  const child = spawn('pwsh.exe', ['-Sta', '-NoLogo', '-NoProfile', '-NonInteractive', '-File', path.resolve('tests/native-window-fixture.ps1'), '-Configuration', encode({ title, width, height, x, y, split })], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let errors = ''; const lines = []
  child.stderr.on('data', value => { errors += value })
  const reader = createInterface({ input: child.stdout })
  reader.on('line', value => { lines.push(JSON.parse(value)) })
  const next = async () => {
    await waitFor(() => { if (lines.length) return true; if (child.exitCode !== null) throw Error(errors || 'Native window fixture exited'); return false }, 15000)
    const value = lines.shift(); if (value.error) throw Error(value.error); return value
  }
  try {
    const ready = await next(); assert.equal(ready.ready, true)
    return {
      handle: ready.handle, width: ready.width, height: ready.height,
      action: async (action, options = {}) => { child.stdin.write(encode({ action, ...options })+'\n'); assert.equal((await next()).ok, true) },
      close: async () => { child.stdin.end(encode({ action: 'dispose' })+'\n'); await waitFor(() => child.exitCode !== null); assert.equal(child.exitCode, 0, errors); reader.close() }
    }
  } catch (error) { child.stdin.end(); await waitFor(() => child.exitCode !== null).catch(() => child.kill()); throw error }
}
