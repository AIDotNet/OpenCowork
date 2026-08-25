import type { BuiltinProviderPreset } from './types'

export const fireworksPreset: BuiltinProviderPreset = {
  builtinId: 'fireworks',
  version: 1,
  name: 'Fireworks',
  type: 'openai-chat',
  defaultBaseUrl: 'https://api.fireworks.ai/inference/v1',
  homepage: 'https://fireworks.ai',
  apiKeyUrl: 'https://fireworks.ai/account/api-keys',
  defaultModel: 'accounts/fireworks/models/deepseek-v4-pro',
  defaultModels: [
    {
      id: 'accounts/fireworks/models/deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      icon: 'deepseek',
      enabled: true,
      contextLength: 1_048_576,
      maxOutputTokens: 32_768,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'accounts/fireworks/models/deepseek-v3p2',
      name: 'DeepSeek V3.2',
      icon: 'deepseek',
      enabled: true,
      contextLength: 164_000,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    },
    {
      id: 'accounts/fireworks/models/kimi-k2p5',
      name: 'Kimi K2.5',
      icon: 'kimi',
      enabled: true,
      contextLength: 262_144,
      maxOutputTokens: 16_384,
      supportsVision: true,
      supportsFunctionCall: true
    },
    {
      id: 'accounts/fireworks/models/qwen3-235b-a22b',
      name: 'Qwen3 235B',
      icon: 'qwen',
      enabled: true,
      contextLength: 131_072,
      maxOutputTokens: 16_384,
      supportsVision: false,
      supportsFunctionCall: true
    }
  ]
}
