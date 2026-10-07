import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'

const version = JSON.parse(await readFile('package.json', 'utf8')).version
const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-portable-test-'))
const reservation = createServer()
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve))
const port = reservation.address().port
await new Promise(resolve => reservation.close(resolve))
const portableProcess = spawn(path.resolve(`release/DustDesk-${version}-x64-portable.exe`), [`--remote-debugging-port=${port}`], { windowsHide: true, stdio: 'ignore', env: {
  ...process.env,
  DUSTDESK_TEST_DATA_DIR: path.join(root, 'data'),
  DUSTDESK_TEST_USER_DATA_DIR: path.join(root, 'user-data'),
  DUSTDESK_TEST_DESKTOP_DIR: path.join(root, 'desktop')
} })
let launchError
portableProcess.on('error', error => { launchError = error })
let browser
try {
  const deadline = Date.now() + 40_000
  while (Date.now() < deadline && !browser) {
    if (launchError) throw launchError
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    } catch { /* The portable launcher extracts the application before starting it. */ }
    if (!browser) await new Promise(resolve => setTimeout(resolve, 250))
  }
  assert.ok(browser, 'Portable application starts and exposes its test debug endpoint')
  const context = browser.contexts()[0]
  const page = context.pages()[0]
  await page.locator('h1').waitFor()
  assert.equal(await page.locator('.sidebar .version').textContent(), `v${version}`)
  assert.equal(await page.evaluate(() => typeof window.dustdesk.setWidgetVisibility), 'function')
  assert.equal(await page.evaluate(async () => (await window.dustdesk.loadWorkspace()).SchemaVersion), 3)
  const widgetPromise = context.waitForEvent('page')
  assert.deepEqual(await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', true)), { ok: true, visible: true })
  const widget = await widgetPromise
  await widget.locator('.widget-content').waitFor()
  assert.deepEqual(await page.evaluate(() => window.dustdesk.setWidgetVisibility('todo', false)), { ok: true, visible: false })
  console.log(`Portable DustDesk ${version} startup, displayed version, workspace and widget smoke passed`)
} finally {
  if (browser) {
    const session = await browser.newBrowserCDPSession().catch(() => null)
    if (session) await Promise.race([session.send('Browser.close').catch(() => {}), new Promise(resolve => setTimeout(resolve, 3000))])
    await browser.close().catch(() => {})
  }
  if (portableProcess.exitCode === null && portableProcess.pid) {
    try { execFileSync('taskkill', ['/PID', String(portableProcess.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* It may already have exited. */ }
  }
  await rm(root, { recursive: true, force: true })
}
