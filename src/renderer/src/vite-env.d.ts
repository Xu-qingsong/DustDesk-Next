import type { DustDeskApi } from '../../shared/types'

declare global {
  interface Window { dustdesk: DustDeskApi }
}

export {}
