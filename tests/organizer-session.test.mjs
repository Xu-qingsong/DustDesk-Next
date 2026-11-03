import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { mainFixture } from './main-headless-harness.mjs'

async function collect(fixture, name, categoryIndex = 0, directory = false) {
  const source = path.join(fixture.root, 'desktop', name)
  await fs.mkdir(path.dirname(source), { recursive: true })
  if (directory) {
    await fs.mkdir(source)
    await fs.writeFile(path.join(source, 'inside.txt'), 'folder contents')
  } else await fs.writeFile(source, `contents: ${categoryIndex}`)
  const category = (await fixture.load()).DesktopCategories[categoryIndex]
  const result = await fixture.invoke('organizer:move', category.Id, source)
  assert.equal(result.ok, true, result.error)
  return { source, stored: result.path, category }
}

for (const response of [0, 1, 2]) test(`quit confirmation response ${response} restores, keeps or cancels as selected`, async t => {
  const fixture = await mainFixture(t)
  const file = await collect(fixture, 'choice.txt')
  let prompts = 0
  fixture.electron.dialog.showMessageBox = async (...args) => {
    prompts++
    const options = args.at(-1)
    assert.deepEqual(options.buttons, ['恢复并退出', '保留收纳并退出', '取消'])
    assert.equal(options.defaultId, 2)
    assert.equal(options.cancelId, 2)
    // The dialog itself must not move files before receiving a response.
    await fs.stat(file.stored)
    await assert.rejects(fs.stat(file.source), { code: 'ENOENT' })
    return { response }
  }
  assert.equal(await fixture.prepareToQuit(), response !== 2)
  assert.equal(prompts, 1)
  if (response === 0) {
    await fs.stat(file.source)
    await assert.rejects(fs.stat(file.stored), { code: 'ENOENT' })
  } else {
    await fs.stat(file.stored)
    await assert.rejects(fs.stat(file.source), { code: 'ENOENT' })
    assert.equal(((await fixture.load()).OrganizerDesktopRestores ?? []).length, 0)
  }
})

test('quit does not ask to restore when there are no stored items', async t => {
  const fixture = await mainFixture(t)
  fixture.electron.dialog.showMessageBox = async () => { throw Error('Unexpected confirmation') }
  assert.equal(await fixture.prepareToQuit(), true)
})

test('quit restores files and folders without overwriting desktop namesakes; restart preserves categories and undo', async t => {
  const fixture = await mainFixture(t)
  const file = await collect(fixture, 'report.txt')
  const folder = await collect(fixture, '资料.v1', 1, true)
  const sameName = await collect(fixture, 'report.txt', 1)
  await fs.writeFile(file.source, 'new desktop file')
  await fixture.restoreOrganizerForQuit()
  assert.equal(await fs.readFile(file.source, 'utf8'), 'new desktop file')
  const restored = (await fixture.load()).OrganizerDesktopRestores
  assert.equal(restored.length, 3)
  for (const item of restored) {
    await assert.rejects(fs.stat(item.source), { code: 'ENOENT' })
    await fs.stat(item.target)
  }
  assert.equal(await fs.readFile(path.join(folder.source, 'inside.txt'), 'utf8'), 'folder contents')
  assert.equal(await fs.readFile(path.join(fixture.root, 'desktop', 'report (1).txt'), 'utf8'), 'contents: 0')
  assert.equal(await fs.readFile(path.join(fixture.root, 'desktop', 'report (2).txt'), 'utf8'), 'contents: 1')
  // A delayed renderer save cannot erase the main-process restoration journal.
  const state = await fixture.load()
  await fixture.invoke('workspace:save', { ...state, OrganizerDesktopRestores: [] }, state)
  assert.equal((await fixture.load()).OrganizerDesktopRestores.length, 3)
  await fixture.resumeOrganizerSession()
  for (const item of [file, folder, sameName]) {
    await fs.stat(item.stored)
    assert.ok((await fixture.load()).DesktopCategories.find(category => category.Id === item.category.Id).ItemPaths.includes(item.stored))
  }
  assert.equal((await fixture.load()).OrganizerDesktopRestores.length, 0)
  assert.equal((await fixture.invoke('organizer:restore', folder.category.Id, folder.stored)).ok, true)
  await fs.unlink(file.source)
  assert.equal((await fixture.invoke('organizer:undo')).ok, true)
})

test('a failed journal write leaves stored files untouched; a cancelled quit can resume and retry', async t => {
  const fixture = await mainFixture(t)
  const file = await collect(fixture, 'retry.txt')
  const blocked = await collect(fixture, 'blocked.txt')
  const write = fixture.fileSystem.writeFile
  fixture.fileSystem.writeFile = async () => { throw Error('disk full') }
  await assert.rejects(fixture.restoreOrganizerForQuit(), /disk full/)
  await fs.stat(file.stored)
  await assert.rejects(fs.stat(file.source), { code: 'ENOENT' })
  fixture.fileSystem.writeFile = write
  await fixture.resumeOrganizerSession()
  const rename = fixture.fileSystem.rename
  fixture.fileSystem.rename = async (source, ...args) => {
    if (source === blocked.stored) throw Error('file in use')
    return rename(source, ...args)
  }
  await assert.rejects(fixture.restoreOrganizerForQuit(), /退出已取消/)
  await fs.stat(blocked.stored)
  await fs.stat(file.source)
  fixture.fileSystem.rename = rename
  await fixture.resumeOrganizerSession()
  await fs.stat(file.stored)
  await assert.rejects(fs.stat(file.source), { code: 'ENOENT' })
  await fixture.restoreOrganizerForQuit()
  assert.equal(await fs.readFile(file.source, 'utf8'), 'contents: 0')
})

test('restart does not collect a replacement at a restored desktop path', async t => {
  const fixture = await mainFixture(t)
  const file = await collect(fixture, 'replace.txt')
  await fixture.restoreOrganizerForQuit()
  // Renaming guarantees that the replacement has a different file identity.
  await fs.rename(file.source, `${file.source}.kept`)
  await fs.writeFile(file.source, 'replacement')
  await fixture.resumeOrganizerSession()
  assert.equal(await fs.readFile(file.source, 'utf8'), 'replacement')
  await assert.rejects(fs.stat(file.stored), { code: 'ENOENT' })
})
