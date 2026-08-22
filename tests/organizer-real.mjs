import assert from 'node:assert/strict'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  await app.window.getByText('桌面收纳', { exact: true }).click()
  assert.match(await app.window.locator('h1').textContent(), /桌面收纳/)
  console.log('Organizer smoke passed')
} finally {
  await closeDustDesk(app)
}
