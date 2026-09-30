import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/shared/urls.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { isHttpUrl } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('HTTP addresses require an explicit scheme and retain HTTP-only or intranet support', () => {
  for (const url of ['http://localhost:8080/path', 'http://192.168.1.2', 'https://example.com', 'HTTP://example.com', 'https://例子.测试/路径']) assert.equal(isHttpUrl(url), true, url)
  for (const url of ['www.example.com', 'example.com', 'http:example.com', 'https:/example.com', '//example.com', 'file:///test', 'javascript:alert(1)', 'https://', '']) assert.equal(isHttpUrl(url), false, url)
})
