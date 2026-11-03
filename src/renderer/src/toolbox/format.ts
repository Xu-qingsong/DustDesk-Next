export function fileSize(value: number) {
  return value >= 1024 * 1024 ? (value / 1024 / 1024).toFixed(2) + ' MiB' : (value / 1024).toFixed(1) + ' KiB'
}
