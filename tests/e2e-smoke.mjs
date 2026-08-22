import assert from 'node:assert/strict'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

const app = await launchDustDesk()
try {
  assert.equal(await app.window.title(), 'DustDesk')
  await app.window.getByText('任务', { exact: true }).click()
  await app.window.getByText('设置', { exact: true }).click()
  await app.window.getByTitle('桌面小组件').click()
  await app.window.getByText('桌面小组件', { exact: true }).last().waitFor()
  console.log('Electron smoke passed')
} finally {
  await closeDustDesk(app)
}
