export function createCanvas(width: number, height: number) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  return canvas
}

export function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('无法读取截图'))
    image.src = source
  })
}

export function composeScreenshot(base: HTMLCanvasElement, marks: HTMLCanvasElement) {
  const result = createCanvas(base.width, base.height)
  const context = result.getContext('2d')!
  context.drawImage(base, 0, 0)
  context.drawImage(marks, 0, 0)
  return result
}

export function redactPixels(source: HTMLCanvasElement, target: HTMLCanvasElement, x: number, y: number, tool: 'mosaic' | 'blur') {
  const left = Math.max(0, Math.floor(x - 18)); const top = Math.max(0, Math.floor(y - 18))
  const width = Math.min(source.width, Math.ceil(x + 18)) - left
  const height = Math.min(source.height, Math.ceil(y + 18)) - top
  if (width <= 0 || height <= 0) return
  const context = target.getContext('2d')!
  context.save()
  context.globalCompositeOperation = 'source-over'
  context.globalAlpha = 1
  if (tool === 'mosaic') {
    const small = createCanvas(Math.max(1, Math.ceil(width / 12)), Math.max(1, Math.ceil(height / 12)))
    small.getContext('2d')!.drawImage(source, left, top, width, height, 0, 0, small.width, small.height)
    context.imageSmoothingEnabled = false
    context.drawImage(small, 0, 0, small.width, small.height, left, top, width, height)
  } else {
    // Blur the neighboring pixels too, so the brush boundary doesn't expose the original.
    context.beginPath(); context.rect(left, top, width, height); context.clip()
    context.filter = 'blur(10px)'
    context.drawImage(source, 0, 0)
  }
  context.restore()
}
