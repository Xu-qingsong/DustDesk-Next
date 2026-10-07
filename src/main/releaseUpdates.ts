import { repository } from '../shared/repository'

export type UpdateCheckResult = { ok: boolean; available: boolean; currentVersion?: string; version?: string; releaseNotes?: string; releaseUrl?: string; message?: string; error?: string }

function parseVersion(value: string) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value)
  if (!match) throw Error(`无法识别版本号：${value}`)
  return { numbers: match.slice(1, 4).map(n => BigInt(n)), prerelease: match[4]?.split('.') }
}

export function compareVersions(left: string, right: string) {
  const a = parseVersion(left), b = parseVersion(right)
  for (let i = 0; i < 3; i++) if (a.numbers[i] !== b.numbers[i]) return a.numbers[i]! > b.numbers[i]! ? 1 : -1
  if (!a.prerelease || !b.prerelease) return a.prerelease ? -1 : b.prerelease ? 1 : 0
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i++) {
    const x = a.prerelease[i], y = b.prerelease[i]
    if (x === y) continue
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y)
    if (numericX && numericY) return BigInt(x) > BigInt(y) ? 1 : -1
    if (numericX !== numericY) return numericX ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

export function createReleaseUpdateChecker(deps: {
  version: () => string
  request: (url: string, options: RequestInit) => Promise<Response>
  confirm: (version: string, currentVersion: string, notes: string) => Promise<boolean>
  open: (url: string) => Promise<void>
}) {
  let pending: Promise<UpdateCheckResult> | undefined
  const check = async (): Promise<UpdateCheckResult> => {
    try {
      const currentVersion = deps.version()
      const options = { headers: { Accept: 'application/vnd.github+json', 'User-Agent': `DustDesk/${currentVersion}` }, signal: AbortSignal.timeout(15_000) }
      const response = await deps.request(repository.latestReleaseApi, options)
      if (response.status === 404) {
        // Distinguish an accessible repository without releases from a missing
        // or private repository; neither case means the app is up to date.
        const repo = await deps.request(`https://api.github.com/repos/${repository.owner}/${repository.name}`, options)
        if (!repo.ok) throw Error('无法访问项目仓库，请稍后重试')
        return { ok: true, available: false, currentVersion, message: '当前仓库尚未发布正式版本' }
      }
      if (response.status === 403 || response.status === 429) throw Error('GitHub 请求受限，请稍后再检查更新')
      if (!response.ok) throw Error(`无法读取 GitHub 发布版本（${response.status}）`)
      const release = await response.json()
      if (!release || release.draft || release.prerelease || typeof release.tag_name !== 'string') throw Error('GitHub 正式版本信息无效')
      const version = release.tag_name
      const available = compareVersions(version, currentVersion) > 0
      const releaseNotes = typeof release.body === 'string' && release.body.trim() ? release.body.trim().slice(0, 20_000) : '此版本未提供更新说明，请查看版本发布页面。'
      // Construct the URL from our repository and tag, never from release HTML.
      const releaseUrl = `${repository.releases}/tag/${encodeURIComponent(version)}`
      if (available && await deps.confirm(version, currentVersion, releaseNotes)) await deps.open(releaseUrl)
      return { ok: true, available, currentVersion, version, releaseNotes, releaseUrl }
    } catch (error) {
      return { ok: false, available: false, error: error instanceof Error && /timeout|aborted/i.test(error.message) ? '检查更新超时，请检查网络后重试' : error instanceof Error ? error.message : '检查更新失败，请稍后重试' }
    }
  }
  return {
    check(): Promise<UpdateCheckResult> {
      // Settings and tray share both the request and the confirmation dialog.
      return pending ??= check().finally(() => { pending = undefined })
    }
  }
}
