import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ts from 'typescript'

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`
const source = file => fs.readFile(new URL(`../src/main/${file}.ts`, import.meta.url), 'utf8')
const paths = moduleUrl(await source('fileOperations'))
const { createClipboardAssets } = await import(moduleUrl((await source('clipboardAssets')).replace("'./fileOperations'", JSON.stringify(paths))))
const { isCompleteWorkspace } = await import(moduleUrl(await source('workspaceValidation')))
const { createFileSearch } = await import(moduleUrl(await source('fileSearch')))
const { sampleWindowsDiskThroughput } = await import(moduleUrl(await source('diskMetrics')))
const state = () => ({ SchemaVersion: 3, Settings: {}, Todos: [], Notes: [], Projects: [], Launchers: [], LinkGroups: [], ClipboardHistory: [], DesktopCategories: [], TagPresets: [] })

test('damaged records and duplicate IDs fail validation without rejecting legacy optional fields', () => {
  for (const key of ['Todos', 'Notes', 'Projects', 'Launchers', 'LinkGroups', 'ClipboardHistory', 'DesktopCategories', 'TagPresets']) {
    assert.equal(isCompleteWorkspace({ ...state(), [key]: [{}] }), false, key)
  }
  assert.equal(isCompleteWorkspace({ ...state(), Notes: [{ Id: 'n', Title: 'keep', Text: 'body' }] }), true)
  assert.equal(isCompleteWorkspace({ ...state(), Notes: [{ Id: 'n', Title: 'keep' }] }), false)
  assert.equal(isCompleteWorkspace({ ...state(), Todos: [{ Id: 't', Title: 'one' }, { Id: 't', Title: 'two' }] }), false)
  assert.equal(isCompleteWorkspace({ ...state(), Projects: [{ Id: 'p', Name: 'project', Phases: [{ Id: 'f', Title: 'phase', Subtasks: [{}] }] }] }), false)
  assert.equal(isCompleteWorkspace({ ...state(), SchemaVersion: 1, Notes: [{ Title: 'legacy', Text: 'preserved' }] }), true)
  assert.equal(isCompleteWorkspace({ ...state(), SchemaVersion: 4 }), false)
})

test('duplicate recovery, rule, focus and cross-group link IDs cannot silently lose or double-count records', () => {
  const entry = { Id: 'duplicate', kind: 'note', value: { Id: 'note-a', Title: 'A', Text: 'keep A' }, ExpiresAt: '2099-01-01T00:00:00Z' }
  assert.equal(isCompleteWorkspace({ ...state(), RecycleBin: [entry, { ...entry, value: { Id: 'note-b', Title: 'B', Text: 'keep B' } }] }), false)
  const rule = { Id: 'duplicate', Enabled: true, Match: 'name', Pattern: 'file', CategoryId: 'category' }
  assert.equal(isCompleteWorkspace({ ...state(), OrganizerRules: [rule, { ...rule }] }), false)
  const session = { Id: 'duplicate', TaskTitle: 'Task', ProjectName: '', Seconds: 60 }
  assert.equal(isCompleteWorkspace({ ...state(), FocusSessions: [session, { ...session }] }), false)
  const link = { Id: 'duplicate', Name: 'link', Url: 'https://example.com' }
  assert.equal(isCompleteWorkspace({ ...state(), LinkGroups: [{ Id: 'one', Name: 'one', Links: [link] }, { Id: 'two', Name: 'two', Links: [{ ...link }] }] }), false)
})

test('clipboard assets migrate, deduplicate, survive deletion and travel with portable backups', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-clipboard-assets-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const manager = createClipboardAssets(() => root)
  const encoded = Buffer.alloc(1024 * 1024, 7).toString('base64')
  const workspace = { ...state(), ClipboardHistory: [{ Id: 'image', Kind: 'Image', Text: '', ImagePngBase64: encoded, ImageFileName: 'image.png' }] }
  await manager.externalize(workspace)
  assert.equal(workspace.ClipboardHistory[0].ImagePngBase64, '')
  assert.ok(JSON.stringify(workspace).length < 1000)
  assert.equal(await manager.read(workspace.ClipboardHistory[0]), encoded)
  const duplicate = structuredClone(workspace)
  duplicate.ClipboardHistory[0].ImagePngBase64 = encoded
  await manager.externalize(duplicate)
  assert.deepEqual(await fs.readdir(path.join(root, 'ClipboardImages')), [workspace.ClipboardHistory[0].ImageAssetName])
  const portable = await manager.forBackup(workspace)
  assert.equal(portable.ClipboardHistory[0].ImagePngBase64, encoded)
  assert.equal(workspace.ClipboardHistory[0].ImagePngBase64, '')
  const destination = path.join(root, 'other-installation'); await fs.mkdir(destination)
  const other = createClipboardAssets(() => destination)
  await other.externalize(portable)
  assert.equal(await other.read(portable.ClipboardHistory[0]), encoded)
  await manager.externalize({ ...workspace, ClipboardHistory: [] })
  assert.equal(await manager.read(workspace.ClipboardHistory[0]), encoded, 'recovery references must survive history deletion')
  await assert.rejects(manager.read({ ImageAssetName: '../outside.png' }), /引用无效/)
  await fs.writeFile(path.join(root, 'ClipboardImages', workspace.ClipboardHistory[0].ImageAssetName), 'damaged')
  await assert.rejects(manager.read(workspace.ClipboardHistory[0]), /损坏/)
})

test('clipboard asset writes reject junctions without clearing the inline recovery data', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-clipboard-junction-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const data = path.join(root, 'data'); const outside = path.join(root, 'outside')
  await fs.mkdir(data); await fs.mkdir(outside)
  await fs.symlink(outside, path.join(data, 'ClipboardImages'), 'junction')
  const workspace = { ...state(), ClipboardHistory: [{ Kind: 'Image', ImagePngBase64: 'aW1hZ2U=' }] }
  await assert.rejects(createClipboardAssets(() => data).externalize(workspace), /redirected/)
  assert.equal(workspace.ClipboardHistory[0].ImagePngBase64, 'aW1hZ2U=')
  assert.deepEqual(await fs.readdir(outside), [])
})

test('Windows disk rates preserve bytes, distinguish idle from missing data and handle failures', async () => {
  assert.deepEqual(await sampleWindowsDiskThroughput(async (_command, _args, options) => {
    assert.equal(options.windowsHide, true)
    assert.equal(options.timeout, 5000)
    return { stdout: '{"read":1048576,"write":0}' }
  }), { read: 1048576, write: 0 })
  for (const stdout of ['', 'null', '{"read":-1}', '{"read":"invalid","write":null}']) {
    assert.deepEqual(await sampleWindowsDiskThroughput(async () => ({ stdout })), { read: null, write: null })
  }
  assert.deepEqual(await sampleWindowsDiskThroughput(async () => { throw Error('timeout') }), { read: null, write: null })
})

const entry = (name, directory = false) => ({ name, isDirectory: () => directory, isSymbolicLink: () => false })
test('cancelled searches stop traversal and never populate the result cache', async () => {
  let release
  let calls = 0
  const search = createFileSearch(async () => {
    calls++
    if (calls === 1) await new Promise(resolve => { release = resolve })
    return calls === 1 ? [entry('match.txt'), entry('nested', true)] : [entry('fresh-match.txt')]
  })
  const controller = new AbortController()
  const pending = search(['/root'], 'match', controller.signal)
  controller.abort(); release()
  assert.deepEqual(await pending, [])
  assert.equal(calls, 1)
  const second = new AbortController(); second.abort()
  assert.deepEqual(await search(['/root'], 'match', second.signal), [])
  assert.equal(calls, 1)
  assert.equal((await search(['/root'], 'match', new AbortController().signal))[0].Name, 'fresh-match.txt')
  assert.equal(calls, 2)
})

test('overlapping search roots are scanned once and identical queries reuse the short cache', async () => {
  const root = path.resolve('fixture-root')
  const nested = path.join(root, 'nested')
  const calls = []
  const search = createFileSearch(async directory => {
    calls.push(directory)
    return directory === root ? [entry('nested', true), entry('match-a')] : [entry('match-b')]
  })
  const results = await search([root, nested, root], 'match', new AbortController().signal)
  assert.deepEqual(results.map(item => item.Name), ['match-a', 'match-b'])
  assert.deepEqual(calls, [root, nested])
  assert.deepEqual(await search([root, nested, root], 'match', new AbortController().signal), results)
  assert.equal(calls.length, 2)
})
