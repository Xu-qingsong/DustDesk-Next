const KIB = 1024
const MIB = KIB ** 2
const GIB = KIB ** 3

export const formatBytes = (bytes: number) => {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  if (value < KIB) return `${Math.round(value)} B`
  if (value < MIB) return `${(value / KIB).toFixed(1)} KB`
  if (value < GIB) return `${(value / MIB).toFixed(1)} MB`
  return `${(value / GIB).toFixed(1)} GB`
}

export const formatRate = (bytes: number) => `${formatBytes(bytes)}/s`
