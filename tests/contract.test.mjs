import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (file) => readFileSync(resolve(root, file), 'utf8')

test('application entry and build use Rust and Tauri without Electron', () => {
  const packageJson = JSON.parse(read('package.json'))
  assert.equal(packageJson.main, undefined)
  for (const name of ['electron', 'electron-builder', 'electron-vite']) {
    assert.equal(packageJson.dependencies?.[name], undefined)
    assert.equal(packageJson.devDependencies?.[name], undefined)
  }
  assert.equal(existsSync(resolve(root, 'src/main')), false)
  assert.equal(existsSync(resolve(root, 'src/preload')), false)
  assert.equal(existsSync(resolve(root, 'electron.vite.config.ts')), false)
  assert.equal(packageJson.scripts.dev, 'tauri dev')
  assert.equal(packageJson.scripts.build, 'vite build --config vite.tauri.config.ts')
  assert.equal(packageJson.scripts['build:app'], 'tauri build --no-bundle')
})

test('historical behavior fixture retains the original security boundary', () => {
  const main = read('tests/reference/src/main/index.ts')
  assert.match(main, /contextIsolation:\s*true/)
  assert.match(main, /nodeIntegration:\s*false/)
  assert.match(main, /sandbox:\s*true/)
  const preload = read('tests/reference/src/preload/index.ts')
  assert.match(preload, /contextBridge\.exposeInMainWorld\(['"]dustdesk['"]/) 
})

test('workspace persistence and compatibility fields remain available', () => {
  const main = read('tests/reference/src/main/index.ts')
  assert.match(main, /workspace:load/)
  assert.match(main, /workspace:save/)
  assert.match(main, /TagPresets/)
  assert.match(main, /WidgetPlacements/)
  assert.match(main, /electron-tmp-/)
})

test('widget keys include object and organizer variants', () => {
  const main = read('tests/reference/src/main/index.ts')
  assert.match(main, /note\|project/) 
  assert.match(main, /organizer-group/) 
  assert.match(main, /widgets:move/)
  assert.match(main, /widgets:visibility/)
  assert.match(main, /widgets:resize/) 
})

test('root scripts do not depend on dotnet', () => {
  const packageJson = JSON.parse(read('package.json'))
  assert.equal(Object.values(packageJson.scripts).some((value) => /dotnet/i.test(value)), false)
})
