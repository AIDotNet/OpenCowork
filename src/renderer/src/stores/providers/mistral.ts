import type { BuiltinProviderPreset } from './types'

export const mistralPreset: BuiltinProviderPreset = {
  builtinId: 'mistral',
  version: 1,
  name: 'Mistral',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  homepage: 'https://mistral.ai',
  apiKeyUrl: 'https://console.mistral.ai/api-keys',
  defaultModel: 'mistral-medium-3.5',
  defaultModels: [
    {
      id: 'mistral-medium-3.5',
      name: 'Mistral Medium 3.5',
      icon: 'mistral',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 1.5,
      outputPrice: 7.5,
      supportsThinking: true,
      thinkingConfig: {
        bodyParams: {},
        reasoningEffortLevels: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium'
      }
    },
    {
      id: 'mistral-small-latest',
      name: 'Mistral Small',
      icon: 'mistral',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 0.1,
      outputPrice: 0.3
    },
    {
      id: 'mistral-large-latest',
      name: 'Mistral Large',
      icon: 'mistral',
      enabled: true,
      contextLength: 128_000,
      maxOutputTokens: 32_768,
      supportsVision: true,
      supportsFunctionCall: true,
      inputPrice: 2,
      outputPrice: 6
    },
    {
      id: 'codestral-latest',
      name: 'Codestral',
      icon: 'mistral',
      enabled: true,
      contextLength: 256_000,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
