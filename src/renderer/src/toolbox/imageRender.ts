import { imageLayout } from '../../../shared/imageTools'
import { cropLayout } from '../../../shared/imagePresets'
import type { ImageOptions } from '../../../shared/toolbox'
export function drawToolImage(image: ImageBitmap, options: ImageOptions, watermark?: ImageBitmap) {
  const quick = options.category === 'avatar' || options.category === 'portrait'
  const layout = quick ? cropLayout(image.width, image.height, options) : imageLayout(image.width, image.height, options)
  if (!Number.isFinite(layout.width * layout.height) || layout.width < 1 || layout.height < 1 || layout.width * layout.height > 64_000_000) throw Error('输出尺寸无效或超过 6400 万像素')
  const canvas = new OffscreenCanvas(layout.width, layout.height), context = canvas.getContext('2d')!
  const circle = options.category === 'avatar' && options.avatarShape === 'circle'
  if (circle) { context.beginPath(); context.arc(canvas.width / 2, canvas.height / 2, canvas.width / 2, 0, Math.PI * 2); context.clip() }
  if (options.format === 'jpeg') { context.fillStyle = options.background; context.fillRect(0, 0, canvas.width, canvas.height) }
  context.drawImage(image, layout.x, layout.y, layout.drawWidth, layout.drawHeight)
  if (options.watermark !== 'none') {
    const size = Math.max(1, Math.min(options.watermarkSize, 10000)), margin = Math.max(0, options.margin), rows = options.text.split('\n')
    context.font = `${size}px "Microsoft YaHei", sans-serif`; context.textBaseline = 'top'
    if (options.watermark === 'image' && !watermark) throw Error('请选择水印图片')
    const width = watermark ? size : Math.max(...rows.map(row => context.measureText(row).width)), height = watermark ? size * watermark.height / watermark.width : rows.length * size * 1.25
    const col = options.position % 3, row = Math.floor(options.position / 3)
    const x = col === 0 ? margin : col === 1 ? (canvas.width - width) / 2 : canvas.width - width - margin
    const y = row === 0 ? margin : row === 1 ? (canvas.height - height) / 2 : canvas.height - height - margin
    context.globalAlpha = Math.max(0, Math.min(1, options.opacity / 100))
    if (watermark) context.drawImage(watermark, x, y, width, height)
    else { context.fillStyle = options.color; rows.forEach((text, index) => context.fillText(text, x, y + index * size * 1.25)) }
  }
  return { canvas, layout }
}
