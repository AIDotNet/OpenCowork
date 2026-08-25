import type { BuiltinProviderPreset } from './types'

export const lmstudioPreset: BuiltinProviderPreset = {
  builtinId: 'lmstudio',
  version: 1,
  name: 'LM Studio',
  type: 'openai-chat',
  defaultBaseUrl: 'http://localhost:1234/v1',
  homepage: 'https://lmstudio.ai',
  apiKeyUrl: 'https://lmstudio.ai',
  defaultModels: [],
  requiresApiKey: false
}
