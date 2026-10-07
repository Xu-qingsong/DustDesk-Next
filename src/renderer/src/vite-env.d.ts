import type { DustDeskApi } from '../../shared/types'

declare global {
  const __APP_VERSION__: string
  interface Window { dustdesk: DustDeskApi }
}

export {}
