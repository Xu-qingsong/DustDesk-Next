import ts from 'typescript'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('./reference/src/main/workspaceOwnership.ts', import.meta.url), 'utf8')
const output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
export const ownershipModuleUrl = 'data:text/javascript;base64,' + Buffer.from(output).toString('base64')
export const { acquireWorkspaceOwnership } = await import(ownershipModuleUrl)
