import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

// Read-only native audit; the Electron helper never creates a BrowserWindow.
const require = createRequire(import.meta.url)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const output = path.resolve(process.argv[2] || 'artifacts/icon-audit')
const result = spawnSync(require('electron'), [path.resolve('tests/icon-audit-electron.cjs'), output], {
  env, windowsHide: true, encoding: 'utf8', timeout: 90_000
})
process.stdout.write(result.stdout || '')
process.stderr.write(result.stderr || '')
if (result.error) console.error(result.error)
process.exitCode = result.status === 0 ? 0 : 1
