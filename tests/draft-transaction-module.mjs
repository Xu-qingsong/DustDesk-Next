import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { draftModuleUrl } from './draft-module.mjs'
import { draftLineageModuleUrl } from './draft-lineage-module.mjs'
const source = ts.transpileModule(await readFile(new URL('./reference/src/main/draftTransaction.ts', import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  .replaceAll("'../shared/draftMigration'", JSON.stringify(draftModuleUrl)).replaceAll('"../shared/draftMigration"', JSON.stringify(draftModuleUrl))
  .replaceAll("'./draftLineage'", JSON.stringify(draftLineageModuleUrl)).replaceAll('"./draftLineage"', JSON.stringify(draftLineageModuleUrl))
export const draftTransactionModuleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
export const { createElectronDraftTransactions, electronDraftTransactionFile } = await import(draftTransactionModuleUrl)
