import { readFile } from 'node:fs/promises'
import ts from 'typescript'

export async function draftModuleSource() {
  const source = await readFile(new URL('../src/shared/draftMigration.ts', import.meta.url), 'utf8')
  return ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
}
export const draftModuleUrl = 'data:text/javascript;base64,' + Buffer.from(await draftModuleSource()).toString('base64')
