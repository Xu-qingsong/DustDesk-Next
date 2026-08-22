import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  await mkdir('test-artifacts', { recursive: true })
  const screenshot = await app.window.screenshot({ path: 'test-artifacts/electron-smoke.png' })
  assert.ok(screenshot.length > 1000)
  console.log('Visual smoke passed')
} finally {
  await closeDustDesk(app)
}
