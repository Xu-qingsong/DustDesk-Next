import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { closeDustDesk, launchDustDesk } from './electron-harness.mjs'

let fixture = await launchDustDesk()
const load = () => fixture.window.evaluate(() => window.dustdesk.loadWorkspace())
const root = fixture.tempRoot
const workspaceFile = path.join(root, 'data', 'workspace.json')
try {
  const encoded = await fixture.electronApp.evaluate(({ nativeImage }) => {
    const bytes = Buffer.alloc(256 * 256 * 4)
    let seed = 42
    for (let i = 0; i < bytes.length; i++) { seed = (1664525 * seed + 1013904223) >>> 0; bytes[i] = seed >>> 24 }
    return nativeImage.createFromBitmap(bytes, { width: 256, height: 256 }).toPNG().toString('base64')
  })
  const legacy = await load()
  legacy.SchemaVersion = 2
  legacy.Settings.ClipboardMonitoringEnabled = false
  legacy.Settings.AutomaticBackupEnabled = false
  legacy.ClipboardHistory = [{ Id: 'image', Kind: 'Image', Text: '', ImagePngBase64: encoded, ImageFileName: 'fixture.png', ImageSha256: 'fixture', CreatedAt: new Date().toISOString(), IsLocked: true, IsPinned: true }]
  await closeDustDesk({ ...fixture, preserveTempRoot: true })
  await writeFile(workspaceFile, JSON.stringify(legacy))
  fixture = await launchDustDesk({ tempRoot: root })
  const migrated = await load()
  assert.equal(migrated.SchemaVersion, 3)
  assert.equal(migrated.ClipboardHistory[0].ImagePngBase64, '')
  const imagePath = path.join(root, 'data', 'ClipboardImages', migrated.ClipboardHistory[0].ImageAssetName)
  assert.equal((await readFile(imagePath)).toString('base64'), encoded)
  assert.ok((await readFile(workspaceFile)).length < encoded.length / 4)
  console.log('Legacy clipboard migration preserves images and shrinks workspace payload')

  const expectedPixels = await fixture.electronApp.evaluate(({ nativeImage }, encoded) => process.getBuiltinModule('crypto').createHash('sha256').update(nativeImage.createFromBuffer(Buffer.from(encoded, 'base64')).toBitmap()).digest('hex'), encoded)
  await fixture.electronApp.evaluate(({ clipboard }) => {
    globalThis.originalImageWriter = clipboard.writeImage
    clipboard.writeImage = image => { globalThis.copiedImage = process.getBuiltinModule('crypto').createHash('sha256').update(image.toBitmap()).digest('hex') }
    process.getBuiltinModule('electron').net.fetch = async () => new Response(JSON.stringify({ tag_name: 'v1.0.0', body: '发布说明' }))
  })
  assert.equal((await fixture.window.evaluate(() => window.dustdesk.checkForUpdate())).available, false)
  await fixture.electronApp.evaluate(() => {
    const { net, dialog } = process.getBuiltinModule('electron')
    net.fetch = async () => new Response(JSON.stringify({ tag_name: 'v1.1.0', body: '新版本发布说明' }))
    dialog.showMessageBox = async () => ({ response: 0 })
  })
  assert.equal((await fixture.window.evaluate(() => window.dustdesk.checkForUpdate())).available, true)
  await fixture.window.evaluate(() => window.dustdesk.writeClipboard({ recordId: 'image' }))
  assert.equal(await fixture.electronApp.evaluate(() => globalThis.copiedImage), expectedPixels)

  const backup = await fixture.window.evaluate(() => window.dustdesk.createBackup())
  assert.equal(backup.ok, true)
  const portable = JSON.parse(await readFile(backup.path, 'utf8'))
  assert.equal(portable.ClipboardHistory[0].ImagePngBase64, encoded)
  await fixture.window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    await window.dustdesk.saveWorkspace({ ...state, ClipboardHistory: [] }, state)
  })
  // Corrupt the managed copy: recovery must use the image embedded in the backup.
  await writeFile(imagePath, 'damaged')
  assert.equal((await fixture.window.evaluate(file => window.dustdesk.restoreBackup(file), backup.path)).ok, true)
  await fixture.window.evaluate(() => window.dustdesk.writeClipboard({ recordId: 'image' }))
  assert.equal(await fixture.electronApp.evaluate(() => globalThis.copiedImage), expectedPixels)
  const restored = await load()
  assert.equal(restored.ClipboardHistory[0].ImagePngBase64, '')
  assert.equal(restored.ClipboardHistory[0].IsLocked, true)
  console.log('Update availability, image copy and portable backup recovery passed')

  const malformed = path.join(root, 'data', 'Backups', 'malformed.json')
  await writeFile(malformed, JSON.stringify({ ...portable, Notes: [{}] }))
  const before = await readFile(workspaceFile, 'utf8')
  assert.equal((await fixture.window.evaluate(file => window.dustdesk.restoreBackup(file), malformed)).ok, false)
  assert.equal(await readFile(workspaceFile, 'utf8'), before)
  await assert.rejects(fixture.window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    await window.dustdesk.saveWorkspace({ ...state, Notes: [{}] }, state)
  }), /不完整/)
  assert.equal(await readFile(workspaceFile, 'utf8'), before)

  await fixture.electronApp.evaluate(() => {
    const fs = process.getBuiltinModule('fs').promises
    globalThis.originalRename = fs.rename
    fs.rename = async (from, to) => {
      if (String(to).endsWith('workspace.json')) throw Error('TEST_SAVE_FAILURE')
      return globalThis.originalRename(from, to)
    }
  })
  await assert.rejects(fixture.window.evaluate(async () => {
    const state = await window.dustdesk.loadWorkspace()
    await window.dustdesk.saveWorkspace({ ...state, QuickNote: 'must not commit' }, state)
  }), /TEST_SAVE_FAILURE/)
  await fixture.electronApp.evaluate(() => { process.getBuiltinModule('fs').promises.rename = globalThis.originalRename })
  assert.equal(await readFile(workspaceFile, 'utf8'), before)
  console.log('Malformed backups and failed writes preserve the existing workspace')

  const inlineWorkspace = JSON.stringify({ ...portable, QuickNote: 'valid-inline-workspace' })
  await writeFile(workspaceFile, inlineWorkspace)
  await writeFile(imagePath, 'damaged')
  await fixture.electronApp.evaluate(() => {
    const fs = process.getBuiltinModule('fs').promises
    fs.rename = async (from, to) => {
      if (String(to).endsWith('.png')) throw Error('TEST_ASSET_WRITE_FAILURE')
      return globalThis.originalRename(from, to)
    }
  })
  await assert.rejects(load(), /TEST_ASSET_WRITE_FAILURE/)
  assert.equal(await readFile(workspaceFile, 'utf8'), inlineWorkspace, 'migration failure must not fall back to an older backup')
  await fixture.electronApp.evaluate(() => { process.getBuiltinModule('fs').promises.rename = globalThis.originalRename })
  assert.equal((await load()).QuickNote, 'valid-inline-workspace')
  assert.equal((await load()).ClipboardHistory[0].ImagePngBase64, '')
  console.log('Failed asset migration preserves the valid inline workspace and retries safely')

  const searchRoot = path.join(root, 'cancel-search'); await mkdir(searchRoot)
  await fixture.window.evaluate(async searchRoot => {
    const state = await window.dustdesk.loadWorkspace()
    const Settings = { ...state.Settings, SearchDesktopFiles: false, SearchAppData: false, SearchStartMenuApps: false, SearchProjectPaths: false, SearchCustomPaths: true, SearchCustomRoots: [searchRoot] }
    await window.dustdesk.saveWorkspace({ ...state, Settings }, state)
  }, searchRoot)
  await fixture.electronApp.evaluate((_electron, searchRoot) => {
    const fs = process.getBuiltinModule('fs').promises
    globalThis.originalReaddir = fs.readdir
    fs.readdir = async (...args) => {
      if (args[0] === searchRoot) await new Promise(resolve => { globalThis.releaseSearch = resolve })
      return globalThis.originalReaddir(...args)
    }
  }, searchRoot)
  await fixture.window.evaluate(() => { window.searchDone = false; window.pendingSearch = window.dustdesk.searchFiles('needle', 'owned-search').then(value => { window.searchDone = true; return value }) })
  await assert.doesNotReject(async () => {
    for (let i = 0; i < 100; i++) {
      if (await fixture.electronApp.evaluate(() => Boolean(globalThis.releaseSearch))) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    throw Error('Search did not start')
  })
  const newWindow = fixture.electronApp.waitForEvent('window')
  await fixture.window.evaluate(() => window.dustdesk.showQuickCapture())
  const capture = await newWindow
  await capture.getByLabel('记录标题').waitFor()
  await capture.evaluate(() => window.dustdesk.cancelFileSearch('owned-search'))
  assert.equal(await fixture.window.evaluate(() => window.searchDone), false)
  await fixture.window.evaluate(() => window.dustdesk.cancelFileSearch('owned-search'))
  await fixture.electronApp.evaluate(() => { globalThis.releaseSearch(); process.getBuiltinModule('fs').promises.readdir = globalThis.originalReaddir })
  assert.deepEqual(await fixture.window.evaluate(() => window.pendingSearch), [])
  console.log('File search cancellation is scoped to the requesting window')

  const metrics = await fixture.window.evaluate(() => window.dustdesk.sampleSystemMetrics())
  for (const key of ['DiskReadBytesPerSecond', 'DiskWriteBytesPerSecond']) assert.ok(metrics[key] === null || Number.isFinite(metrics[key]) && metrics[key] >= 0)
  console.log('Windows disk sample:', metrics.DiskReadBytesPerSecond, metrics.DiskWriteBytesPerSecond)
} finally {
  await fixture.electronApp.evaluate(({ clipboard }) => {
    if (globalThis.originalImageWriter) clipboard.writeImage = globalThis.originalImageWriter
    const fs = process.getBuiltinModule('fs').promises
    if (globalThis.originalRename) fs.rename = globalThis.originalRename
    if (globalThis.originalReaddir) fs.readdir = globalThis.originalReaddir
    globalThis.releaseSearch?.()
  }).catch(() => {})
  await closeDustDesk(fixture)
}
