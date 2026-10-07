import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import ts from 'typescript'
import { mainFixture } from './main-headless-harness.mjs'

const compile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const moduleUrl = text => `data:text/javascript;base64,${Buffer.from(text).toString('base64')}`
const repoUrl = moduleUrl(compile(await fs.readFile('src/shared/repository.ts', 'utf8')))
const { repository } = await import(repoUrl)
const { compareVersions, createReleaseUpdateChecker } = await import(moduleUrl(compile(await fs.readFile('src/main/releaseUpdates.ts', 'utf8')).replace("'../shared/repository'", JSON.stringify(repoUrl))))
const response = body => new Response(JSON.stringify(body), { status: 200 })
const release = { tag_name: 'v1.2.0', body: '## 更新内容\n- 修复截图卡顿\n- 完善阶段弹窗', draft: false, prerelease: false }

test('release comparison handles numeric segments, prefixes, prereleases and build metadata', () => {
  for (const [a, b, expected] of [['v1.10.0', '1.9.9', 1], ['v1.0.0', '1.0.0', 0], ['1.0.0', '1.0.0-beta.2', 1], ['1.0.0-beta.10', '1.0.0-beta.2', 1], ['1.0.0+build.2', '1.0.0+build.1', 0], ['0.9.0', '1.0.0', -1]]) assert.equal(compareVersions(a, b), expected)
  assert.throws(() => compareVersions('latest', '1.0.0'), /无法识别/)
})

test('new versions show release notes and open only this repository after confirmation', async t => {
  const f = await mainFixture(t), dialogs = [], opened = [], requests = []
  f.electron.net.fetch = async (url, options) => { requests.push(url); assert.equal(options.headers.Accept, 'application/vnd.github+json'); return response({ ...release, html_url: 'https://other.example/release' }) }
  f.electron.dialog.showMessageBox = async (...args) => { dialogs.push(args.at(-1)); return { response: 0 } }
  f.electron.shell.openExternal = async url => { opened.push(url) }
  const declined = await f.invoke('update:check')
  assert.equal(declined.available, true); assert.equal(declined.releaseNotes, release.body)
  assert.match(dialogs[0].detail, /修复截图卡顿/); assert.match(dialogs[0].detail, /当前版本：1.0.0/)
  assert.deepEqual(opened, [])
  f.electron.dialog.showMessageBox = async () => ({ response: 1 })
  assert.equal((await f.invoke('update:check')).ok, true)
  assert.deepEqual(opened, [`${repository.releases}/tag/v1.2.0`])
  assert.deepEqual(requests, [repository.latestReleaseApi, repository.latestReleaseApi])
  assert.equal(f.handlers.has('update:download'), false); assert.equal(f.handlers.has('update:install'), false)
})

test('same or older releases never prompt or open an update', async t => {
  const f = await mainFixture(t)
  f.electron.dialog.showMessageBox = async () => { throw Error('Unexpected dialog') }
  for (const tag_name of ['v1.0.0', 'v0.9.0']) {
    f.electron.net.fetch = async () => response({ ...release, tag_name })
    assert.deepEqual((({ ok, available }) => ({ ok, available }))(await f.invoke('update:check')), { ok: true, available: false })
  }
})

test('empty repositories, inaccessible repositories and rate limits are distinct from latest-version success', async t => {
  const f = await mainFixture(t)
  f.electron.net.fetch = async url => url === repository.latestReleaseApi ? new Response('', { status: 404 }) : response({ name: repository.name })
  const empty = await f.invoke('update:check'); assert.equal(empty.ok, true); assert.match(empty.message, /尚未发布/)
  for (const status of [403, 429, 500, 404]) {
    f.electron.net.fetch = async () => new Response('', { status })
    const result = await f.invoke('update:check'); assert.equal(result.ok, false); assert.ok(result.error)
  }
  f.electron.net.fetch = async () => { throw Error('network offline') }
  assert.equal((await f.invoke('update:check')).ok, false)
  f.electron.net.fetch = async () => response({ ...release, tag_name: 'latest' })
  assert.equal((await f.invoke('update:check')).ok, false)
  f.electron.net.fetch = async () => response(release)
  assert.equal((await f.invoke('update:check')).ok, true, 'A failed check must remain retryable')
})

test('concurrent checks share the request and confirmation; missing notes have a readable fallback', async () => {
  let finish, requests = 0, prompts = 0
  const checker = createReleaseUpdateChecker({ version: () => '1.0.0', request: () => { requests++; return new Promise(resolve => { finish = resolve }) }, confirm: async (_version, _current, notes) => { prompts++; assert.match(notes, /未提供更新说明/); return false }, open: async () => { throw Error('Unexpected browser navigation') } })
  const a = checker.check(), b = checker.check(); assert.equal(a, b)
  finish(response({ ...release, body: '' })); await Promise.all([a, b])
  assert.equal(requests, 1); assert.equal(prompts, 1)
})

test('publish and help links use the current code repository', async () => {
  const pkg = JSON.parse(await fs.readFile('package.json', 'utf8'))
  assert.equal(pkg.build.publish.owner, repository.owner); assert.equal(pkg.build.publish.repo, repository.name)
  assert.equal(pkg.homepage, repository.url); assert.equal(pkg.bugs.url, repository.issues)
})
