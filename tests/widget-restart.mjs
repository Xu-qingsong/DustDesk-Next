import assert from 'node:assert/strict'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  const windowPromise = app.electronApp.waitForEvent('window', { timeout: 10000 })
  await app.window.getByTitle('桌面小组件').click()
  await app.window.getByText('任务', { exact: true }).last().click()
  await windowPromise
  assert.equal(await app.electronApp.windows().length >= 2, true)
  console.log('Widget smoke passed')
} finally {
  await closeDustDesk(app)
}
