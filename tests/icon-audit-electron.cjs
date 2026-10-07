const { app, nativeImage, shell } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { createHash } = require('node:crypto')
const ts = require('typescript')

process.on('uncaughtException', error => { console.error(error); process.exit(1) })
app.disableHardwareAcceleration()

app.whenReady().then(async () => {
  const output = process.argv[2]
  await fs.mkdir(output, { recursive: true })
  const cleanups = []
  const { mainFixture } = await import('./main-headless-harness.mjs')
  const fixture = await mainFixture({ after: fn => cleanups.push(fn) })
  fixture.childProcess.execFile = require('node:child_process').execFile
  fixture.electron.app.getFileIcon = app.getFileIcon.bind(app)
  try {
    const modulePath = path.join(fixture.root, 'native-reference.mjs')
    const source = await fs.readFile('src/main/windowsIcons.ts', 'utf8')
    await fs.writeFile(modulePath, ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText)
    const { extractWindowsIconResources } = await import(pathToFileURL(modulePath).href)
    const hash = url => url ? createHash('sha256').update(nativeImage.createFromDataURL(url).resize({ width: 32, height: 32 }).toBitmap()).digest('hex') : null
    const items = new Map()
    async function add(file, group) {
      if (items.has(file.toLowerCase())) return
      try { const info = await fs.stat(file); items.set(file.toLowerCase(), { path: file, name: path.basename(file), group, isDirectory: info.isDirectory() }) } catch { /* Report only existing local items. */ }
    }
    for (const desktop of [app.getPath('desktop'), path.join(process.env.PUBLIC, 'Desktop')]) {
      for (const entry of await fs.readdir(desktop)) if (entry.toLowerCase() !== 'desktop.ini') await add(path.join(desktop, entry), 'desktop')
    }
    const data = path.join(app.getPath('appData'), 'DustDesk.Next', 'Data')
    const state = JSON.parse(await fs.readFile(path.join(data, 'workspace.json'), 'utf8'))
    for (const category of state.DesktopCategories) for (const file of category.ItemPaths) await add(file, 'collected')
    for (const launcher of state.Launchers) await add(launcher.Path, 'launcher')
    // Test type associations without reading the user's document contents.
    const samples = path.join(fixture.root, 'samples')
    await fs.mkdir(samples)
    for (const extension of ['txt', 'pdf', 'docx', 'xlsx', 'pptx', 'png', 'jpg', 'svg', 'mp3', 'mp4', 'zip', 'json', 'js', 'html', 'url', 'unknown', '']) {
      const file = path.join(samples, 'sample' + (extension ? '.' + extension : ''))
      await fs.writeFile(file, extension === 'url' ? '[InternetShortcut]\r\nURL=https://example.com\r\n' : '')
      await add(file, 'sample')
    }
    const dotfile = path.join(samples, '.gitignore')
    await fs.writeFile(dotfile, '')
    await add(dotfile, 'sample')
    for (const name of ['folder', 'folder.txt', 'folder.exe', 'folder.lnk']) { const file = path.join(samples, name); await fs.mkdir(file); await add(file, 'sample') }
    // Include direct program paths as well as the shortcut resource selections.
    for (const item of [...items.values()]) if (/\.lnk$/i.test(item.path) && !item.isDirectory) {
      try { const link = shell.readShortcutLink(item.path); if (link.target) await add(link.target, 'program') } catch { }
    }
    const genericExe = path.join(samples, 'no-resources.exe')
    await fs.writeFile(genericExe, '')
    const drive = path.parse(samples).root
    const [driveUrl, genericExeUrl, genericFileUrl] = await extractWindowsIconResources([drive, genericExe, path.join(samples, 'sample.unknown')].map(file => ({ path: file, index: 0, shellItem: true })))
    const baselines = { drive: hash(driveUrl), genericProgram: hash(genericExeUrl), genericFile: hash(genericFileUrl) }
    const list = [...items.values()]
    const references = []
    // SHGetFileInfo reads the real shell item regardless of the filename's extension.
    for (let index = 0; index < list.length; index += 32) references.push(...await extractWindowsIconResources(list.slice(index, index + 32).map(item => ({ path: item.path, index: 0, shellItem: true }))))
    let activeProcesses = 0; let maximumProcesses = 0; let processCount = 0
    fixture.childProcess.execFile = (...args) => {
      processCount++; maximumProcesses = Math.max(maximumProcesses, ++activeProcesses)
      const callback = args.pop()
      return require('node:child_process').execFile(...args, (...result) => { activeProcesses--; callback(...result) })
    }
    const started = Date.now()
    const results = await Promise.all(list.map(async (item, index) => {
      const result = await fixture.invoke('path:icon', item.path)
      const actualHash = hash(result.dataUrl)
      const referenceHash = hash(references[index])
      const imageFile = result.dataUrl ? `${index}-actual.png` : null
      if (imageFile) await fs.writeFile(path.join(output, imageFile), nativeImage.createFromDataURL(result.dataUrl).toPNG())
      if (references[index]) await fs.writeFile(path.join(output, `${index}-shell.png`), nativeImage.createFromDataURL(references[index]).toPNG())
      return { ...item, index, imageFile, referenceFile: references[index] ? `${index}-shell.png` : null, resultDirectory: result.isDirectory, width: result.dataUrl ? nativeImage.createFromDataURL(result.dataUrl).getSize().width : 0,
        matchesDrive: actualHash === baselines.drive, genericProgram: actualHash === baselines.genericProgram, genericFile: actualHash === baselines.genericFile,
        matchesShell: actualHash === referenceHash, hasIcon: !!result.dataUrl }
    }))
    const report = { durationMs: Date.now() - started, processCount, maximumProcesses, count: results.length,
      driveMismatches: results.filter(item => item.matchesDrive && item.path !== drive).map(item => item.name),
      fileMismatches: results.filter(item => !/\.(lnk|exe|dll|ico|icl)$/i.test(item.path) && !item.matchesShell).map(item => item.name),
      missing: results.filter(item => !item.hasIcon).map(item => item.name), results }
    await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ count: report.count, durationMs: report.durationMs, maximumProcesses, driveMismatches: report.driveMismatches, fileMismatches: report.fileMismatches, missing: report.missing,
      genericPrograms: results.filter(item => item.genericProgram).map(item => item.name), groups: Object.fromEntries(['desktop', 'collected', 'launcher', 'program', 'sample'].map(group => [group, results.filter(item => item.group === group).length])) }, null, 2))
  } finally { for (const cleanup of cleanups) await cleanup() }
  app.quit()
}).catch(error => { console.error(error); app.exit(1) })
