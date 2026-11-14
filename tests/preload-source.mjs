import { readFile } from 'node:fs/promises'
import ts from 'typescript'

export async function electronPreloadSource() {
  const draft = ts.transpileModule(await readFile('src/shared/draftMigration.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const preload = ts.transpileModule(await readFile('tests/reference/src/preload/index.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const reader = ts.transpileModule(await readFile('tests/reference/src/preload/draftReader.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '').replace('export function installDraftReader', 'function installDraftReader')
  const control = ts.transpileModule(await readFile('tests/reference/src/preload/draftControl.ts', 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace(/import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?/g, '').replace('export function installDraftControl', 'function installDraftControl')
  return preload.replace(/import\s+\{[^}]+\}\s+from\s+['"]electron['"];?/, '').replace(/import\s+\{\s*collectDrafts\s*\}\s+from\s+['"][^'"]*draftMigration['"];?/, 'const { collectDrafts, prepareDraftImport, recoverNativeDraftImport } = (() => { const exports = {}; ' + draft + '; return exports })();').replace(/import\s+\{\s*installDraftReader\s*\}\s+from\s+['"][^'"]*draftReader['"];?/, reader).replace(/import\s+\{\s*installDraftControl\s*\}\s+from\s+['"][^'"]*draftControl['"];?/, control)
}
