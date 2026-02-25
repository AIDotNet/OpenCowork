import type { AIModelConfig, ProviderType } from '../../lib/api/types'

export interface BuiltinProviderPreset {
  builtinId: string
  name: string
  type: ProviderType
  defaultBaseUrl: string
  defaultModels: AIModelConfig[]
  defaultEnabled?: boolean
  requiresApiKey?: boolean
  homepage: string
  /** Link for users to create/manage API keys */
  apiKeyUrl?: string
  /** Custom User-Agent header for providers that require platform identification (e.g. Moonshot套餐) */
  userAgent?: string
}
