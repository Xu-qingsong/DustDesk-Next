// Separate old-module process: stop at its actual link/save/unlink boundary.
// The parent owns the temporary roots and forcibly ends this process.
import { promises as fs } from 'node:fs'
import path from 'node:path'
const [moduleUrl, storage, downloads, phase] = process.argv.slice(2)
if (!process.send || !['before-save', 'after-save'].includes(phase)) throw Error('isolated IPC fixture arguments required')
const { createLanService } = await import(moduleUrl)
const originalLink = fs.link, originalRemove = fs.rm
let published
async function halt() {
  process.send({ event: 'publication-gap', phase, ...published })
  await new Promise(() => {})
}
fs.link = async (source, target) => {
  await originalLink(source, target)
  if (String(source).startsWith(downloads + path.sep) && String(source).endsWith('.part')) {
    published = { part: source, target }
    if (phase === 'before-save') await halt()
  }
}
fs.rm = async (target, options) => {
  if (phase === 'after-save' && published?.part === target) await halt()
  return originalRemove(target, options)
}
const service = createLanService({ storage, downloads, name: 'Old publication fixture', host: '127.0.0.1', discovery: false,
  changed() {}, confirmPair: async () => true, confirmReceive: async () => downloads })
await service.enable(true)
process.send({ event: 'ready', port: service.snapshot().port })
