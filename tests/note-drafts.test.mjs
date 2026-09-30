import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/renderer/src/widgets/noteDrafts.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { NoteDraftStore, noteDraftKey, savedNoteDraft } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
const note = { Id: 'one', Title: 'Title', Text: 'saved text' }
function storage() {
  const values = new Map()
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('clean synchronization in another widget cannot overwrite a private dirty draft', () => {
  const disk = storage(); const recent = new NoteDraftStore(disk); const pinned = new NoteDraftStore(disk)
  const draft = { ...savedNoteDraft(note), text: 'private recent draft' }
  recent.write('notes', note.Id, draft)
  pinned.write(`note:${note.Id}`, note.Id, savedNoteDraft({ ...note, Text: 'external update' }))
  assert.deepEqual(recent.read('notes', { ...note, Text: 'external update' }), draft)
  assert.deepEqual(new NoteDraftStore(disk).read('notes', note), draft)
  assert.equal(pinned.read(`note:${note.Id}`, { ...note, Text: 'latest update' }).text, 'latest update')
})

test('legacy drafts migrate independently and do not reappear after a scoped save', () => {
  const disk = storage(); const draft = { ...savedNoteDraft(note), text: 'legacy unsaved' }
  disk.setItem(`widget-note:${note.Id}`, JSON.stringify(draft))
  const recent = new NoteDraftStore(disk)
  assert.deepEqual(recent.read('notes', note), draft)
  recent.write('notes', note.Id, draft)
  const saved = { ...note, Text: draft.text }
  recent.write('notes', note.Id, savedNoteDraft(saved))
  assert.equal(new NoteDraftStore(disk).read('notes', { ...saved, Text: 'new external update' }).text, 'new external update')
  assert.deepEqual(new NoteDraftStore(disk).read(`note:${note.Id}`, note), draft)
  assert.equal(JSON.parse(disk.getItem(`widget-note:${note.Id}`)).text, 'legacy unsaved')
})

test('failed writes survive editor switches in memory and keep shutdown blocked until retry succeeds', () => {
  const disk = storage(); let failing = true
  const store = new NoteDraftStore({ getItem: disk.getItem, setItem: (key, value) => { if (failing) throw new Error('disk full'); disk.setItem(key, value) } })
  const draft = { ...savedNoteDraft(note), text: 'not yet persisted' }
  assert.throws(() => store.write('notes', note.Id, draft), /disk full/)
  assert.deepEqual(store.read('notes', note), draft)
  assert.throws(() => store.flush(), /disk full/)
  failing = false; store.flush()
  assert.deepEqual(JSON.parse(disk.getItem(noteDraftKey('notes', note.Id))), draft)
  assert.deepEqual(new NoteDraftStore(disk).read('notes', note), draft)
})
