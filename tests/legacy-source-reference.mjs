import assert from 'node:assert/strict'
import { createReadStream, createWriteStream, promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

export async function fileDigest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

export async function extractOfficialLegacyReference(parent) {
  const catalog = JSON.parse(await fs.readFile('src-tauri/trust/legacy-windows-x64.json', 'utf8'))
  const release = catalog.releases.find(release => release.version === '1.0.2')
  assert.ok(release)
  assert.deepEqual(release.files.map(file => file.path), ['DustDesk.exe', 'resources/app.asar'])
  const zipPath = path.resolve(process.env.DUSTDESK_LEGACY_RELEASE_ZIP ?? path.join('release', release.zipName))
  assert.equal(await fileDigest(zipPath), release.zipSha256, 'Use the exact official green ZIP, not a rebuilt or synthetic installation')
  const root = path.join(parent, 'official-legacy-reference')
  await fs.mkdir(path.join(root, 'resources'), { recursive: true })
  const zip = await new Promise((resolve, reject) => yauzl.open(zipPath, { lazyEntries: true }, (error, zip) => error ? reject(error) : resolve(zip)))
  const extracted = new Set()
  await new Promise((resolve, reject) => {
    const fail = error => { zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('end', resolve)
    zip.on('entry', entry => {
      const expected = release.files.find(file => file.path === entry.fileName)
      if (!expected) { zip.readEntry(); return }
      if (extracted.has(expected.path)) { fail(Error('Duplicate critical ZIP entry: ' + expected.path)); return }
      if (entry.uncompressedSize !== expected.size) { fail(Error('Official ZIP entry size mismatch: ' + expected.path)); return }
      extracted.add(expected.path)
      zip.openReadStream(entry, (error, source) => {
        if (error) { fail(error); return }
        pipeline(source, createWriteStream(path.join(root, expected.path), { flags: 'wx' }))
          .then(() => zip.readEntry(), fail)
      })
    })
    zip.readEntry()
  })
  assert.equal(extracted.size, release.files.length)
  for (const file of release.files) {
    assert.equal((await fs.stat(path.join(root, file.path))).size, file.size)
    assert.equal(await fileDigest(path.join(root, file.path)), file.sha256)
  }
  return { root, zipPath, release }
}
