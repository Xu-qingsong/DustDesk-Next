import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mainFixture } from './main-headless-harness.mjs'

test('sidebar settings persist, repair unknown menu ids and survive unrelated settings saves', async t => {
  const fixture = await mainFixture(t), original = await fixture.load()
  assert.deepEqual(original.Settings.SidebarHidden, ['textTools', 'imageTools', 'lan'])
  const state = structuredClone(original)
  state.Settings.SidebarOrder = ['lan','lan','settings','removed','tasks',null]
  state.Settings.SidebarHidden = ['notes','notes','settings','removed']
  await fixture.invoke('workspace:save', state, original)
  const saved = await fixture.load()
  assert.equal(saved.Settings.SidebarOrder[0], 'lan')
  assert.equal(saved.Settings.SidebarOrder[1], 'tasks')
  assert.equal(saved.Settings.SidebarOrder.length, 16)
  assert.equal(new Set(saved.Settings.SidebarOrder).size, 16)
  assert.deepEqual(saved.Settings.SidebarHidden, ['notes'])
  const unrelated = structuredClone(original); unrelated.Settings.Theme = 'dark'
  await fixture.invoke('workspace:save', unrelated, original)
  const merged = await fixture.load()
  assert.deepEqual(merged.Settings.SidebarOrder, saved.Settings.SidebarOrder)
  assert.deepEqual(merged.Settings.SidebarHidden, ['notes'])
  assert.equal(merged.Settings.Theme, 'dark')
  await fixture.invoke('workspace:save', { ...merged, Settings: { ...merged.Settings, SidebarHidden: [] } }, merged)
  assert.deepEqual((await fixture.load()).Settings.SidebarHidden, [], 'Explicitly showing every menu must survive normalization')
  const legacy = await fixture.load()
  delete legacy.Settings.SidebarHidden
  await fixture.invoke('workspace:save', legacy)
  assert.deepEqual((await fixture.load()).Settings.SidebarHidden, ['textTools', 'imageTools', 'lan'], 'Settings without a saved preference use the defaults')
})
