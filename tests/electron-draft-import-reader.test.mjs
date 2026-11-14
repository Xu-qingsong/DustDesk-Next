import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import ts from 'typescript'
import { draftModuleUrl } from './draft-module.mjs'
import { draftLineageModuleUrl } from './draft-lineage-module.mjs'
import { draftTransactionModuleUrl } from './draft-transaction-module.mjs'

let source = ts.transpileModule(await fs.readFile('tests/reference/src/main/draftImport.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const nativeOnly = 'data:text/javascript;base64,' + Buffer.from('export function openDraftBrowser() { throw Error("native browser unavailable in file-reader unit test") }').toString('base64')
for (const [name, url] of Object.entries({ '../shared/draftMigration': draftModuleUrl, './draftLineage': draftLineageModuleUrl, './draftTransaction': draftTransactionModuleUrl, './draftBrowser': nativeOnly })) source = source.replaceAll("'" + name + "'", JSON.stringify(url)).replaceAll('"' + name + '"', JSON.stringify(url))
const { readDraftImport } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const migration = await import(draftModuleUrl)

test('native import reader preserves exact UTF-8 bytes and rejects oversized, linked, malformed and changed files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-import-reader-'))
  const location = path.join(root, 'drafts.json')
  const serialized = await migration.createDraftArchive([{ key: migration.taskDraftStorageKey, value: '{ "title":"草稿🪶", "requestId":"keep-byte-identity" }' }], { runtime: 'tauri', appVersion: '1.0.2', workspaceFingerprint: 'a'.repeat(64) })
  const originalOpen = fs.open
  try {
    await fs.writeFile(location, serialized); assert.equal(await readDraftImport(location), serialized)
    await assert.rejects(readDraftImport('drafts.json'), /JSON/)
    await assert.rejects(readDraftImport(path.join(root, 'drafts.txt')), /JSON/)
    await fs.writeFile(location, Buffer.from([0xff, 0xfe, 0xfd])); await assert.rejects(readDraftImport(location))
    await fs.writeFile(location, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(serialized)])); await assert.rejects(readDraftImport(location))
    await fs.writeFile(location, '{broken'); await assert.rejects(readDraftImport(location))
    const large = await fs.open(location, 'w'); try { await large.truncate(migration.maxDraftArchiveBytes + 1) } finally { await large.close() }
    await assert.rejects(readDraftImport(location), /64 MiB/)
    await fs.writeFile(location, serialized)
    const hardlink = path.join(root, 'linked.json'); await fs.link(location, hardlink)
    await assert.rejects(readDraftImport(hardlink), /独立普通文件/); await fs.unlink(hardlink)
    const alias = path.join(root, 'alias'); await fs.symlink(root, alias, 'junction')
    await assert.rejects(readDraftImport(path.join(alias, 'drafts.json')), /链接或重解析点/)
    await fs.mkdir(path.join(root, 'directory.json')); await assert.rejects(readDraftImport(path.join(root, 'directory.json')))
    let observed = false
    fs.open = async (target, ...args) => {
      const handle = await originalOpen(target, ...args)
      if (target === location) {
        const read = handle.read.bind(handle)
        handle.read = async (...parameters) => {
          const result = await read(...parameters)
          if (!observed) { observed = true; await fs.writeFile(location, serialized + 'changed-during-read') }
          return result
        }
      }
      return handle
    }
    await assert.rejects(readDraftImport(location), /读取时变化/); assert.equal(observed, true)
  } finally { fs.open = originalOpen; await fs.rm(root, { recursive: true, force: true }) }
})
