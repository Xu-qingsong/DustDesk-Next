import assert from 'node:assert/strict'
import { test } from 'node:test'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { mainFixture } from './main-headless-harness.mjs'

async function iconsModule(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-resource-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, 'icons.mjs')
  const source = await fs.readFile('src/main/windowsIcons.ts', 'utf8')
  await fs.writeFile(file, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
  return { root, ...await import(pathToFileURL(file).href) }
}

test('resource requests batch, share work and invalidate when the file changes', async t => {
  const { createWindowsIconReader } = await iconsModule(t)
  const calls = []
  const read = createWindowsIconReader(async resources => { calls.push(resources); return resources.map(item => `${item.path}:${item.index}`) })
  const first = read({ path: 'app.exe', index: -101 }, 'size:time')
  assert.equal(read({ path: 'APP.EXE', index: -101 }, 'size:time'), first)
  const second = read({ path: 'icon.dll', index: 2 }, 'size:time')
  assert.deepEqual(await Promise.all([first, second]), ['app.exe:-101', 'icon.dll:2'])
  assert.equal(calls.length, 1)
  assert.equal(await read({ path: 'app.exe', index: -101 }, 'updated'), 'app.exe:-101')
  assert.equal(calls.length, 2)
})

test('failed resource extraction can retry and cannot leave a request pending', async t => {
  const { createWindowsIconReader } = await iconsModule(t)
  let calls = 0
  const read = createWindowsIconReader(async () => { if (++calls === 1) throw Error('temporary extraction failure'); return ['retried'] })
  assert.equal(await read({ path: 'app.exe', index: 0 }, 'fingerprint'), undefined)
  assert.equal(await read({ path: 'app.exe', index: 0 }, 'fingerprint'), 'retried')
})

test('native extraction serializes small batches instead of launching a process for every tile', async t => {
  const { createWindowsIconReader } = await iconsModule(t)
  let active = 0; let maximum = 0
  const sizes = []
  const read = createWindowsIconReader(async resources => {
    maximum = Math.max(maximum, ++active); sizes.push(resources.length)
    await new Promise(resolve => setTimeout(resolve, 25))
    active--
    return resources.map(resource => resource.path)
  })
  const initial = Array.from({ length: 70 }, (_, i) => read({ path: `app-${i}`, index: 0 }, '1'))
  await new Promise(resolve => setTimeout(resolve, 25))
  const later = Array.from({ length: 5 }, (_, i) => read({ path: `late-${i}`, index: 0 }, '1'))
  assert.equal((await Promise.all([...initial, ...later])).length, 75)
  assert.equal(maximum, 1)
  assert.deepEqual(sizes, [32, 32, 11])
})

async function writeShortcut(file, target, icon = '') {
  const script = `
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$ws = New-Object -ComObject WScript.Shell
$link = $ws.CreateShortcut($request.file)
$link.TargetPath = $request.target
$link.IconLocation = $request.icon
$link.Save()
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($ws)
`
  await new Promise((resolve, reject) => {
    const child = execFile(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 5000 }, error => error ? reject(error) : resolve())
    child.stdin.end(JSON.stringify({ file, target, icon }))
  })
}

