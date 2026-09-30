import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'

async function sourceModuleUrl(relative) {
  const source = await fs.readFile(new URL(relative, import.meta.url), 'utf8')
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
}

const { assertPathWithinRoot, moveFileSafely } = await import(await sourceModuleUrl('../src/main/fileOperations.ts'))
const { createClipboardSampler } = await import(await sourceModuleUrl('../src/main/clipboardSampler.ts'))
const { retainClipboardHistory } = await import(await sourceModuleUrl('../src/renderer/src/utils/clipboard.ts'))
const datesUrl = await sourceModuleUrl('../src/renderer/src/utils/dates.ts')
const { daysUntilPayday, isTodoOverdue } = await import(datesUrl)

async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-file-regression-'))
  try { await run(root) }
  finally { await fs.rm(root, { recursive: true, force: true }) }
}

test('cross-volume cleanup failure preserves the complete destination', () => fixture(async root => {
  const source = path.join(root, 'source'); const target = path.join(root, 'target')
  await fs.mkdir(source)
  await fs.writeFile(path.join(source, 'a.txt'), 'recoverable')
  await fs.writeFile(path.join(source, 'locked.txt'), 'locked')
  const injected = {
    ...fs,
    rename: async (from, to) => {
      if (from === source) throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' })
      return fs.rename(from, to)
    },
    rm: async (value, options) => {
      if (value === source) {
        await fs.rm(path.join(source, 'a.txt'))
        throw Object.assign(new Error('locked'), { code: 'EPERM' })
      }
      return fs.rm(value, options)
    }
  }
  await assert.rejects(moveFileSafely(source, target, injected), /complete copy retained/)
  assert.equal(await fs.readFile(path.join(target, 'a.txt'), 'utf8'), 'recoverable')
  assert.equal(await fs.readFile(path.join(target, 'locked.txt'), 'utf8'), 'locked')
  assert.equal(await fs.readFile(path.join(source, 'locked.txt'), 'utf8'), 'locked')
  assert.deepEqual((await fs.readdir(root)).sort(), ['source', 'target'])
}))

