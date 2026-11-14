import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'
const require = createRequire(import.meta.url)
export async function toolboxModules(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-tools-test-'))
  const services = []
  // TestContext after hooks run in registration order. Dispose real owners
  // before this first-registered hook removes their physical directories.
  t.after(async () => {
    for (const service of services.reverse()) await service.dispose()
    await fs.rm(root, { recursive: true, force: true })
  })
  const compiled = new Map()
  async function compile(file) {
    file = path.resolve(file)
    if (compiled.has(file)) return compiled.get(file)
    const outputPath = path.join(root, 'compiled', path.relative(path.resolve('.'), file).replace(/\.ts$/, '.mjs'))
    const url = pathToFileURL(outputPath).href; compiled.set(file, url)
    let output = ts.transpileModule(await fs.readFile(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    for (const match of [...output.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)]) {
      const specifier = match[2]
      const replacement = specifier.startsWith('.') ? await compile(path.resolve(path.dirname(file), specifier + '.ts')) : specifier.startsWith('node:') ? specifier : pathToFileURL(require.resolve(specifier)).href
      output = output.replaceAll(`${match[1]}${specifier}${match[1]}`, JSON.stringify(replacement))
    }
    await fs.mkdir(path.dirname(outputPath), { recursive:true }); await fs.writeFile(outputPath, output); return url
  }
  const load = file => compile(file).then(url => import(url))
  const lanModule = await load('tests/reference/src/main/lanTransfer.ts')
  const lan = { ...lanModule, createLanService(options) { const service = lanModule.createLanService(options); services.push(service); return service } }
  return { root, text: await load('src/shared/textTools.ts'), image: await load('src/shared/imageTools.ts'), assets: await load('tests/reference/src/main/toolAssets.ts'), lan, lanModuleUrl: await compile('tests/reference/src/main/lanTransfer.ts') }
}