test('native Windows extraction bypasses generic shell icons and reads Unicode extensionless resources', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
  const fixture = await mainFixture(t)
  // A real Windows API subprocess is allowed here; it creates no windows and
  // reads embedded icons without executing the test's program or shortcut.
  fixture.childProcess.execFile = execFile
  fixture.electron.app.getFileIcon = () => { throw Error('Must not return the generic association icon') }
  const shortcut = path.join(fixture.root, 'example.lnk')
  await writeShortcut(shortcut, process.execPath)
  fixture.electron.shell.readShortcutLink = () => { throw Error('Must not synchronously read shortcuts') }
  const program = await fixture.invoke('path:icon', shortcut)
  assert.match(program.dataUrl, /^data:image\/png;base64,/)
  const png = Buffer.from(program.dataUrl.split(',')[1], 'base64')
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')

  const icon = Buffer.alloc(22)
  icon.writeUInt16LE(1, 2); icon.writeUInt16LE(1, 4)
  icon[6] = png.readUInt32BE(16) % 256; icon[7] = png.readUInt32BE(20) % 256
  icon.writeUInt16LE(1, 10); icon.writeUInt16LE(32, 12)
  icon.writeUInt32LE(png.length, 14); icon.writeUInt32LE(22, 18)
  const customPath = path.join(fixture.root, '中文，图标,ProductIcon')
  await fs.writeFile(customPath, Buffer.concat([icon, png]))
  const customShortcut = path.join(fixture.root, '自定义图标.lnk')
  await writeShortcut(customShortcut, path.join(fixture.root, 'missing.exe'), customPath + ',0')
  assert.equal((await fixture.invoke('path:icon', customShortcut)).dataUrl, program.dataUrl)

  const invalidCustom = path.join(fixture.root, 'invalid-custom.lnk')
  await writeShortcut(invalidCustom, process.execPath, customPath + ',9999')
  assert.equal((await fixture.invoke('path:icon', invalidCustom)).dataUrl, program.dataUrl, 'An invalid icon index falls back to the default resource')
  const missingCustom = path.join(fixture.root, 'missing-custom.lnk')
  await writeShortcut(missingCustom, process.execPath, path.join(fixture.root, 'removed.ico') + ',0')
  assert.equal((await fixture.invoke('path:icon', missingCustom)).dataUrl, program.dataUrl, 'A missing custom icon falls back to the program resource')

  const { extractWindowsIconResources } = await iconsModule(t)
  const resources = await extractWindowsIconResources([{ path: 'missing.exe', index: 0 }, { path: customPath, index: 0 }])
  assert.equal(resources[0], undefined)
  assert.match(resources[1], /^data:image\/png;base64,/)

  const folders = ['ordinary', 'folder.txt', 'folder.exe', 'folder.lnk'].map(name => path.join(fixture.root, name))
  await Promise.all(folders.map(folder => fs.mkdir(folder)))
  const folderIcons = await Promise.all(folders.map(folder => fixture.invoke('path:icon', folder)))
  const [driveIcon] = await extractWindowsIconResources([{ path: path.parse(fixture.root).root, index: 0, directory: true }])
  assert.ok(driveIcon)
  for (const icon of folderIcons) {
    assert.equal(icon.isDirectory, true)
    assert.match(icon.dataUrl, /^data:image\/png;base64,/)
    assert.equal(icon.dataUrl, folderIcons[0].dataUrl, 'Folder names with file extensions must still use the folder shell item')
    assert.notEqual(icon.dataUrl, driveIcon, 'Folders must not display the volume icon')
  }
})

test('documents, URL shortcuts and extensionless files use their actual shell item instead of a volume association', { skip: process.platform !== 'win32', timeout: 20_000 }, async t => {
  const fixture = await mainFixture(t)
  const requests = []
  fixture.childProcess.execFile = (...args) => {
    const child = execFile(...args)
    const end = child.stdin.end.bind(child.stdin)
    child.stdin.end = (input, ...rest) => { requests.push(...JSON.parse(input)); return end(input, ...rest) }
    return child
  }
  fixture.electron.app.getFileIcon = () => { throw Error('Legacy associations must not be used') }
  const files = ['plain', '.gitignore', '文档.TXT', 'sample.pdf', 'sample.docx', 'sample.xlsx', 'sample.pptx', 'sample.png', 'sample.zip', 'sample.json', 'sample.unknown', 'website.URL'].map(name => path.join(fixture.root, name))
  await Promise.all(files.map(file => fs.writeFile(file, /\.url$/i.test(file) ? '[InternetShortcut]\r\nURL=https://example.com\r\n' : '')))
  const { extractWindowsIconResources } = await iconsModule(t)
  const [driveIcon] = await extractWindowsIconResources([{ path: path.parse(fixture.root).root, index: 0, shellItem: true }])
  const actual = await Promise.all(files.map(file => fixture.invoke('path:icon', file)))
  for (const [index, result] of actual.entries()) {
    assert.equal(result.isDirectory, false)
    assert.match(result.dataUrl, /^data:image\/png;base64,/)
    assert.equal(requests.find(request => request.path === files[index])?.shellItem, true, 'Read the actual shell item: ' + files[index])
    assert.notEqual(result.dataUrl, driveIcon, 'Files must not return the drive icon')
  }
})
