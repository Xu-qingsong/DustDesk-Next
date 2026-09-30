export const argbCss = (argb: number, alpha: number) => {
  const value = Number.isFinite(Number(argb)) ? (Number(argb) >>> 0) : 0xffffffff
  return `rgba(${(value >>> 16) & 255}, ${(value >>> 8) & 255}, ${value & 255}, ${Math.max(0, Math.min(1, alpha))})`
}

export const argbHex = (argb: number) => `#${(Number(argb) >>> 0).toString(16).slice(-6).padStart(6, '0')}`

export const tagColor = (tag: string) => {
  const colors = [-65536, -16711936, -16776961, -23296, -8388480, -12525360]
  return colors[Math.max(0, tag.length - 1) % colors.length] ?? -65536
}
