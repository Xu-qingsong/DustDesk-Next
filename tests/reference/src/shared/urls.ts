/** Validate an explicit scheme without supplying or changing the user's URL. */
export function isHttpUrl(value: string) {
  if (!/^https?:\/\//i.test(value.trim())) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname)
  } catch { return false }
}
