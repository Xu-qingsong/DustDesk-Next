import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

export async function launchDustDesk() {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-test-'))
  const electronApp = await electron.launch({
    args: [path.resolve(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      DUSTDESK_TEST_DATA_DIR: path.join(tempRoot, 'data'),
      DUSTDESK_TEST_DESKTOP_DIR: path.join(tempRoot, 'desktop'),
      DUSTDESK_TEST_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  const window = await electronApp.firstWindow({ timeout: 15000 })
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('h1')
  return { electronApp, window, tempRoot }
}

export async function closeDustDesk({ electronApp, tempRoot }) {
  try {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await Promise.race([
      electronApp.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ])
  } finally { await rm(tempRoot, { recursive: true, force: true }).catch(() => {}) }
}
