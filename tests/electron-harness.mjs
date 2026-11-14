import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'

export async function launchDustDesk(options = {}) {
  const startupTimeoutMs = options.startupTimeoutMs ?? 15000
  assert.ok(Number.isSafeInteger(startupTimeoutMs) && startupTimeoutMs >= 100 && startupTimeoutMs <= 120000, 'Startup timeout must be bounded between 100 and 120000 ms')
  const tempRoot = options.tempRoot ?? await mkdtemp(path.join(os.tmpdir(), 'dustdesk-electron-test-'))
  const dataDirectory = options.dataDirectory ?? path.join(tempRoot, 'data')
  const relative = path.relative(path.resolve(tempRoot), path.resolve(dataDirectory))
  assert.ok(path.isAbsolute(dataDirectory) && relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), 'Shared test data must remain inside its explicitly isolated root')
  if (options.bootstrap) {
    const bootstrapRelative = path.relative(path.resolve(tempRoot), path.resolve(options.bootstrap))
    assert.ok(path.isAbsolute(options.bootstrap) && bootstrapRelative && bootstrapRelative !== '..' && !bootstrapRelative.startsWith('..' + path.sep) && !path.isAbsolute(bootstrapRelative), 'Test bootstrap must remain inside its explicitly isolated root')
  }
  const electronApp = await electron.launch({
    ...(process.env.DUSTDESK_PRESET_EXECUTABLE ? { executablePath: process.env.DUSTDESK_PRESET_EXECUTABLE } : {}),
    args: process.env.DUSTDESK_PRESET_EXECUTABLE ? [] : [options.bootstrap ?? path.resolve(process.cwd(), 'out/main/index.js')],
    env: {
      ...process.env,
      DUSTDESK_TEST_DATA_DIR: dataDirectory,
      DUSTDESK_TEST_DESKTOP_DIR: path.join(tempRoot, 'desktop'),
      DUSTDESK_TEST_USER_DATA_DIR: path.join(tempRoot, 'user-data'),
      ELECTRON_DISABLE_SECURITY_WARNINGS: 'true'
    }
  })
  // Startup may create a private blank recovery page at the same file URL.
  // Wait for the ordinary app, never treat that short-lived page as its UI.
  let window
  const deadline = Date.now() + startupTimeoutMs
  while (!window && Date.now() < deadline) {
    for (const page of electronApp.windows()) {
      if (!page.url() || page.url().includes('widget=') || page.isClosed()) continue
      if (await page.locator('h1').count().catch(() => 0)) { window = page; break }
    }
    if (!window) await new Promise(resolve => setTimeout(resolve, 50))
  }
  if (!window) { await electronApp.close().catch(() => {}); throw Error('Ordinary Electron app did not start after controlled draft recovery') }
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
