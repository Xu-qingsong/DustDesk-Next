import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')

test('root project is Electron-only', () => {
  assert.equal(existsSync(resolve(root, 'package.json')), true)
  assert.equal(existsSync(resolve(root, 'src/main/index.ts')), true)
  assert.equal(existsSync(resolve(root, 'src/preload/index.ts')), true)
  for (const legacy of ['DustDesk.Next.csproj', 'DustDesk.Next.slnx', 'App.xaml', 'Views', 'Widgets']) {
    assert.equal(existsSync(resolve(root, legacy)), false, `legacy WPF entry remains: ${legacy}`)
  }
})

test('Electron security boundary is retained', () => {
  const main = read('src/main/index.ts')
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  const preload = read('src/preload/index.ts')
  assert.match(preload, /contextBridge\.exposeInMainWorld\(['"]dustdesk['"]/) 
})

test('workspace persistence and compatibility fields remain available', () => {
  const main = read('src/main/index.ts')
  assert.match(main, /workspace:load/)
  assert.match(main, /workspace:save/)
  assert.match(main, /TagPresets/)
  assert.match(main, /WidgetPlacements/)
  assert.match(main, /electron-tmp-/)
})

test('widget keys include object and organizer variants', () => {
  const main = read('src/main/index.ts')
  assert.match(main, /note\|project/) 
  assert.match(main, /organizer-group/) 
  assert.match(main, /widgets:resize/) 
})

test('root scripts do not depend on dotnet', () => {
  const packageJson = JSON.parse(read('package.json'))
  assert.equal(Object.values(packageJson.scripts).some((value) => /dotnet/i.test(value)), false)
})
