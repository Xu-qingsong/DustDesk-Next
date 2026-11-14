import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { mainFixture } from './main-headless-harness.mjs'

const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, reorder(value[key])])) : value

test('reading a semantically normalized Rust-ordered workspace preserves its exact bytes and backup', async suite => {
  const fixture = await mainFixture(suite)
  await fixture.load()
  const initial = await fixture.load()
  const location = path.join(fixture.data, 'workspace.json'), backup = location + '.bak'
  const previousBackup = await readFile(backup).catch(() => undefined)
  const original = '\r\n' + JSON.stringify(reorder(initial), null, 4) + '\r\n'
  await writeFile(location, original)
  assert.deepEqual(await fixture.load(), initial)
  assert.deepEqual(await fixture.load(), initial)
  assert.equal(await readFile(location, 'utf8'), original)
  assert.deepEqual(await readFile(backup).catch(() => undefined), previousBackup)
})

test('semantic normalization still persists a real correction and preserves ordered arrays', async suite => {
  const fixture = await mainFixture(suite), state = await fixture.load()
  state.Settings.WidgetPlacements = { todo: { X: 17.6, Visible: true } }
  state.Todos.reverse()
  const location = path.join(fixture.data, 'workspace.json'), original = JSON.stringify(reorder(state))
  await writeFile(location, original)
  const result = await fixture.load()
  assert.equal(result.Settings.WidgetPlacements.todo.X, 18)
  assert.deepEqual(result.Todos.map(todo => todo.Id), state.Todos.map(todo => todo.Id))
  assert.notEqual(await readFile(location, 'utf8'), original)
  assert.equal(await readFile(location + '.bak', 'utf8'), original)
})
