// Isolated old-module process for native directory-lease admission tests.
import { promises as fs } from 'node:fs'
import path from 'node:path'
const [moduleUrl, storage, downloads] = process.argv.slice(2)
if (!process.send) throw Error('IPC fixture required')
const { createLanService } = await import(moduleUrl)
let allowTransfers = false, heldWork, releaseWork
const link = fs.link, rm = fs.rm
fs.link = async (...args) => {
  const result = await link(...args)
  if (heldWork === 'publication' && path.resolve(args[0]).startsWith(path.resolve(downloads) + path.sep)) {
    heldWork = undefined
    await new Promise(resolve => { releaseWork = resolve; process.send({ event: 'file-work-held' }) })
  }
  return result
}
fs.rm = async (...args) => {
  if (heldWork === 'cleanup' && path.resolve(args[0]).startsWith(path.resolve(downloads) + path.sep) && path.basename(args[0]).startsWith('.dustdesk-part-')) {
    heldWork = undefined
    await new Promise(resolve => { releaseWork = resolve; process.send({ event: 'file-work-held' }) })
  }
  return rm(...args)
}
const service = createLanService({ storage, downloads, name: 'LAN ownership fixture', host: '127.0.0.1', discovery: false,
  changed() {}, confirmPair: async () => { if (!allowTransfers) throw Error('unexpected pair prompt'); return true }, confirmReceive: async () => {
    if (!allowTransfers) throw Error('unexpected receive prompt')
    if (heldWork === 'confirmation') { heldWork = undefined; process.send({ event: 'confirmation-held' }); return new Promise(() => {}) }
    return downloads
  } })
process.on('message', async message => {
  const { id, command, enabled } = message
  try {
    if (command === 'enable') await service.enable(enabled)
    else if (command === 'restore') await service.restore()
    else if (command === 'dispose') { const operation = service.dispose(); setImmediate(() => process.send({ event: 'disposing' })); await operation }
    else if (command === 'allow-transfers') allowTransfers = true
    else if (command === 'hold-file-work') heldWork = message.kind
    else if (command === 'release-file-work') { releaseWork?.(); releaseWork = undefined }
    else if (command === 'control') await service.control(message.task, message.action)
    else throw Error('unknown fixture command')
    const reply = { id, ok: true, snapshot: service.snapshot() }
    if (command === 'dispose') process.send(reply, () => process.disconnect())
    else process.send(reply)
  } catch (error) { process.send({ id, ok: false, error: String(error) }) }
})
process.send({ event: 'ready' })
