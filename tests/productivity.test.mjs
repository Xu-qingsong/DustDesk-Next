import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText).toString('base64')}`
const shared = moduleUrl(await readFile(new URL('../src/shared/productivity.ts', import.meta.url), 'utf8'))
const core = await import(moduleUrl((await readFile(new URL('../src/main/productivityState.ts', import.meta.url), 'utf8')).replaceAll("'../shared/productivity'", JSON.stringify(shared))))
const { focusElapsed, productivityDefaults } = await import(shared)
const { isCompleteWorkspace } = await import(moduleUrl(await readFile(new URL('../src/main/workspaceValidation.ts', import.meta.url), 'utf8')))
function state() { return { ...productivityDefaults(), Settings: {}, Todos: [], Notes: [], Projects: [], Launchers: [], LinkGroups: [], ClipboardHistory: [], DesktopCategories: [], TagPresets: [], SchemaVersion: 2 } }

test('quick capture retries are idempotent across serialization and recycling', () => {
  const current = state()
  const action = { type: 'capture', kind: 'task', title: 'Saved once', text: 'body', requestId: 'stable-submission' }
  core.applyProductivityAction(current, action)
  const reopened = JSON.parse(JSON.stringify(current))
  core.applyProductivityAction(reopened, action)
  assert.equal(reopened.Todos.length, 1)
  const deleted = structuredClone(reopened); deleted.Todos = []
  core.collectDeleted(reopened, deleted)
  core.applyProductivityAction(deleted, action)
  assert.equal(deleted.Todos.length, 0)
  assert.equal(deleted.RecycleBin.length, 1)
})

test('saving a conflicting draft as a new note preserves the original and its appearance', () => {
  const current = state()
  core.applyProductivityAction(current, { type: 'capture', kind: 'note', title: 'Original', text: 'newer saved text' })
  const original = current.Notes[0]
  Object.assign(original, { FontSize: 30, FontBold: true, BackgroundImagePath: 'managed.png', ColorArgb: -16711936 })
  const action = { type: 'capture', kind: 'note', sourceNoteId: original.Id, title: 'Private draft', text: 'unsaved text', requestId: 'recovery-copy' }
  core.applyProductivityAction(current, action)
  core.applyProductivityAction(current, action)
  assert.equal(current.Notes.length, 2)
  assert.equal(current.Notes[0].FontSize, 30)
  assert.equal(current.Notes[0].FontBold, true)
  assert.equal(current.Notes[0].BackgroundImagePath, 'managed.png')
  assert.equal(original.Text, 'newer saved text')
  assert.equal(current.Notes[0].Text, 'unsaved text')
})

test('recycle captures complete deleted records, expires old records and protects main-owned state', () => {
  const before = state(); core.applyProductivityAction(before, { type: 'capture', kind: 'task', title: 'Task', text: 'details' })
  core.applyProductivityAction(before, { type: 'capture', kind: 'note', title: 'Note', text: 'body' })
  const after = structuredClone(before); after.Todos = []; after.Notes = []
  core.collectDeleted(before, after, Date.parse('2026-01-01'))
  assert.equal(after.RecycleBin.length, 2)
  assert.equal(after.RecycleBin[0].value.Note, 'details')
  assert.equal(after.RecycleBin[1].value.Text, 'body')
  assert.equal(after.RecycleBin[0].ExpiresAt, '2026-01-31T00:00:00.000Z')
  core.collectDeleted(after, structuredClone(after), Date.parse('2026-02-01'))
  const latest = state(); core.collectDeleted(after, latest, Date.parse('2026-02-01'))
  assert.deepEqual(latest.RecycleBin, [])
})

test('restoring a link recreates its missing group, refuses conflicts and never duplicates it', () => {
  const before = state(); before.LinkGroups = [{ Id: 'group', Name: 'Links', Links: [{ Id: 'link', Name: 'HTTP', Url: 'http://example.test', Note: '', CreatedAt: '', UpdatedAt: '' }] }]
  const next = structuredClone(before); next.LinkGroups[0].Links = []
  core.collectDeleted(before, next)
  const entry = next.RecycleBin[0]; next.LinkGroups = []
  core.restoreRecycled(next, entry.Id)
  assert.equal(next.LinkGroups[0].Links[0].Url, 'http://example.test')
  next.RecycleBin.push(entry)
  assert.throws(() => core.restoreRecycled(next, entry.Id), /已存在/)
  assert.equal(next.RecycleBin.length, 1)
})

test('moving links across existing groups does not create a deletion', () => {
  const before = state(); before.LinkGroups = [{ Id: 'a', Name: 'A', Links: [{ Id: 'link', Name: 'Link', Url: 'http://example.test' }] }, { Id: 'b', Name: 'B', Links: [] }]
  const next = structuredClone(before); next.LinkGroups[1].Links = next.LinkGroups[0].Links; next.LinkGroups[0].Links = []
  core.collectDeleted(before, next)
  assert.equal(next.RecycleBin.length, 0)
})

test('widget note editing refuses concurrent edits or deleted notes without losing drafts', () => {
  const current = state(); core.applyProductivityAction(current, { type: 'capture', kind: 'note', title: 'Note', text: 'original' })
  const note = current.Notes[0]
  const action = { type: 'note-edit', id: note.Id, previousTitle: 'Note', previousText: 'original', title: 'Changed', text: 'desktop' }
  core.applyProductivityAction(current, action)
  assert.throws(() => core.applyProductivityAction(current, action), /其他窗口/)
  assert.equal(note.Text, 'desktop')
  current.Notes = []
  assert.throws(() => core.applyProductivityAction(current, action), /删除/)
})

test('focus pause, resume and completion account actual time and cap at planned duration', () => {
  const current = state(); const start = Date.parse('2026-09-19T08:00:00Z')
  core.applyProductivityAction(current, { type: 'focus-start', taskId: '', projectId: '', minutes: 1 }, start)
  assert.equal(focusElapsed(current.ActiveFocus, start + 12_000), 12)
  core.applyProductivityAction(current, { type: 'focus-pause' }, start + 12_000)
  assert.equal(focusElapsed(current.ActiveFocus, start + 500_000), 12)
  core.applyProductivityAction(current, { type: 'focus-resume' }, start + 500_000)
  assert.equal(focusElapsed(current.ActiveFocus, start + 400_000), 12, 'clock rollback preserves already accumulated time')
  core.applyProductivityAction(current, { type: 'focus-finish' }, start + 550_000)
  assert.equal(current.ActiveFocus, null)
  assert.equal(current.FocusSessions[0].Seconds, 60)
  assert.equal(current.FocusSessions[0].Completed, true)
  core.applyProductivityAction(current, { type: 'focus-finish' }, start + 560_000)
  assert.equal(current.FocusSessions.length, 1)
})

test('focus cannot overlap and cancellation does not add statistics', () => {
  const current = state(); const action = { type: 'focus-start', taskId: '', projectId: '', minutes: 25 }
  core.applyProductivityAction(current, action)
  assert.throws(() => core.applyProductivityAction(current, action), /先结束/)
  core.applyProductivityAction(current, { type: 'focus-cancel' })
  assert.equal(current.FocusSessions.length, 0)
  assert.throws(() => core.applyProductivityAction(current, { ...action, minutes: NaN }), /时长/)
})

test('organizer rule priority, case, disabled rules and removed categories are respected', () => {
  const current = state(); current.DesktopCategories = [{ Id: 'a', Name: 'A' }, { Id: 'b', Name: 'B' }]
  core.applyProductivityAction(current, { type: 'rules-save', rules: [{ Id: 'r1', Enabled: true, Match: 'name', Pattern: 'invoice', CategoryId: 'a' }, { Id: 'r2', Enabled: true, Match: 'extension', Pattern: '*.pdf, DOCX', CategoryId: 'b' }] })
  assert.equal(core.matchOrganizerRule('INVOICE.pdf', current).Id, 'a')
  current.OrganizerRules[0].Enabled = false
  assert.equal(core.matchOrganizerRule('INVOICE.PDF', current).Id, 'b')
  assert.equal(core.matchOrganizerRule('notes.docx', current).Id, 'b')
  current.DesktopCategories = []
  assert.equal(core.matchOrganizerRule('notes.docx', current), undefined)
})

test('legacy workspaces migrate but malformed new feature collections fail validation', () => {
  const old = state(); delete old.RecycleBin; delete old.ActiveFocus; delete old.FocusSessions; delete old.OrganizerRules
  assert.equal(isCompleteWorkspace(old), true)
  assert.deepEqual(core.normalizeProductivity(old), productivityDefaults())
  assert.equal(isCompleteWorkspace({ ...old, RecycleBin: [{ Id: 'bad', value: null }] }), false)
  assert.equal(isCompleteWorkspace({ ...old, FocusSessions: [{ Id: 'bad', Seconds: 'many' }] }), false)
  assert.equal(isCompleteWorkspace({ ...old, ActiveFocus: { PlannedSeconds: NaN } }), false)
})
