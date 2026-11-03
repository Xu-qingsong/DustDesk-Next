import yauzl from 'yauzl'

// Read exported archives with an independent ZIP implementation.
export function readZip(target) {
  return new Promise((resolve, reject) => yauzl.open(target, { lazyEntries: true }, (error, zip) => {
    if (error) { reject(error); return }
    const files = new Map()
    const fail = error => { zip.close(); reject(error) }
    zip.on('error', fail)
    zip.on('end', () => resolve(files))
    zip.on('entry', entry => {
      if (files.has(entry.fileName)) { fail(Error('Duplicate ZIP entry: ' + entry.fileName)); return }
      zip.openReadStream(entry, (error, stream) => {
        if (error) { fail(error); return }
        const chunks = []
        stream.on('error', fail)
        stream.on('data', chunk => chunks.push(chunk))
        stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
      })
    })
    zip.readEntry()
  }))
}
