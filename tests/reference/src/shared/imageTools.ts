import type { ImageOptions } from './toolbox'
export function inspectToolImage(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > 100 * 1024 * 1024) throw Error('单张图片最多 100 MiB')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number, size: number) => String.fromCharCode(...bytes.subarray(start, start + size))
  let format: 'png' | 'jpeg' | 'webp', width = 0, height = 0
  if (bytes.length >= 24 && ascii(1, 3) === 'PNG' && bytes[0] === 137) {
    format = 'png'; width = view.getUint32(16); height = view.getUint32(20)
    for (let at = 8; at + 12 <= bytes.length;) { const length = view.getUint32(at); if (ascii(at + 4, 4) === 'acTL') throw Error('暂不支持动画 PNG'); if (length > bytes.length - at - 12) throw Error('PNG 文件损坏'); at += length + 12 }
  } else if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    format = 'webp'
    for (let at = 12; at + 8 <= bytes.length;) {
      const type = ascii(at, 4), length = view.getUint32(at + 4, true), p = at + 8
      if (length > bytes.length - p) throw Error('WebP 文件损坏')
      if (type === 'ANIM' || type === 'ANMF' || (type === 'VP8X' && (bytes[p]! & 2))) throw Error('暂不支持动画 WebP')
      if (type === 'VP8X' && length >= 10) { width = 1 + bytes[p + 4]! + (bytes[p + 5]! << 8) + (bytes[p + 6]! << 16); height = 1 + bytes[p + 7]! + (bytes[p + 8]! << 8) + (bytes[p + 9]! << 16) }
      if (!width && type === 'VP8 ' && length >= 10) { width = view.getUint16(p + 6, true) & 16383; height = view.getUint16(p + 8, true) & 16383 }
      if (!width && type === 'VP8L' && length >= 5) { const value = view.getUint32(p + 1, true); width = (value & 16383) + 1; height = ((value >>> 14) & 16383) + 1 }
      at = p + length + (length & 1)
    }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    format = 'jpeg'
    for (let at = 2; at + 4 <= bytes.length;) {
      if (bytes[at] !== 255) throw Error('JPG 文件损坏')
      while (bytes[at] === 255) at++
      const marker = bytes[at++]!
      if (marker === 217 || marker === 218) break
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue
      const length = view.getUint16(at)
      if (length < 2 || at + length > bytes.length) throw Error('JPG 文件损坏')
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 7) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); break }
      at += length
    }
  } else throw Error('请选择静态 PNG、JPG 或 WebP 图片')
  if (!width || !height) throw Error('图片尺寸无效或文件损坏')
  if (width * height > 64_000_000) throw Error('图片最多 6400 万像素')
  return { format, width, height }
}
export function imageLayout(width: number, height: number, options: ImageOptions) {
  let w = width, h = height
  if (options.resize === 'percent') { const scale = options.percent / 100; w *= options.upscale ? scale : Math.min(scale, 1); h *= options.upscale ? scale : Math.min(scale, 1) }
  else if (options.resize === 'dimensions') {
    if (options.fit === 'stretch') { w = options.upscale ? options.width : Math.min(options.width, width); h = options.upscale ? options.height : Math.min(options.height, height) }
    else if (options.fit === 'cover') { w = options.width; h = options.height; if (!options.upscale) { const scale = Math.min(1, width / w, height / h); w *= scale; h *= scale } }
    else { let scale = Math.min(options.width / width, options.height / height); if (!options.upscale) scale = Math.min(1, scale); w *= scale; h *= scale }
  }
  w = Math.round(w); h = Math.round(h)
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w * h > 64_000_000 || w > 32767 || h > 32767) throw Error('输出尺寸无效或超过 6400 万像素')
  const cover = options.resize === 'dimensions' && options.fit === 'cover'
  const scale = Math.max(w / width, h / height), drawWidth = cover ? width * scale : w, drawHeight = cover ? height * scale : h
  return { width: w, height: h, x: (w - drawWidth) / 2, y: (h - drawHeight) / 2, drawWidth, drawHeight }
}
