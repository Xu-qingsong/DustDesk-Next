import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { acquireWorkspaceOwnership, ownershipModuleUrl } from './workspace-ownership-module.mjs'

const options = { skip: process.platform !== 'win32' }
async function fixture(callback) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dustdesk-ownership-test-'))
  try { await callback(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('workspace ownership excludes normalized and case-varied names, permits independent roots and releases idempotently', options, async () => {
  await fixture(async root => {
    const directory = path.join(root, 'Data')
    const first = await acquireWorkspaceOwnership(directory)
    let separate
    try {
      await assert.rejects(acquireWorkspaceOwnership(path.join(directory, '..', 'Data')), /另一个进程/)
      await assert.rejects(acquireWorkspaceOwnership(directory.toUpperCase()), /另一个进程/)
      separate = await acquireWorkspaceOwnership(path.join(root, 'Other'))
    } finally { await separate?.release(); await first.release(); await first.release() }
    await (await acquireWorkspaceOwnership(directory)).release()
  })
})

test('workspace ownership refuses relative paths, files and junctions without modifying the target', options, async () => {
  await fixture(async root => {
    await assert.rejects(acquireWorkspaceOwnership('relative'), /绝对路径/)
    const target = path.join(root, 'Target'); await mkdir(target)
    const alias = path.join(root, 'Alias'); await symlink(target, alias, 'junction')
    await assert.rejects(acquireWorkspaceOwnership(alias), /重解析点/)
    await assert.rejects(acquireWorkspaceOwnership(path.join(alias, 'Nested')), /重解析点/)
    const file = path.join(root, 'file'); await writeFile(file, 'unchanged')
    await assert.rejects(acquireWorkspaceOwnership(file))
    await (await acquireWorkspaceOwnership(target)).release()
  })
})

test('another process cannot claim ownership and a killed owner leaves no stale lock to remove', options, async () => {
  await fixture(async root => {
    const program = 'const {acquireWorkspaceOwnership}=await import(' + JSON.stringify(ownershipModuleUrl) + '); const ownership=await acquireWorkspaceOwnership(process.argv[1]); console.log("ready");'
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    let output = ''; let errors = ''
    child.stdout.on('data', bytes => { output += bytes })
    child.stderr.on('data', bytes => { errors += bytes })
    try {
      const deadline = Date.now() + 10000
      while (!output.includes('ready')) {
        assert.equal(child.exitCode, null, errors)
        assert.ok(Date.now() < deadline, 'child did not acquire ownership: ' + errors)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      await assert.rejects(acquireWorkspaceOwnership(root), /另一个进程/)
    } finally { child.kill(); await exited }
    await (await acquireWorkspaceOwnership(root)).release()
  })
})
