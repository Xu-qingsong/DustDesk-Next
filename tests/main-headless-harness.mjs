import { EventEmitter } from 'node:events'
import * as nodeFs from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import ts from 'typescript'

// Compile the real main-process implementation, replacing only native/system
// boundaries. No Electron process, desktop window, shortcut or clipboard access.
export async function mainFixture(t, { screenshotWindows = false, widgetWindows = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dustdesk-headless-'))
  const sourceRoot = fileURLToPath(new URL('../src/', import.meta.url))
  const data = path.join(root, 'data')
  const handlers = new Map()
  const ipcMain = Object.assign(new EventEmitter(), { handle: (name, handler) => handlers.set(name, handler) })
  const app = Object.assign(new EventEmitter(), {
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => {}),
    getPath: name => path.join(root, name), setPath: () => {}, quit: () => {},
    getVersion: () => '1.0.0',
    getLoginItemSettings: () => ({ openAtLogin: false })
  })
  const virtualWindows = []
  let shutdownWidgets = () => {}
  class ForbiddenWindow {
    constructor(options) {
      if (!screenshotWindows && !widgetWindows) throw Error('Headless tests must never create a native window')
      const win = Object.assign(new EventEmitter(), {
        options, destroyed: false, visible: false, bounds: { x: 0, y: 0, width: options.width, height: options.height },
        isDestroyed: () => win.destroyed, isVisible: () => win.visible,
        show: () => { win.visible = true }, hide: () => { win.visible = false }, focus: () => {},
        setContentProtection: value => { win.contentProtected = value },
        setOpacity: value => { win.opacity = value }, setAlwaysOnTop: value => { win.topmost = value }, setIgnoreMouseEvents: value => { win.mouseThrough = value }, setResizable: value => { win.resizable = value },
        setPosition: (x, y) => { Object.assign(win.bounds, { x, y }); win.emit('move'); win.emit('moved') }, setSize: (width, height) => { Object.assign(win.bounds, { width, height }) }, getBounds: () => ({ ...win.bounds }),
        setBounds: bounds => { Object.assign(win.bounds, bounds) }, setMinimumSize: () => {}, setMovable: value => { win.movable = value }, setBackgroundColor: () => {},
        close: () => win.destroy(), destroy: () => { if (!win.destroyed) { win.destroyed = true; win.emit('closed') } },
        loadURL: async () => { win.webContents.emit('did-finish-load') }, loadFile: async () => { win.webContents.emit('did-finish-load') },
        webContents: Object.assign(new EventEmitter(), { id: virtualWindows.length + 100, send: (...args) => { win.messages.push(args) } }), messages: []
      })
      virtualWindows.push(win)
      return win
    }
    static getAllWindows() { return virtualWindows }
    static fromWebContents(sender) { return virtualWindows.find(window => window.webContents === sender) }
  }
  const shortcutCalls = []
  const electron = {
    app, ipcMain, BrowserWindow: ForbiddenWindow,
    globalShortcut: { register: key => { shortcutCalls.push(key); return true }, unregisterAll: () => { shortcutCalls.length = 0 } },
    Notification: { isSupported: () => false }, powerMonitor: new EventEmitter(),
    clipboard: {}, dialog: { showMessageBox: async () => ({ response: 0 }) }, Menu: {}, nativeImage: {}, screen: {}, shell: {}, Tray: ForbiddenWindow,
    net: { fetch: async () => new Response(JSON.stringify({ tag_name: 'v1.0.0', body: '已发布版本' }), { status: 200 }) }
  }
  const fileSystem = { ...nodeFs.promises }
  const childProcess = { execFile: () => { throw Error('System processes are forbidden in headless tests') } }
  const key = crypto.randomUUID()
  const fixtures = globalThis.__dustdeskHeadlessFixtures ??= new Map()
  fixtures.set(key, { electron, fileSystem, childProcess, existsSync: nodeFs.existsSync })
  t.after(async () => {
    shutdownWidgets()
    for (const window of virtualWindows) if (window.options && !window.isDestroyed()) window.destroy()
    fixtures.delete(key)
    await fs.rm(root, { recursive: true, force: true })
  })
  const mocks = {
    electron: 'export const { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, net, Notification, powerMonitor, screen, shell, Tray } = fixture.electron;',
    'node:fs': 'export const promises = fixture.fileSystem; export const existsSync = fixture.existsSync;',
    'node:child_process': 'export function execFile(...args) { return fixture.childProcess.execFile(...args) }',
    systeminformation: 'export default { currentLoad: async () => ({ currentLoad: 5 }), mem: async () => ({ total: 1000, available: 500 }), fsSize: async () => [], networkStats: async () => [], inetLatency: async () => -1, time: () => ({ uptime: 60 }) };',
    xlsx: 'export const utils = {}; export function writeFile() { throw Error("Spreadsheet export is not mocked") }'
  }
  const mockUrls = new Map()
  for (const [name, body] of Object.entries(mocks)) {
    const target = path.join(root, `mock-${mockUrls.size}.mjs`)
    await fs.writeFile(target, `const fixture = globalThis.__dustdeskHeadlessFixtures.get(${JSON.stringify(key)});\n${body}`)
    mockUrls.set(name, pathToFileURL(target).href)
  }
  const compiled = new Map()
  async function compile(sourcePath) {
    if (compiled.has(sourcePath)) return compiled.get(sourcePath)
    const target = path.join(root, 'compiled', path.relative(sourceRoot, sourcePath).replace(/\.ts$/, '.mjs'))
    const url = pathToFileURL(target).href
    compiled.set(sourcePath, url)
    let source = await fs.readFile(sourcePath, 'utf8')
    if (sourcePath === path.join(sourceRoot, 'main', 'index.ts')) {
      source += '\nexport { registerIpc };\nexport function setScreenshotTestWindow(window) { mainWindow = window };\nexport function stopWidgetTestWindows() { isQuitting = true; for (const window of widgetWindows.values()) window.destroy() };\n'
      for (const [name, directory] of Object.entries({ DATA: data, USER_DATA: path.join(root, 'user-data'), DESKTOP: path.join(root, 'desktop') })) {
        source = source.replaceAll(`process.env.DUSTDESK_TEST_${name}_DIR`, JSON.stringify(directory))
      }
    }
    let output = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
    for (const match of [...output.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)]) {
      const specifier = match[2]
      const replacement = mockUrls.get(specifier) ?? (specifier.startsWith('.') ? await compile(path.resolve(path.dirname(sourcePath), specifier + '.ts')) : specifier)
      output = output.replaceAll(`${match[1]}${specifier}${match[1]}`, JSON.stringify(replacement))
    }
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, output)
    return url
  }
  const main = await import(await compile(path.join(sourceRoot, 'main', 'index.ts')))
  shutdownWidgets = main.stopWidgetTestWindows
  main.registerIpc()
  let nextClient = 0
  function client(onSend = () => {}, mainClient = false) {
    const sender = Object.assign(new EventEmitter(), { id: ++nextClient, isDestroyed: () => false, send: onSend })
    const window = { isDestroyed: () => false, webContents: sender, show: () => {}, focus: () => {}, isMinimized: () => false }
    virtualWindows.push(window)
    if (mainClient) main.setScreenshotTestWindow(window)
    return (channel, ...args) => {
      if (!handlers.has(channel)) throw Error(`Missing IPC handler: ${channel}`)
      return Promise.resolve().then(() => handlers.get(channel)({ sender }, ...args))
    }
  }
  const invoke = client()
  return { root, data, electron, fileSystem, childProcess, shortcutCalls, invoke, client, windows: virtualWindows, handlers, load: () => invoke('workspace:load') }
}
