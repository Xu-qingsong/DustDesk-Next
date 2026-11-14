import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const archive = path.resolve(process.env.DUSTDESK_GREEN_ARCHIVE ?? `release/DustDesk-${version}-x64-green.zip`)
const directory = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-green-test-'))
assert.equal(path.dirname(directory), path.resolve(os.tmpdir()))
assert.match(path.basename(directory), /^dustdesk-green-test-[a-zA-Z0-9]+$/)
try {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DUSTDESK_GREEN_ARCHIVE -DestinationPath $env:DUSTDESK_GREEN_DIRECTORY'], { env: { ...process.env, DUSTDESK_GREEN_ARCHIVE: archive, DUSTDESK_GREEN_DIRECTORY: directory }, stdio: 'pipe', windowsHide: true })
  const executable = path.join(directory, 'DustDesk.exe')
  await access(executable)
  execFileSync(process.execPath, ['tests/package-smoke.mjs'], { env: { ...process.env, DUSTDESK_PACKAGE_EXECUTABLE: executable }, stdio: 'inherit', windowsHide: true })
  console.log(`Green ZIP DustDesk ${version} extraction and Tauri startup passed`)
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) }
