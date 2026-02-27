import type {
  AIModelConfig,
  ProviderType,
  AuthMode,
  OAuthConfig,
  ChannelConfig,
  RequestOverrides,
  ProviderUiConfig,
} from '../../lib/api/types'

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
  /** Whether to route API requests via the system proxy */
  useSystemProxy?: boolean
  /** Custom User-Agent header for providers that require platform identification (e.g. Moonshot套餐) */
  userAgent?: string
  /** Default model ID to use when this provider is first selected */
  defaultModel?: string
  /** Authentication mode for this provider */
  authMode?: AuthMode
  /** OAuth configuration (when authMode === 'oauth') */
  oauthConfig?: OAuthConfig
  /** Channel auth configuration (when authMode === 'channel') */
  channelConfig?: ChannelConfig
  /** Optional request overrides (headers/body) for this provider */
  requestOverrides?: RequestOverrides
  /** Optional prompt name to use for Responses instructions */
  instructionsPrompt?: string
  /** Optional UI configuration for this provider */
  ui?: ProviderUiConfig
}
