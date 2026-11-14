import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yazl from 'yazl'

assert.equal(process.platform, 'win32', 'Windows packaging requires Windows')
assert.equal(process.arch, 'x64', 'Build the Windows x64 release on an x64 host')
assert.deepEqual(process.argv.slice(2), [], 'This command creates local artifacts; it accepts no publishing options')
const root = fileURLToPath(new URL('../', import.meta.url))
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
const run = (command, args, env = process.env) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true })
  child.once('error', reject)
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(Error(`${command} exited with ${code ?? signal}`)))
})
const npmCli = process.env.npm_execpath
assert.ok(npmCli && path.isAbsolute(npmCli), 'Run this script through npm run dist')
await run(process.execPath, [npmCli, 'run', 'check:silent'])
await run(process.execPath, [path.join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'build', '--target', 'x86_64-pc-windows-msvc', '--bundles', 'nsis'])
const target = path.join(root, 'src-tauri/target/x86_64-pc-windows-msvc/release')
const installers = (await readdir(path.join(target, 'bundle/nsis'))).filter(name => name === `DustDesk_${version}_x64-setup.exe`)
assert.equal(installers.length, 1, 'Expected exactly the current version NSIS installer')
const release = path.join(root, 'release')
await mkdir(release, { recursive: true })
const installer = path.join(release, `DustDesk-${version}-x64.exe`)
const archive = path.join(release, `DustDesk-${version}-x64-green.zip`)
const executable = path.join(target, 'DustDesk.exe')
assert.ok((await stat(executable)).size > 0)
await copyFile(path.join(target, 'bundle/nsis', installers[0]), installer)
// Tauri embeds the renderer and uses the installed WebView2 runtime. The green
// archive contains the application itself, with no portable launcher.
const zip = new yazl.ZipFile()
zip.addFile(executable, 'DustDesk.exe')
zip.addBuffer(Buffer.from(`DustDesk ${version}\r\n\r\n解压后运行 DustDesk.exe。需要 Windows 10/11 x64 和 Microsoft Edge WebView2 运行时。\r\n数据保存在 DustDesk.exe 同级的 Data 文件夹。移动绿色版时，请一起移动 Data 文件夹。\r\n`, 'utf8'), 'README.txt')
const writing = pipeline(zip.outputStream, createWriteStream(archive))
zip.end()
await writing
await run(process.execPath, ['--test', 'tests/tauri-default-app.mjs'], { ...process.env, DUSTDESK_TAURI_EXECUTABLE: executable })
await run(process.execPath, ['tests/tauri-release-boundaries.mjs'], { ...process.env, DUSTDESK_PACKAGE_EXECUTABLE: executable })
await run(process.execPath, ['tests/green-smoke.mjs'], { ...process.env, DUSTDESK_GREEN_ARCHIVE: archive })
const sums = await Promise.all([installer, archive].map(async file => `${createHash('sha256').update(await readFile(file)).digest('hex')}  ${path.basename(file)}`))
await writeFile(path.join(release, 'SHA256SUMS.txt'), sums.join('\n') + '\n')
console.log(`Created ${path.basename(installer)}, ${path.basename(archive)} and SHA256SUMS.txt`)
