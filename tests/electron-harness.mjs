import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'

export async function launchDustDesk(options = {}) {
  const tempRoot = options.tempRoot ?? await mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-test-'))
  const electronApp = await electron.launch({
    ...(process.env.DUSTDESK_PRESET_EXECUTABLE ? { executablePath: process.env.DUSTDESK_PRESET_EXECUTABLE } : {}),
    args: process.env.DUSTDESK_PRESET_EXECUTABLE ? [] : [path.resolve(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      DUSTDESK_TEST_DATA_DIR: path.join(tempRoot, 'data'),
      DUSTDESK_TEST_DESKTOP_DIR: path.join(tempRoot, 'desktop'),
      DUSTDESK_TEST_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  const firstWindow = await electronApp.firstWindow({ timeout: 15000 })
  await firstWindow.waitForLoadState('domcontentloaded')
  const window = electronApp.windows().find(page => page.url() && !page.url().includes('widget=')) ?? (firstWindow.url().includes('widget=')
    ? await electronApp.waitForEvent('window', { predicate: page => Boolean(page.url()) && !page.url().includes('widget='), timeout: 15000 })
    : firstWindow)
  await window.waitForLoadState('domcontentloaded')
  await window.waitForSelector('h1')
  if (options.showToolMenus) await window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    await window.dustdesk.saveWorkspace({ ...state, Settings: { ...state.Settings, SidebarHidden: (state.Settings.SidebarHidden ?? []).filter(id => !['textTools', 'imageTools', 'lan'].includes(id)) } }, state)
  })
  return { electronApp, window, tempRoot }
}

export async function closeDustDesk({ electronApp, tempRoot, preserveTempRoot = false }) {
  try {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => {})
    await Promise.race([
      electronApp.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000))
    ])
  } finally { if (!preserveTempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {}) }
}
