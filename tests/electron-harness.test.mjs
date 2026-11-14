import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { launchDustDesk } from './electron-harness.mjs'
import { mainFixture } from './main-headless-harness.mjs'

test('headless main imports the real native lease boundary but never spawns system processes', async testContext => {
  const fixture = await mainFixture(testContext)
  assert.throws(() => fixture.childProcess.spawn('dustdesk-tauri.exe', ['--legacy-source-lease-v1']), /System processes are forbidden/)
  assert.throws(() => fixture.childProcess.execFile('unexpected.exe'), /System processes are forbidden/)
})

test('shared-runtime native harness rejects external, prefix-sibling and relative data roots before launching Electron', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-harness-safety-'))
  const marker = path.join(root, 'marker.txt'); await writeFile(marker, 'unchanged')
  try {
    for (const dataDirectory of [root, root + '-outside', path.join(root, '..', 'outside'), 'relative-data']) {
      await assert.rejects(launchDustDesk({ tempRoot: root, dataDirectory }), /Shared test data must remain/)
    }
    assert.equal(await readFile(marker, 'utf8'), 'unchanged')
    assert.deepEqual(await readdir(root), ['marker.txt'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
