import type { ImageOptions } from './toolbox'
export const portraitPresets = [
  { id: 'small-one', name: '小一寸', mmWidth: 22, mmHeight: 32 },
  { id: 'one', name: '一寸', mmWidth: 25, mmHeight: 35 },
  { id: 'small-two', name: '小二寸', mmWidth: 33, mmHeight: 48 },
  { id: 'two', name: '二寸', mmWidth: 35, mmHeight: 49 }
].map(preset => ({ ...preset, width: Math.round(preset.mmWidth / 25.4 * 300), height: Math.round(preset.mmHeight / 25.4 * 300) }))
export const centeredCrop = { x: .5, y: .5, zoom: 1 }
export function cropLayout(width: number, height: number, options: ImageOptions) {
  const zoom = Math.max(1, Math.min(8, options.crop?.zoom ?? 1))
  const scale = Math.max(options.width / width, options.height / height) * zoom
  const drawWidth = width * scale, drawHeight = height * scale
  const centerX = Math.max(0, Math.min(1, options.crop?.x ?? .5)), centerY = Math.max(0, Math.min(1, options.crop?.y ?? .5))
  return { width: options.width, height: options.height, drawWidth, drawHeight,
    x: Math.max(options.width - drawWidth, Math.min(0, options.width / 2 - centerX * drawWidth)),
    y: Math.max(options.height - drawHeight, Math.min(0, options.height / 2 - centerY * drawHeight)) }
}
