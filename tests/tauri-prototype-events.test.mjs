import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile('src/renderer/src/migration/events.ts', 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replaceAll('@tauri-apps/api/core', import.meta.resolve('@tauri-apps/api/core'))
const { listenPrototype } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'))
function fixture(attach = async () => 'own-token') {
  const calls = []; const callbacks = new Map(); let identifier = 0
  globalThis.window = { __TAURI_INTERNALS__: {
    transformCallback: callback => { const key = ++identifier; callbacks.set(key, callback); return key },
    unregisterCallback: key => callbacks.delete(key),
    invoke: async (command, args) => { calls.push({ command, args }); return command === 'prototype_event_attach' ? attach() : true },
  } }
  return { calls, send: (payload, index) => [...callbacks.values()][0]({ index, message: payload }) }
}
test('prototype transport uses only an explicit private Channel and detaches its exact token once', async () => {
  const harness = fixture(); const values = []
  const stop = await listenPrototype('prototype:captured', value => values.push(value))
  harness.send('own-event', 0); assert.deepEqual(values, ['own-event'])
  stop(); stop(); harness.send('after-unsubscribe', 1)
  assert.deepEqual(values, ['own-event'])
  assert.deepEqual(harness.calls.map(call => call.command), ['prototype_event_attach', 'prototype_event_detach'])
  assert.deepEqual(harness.calls[1].args, { event: 'prototype:captured', token: 'own-token' })
})
test('prototype transport preserves SDK packet ordering without a generic event listener', async () => {
  const harness = fixture(); const values = []
  const stop = await listenPrototype('prototype:workspace-changed', value => values.push(value))
  harness.send('later', 1); assert.deepEqual(values, [])
  harness.send('first', 0); assert.deepEqual(values, ['first', 'later'])
  assert.equal(harness.calls.some(call => call.command.startsWith('plugin:event|')), false)
  stop()
})
