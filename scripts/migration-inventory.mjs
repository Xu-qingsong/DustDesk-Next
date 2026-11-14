import ts from 'typescript'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sources = [ ['DustDeskApi', 'src/shared/types.ts'], ['ToolboxApi', 'src/shared/toolbox.ts'] ]
const isolatedVerified = new Set(['loadWorkspace', 'saveWorkspace', 'getDataLocation', 'onWorkspaceChanged', 'showMainWindow', 'hideMainWindow', 'platform'])
const screenshotPartial = new Set(['createScreenshotDocument', 'readScreenshotDocument', 'discardScreenshotDocument', 'finishScreenshot', 'listScreenshotWindows', 'startScreenshot', 'selectScreenshotRegion', 'onScreenshotDocument', 'readPinnedScreenshot', 'onPinnedScreenshotSaveRequested', 'savePinnedScreenshot', 'controlPinnedScreenshot', 'onPinnedScreenshotChanged'])
// Public Electron preload names are not a permission template for Tauri.
// Record the actual role adapters instead of treating main-window stubs as
// missing product entry points or granting main access to another owner.
const screenshotRouting = Object.fromEntries([
  ['selectScreenshotRegion', 'capture-window', 'src/renderer/src/runtime/capture.tsx', 'ScreenshotRuntime.selectRegion', 'denied'],
  ...['readPinnedScreenshot', 'savePinnedScreenshot', 'controlPinnedScreenshot', 'onPinnedScreenshotChanged', 'onPinnedScreenshotSaveRequested'].map(name => [name, 'pin-window', 'src/renderer/src/runtime/pin.tsx', `PinRuntime.${name}`, 'denied-or-inert']),
  ['cancelScreenshotOverlay', 'capture-window', 'src/renderer/src/runtime/capture.tsx', 'screenshot_overlay_cancel', 'denied'],
  ...['submitScreenshotOverlay', 'onScreenshotOverlaySource', 'saveScreenshot', 'pinScreenshot'].map(name => [name, 'legacy-electron', null, null, 'unimplemented-unused-by-current-renderer']),
  ['onScreenshotCaptured', 'legacy-electron', 'src/renderer/src/app/App.tsx', 'Tauri delivers onScreenshotDocument instead', 'inert-legacy-subscription'],
].map(([name, role, source, binding, mainAdapter]) => [name, { role, source, binding, mainAdapter }]))
const partial = new Set(['onBeforeQuit', 'onMainWindowReleaseCheck', 'productivity', 'createBackup', 'listBackups', 'previewBackup', 'restoreBackup', 'backupStatus', 'readImageFile', 'checkResources', 'cancelResourceCheck', 'onResourceCheckProgress', 'pickFolder', 'pickPath', 'openPath', 'openUrl', 'pickNoteBackground', 'importNoteBackground', 'clearNoteBackground', 'getPathIcon', 'showPathContextMenu', 'listDesktopEntries', 'moveIntoCategory', 'restoreToDesktop', 'undoOrganizerMove', 'planSmartOrganize', 'executeSmartOrganize', 'searchFiles', 'cancelFileSearch', 'sampleSystemMetrics', 'getStartupEnabled', 'setStartupEnabled', 'readClipboard', 'writeClipboard', 'previewClipboardImage', 'onClipboardChanged'])

for (const name of ['onFilesDropped','toggleWidgets','getWidgetVisibility','hideWidget','setWidgetVisibility','setWidgetOptions','moveWidget','resizeWidget','listWidgetPresets','saveWidgetPreset','applyWidgetPreset','deleteWidgetPreset','onWidgetVisibilityChanged','onWidgetAppearance','exportProjects','checkForUpdate','showQuickCapture','hideQuickCapture','setHotkeys']) partial.add(name)

export function extractMembers(text, interfaceName) {
  const source = ts.createSourceFile('contract.ts', text, ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(statement => ts.isInterfaceDeclaration(statement) && statement.name.text === interfaceName)
  if (!declaration) throw Error('Missing public contract: ' + interfaceName)
  return declaration.members.map(member => ({
    name: member.name?.getText(source),
    kind: ts.isMethodSignature(member) ? 'method' : 'property',
    signature: member.getText(source)
  }))
}

export async function createInventory() {
  const contracts = await Promise.all(sources.map(async ([name, file]) => ({ name, file, members: extractMembers(await readFile(file, 'utf8'), name).map(member => ({
    ...member,
    ...(screenshotRouting[member.name] ? { tauriRouting: screenshotRouting[member.name] } : {}),
    tauriStatus: name === 'DustDeskApi' && isolatedVerified.has(member.name) ? 'isolated-verified' : (name === 'DustDeskApi' && (partial.has(member.name) || screenshotPartial.has(member.name))) || (name === 'ToolboxApi' && ['exportText', 'copyText', 'pick', 'registerPaths', 'importImage', 'readAsset', 'releaseAssets', 'beginImageExport', 'exportImage', 'endImageExport', 'lanSnapshot', 'lanEnable', 'lanConnect', 'lanSend', 'lanControl', 'onLanChanged'].includes(member.name)) ? 'partial' : 'pending'
  })) })))
  return { schema: 2, branch: 'codex/tauri-migration', scope: 'full-feature-replacement', implementationScope: 'isolated-workspace-only', prototypeIsPublicApiImplementation: false, productionReady: false, verificationSuite: 'tests/tauri-app.mjs', contracts }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const report = await createInventory()
  await mkdir('artifacts/tauri-migration', { recursive: true })
  await writeFile('artifacts/tauri-migration/api-inventory.json', JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ interfaces: report.contracts.map(contract => ({ name: contract.name, members: contract.members.length })), destination: 'artifacts/tauri-migration/api-inventory.json', isolatedVerifiedMembers: report.contracts.flatMap(contract => contract.members).filter(member => member.tauriStatus === 'isolated-verified').length, productionReady: false }, null, 2))
}
