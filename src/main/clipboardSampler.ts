import { createHash } from 'node:crypto'
import type { NativeImage } from 'electron'

export function createClipboardSampler(maxBytes: number, maxPixels = 16_000_000) {
  let previous = ''
  return (text: string, image: Pick<NativeImage, 'isEmpty' | 'getSize' | 'toBitmap' | 'toPNG'>) => {
    const { width, height } = image.getSize()
    if (!image.isEmpty() && width * height > maxPixels) return null
    const rawHash = createHash('sha256').update(text).update(`${width}:${height}:`)
    if (!image.isEmpty()) rawHash.update(image.toBitmap())
    const fingerprint = rawHash.digest('hex')
    if (fingerprint === previous) return null
    previous = fingerprint
    const png = image.isEmpty() ? null : image.toPNG()
    if (png && png.byteLength > maxBytes) return null
    const imagePngBase64 = png?.toString('base64') ?? ''
    if (!text && !imagePngBase64) return null
    return { text, imagePngBase64, fingerprint: createHash('sha256').update(text).update(imagePngBase64).digest('hex') }
  }
}
