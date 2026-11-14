import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/renderer/src/runtime/eventTransport.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const resolved = compiled.replaceAll('@tauri-apps/api/core', import.meta.resolve('@tauri-apps/api/core')).replaceAll('@tauri-apps/api/event', import.meta.resolve('@tauri-apps/api/event'))
const { createRuntimeEvents } = await import('data:text/javascript;base64,' + Buffer.from(resolved).toString('base64'))

function fixture(invoke = async () => 'connection-token') {
  const callbacks = new Map(); const calls = []; let identifier = 0
  globalThis.window = {
    __TAURI_INTERNALS__: {
      transformCallback: callback => { const key = ++identifier; callbacks.set(key, callback); return key },
      unregisterCallback: key => callbacks.delete(key),
      invoke: async (command, args) => { calls.push({ command, args }); return invoke(command, args) },
    },
    __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
  }
  return { callbacks, calls, frame: (index, payload, token = 'connection-token') => [...callbacks.values()][0]?.({ index, message: { token, event: 'workspace:snapshot', payload } }) }
}

test('widget transport connects once and the real SDK Channel orders packets without generic event permission', async () => {
  const harness = fixture(); const events = createRuntimeEvents('workspace-widget-todo'); const values = []
  await events.listen('workspace:snapshot', message => values.push(message.payload))
  const first = events.connect(); const second = events.connect(); assert.equal(first, second); await first
  harness.frame(1, 'second'); assert.deepEqual(values, []); harness.frame(0, 'first'); assert.deepEqual(values, ['first', 'second'])
  harness.frame(2, 'foreign', 'foreign-token'); assert.deepEqual(values, ['first', 'second'])
  assert.deepEqual(harness.calls.map(call => call.command), ['widget_events_attach'])
  events.dispose(); harness.frame(3, 'after-dispose'); assert.deepEqual(values, ['first', 'second'])
  ;[...harness.callbacks.values()][0]({ end: true, index: 4 }); assert.equal(harness.callbacks.size, 0)
  assert.deepEqual(harness.calls.at(-1), { command: 'widget_events_detach', args: { token: 'connection-token' } })
})

test('widget unsubscribe is local and a failing callback cannot suppress another consumer', async () => {
  const harness = fixture(); const events = createRuntimeEvents('workspace-widget-notes'); const values = []; const errors = []; const original = console.error
  console.error = (...args) => errors.push(args)
  try {
    const off = await events.listen('workspace:snapshot', () => { throw Error('consumer fixture') })
    await events.listen('workspace:snapshot', message => values.push(message.payload)); await events.connect()
    harness.frame(0, 'before'); off(); off(); harness.frame(1, 'after')
    assert.deepEqual(values, ['before', 'after']); assert.equal(errors.length, 1)
    assert.ok(!harness.calls.some(call => call.command.startsWith('plugin:event|')))
  } finally { events.dispose(); console.error = original }
})

test('disposing during attach detaches the late native token exactly once and suppresses callbacks', async () => {
  let resolveAttach; const harness = fixture(command => command === 'widget_events_attach' ? new Promise(resolve => { resolveAttach = resolve }) : true)
  const events = createRuntimeEvents('workspace-widget-monitor'); const values = []
  await events.listen('workspace:snapshot', message => values.push(message.payload)); const connecting = events.connect()
  events.dispose(); events.dispose(); harness.frame(0, 'late event'); resolveAttach('late-token'); await connecting
  ;[...harness.callbacks.values()][0]({ end: true, index: 1 }); assert.equal(harness.callbacks.size, 0)
  assert.deepEqual(harness.calls.map(call => call.command), ['widget_events_attach', 'widget_events_detach'])
  assert.deepEqual(harness.calls[1].args, { token: 'late-token' }); assert.deepEqual(values, [])
  await assert.rejects(events.connect(), /已关闭/); await assert.rejects(events.listen('ignored', () => {}), /已关闭/)
})

test('failed widget attach can be disposed without delivering more messages', async () => {
  const harness = fixture(async () => { throw Error('native denied fixture') }); const events = createRuntimeEvents('workspace-widget-todo')
  const values = []; await events.listen('workspace:snapshot', message => values.push(message.payload))
  await assert.rejects(events.connect(), /native denied fixture/); events.dispose(); harness.frame(0, 'after failure'); assert.deepEqual(values, [])
  assert.equal(harness.calls.length, 1)
})

test('trusted main transport still subscribes only to its native window and uses normal unlisten', async () => {
  const harness = fixture(async command => command === 'plugin:event|listen' ? 42 : undefined)
  const events = createRuntimeEvents('workspace-main'); const values = []
  const off = await events.listen('workspace:snapshot', message => values.push(message.payload)); await events.connect()
  assert.equal(harness.calls[0].command, 'plugin:event|listen'); assert.deepEqual(harness.calls[0].args.target, { kind: 'WebviewWindow', label: 'workspace-main' })
  harness.callbacks.get(harness.calls[0].args.handler)({ payload: 'trusted' }); assert.deepEqual(values, ['trusted'])
  await off(); events.dispose(); assert.deepEqual(harness.calls.map(call => call.command), ['plugin:event|listen', 'plugin:event|unlisten'])
})

test('quick capture uses its dedicated native channel with no generic event subscription', async () => {
  const harness = fixture(); const events = createRuntimeEvents('quick-capture'); const values = []
  await events.listen('workspace:snapshot', message => values.push(message.payload)); await events.connect()
  harness.frame(0, 'owner packet'); harness.frame(1, 'foreign packet', 'other-token')
  assert.deepEqual(values, ['owner packet']); events.dispose()
  assert.deepEqual(harness.calls.map(call => call.command), ['quick_capture_events_attach', 'quick_capture_events_detach'])
})