test('failed cross-volume copy only cleans its own staging directory', () => fixture(async root => {
  const source = path.join(root, 'source.txt'); const target = path.join(root, 'target.txt')
  await fs.writeFile(source, 'original')
  const injected = { ...fs,
    rename: async () => { throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' }) },
    cp: async (_from, to) => { await fs.writeFile(to, 'partial'); throw new Error('copy failed') }
  }
  await assert.rejects(moveFileSafely(source, target, injected), /copy failed/)
  assert.equal(await fs.readFile(source, 'utf8'), 'original')
  assert.deepEqual(await fs.readdir(root), ['source.txt'])
}))

test('successful cross-volume moves and existing-target conflicts preserve data', () => fixture(async root => {
  const source = path.join(root, 'source.txt'); const target = path.join(root, 'target.txt')
  await fs.writeFile(source, 'original')
  await fs.writeFile(target, 'existing')
  await assert.rejects(moveFileSafely(source, target), /Target already exists/)
  assert.equal(await fs.readFile(target, 'utf8'), 'existing')
  const destination = path.join(root, 'moved.txt')
  const injected = { ...fs, rename: async (from, to) => {
    if (from === source) throw Object.assign(new Error('cross-volume'), { code: 'EXDEV' })
    return fs.rename(from, to)
  } }
  await moveFileSafely(source, destination, injected)
  assert.equal(await fs.readFile(destination, 'utf8'), 'original')
  await assert.rejects(fs.stat(source), { code: 'ENOENT' })
}))

test('managed paths reject category and managed-directory junctions', () => fixture(async root => {
  const data = path.join(root, 'data'); const outside = path.join(root, 'outside')
  await fs.mkdir(data); await fs.mkdir(outside)
  await fs.symlink(outside, path.join(data, 'DesktopOrganizer'), 'junction')
  await assert.rejects(assertPathWithinRoot(data, path.join(data, 'DesktopOrganizer', 'new.txt'), true), /redirected/)
  await fs.mkdir(path.join(data, 'safe'))
  await fs.symlink(outside, path.join(data, 'safe', 'category'), 'junction')
  await assert.rejects(assertPathWithinRoot(data, path.join(data, 'safe', 'category', 'new.txt'), true), /redirected/)
  await assert.rejects(assertPathWithinRoot(data, path.join(outside, 'file.txt'), true), /outside/)
  await assertPathWithinRoot(data, path.join(data, 'safe', 'new', 'file.txt'), true)
}))

test('payday honors 29-31, month ends, leap years, year rollover and today', () => {
  for (const [date, day, expected] of [
    ['2026-10-05T12:00:00', 31, 26], ['2026-09-10T12:00:00', 10, 0],
    ['2026-09-05T12:00:00', 31, 25], ['2026-02-01T12:00:00', 31, 27],
    ['2028-02-01T12:00:00', 29, 28], ['2026-12-31T12:00:00', 10, 10],
    ['2026-01-31T12:00:00', 31, 0], ['2026-02-28T23:59:59', 31, 0]
  ]) assert.equal(daysUntilPayday(new Date(date), day), expected, `${date}/${day}`)
})

test('project date inputs round-trip in positive and negative time zones', () => {
  for (const timezone of ['Asia/Shanghai', 'America/New_York', 'Pacific/Auckland']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { localDateIsoValue, localDateInputValue, daysUntilPayday } from ${JSON.stringify(datesUrl)};
      for (const value of ['2026-09-05', '2026-03-08', '2026-11-01']) {
        assert.equal(localDateInputValue(localDateIsoValue(value)), value);
        assert.equal(localDateInputValue(value), value);
      }
      assert.equal(localDateIsoValue(''), null);
      assert.equal(localDateInputValue('invalid'), '');
      assert.equal(daysUntilPayday(new Date('2026-03-07T12:00:00'), 10), 3);
    `], { env: { ...process.env, TZ: timezone }, encoding: 'utf8' })
    assert.equal(result.status, 0, `${timezone}: ${result.stderr}`)
  }
})

test('clipboard retention protects locked and pinned records at and over capacity', () => {
  const history = Array.from({ length: 202 }, (_, i) => ({ Id: String(i), IsLocked: i === 201, IsPinned: i === 200 }))
  const kept = retainClipboardHistory(history)
  assert.equal(kept.length, 200)
  assert.equal(kept[0].Id, '0')
  assert.equal(kept.some(r => r.Id === '201'), true)
  assert.equal(kept.some(r => r.Id === '200'), true)
  assert.equal(kept.some(r => r.Id === '199'), false)
  const allLocked = history.map(item => ({ ...item, IsLocked: true }))
  assert.equal(retainClipboardHistory(allLocked).length, 202)
})

test('notified but incomplete tasks remain overdue', () => {
  const task = { IsCompleted: false, ReminderAt: '2026-01-01T12:00:00Z', ReminderNotifiedAt: '2026-01-01T12:00:01Z' }
  const now = new Date('2026-02-01T12:00:00Z')
  assert.equal(isTodoOverdue(task, now), true)
  assert.equal(isTodoOverdue({ ...task, IsCompleted: true }, now), false)
  assert.equal(isTodoOverdue({ ...task, ReminderAt: null }, now), false)
  assert.equal(isTodoOverdue({ ...task, ReminderAt: 'invalid' }, now), false)
})

test('unchanged clipboard images are not repeatedly PNG encoded', () => {
  let encoded = 0
  const image = { isEmpty: () => false, getSize: () => ({ width: 2, height: 2 }), toBitmap: () => Buffer.from('raw'), toPNG: () => { encoded++; return Buffer.from('png') } }
  const sample = createClipboardSampler(1024)
  assert.ok(sample('', image))
  assert.equal(sample('', image), null)
  assert.equal(encoded, 1)
  assert.ok(sample('changed', image))
  assert.equal(encoded, 2)
  assert.equal(sample('', { ...image, getSize: () => ({ width: 100000, height: 100000 }) }), null)
  assert.equal(encoded, 2)
  assert.equal(createClipboardSampler(1)('', image), null)
})

test('typecheck includes application sources and cannot emit adjacent artifacts', () => {
  const config = ts.readConfigFile('tsconfig.json', ts.sys.readFile)
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd())
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.options.noEmit, true)
  assert.equal(parsed.options.strict, true)
  assert.equal(parsed.options.noUncheckedIndexedAccess, true)
  for (const file of ['src/main/index.ts', 'src/preload/index.ts', 'src/renderer/src/app/App.tsx']) {
    assert.ok(parsed.fileNames.some(name => path.resolve(name) === path.resolve(file)), file)
  }
})
