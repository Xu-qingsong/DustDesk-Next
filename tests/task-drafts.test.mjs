import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { draftModuleUrl } from './draft-module.mjs'

const source = await readFile(new URL('../src/renderer/src/widgets/taskDrafts.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { TaskDraftStore, taskDraftKey } = await import('data:text/javascript;base64,' + Buffer.from(compiled.replace('../../../shared/draftMigration', draftModuleUrl)).toString('base64'))
const state = () => ({ Todos: [], RecycleBin: [] })
function storage() {
  const values = new Map(); let blocked = false
  return { values, block: value => { blocked = value }, getItem: key => { if (blocked) throw Error('read blocked'); return values.get(key) ?? null }, setItem: (key, value) => { if (blocked) throw Error('write blocked'); values.set(key, value) } }
}

test('typed task drafts survive renderer recreation and retain one id until the task is saved', () => {
  const disk = storage(); const first = new TaskDraftStore(disk); first.load(state()); first.change('未提交🪶任务')
  const identifier = first.current.requestId; first.change('修改后的未提交任务'); const second = new TaskDraftStore(disk)
  assert.deepEqual(second.load(state()), { title: '修改后的未提交任务', requestId: identifier }); assert.equal(second.pending, false)
  second.clear(); assert.notEqual(second.current.requestId, identifier); assert.equal(new TaskDraftStore(disk).load(state()).title, '')
})

test('failed writes stay in memory and veto a flush until storage recovers', () => {
  const disk = storage(); const drafts = new TaskDraftStore(disk); drafts.load(state()); disk.block(true)
  assert.throws(() => drafts.change('磁盘失败时的输入'), /write blocked/); assert.equal(drafts.current.title, '磁盘失败时的输入'); assert.equal(drafts.pending, true)
  assert.throws(() => drafts.flush(), /write blocked/); assert.equal(drafts.pending, true); disk.block(false); drafts.flush()
  assert.equal(drafts.pending, false); assert.equal(new TaskDraftStore(disk).load(state()).title, '磁盘失败时的输入')
})

test('failed cleanup cannot resurrect a committed or recycled task after renderer restart', () => {
  for (const recycled of [false, true]) {
    const disk = storage(); const drafts = new TaskDraftStore(disk); drafts.load(state()); drafts.change('已保存但清理失败'); const identifier = drafts.current.requestId
    disk.block(true); assert.throws(() => drafts.clear(), /write blocked/); assert.equal(drafts.current.title, ''); assert.equal(drafts.pending, true); disk.block(false)
    const workspace = state(); if (recycled) workspace.RecycleBin.push({ kind: 'task', value: { Id: identifier } }); else workspace.Todos.push({ Id: identifier })
    const restarted = new TaskDraftStore(disk); assert.equal(restarted.load(workspace).title, ''); assert.notEqual(restarted.current.requestId, identifier)
    assert.equal(new TaskDraftStore(disk).load(workspace).title, '')
  }
})

test('unreadable and malformed task drafts remain untouched and cannot be acknowledged as flushed', () => {
  for (const value of ['{', 'null', '{}', JSON.stringify({ title: '原文', requestId: '' }), JSON.stringify({ title: '字'.repeat(301), requestId: 'id' })]) {
    const disk = storage(); disk.values.set(taskDraftKey, value); const drafts = new TaskDraftStore(disk)
    assert.throws(() => drafts.load(state())); assert.equal(drafts.ready, false); assert.throws(() => drafts.flush(), /尚未读取/); assert.equal(disk.values.get(taskDraftKey), value)
  }
  const disk = storage(); disk.block(true); const drafts = new TaskDraftStore(disk); assert.throws(() => drafts.load(state()), /read blocked/); assert.equal(drafts.ready, false)
  disk.block(false); assert.equal(drafts.load(state()).title, ''); assert.equal(drafts.ready, true)
})

test('reconciled cleanup failure retains an empty pending checkpoint for retry rather than old task text', () => {
  const disk = storage(); const drafts = new TaskDraftStore(disk); drafts.load(state()); drafts.change('已提交')
  const workspace = { Todos: [{ Id: drafts.current.requestId }], RecycleBin: [] }; const restarted = new TaskDraftStore({ getItem: key => disk.getItem(key), setItem: () => { throw Error('quota') } })
  assert.throws(() => restarted.load(workspace), /quota/); assert.equal(restarted.ready, true); assert.equal(restarted.pending, true); assert.equal(restarted.current.title, '')
})
