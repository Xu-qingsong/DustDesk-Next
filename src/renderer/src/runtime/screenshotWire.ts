import type { ScreenshotFinishRequest } from '../../../shared/screenshotDocument'

export function screenshotFinishBytes(request: ScreenshotFinishRequest) {
  const {png = new Uint8Array(), jpeg = new Uint8Array(), ...metadata} = request
  if (!(png instanceof Uint8Array) || !(jpeg instanceof Uint8Array) || png.byteLength > 32 * 1024 * 1024 || jpeg.byteLength > 32 * 1024 * 1024) throw Error('截图输出数据无效或过大（单图最大 32 MB）')
  const document = new TextEncoder().encode(JSON.stringify({...metadata, pngLength:png.byteLength, jpegLength:jpeg.byteLength}))
  if (document.byteLength > 16 * 1024 * 1024) throw Error('截图文档元数据超过 16 MiB')
  const bytes = new Uint8Array(4 + document.byteLength + png.byteLength + jpeg.byteLength)
  new DataView(bytes.buffer).setUint32(0, document.byteLength, true)
  bytes.set(document,4); bytes.set(png,4+document.byteLength); bytes.set(jpeg,4+document.byteLength+png.byteLength)
  return bytes
}
