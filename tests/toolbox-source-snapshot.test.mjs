import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mainFixture } from './main-headless-harness.mjs'

test('LAN-only suspension blocks recreation, preserves loaded images, resumes once and does not initialize a missing LAN profile', async context => {
  const fixture = await mainFixture(context), invoke = fixture.client(() => {}, true)
  const bytes = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64'))
  const image = await invoke('toolbox:import-image', bytes, 'retained.png')
  assert.equal((await invoke('toolbox:lan-snapshot')).enabled, false)
  try {
    const resume = await fixture.toolboxRuntime.suspendLan()
    await assert.rejects(invoke('toolbox:lan-snapshot'), /维护或停止/)
    await assert.rejects(fixture.toolboxRuntime.suspendLan(), /已在维护或停止/)
    assert.deepEqual(await invoke('toolbox:read-asset', image.id), bytes)
    await resume(); await resume()
    assert.equal((await invoke('toolbox:lan-snapshot')).enabled, false)
    assert.deepEqual(await invoke('toolbox:read-asset', image.id), bytes)
    await assert.rejects(fixture.fileSystem.stat(fixture.root + '/user-data/LanTransfers'), { code: 'ENOENT' })
  } finally { await fixture.toolboxRuntime.dispose() }
})

test('application disposal during LAN suspension cannot be undone by a late resume callback', async context => {
  const fixture = await mainFixture(context), invoke = fixture.client(() => {}, true)
  await invoke('toolbox:lan-snapshot')
  const resume = await fixture.toolboxRuntime.suspendLan()
  await fixture.toolboxRuntime.dispose(); await resume()
  await assert.rejects(invoke('toolbox:lan-snapshot'), /维护或停止/)
})
