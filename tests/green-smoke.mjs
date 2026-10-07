import { execFileSync } from 'node:child_process'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const { version } = JSON.parse(await readFile('package.json', 'utf8'))
const archive = path.resolve(`release/DustDesk-${version}-x64-green.zip`)
const directory = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-green-test-'))
try {
  // Pass paths through environment variables, keeping spaces and shell characters literal.
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:DUSTDESK_GREEN_ARCHIVE -DestinationPath $env:DUSTDESK_GREEN_DIRECTORY'], { env: { ...process.env, DUSTDESK_GREEN_ARCHIVE: archive, DUSTDESK_GREEN_DIRECTORY: directory }, stdio: 'pipe' })
  const executable = path.join(directory, 'DustDesk.exe')
  await access(executable)
  await access(path.join(directory, 'resources', 'app.asar'))
  execFileSync(process.execPath, ['tests/package-smoke.mjs'], { env: { ...process.env, DUSTDESK_PACKAGE_EXECUTABLE: executable }, stdio: 'inherit' })
  console.log(`Green ZIP DustDesk ${version} extraction and startup passed`)
} finally {
  await rm(directory, { recursive: true, force: true })
}
