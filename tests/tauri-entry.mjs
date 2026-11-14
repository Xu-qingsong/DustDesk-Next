import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { launchTauri, waitFor } from './tauri-harness.mjs'

await test('--workspace starts only the shared React entry and cannot access prototype capabilities', async () => {
  const application = await launchTauri({ workspace: true })
  try {
    await application.page.getByRole('button', { name: '创建工作区', exact: true }).waitFor()
    assert.equal(application.browser.contexts().flatMap(context => context.pages()).length, 1)
    await assert.rejects(application.invoke('prototype_diagnostics'), /not allowed|权限/i)
    await assert.rejects(access(path.join(application.root, 'user-data', 'tauri-preview', 'Workspace', 'workspace.json')))
    const quitting = application.invoke('application_quit').catch(() => {})
    await waitFor(() => application.child.exitCode !== null)
    assert.equal(application.child.exitCode, 0)
    await quitting
  } finally { await application.close() }
})
